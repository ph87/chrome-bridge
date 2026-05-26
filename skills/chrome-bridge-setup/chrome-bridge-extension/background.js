const NATIVE_HOST_NAME = 'chrome_bridge';
importScripts('runtime-config.js', 'commands/index.js');

const runtimeConfig = globalThis.ChromeBridgeRuntimeConfig || {};
const DEFAULT_AGENT_ID = String(runtimeConfig.defaultAgentId || '').trim();
const AUTO_CONTEXT_ENABLED = runtimeConfig.autoContextEnabled !== false;
const ADAPTER_MAP = Object.freeze({
  'acp-rpc': 'acp-rpc',
  acpRpcAdapter: 'acp-rpc',
  stdio: 'stdio',
  stdioAdapter: 'stdio'
});

let nativePort = null;
let reconnectTimer = null;
const persistentChatContextByTabId = new Map();
const pendingNativeRequestsByTaskId = new Map();
const sidePanelPorts = new Set();

connectNativeHost();
chrome.runtime.onStartup.addListener(connectNativeHost);
chrome.runtime.onInstalled.addListener(connectNativeHost);
chrome.action.onClicked.addListener(handleActionClick);
chrome.runtime.onConnect.addListener(handlePortConnect);
chrome.tabs.onRemoved.addListener(handleTabRemoved);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  return true;
});

async function handleActionClick(tab) {
  connectNativeHost();
  const windowId = tab?.windowId;
  if (windowId == null) return;

  try {
    await chrome.sidePanel.open({ windowId });
  } catch (error) {
    console.warn('[chrome-bridge] failed to open side panel', error);
  }
}

function handlePortConnect(port) {
  if (!port || port.name !== 'sidepanel') return;
  sidePanelPorts.add(port);
  port.onDisconnect.addListener(() => {
    sidePanelPorts.delete(port);
  });
}

async function handleRuntimeMessage(message, sender) {
  if (!message || typeof message !== 'object') throw new Error('Invalid extension message');

  if (message.type === 'bridge_config_get') {
    return await requestNativeConfig('config_get');
  }

  if (message.type === 'bridge_config_set') {
    const config = normalizeBridgeConfig(message.config);
    const result = await requestNativeConfig('config_set', { config });
    if (result?.restartRequired) {
      scheduleNativeHostRestart();
    }
    return result;
  }

  if (message.type === 'bridge_config_refresh_token') {
    return await requestNativeConfig('config_refresh_token');
  }

  if (message.type === 'bridge_chat_send') {
    const targetTab = await resolveChatTargetTab(message, sender);
    const tabId = targetTab.id;
    if (tabId == null) throw new Error('Unable to resolve target tab');

    const text = String(message.text || '').trim();
    if (text === '') throw new Error('Message text is empty');
    const agentSelection = resolveAgentSelection(message);

    const parsedCommand = globalThis.ChromeBridgeCommands.parse(text);
    if (parsedCommand !== null) {
      const commandResult = await globalThis.ChromeBridgeCommands.handle(parsedCommand, {
        tab: {
          id: tabId,
          url: String(targetTab?.url || ''),
          title: String(targetTab?.title || '')
        },
        agentId: agentSelection.agentId,
        agentSpec: agentSelection.agentSpec,
        sendToNative: sendNative,
        forwardEvent: (event) => forwardChatEventToSidePanels(tabId, event)
      });
      if (hasPersistPrefix(commandResult?.persistContext)) {
        persistentChatContextByTabId.set(tabId, {
          ...commandResult.persistContext,
          prefix: String(commandResult.persistContext.prefix || '').trim()
        });
      }
      return { accepted: commandResult.accepted, command: parsedCommand.name };
    }

    const agentId = agentSelection.agentId;
    let persistentCtx = persistentChatContextByTabId.get(tabId);
    if (!persistentCtx && AUTO_CONTEXT_ENABLED) {
      const autoCtx = globalThis.ChromeBridgeCommands.getAutoPersistContext({
        tab: {
          id: tabId,
          url: String(targetTab?.url || ''),
          title: String(targetTab?.title || '')
        },
        agentId,
        sendToNative: sendNative,
        forwardEvent: (event) => forwardChatEventToSidePanels(tabId, event)
      });
      if (hasPersistPrefix(autoCtx)) {
        persistentCtx = {
          ...autoCtx,
          prefix: String(autoCtx.prefix || '').trim()
        };
        persistentChatContextByTabId.set(tabId, persistentCtx);
      }
    }
    const textWithContext =
      hasPersistPrefix(persistentCtx)
        ? [persistentCtx.prefix, `User request: ${text}`].join('\n')
        : text;
    sendNative({
      type: 'chat_user_message',
      tabId,
      agentId,
      agentSpec: agentSelection.agentSpec,
      text: textWithContext
    });
    return { accepted: true };
  }

  if (message.type === 'bridge_chat_close') {
    const tabId = await resolveMessageTabId(message, sender);
    if (tabId == null) return { closed: false };
    persistentChatContextByTabId.delete(tabId);

    sendNative({
      type: 'chat_close',
      tabId
    });
    return { closed: true };
  }

  throw new Error(`Unsupported message type: ${String(message.type || '')}`);
}

async function resolveChatTargetTab(message, sender) {
  const tabId = await resolveMessageTabId(message, sender);
  if (tabId == null) throw new Error('Missing target tab id');

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.id == null) {
    throw new Error(`Target tab not found: ${tabId}`);
  }
  return tab;
}

async function resolveMessageTabId(message, sender) {
  const requestedTabId = Number(message?.tabId);
  if (Number.isFinite(requestedTabId)) return requestedTabId;

  const senderTabId = sender?.tab?.id;
  if (senderTabId != null) return senderTabId;
  return null;
}

function connectNativeHost() {
  if (nativePort !== null) return;

  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (error) {
    console.error('[chrome-bridge] connectNative failed', error);
    scheduleReconnect();
    return;
  }

  nativePort.onMessage.addListener(async (message) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'config_result') {
      resolvePendingNativeRequest(message);
      return;
    }

    if (message.type === 'execute_js') {
      await handleExecute(message);
      return;
    }

    if (message.type === 'list_tabs') {
      await handleListTabs(message);
      return;
    }

    if (message.type === 'list_frames') {
      await handleListFrames(message);
      return;
    }

    if (message.type === 'close_tab') {
      await handleCloseTab(message);
      return;
    }

    if (message.type === 'capture_screenshot') {
      await handleCaptureScreenshot(message);
      return;
    }

    if (message.type === 'chat_event') {
      await handleChatEvent(message);
      return;
    }
  });

  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.warn('[chrome-bridge] native disconnected', err?.message || null);
    for (const pending of pendingNativeRequestsByTaskId.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Native host disconnected'));
    }
    pendingNativeRequestsByTaskId.clear();
    nativePort = null;
    scheduleReconnect();
  });

  sendNative({
    type: 'host_status',
    event: 'extension_connected',
    ts: new Date().toISOString()
  });
}

function scheduleReconnect() {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeHost();
  }, 1500);
}

async function handleExecute(payload) {
  const taskId = String(payload.taskId || '');
  const code = String(payload.code || '').trim();
  const frameId = String(payload?.frameId || '').trim() || null;
  const frameUrlPattern = String(payload?.frameUrlPattern || '').trim() || null;

  if (taskId === '') {
    sendNative({
      type: 'execution_result',
      taskId: '',
      ok: false,
      error: 'Missing taskId'
    });
    return;
  }

  if (code === '') {
    sendNative({
      type: 'execution_result',
      taskId,
      ok: false,
      error: 'Missing code'
    });
    return;
  }

  if (frameId && frameUrlPattern) {
    sendNative({
      type: 'execution_result',
      taskId,
      ok: false,
      error: 'frameId and frameUrlPattern are mutually exclusive'
    });
    return;
  }

  try {
    const tab = await resolveTargetTab(payload);
    const before = { url: tab.url || null, title: tab.title || null };
    const evaluateOutcome = await evaluateInTabWithDebugger(tab.id, code, {
      frameId,
      frameUrlPattern
    });
    const evalResult = evaluateOutcome.evaluation;
    if (evalResult.exceptionDetails) {
      const errText =
        evalResult.exceptionDetails.text ||
        evalResult.result?.description ||
        'Execution failed';
      throw new Error(errText);
    }

    const afterTab = await chrome.tabs.get(tab.id).catch(() => null);

    sendNative({
      type: 'execution_result',
      taskId,
      ok: true,
      result: {
        value: evalResult.result?.value ?? null,
        targetTabId: tab.id,
        targetTabUrl: (afterTab && afterTab.url) || tab.url || null,
        targetFrameId: evaluateOutcome.targetFrameId,
        probe: {
          before,
          after: {
            url: (afterTab && afterTab.url) || before.url,
            title: (afterTab && afterTab.title) || before.title
          }
        }
      }
    });
  } catch (error) {
    sendNative({
      type: 'execution_result',
      taskId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleListTabs(payload) {
  const taskId = String(payload.taskId || '');
  if (taskId === '') {
    sendNative({
      type: 'execution_result',
      taskId: '',
      ok: false,
      error: 'Missing taskId'
    });
    return;
  }

  try {
    const windows = await chrome.windows.getAll({ populate: true });
    const rows = [];

    for (const win of windows) {
      const winId = win.id ?? null;
      const winTabs = Array.isArray(win.tabs) ? win.tabs : [];
      for (const tab of winTabs) {
        rows.push({
          windowId: winId,
          tabId: tab.id ?? null,
          index: tab.index ?? null,
          active: Boolean(tab.active),
          pinned: Boolean(tab.pinned),
          audible: Boolean(tab.audible),
          discarded: Boolean(tab.discarded),
          title: tab.title || null,
          url: tab.url || null
        });
      }
    }

    sendNative({
      type: 'execution_result',
      taskId,
      ok: true,
      result: {
        value: {
          totalWindows: windows.length,
          totalTabs: rows.length,
          tabs: rows
        }
      }
    });
  } catch (error) {
    sendNative({
      type: 'execution_result',
      taskId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleListFrames(payload) {
  const taskId = String(payload.taskId || '');
  if (taskId === '') {
    sendNative({
      type: 'execution_result',
      taskId: '',
      ok: false,
      error: 'Missing taskId'
    });
    return;
  }

  try {
    const tab = await resolveTargetTab(payload);
    if (tab.id === undefined) throw new Error('Unable to resolve target tab id');

    const target = { tabId: tab.id };
    await debuggerAttach(target);
    try {
      await debuggerSendCommand(target, 'Page.enable', {});
      const tree = await debuggerSendCommand(target, 'Page.getFrameTree', {});
      const frames = flattenFrameTree(tree?.frameTree).map((frame) => ({
        frameId: frame.id,
        parentFrameId: frame.parentId,
        url: frame.url
      }));

      sendNative({
        type: 'execution_result',
        taskId,
        ok: true,
        result: {
          value: {
            targetTabId: tab.id,
            targetTabUrl: tab.url || null,
            totalFrames: frames.length,
            frames
          }
        }
      });
    } finally {
      await debuggerDetach(target).catch(() => undefined);
    }
  } catch (error) {
    sendNative({
      type: 'execution_result',
      taskId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleCloseTab(payload) {
  const taskId = String(payload.taskId || '');
  if (taskId === '') {
    sendNative({
      type: 'execution_result',
      taskId: '',
      ok: false,
      error: 'Missing taskId'
    });
    return;
  }

  const targetTabId =
    payload?.targetTabId == null || payload?.targetTabId === '' ? null : Number(payload.targetTabId);
  if (!Number.isFinite(targetTabId)) {
    sendNative({
      type: 'execution_result',
      taskId,
      ok: false,
      error: 'Missing or invalid targetTabId'
    });
    return;
  }

  try {
    const tab = await chrome.tabs.get(targetTabId);
    if (!tab || tab.id === undefined) throw new Error(`targetTabId not found: ${targetTabId}`);

    const closedTabInfo = {
      tabId: tab.id,
      windowId: tab.windowId ?? null,
      index: tab.index ?? null,
      title: tab.title || null,
      url: tab.url || null
    };

    await chrome.tabs.remove(targetTabId);

    sendNative({
      type: 'execution_result',
      taskId,
      ok: true,
      result: {
        value: {
          closed: true,
          tab: closedTabInfo
        }
      }
    });
  } catch (error) {
    sendNative({
      type: 'execution_result',
      taskId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleCaptureScreenshot(payload) {
  const taskId = String(payload.taskId || '');
  if (taskId === '') {
    sendNative({
      type: 'execution_result',
      taskId: '',
      ok: false,
      error: 'Missing taskId'
    });
    return;
  }

  try {
    const tab = await resolveTargetTab(payload);
    if (tab.id === undefined) throw new Error('Unable to resolve target tab id');

    const format = String(payload?.format || 'png').trim().toLowerCase();
    if (!['png', 'jpeg', 'webp'].includes(format)) {
      throw new Error('Invalid format, expected png|jpeg|webp');
    }

    const rawQuality = payload?.quality == null || payload?.quality === '' ? null : Number(payload.quality);
    if (rawQuality != null && (!Number.isFinite(rawQuality) || rawQuality < 0 || rawQuality > 100)) {
      throw new Error('Invalid quality, expected 0..100');
    }

    const quality = rawQuality == null ? null : Math.round(rawQuality);
    const captureBeyondViewport = payload?.captureBeyondViewport === true;

    const target = { tabId: tab.id };
    await debuggerAttach(target);
    let screenshot;
    try {
      await debuggerSendCommand(target, 'Page.enable', {});
      const params = {
        format,
        fromSurface: true,
        captureBeyondViewport
      };
      if (quality != null && format !== 'png') {
        params.quality = quality;
      }
      screenshot = await debuggerSendCommand(target, 'Page.captureScreenshot', params);
    } finally {
      await debuggerDetach(target).catch(() => undefined);
    }

    if (!screenshot?.data) {
      throw new Error('Page.captureScreenshot returned empty data');
    }

    const afterTab = await chrome.tabs.get(tab.id).catch(() => null);
    sendNative({
      type: 'execution_result',
      taskId,
      ok: true,
      result: {
        value: {
          dataBase64: screenshot.data,
          format,
          mimeType: format === 'jpeg' ? 'image/jpeg' : `image/${format}`,
          targetTabId: tab.id,
          targetTabUrl: (afterTab && afterTab.url) || tab.url || null,
          captureBeyondViewport
        }
      }
    });
  } catch (error) {
    sendNative({
      type: 'execution_result',
      taskId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleChatEvent(message) {
  forwardChatEventToSidePanels(Number(message?.tabId), message);
}

function forwardChatEventToSidePanels(tabId, event) {
  if (!Number.isFinite(tabId)) return;
  const payload = {
    type: 'bridge_chat_event',
    event: {
      ...event,
      tabId
    }
  };
  for (const panelPort of sidePanelPorts) {
    try {
      panelPort.postMessage(payload);
    } catch (error) {
      console.warn('[chrome-bridge] unable to deliver chat event to side panel', error);
    }
  }
}

function handleTabRemoved(tabId) {
  persistentChatContextByTabId.delete(tabId);
  sendNative({
    type: 'chat_close',
    tabId
  });
}

async function evaluateInTabWithDebugger(tabId, expression, options = {}) {
  const target = { tabId };
  await debuggerAttach(target);
  try {
    const targetFrameId = await resolveEvaluationFrameId(target, options);
    const evaluateParams = {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true
    };

    if (targetFrameId) {
      const worldName = `chrome_bridge_world_${Date.now()}`;
      const isolatedWorld = await debuggerSendCommand(target, 'Page.createIsolatedWorld', {
        frameId: targetFrameId,
        worldName
      });
      const contextId = Number(isolatedWorld?.executionContextId);
      if (!Number.isFinite(contextId)) {
        throw new Error(`Unable to resolve execution context for frameId: ${targetFrameId}`);
      }
      evaluateParams.contextId = contextId;
    }

    const evaluation = await debuggerSendCommand(target, 'Runtime.evaluate', evaluateParams);
    return {
      evaluation,
      targetFrameId
    };
  } finally {
    await debuggerDetach(target).catch(() => undefined);
  }
}

async function resolveEvaluationFrameId(target, options) {
  const requestedFrameId = String(options?.frameId || '').trim() || null;
  const frameUrlPattern = String(options?.frameUrlPattern || '').trim().toLowerCase() || null;
  if (!requestedFrameId && !frameUrlPattern) return null;

  await debuggerSendCommand(target, 'Page.enable', {});
  const tree = await debuggerSendCommand(target, 'Page.getFrameTree', {});
  const frames = flattenFrameTree(tree?.frameTree);

  if (requestedFrameId) {
    const existing = frames.find((frame) => frame.id === requestedFrameId);
    if (!existing) {
      throw new Error(`No frame found for frameId: ${requestedFrameId}`);
    }
    return requestedFrameId;
  }

  const matched = frames.find((frame) => String(frame.url || '').toLowerCase().includes(frameUrlPattern));
  if (matched) return matched.id;

  const knownUrls = frames
    .slice(0, 10)
    .map((frame) => frame.url || '(empty url)')
    .join(', ');
  throw new Error(`No frame matches frameUrlPattern: ${frameUrlPattern}. Known frame URLs: ${knownUrls}`);
}

function flattenFrameTree(frameTree, out = []) {
  if (!frameTree || typeof frameTree !== 'object') return out;
  const frame = frameTree.frame;
  if (frame && typeof frame === 'object') {
    out.push({
      id: String(frame.id || ''),
      parentId: frame.parentId == null ? null : String(frame.parentId),
      url: String(frame.url || '')
    });
  }
  const children = Array.isArray(frameTree.childFrames) ? frameTree.childFrames : [];
  for (const child of children) flattenFrameTree(child, out);
  return out;
}

function debuggerAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message || 'debugger.attach failed'));
        return;
      }
      resolve();
    });
  });
}

function debuggerSendCommand(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message || `${method} failed`));
        return;
      }
      resolve(result);
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message || 'debugger.detach failed'));
        return;
      }
      resolve();
    });
  });
}

async function resolveTargetTab(payload) {
  const targetTabId = payload?.targetTabId == null || payload?.targetTabId === '' ? null : Number(payload.targetTabId);

  if (Number.isFinite(targetTabId)) {
    const tab = await chrome.tabs.get(targetTabId);
    if (!tab || tab.id === undefined) throw new Error(`targetTabId not found: ${targetTabId}`);
    return tab;
  }

  const targetUrlPattern = String(payload?.targetUrlPattern || '').trim().toLowerCase();
  if (targetUrlPattern !== '') {
    const tabs = await chrome.tabs.query({});
    const matched = tabs.find((tab) => String(tab.url || '').toLowerCase().includes(targetUrlPattern));
    if (!matched || matched.id === undefined) throw new Error(`No tab matches targetUrlPattern: ${targetUrlPattern}`);
    return matched;
  }

  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeTab = activeTabs[0];
  if (!activeTab || activeTab.id === undefined) throw new Error('No active tab found');
  return activeTab;
}

function sendNative(message) {
  if (nativePort === null) return;
  try {
    nativePort.postMessage(message);
  } catch (error) {
    console.error('[chrome-bridge] postMessage failed', error);
  }
}

function normalizeBridgeConfig(rawConfig) {
  const mode = String(rawConfig?.mode || '').trim().toLowerCase() === 'ipc' ? 'ipc' : 'http';
  const legacyHost = String(rawConfig?.host || '').trim();
  const legacyPort = Number(rawConfig?.port);
  const legacyHostPort =
    legacyHost !== '' && Number.isInteger(legacyPort) && legacyPort >= 1 && legacyPort <= 65535
      ? `${legacyHost}:${legacyPort}`
      : '';
  const hostPort = normalizeHostPort(String(rawConfig?.hostPort || '').trim() || legacyHostPort);
  const socketPath = String(rawConfig?.socketPath || '').trim();
  const token = String(rawConfig?.token || '').trim();

  if (mode === 'http') {
    if (!hostPort) throw new Error('hostPort is required for HTTP mode');
  } else if (socketPath === '') {
    throw new Error('socketPath is required for IPC mode');
  }
  if (token === '') throw new Error('Token is required');

  return { mode, hostPort: hostPort || null, socketPath, token };
}

function normalizeHostPort(value) {
  const raw = String(value || '').trim();
  if (raw === '') return null;
  const sep = raw.lastIndexOf(':');
  if (sep <= 0 || sep >= raw.length - 1) return null;
  const host = raw.slice(0, sep).trim();
  const port = Number(raw.slice(sep + 1).trim());
  if (host === '') return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${host}:${port}`;
}

function requestNativeConfig(type, payload = {}) {
  connectNativeHost();
  if (nativePort === null) throw new Error('Native host is not connected');

  const taskId = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const message = { type, taskId, ...payload };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingNativeRequestsByTaskId.delete(taskId);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 5000);

    pendingNativeRequestsByTaskId.set(taskId, { resolve, reject, timeout });
    sendNative(message);
  });
}

function resolvePendingNativeRequest(message) {
  const taskId = String(message?.taskId || '');
  if (taskId === '') return;

  const pending = pendingNativeRequestsByTaskId.get(taskId);
  if (!pending) return;

  pendingNativeRequestsByTaskId.delete(taskId);
  clearTimeout(pending.timeout);

  if (message.ok !== true) {
    pending.reject(new Error(String(message.error || 'Native request failed')));
    return;
  }

  pending.resolve({
    config: message.config || null,
    note: message.note || null,
    restartRequired: message.restartRequired === true
  });
}

function scheduleNativeHostRestart() {
  const current = nativePort;
  if (!current) {
    connectNativeHost();
    return;
  }

  setTimeout(() => {
    try {
      current.disconnect();
    } catch (_error) {
      // Ignore disconnect race.
    }
    nativePort = null;
    setTimeout(connectNativeHost, 250);
  }, 50);
}

function resolveAgentId(rawAgentId) {
  const cleaned = String(rawAgentId || '').trim();
  if (cleaned !== '') return cleaned;
  if (DEFAULT_AGENT_ID !== '') return DEFAULT_AGENT_ID;
  throw new Error('No selected agent id');
}

function resolveAgentSelection(message) {
  const agentId = resolveAgentId(message?.agentId);
  const agentSpec = parseAgentSpec(message?.agentSpec);
  return { agentId, agentSpec };
}

function parseAgentSpec(rawSpec) {
  if (!rawSpec || typeof rawSpec !== 'object') {
    throw new Error('Missing agent spec');
  }
  const command = String(rawSpec.command || '').trim();
  if (command === '') throw new Error('Agent command is empty');
  const args = Array.isArray(rawSpec.args) ? rawSpec.args.map((item) => String(item)) : [];
  const adapterRaw = String(rawSpec.adapter || '').trim();
  const adapter = ADAPTER_MAP[adapterRaw] || null;
  if (!adapter) {
    throw new Error(`Unsupported adapter: ${adapterRaw}`);
  }
  return { command, args, adapter };
}

function hasPersistPrefix(persistContext) {
  return String(persistContext?.prefix || '').trim() !== '';
}
