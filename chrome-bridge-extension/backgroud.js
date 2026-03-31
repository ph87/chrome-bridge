const NATIVE_HOST_NAME = 'com.argentum.chrome_bridge';
const SIDEBAR_SCRIPT_FILE = 'sidebar.js';
importScripts('runtime-config.js', 'commands/index.js');

const runtimeConfig = globalThis.ChromeBridgeRuntimeConfig || {};
const DEFAULT_AGENT_ID = String(runtimeConfig.defaultAgentId || '').trim();
const AUTO_CONTEXT_ENABLED = runtimeConfig.autoContextEnabled !== false;

let nativePort = null;
let reconnectTimer = null;
const persistentChatContextByTabId = new Map();

connectNativeHost();
chrome.runtime.onStartup.addListener(connectNativeHost);
chrome.runtime.onInstalled.addListener(connectNativeHost);
chrome.action.onClicked.addListener(handleActionClick);
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
  const tabId = tab?.id;
  if (tabId == null) return;

  try {
    await ensureSidebarScriptInjected(tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'bridge_toggle_sidebar' });
  } catch (error) {
    console.warn('[chrome-bridge] failed to toggle sidebar', error);
  }
}

async function ensureSidebarScriptInjected(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'bridge_sidebar_ping' });
    if (pong?.ok) return;
  } catch (_error) {
    // Content script is not present yet.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [SIDEBAR_SCRIPT_FILE]
  });
}

async function handleRuntimeMessage(message, sender) {
  const invalidMessage =
    message === null ||
    message === undefined ||
    typeof message !== 'object';
  if (invalidMessage) {
    throw new Error('Invalid extension message');
  }

  if (message.type === 'bridge_chat_send') {
    const tabId = sender?.tab?.id;
    if (tabId == null) throw new Error('Unable to resolve sender tab');

    const text = String(message.text || '').trim();
    if (text === '') throw new Error('Message text is empty');

    const parsedCommand = globalThis.ChromeBridgeCommands.parse(text);
    if (parsedCommand !== null) {
      const agentId = resolveAgentId(message.agentId);
      const commandResult = await globalThis.ChromeBridgeCommands.handle(parsedCommand, {
        tab: {
          id: tabId,
          url: String(sender?.tab?.url || ''),
          title: String(sender?.tab?.title || '')
        },
        agentId,
        sendToNative: sendNative,
        forwardEvent: (event) => forwardChatEventToTab(tabId, event)
      });
      if (hasPersistPrefix(commandResult?.persistContext)) {
        persistentChatContextByTabId.set(tabId, {
          ...commandResult.persistContext,
          prefix: String(commandResult.persistContext.prefix || '').trim()
        });
      }
      return { accepted: commandResult.accepted, command: parsedCommand.name };
    }

    const agentId = resolveAgentId(message.agentId);
    let persistentCtx = persistentChatContextByTabId.get(tabId);
    if (!persistentCtx && AUTO_CONTEXT_ENABLED) {
      const autoCtx = globalThis.ChromeBridgeCommands.getAutoPersistContext({
        tab: {
          id: tabId,
          url: String(sender?.tab?.url || ''),
          title: String(sender?.tab?.title || '')
        },
        agentId,
        sendToNative: sendNative,
        forwardEvent: (event) => forwardChatEventToTab(tabId, event)
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
      text: textWithContext
    });
    return { accepted: true };
  }

  if (message.type === 'bridge_chat_close') {
    const tabId = sender?.tab?.id;
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
    const invalidMessage =
      message === null ||
      message === undefined ||
      typeof message !== 'object';
    if (invalidMessage) return;

    if (message.type === 'execute_js') {
      await handleExecute(message);
      return;
    }

    if (message.type === 'list_tabs') {
      await handleListTabs(message);
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

  try {
    const tab = await resolveTargetTab(payload);
    const before = { url: tab.url || null, title: tab.title || null };
    const evalResult = await evaluateInTabWithDebugger(tab.id, code);
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

async function handleChatEvent(message) {
  const tabId = Number(message?.tabId);
  if (!Number.isFinite(tabId)) return;

  try {
    await ensureSidebarScriptInjected(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: 'bridge_chat_event',
      event: message
    });
  } catch (error) {
    console.warn('[chrome-bridge] unable to forward chat event', error);
  }
}

async function forwardChatEventToTab(tabId, event) {
  try {
    await ensureSidebarScriptInjected(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: 'bridge_chat_event',
      event
    });
  } catch (error) {
    console.warn('[chrome-bridge] unable to deliver local chat command event', error);
  }
}

async function evaluateInTabWithDebugger(tabId, expression) {
  const target = { tabId };
  await debuggerAttach(target);
  try {
    return await debuggerSendCommand(target, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true
    });
  } finally {
    await debuggerDetach(target).catch(() => undefined);
  }
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
  const targetTabId =
    payload?.targetTabId == null || payload?.targetTabId === ''
      ? null
      : Number(payload.targetTabId);

  if (Number.isFinite(targetTabId)) {
    const tab = await chrome.tabs.get(targetTabId);
    const invalidTab = tab === null || tab === undefined || tab.id === undefined;
    if (invalidTab) {
      throw new Error(`targetTabId not found: ${targetTabId}`);
    }
    return tab;
  }

  const targetUrlPattern = String(payload?.targetUrlPattern || '').trim().toLowerCase();
  if (targetUrlPattern !== '') {
    const tabs = await chrome.tabs.query({});
    const matched = tabs.find((tab) => String(tab.url || '').toLowerCase().includes(targetUrlPattern));
    const noMatch = matched === null || matched === undefined || matched.id === undefined;
    if (noMatch) {
      throw new Error(`No tab matches targetUrlPattern: ${targetUrlPattern}`);
    }
    return matched;
  }

  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeTab = activeTabs[0];
  const noActive = activeTab === null || activeTab === undefined || activeTab.id === undefined;
  if (noActive) {
    throw new Error('No active tab found');
  }
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

function resolveAgentId(rawAgentId) {
  const cleaned = String(rawAgentId || '').trim();
  if (cleaned !== '') return cleaned;
  if (DEFAULT_AGENT_ID !== '') return DEFAULT_AGENT_ID;
  throw new Error('No agentId provided and no runtime defaultAgentId configured');
}

function hasPersistPrefix(persistContext) {
  return String(persistContext?.prefix || '').trim() !== '';
}
