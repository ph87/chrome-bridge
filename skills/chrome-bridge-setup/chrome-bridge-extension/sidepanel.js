(() => {
  const SETTINGS_KEY = 'chromeBridgeChatSettings';
  const DEFAULT_AGENT_ID = 'echo';
  const BUILTIN_AGENT_CONFIGS = Object.freeze([
    Object.freeze({
      id: DEFAULT_AGENT_ID,
      name: 'Echo',
      command: '/bin/sh',
      args: ['-lc', '/bin/bash "$CHROME_BRIDGE_PROJECT_ROOT/native-host/echo-agent.sh"'],
      adapter: 'stdioAdapter'
    })
  ]);
  const ADAPTER_OPTIONS = Object.freeze([
    { value: 'acpRpcAdapter', label: 'acpRpcAdapter' },
    { value: 'stdioAdapter', label: 'stdioAdapter' }
  ]);
  const MIN_TEXTAREA_HEIGHT = 88;
  const MAX_TEXTAREA_HEIGHT = 220;

  let port = null;
  let chatListEl = null;
  let textareaEl = null;
  let textareaResizeBarEl = null;
  let chatViewEl = null;
  let settingsViewEl = null;
  let activeAgentStatusEl = null;
  let activeTabIdEl = null;
  let tabMetaEl = null;
  let viewToggleBtnEl = null;
  let resetChatBtnEl = null;
  let agentListEl = null;
  let editorWrapEl = null;
  let agentNameInputEl = null;
  let agentCommandInputEl = null;
  let agentArgsInputEl = null;
  let agentAdapterSelectEl = null;
  let bridgeModeSelectEl = null;
  let bridgeHostPortRowEl = null;
  let bridgeHostPortInputEl = null;
  let bridgeSocketPathRowEl = null;
  let bridgeSocketPathInputEl = null;
  let bridgeTokenInputEl = null;
  let bridgeTokenRefreshBtnEl = null;
  let settingsStatusEl = null;

  let activeAgentId = DEFAULT_AGENT_ID;
  let editingAgentId = null;
  let activeTabId = null;
  let activeTabMeta = { title: '', url: '' };
  let bridgeConfig = {
    mode: 'http',
    hostPort: '127.0.0.1:3456',
    socketPath: '',
    token: ''
  };
  let agentConfigs = BUILTIN_AGENT_CONFIGS.map((config) => cloneAgentConfig(config));
  const conversationsByTabId = new Map();
  const assistantStreamsByTabId = new Map();

  if (!hasRuntimeContext()) return;

  document.addEventListener('DOMContentLoaded', () => {
    bindElements();
    bindEvents();
    populateAdapterOptions();
    connectPort();
    void initialize();
  });

  function bindElements() {
    chatListEl = document.getElementById('cb-chat-list');
    textareaEl = document.getElementById('cb-textarea');
    textareaResizeBarEl = document.getElementById('cb-textarea-resize-bar');
    chatViewEl = document.getElementById('cb-chat-view');
    settingsViewEl = document.getElementById('cb-settings-view');
    activeAgentStatusEl = document.getElementById('cb-active-agent-status');
    activeTabIdEl = document.getElementById('cb-active-tab-id');
    tabMetaEl = document.getElementById('cb-tab-meta');
    viewToggleBtnEl = document.getElementById('cb-view-toggle-btn');
    resetChatBtnEl = document.getElementById('cb-reset-chat-btn');
    agentListEl = document.getElementById('cb-agent-list');
    editorWrapEl = document.getElementById('cb-editor');
    agentNameInputEl = document.getElementById('cb-agent-name');
    agentCommandInputEl = document.getElementById('cb-agent-command');
    agentArgsInputEl = document.getElementById('cb-agent-args');
    agentAdapterSelectEl = document.getElementById('cb-agent-adapter');
    bridgeModeSelectEl = document.getElementById('cb-bridge-mode');
    bridgeHostPortRowEl = document.getElementById('cb-bridge-host-port-row');
    bridgeHostPortInputEl = document.getElementById('cb-bridge-host-port');
    bridgeSocketPathRowEl = document.getElementById('cb-bridge-socket-path-row');
    bridgeSocketPathInputEl = document.getElementById('cb-bridge-socket-path');
    bridgeTokenInputEl = document.getElementById('cb-bridge-token');
    bridgeTokenRefreshBtnEl = document.getElementById('cb-bridge-token-refresh');
    settingsStatusEl = document.getElementById('cb-settings-status');
  }

  function bindEvents() {
    viewToggleBtnEl?.addEventListener('click', () => {
      if (isSettingsVisible()) {
        showChat();
        return;
      }
      showSettings();
      void refreshBridgeConfigFromHost();
    });
    resetChatBtnEl?.addEventListener('click', () => {
      void handleResetCurrentTabChat();
    });
    textareaEl?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      void submitMessage();
    });
    setupTextareaResize();

    bridgeModeSelectEl?.addEventListener('change', () => {
      updateBridgeTransportVisibility();
      void handleBridgeConfigSave();
    });
    bridgeHostPortInputEl?.addEventListener('change', () => {
      void handleBridgeConfigSave();
    });
    bridgeHostPortInputEl?.addEventListener('blur', () => {
      void handleBridgeConfigSave();
    });
    bridgeTokenRefreshBtnEl?.addEventListener('click', () => {
      void handleRefreshBridgeToken();
    });

    document.getElementById('cb-agent-new-btn')?.addEventListener('click', beginCreateAgentConfig);
    document.getElementById('cb-agent-save-btn')?.addEventListener('click', () => {
      void handleSaveAgentConfig();
    });
    document.getElementById('cb-agent-cancel-btn')?.addEventListener('click', hideAgentEditor);

    chrome.tabs.onActivated.addListener(() => {
      void refreshActiveTab();
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (activeTabId == null || tabId !== activeTabId) return;
      if (!changeInfo.title && !changeInfo.url && changeInfo.status !== 'complete') return;
      void refreshActiveTab();
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      conversationsByTabId.delete(tabId);
      assistantStreamsByTabId.delete(tabId);
      if (tabId === activeTabId) {
        activeTabId = null;
        activeTabMeta = { title: '', url: '' };
        renderActiveTabMeta();
        renderConversation();
        updateComposerState();
        void refreshActiveTab();
      }
    });
    chrome.windows.onFocusChanged.addListener(() => {
      void refreshActiveTab();
    });
  }

  async function initialize() {
    await loadSettings();
    await refreshActiveTab();
    setTextareaHeight(MIN_TEXTAREA_HEIGHT);
    showChat();
    focusTextarea();
  }

  function setupTextareaResize() {
    if (!textareaEl || !textareaResizeBarEl) return;

    let resizing = false;
    let startY = 0;
    let startHeight = 0;

    const stopResizing = () => {
      if (!resizing) return;
      resizing = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopResizing);
    };

    const onPointerMove = (event) => {
      if (!resizing) return;
      const delta = startY - event.clientY;
      setTextareaHeight(startHeight + delta);
    };

    textareaResizeBarEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      resizing = true;
      startY = event.clientY;
      startHeight = textareaEl.offsetHeight || MIN_TEXTAREA_HEIGHT;
      textareaResizeBarEl.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', stopResizing);
    });
  }

  function setTextareaHeight(value) {
    if (!textareaEl) return;
    const nextHeight = clamp(Number(value) || MIN_TEXTAREA_HEIGHT, MIN_TEXTAREA_HEIGHT, MAX_TEXTAREA_HEIGHT);
    textareaEl.style.height = `${nextHeight}px`;
  }

  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: 'sidepanel' });
    } catch (_error) {
      port = null;
      return;
    }

    port.onMessage.addListener((message) => {
      if (message?.type === 'bridge_chat_event') {
        handleChatEvent(message.event || {});
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      window.setTimeout(connectPort, 1000);
    });
  }

  function populateAdapterOptions() {
    if (!agentAdapterSelectEl) return;
    agentAdapterSelectEl.innerHTML = '';
    for (const option of ADAPTER_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      agentAdapterSelectEl.appendChild(opt);
    }
  }

  async function refreshActiveTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = Array.isArray(tabs) ? tabs[0] : null;
      activeTabId = tab?.id ?? null;
      activeTabMeta = {
        title: String(tab?.title || '').trim(),
        url: String(tab?.url || '').trim()
      };
    } catch (_error) {
      activeTabId = null;
      activeTabMeta = { title: '', url: '' };
    }

    renderActiveTabMeta();
    renderConversation();
    updateComposerState();
  }

  function renderActiveTabMeta() {
    if (activeTabIdEl) {
      activeTabIdEl.textContent = activeTabId == null ? 'Tab: -' : `Tab: ${activeTabId}`;
    }
    if (tabMetaEl) {
      const label = activeTabMeta.title || activeTabMeta.url || 'No active tab available in this window.';
      tabMetaEl.textContent = label;
      tabMetaEl.title = activeTabMeta.url || activeTabMeta.title || '';
    }
    if (activeAgentStatusEl) {
      activeAgentStatusEl.textContent = buildActiveAgentStatusText();
    }
  }

  function updateComposerState() {
    const disabled = activeTabId == null;
    if (textareaEl) textareaEl.disabled = disabled;
    if (resetChatBtnEl) resetChatBtnEl.disabled = disabled;
    if (disabled && textareaEl) {
      textareaEl.placeholder = 'Open a normal browser tab to chat through Chrome Bridge.';
    } else if (textareaEl) {
      textareaEl.placeholder = 'Ask the selected agent...';
    }
  }

  function showChat() {
    chatViewEl?.classList.add('cb-view-active');
    settingsViewEl?.classList.remove('cb-view-active');
    syncViewToggleButton();
    focusTextarea();
  }

  function showSettings() {
    settingsViewEl?.classList.add('cb-view-active');
    chatViewEl?.classList.remove('cb-view-active');
    syncViewToggleButton();
  }

  function isSettingsVisible() {
    return Boolean(settingsViewEl?.classList.contains('cb-view-active'));
  }

  function syncViewToggleButton() {
    if (!viewToggleBtnEl) return;
    if (isSettingsVisible()) {
      viewToggleBtnEl.textContent = '💬';
      viewToggleBtnEl.title = 'Open chat';
      viewToggleBtnEl.setAttribute('aria-label', 'Open chat');
      return;
    }
    viewToggleBtnEl.textContent = '⚙';
    viewToggleBtnEl.title = 'Open settings';
    viewToggleBtnEl.setAttribute('aria-label', 'Open settings');
  }

  async function submitMessage() {
    if (!textareaEl || activeTabId == null) return;
    const text = String(textareaEl.value || '').trim();
    if (text === '') return;

    const activeAgent = getActiveAgentConfig();
    if (!activeAgent) {
      appendMessage(activeTabId, 'system', 'Error: No active agent config');
      return;
    }

    appendMessage(activeTabId, 'user', text);
    textareaEl.value = '';

    try {
      const response = await safeSendRuntimeMessage({
        type: 'bridge_chat_send',
        tabId: activeTabId,
        text,
        agentId: activeAgent.id,
        agentSpec: toRuntimeAgentSpec(activeAgent)
      });
      if (!response?.ok) {
        throw new Error(response?.error || 'Failed to send message');
      }
    } catch (error) {
      appendMessage(activeTabId, 'system', `Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      focusTextarea();
    }
  }

  async function handleResetCurrentTabChat() {
    if (activeTabId == null) return;
    const confirmed = window.confirm('Reset chat context and conversation for the current tab?');
    if (!confirmed) return;

    conversationsByTabId.delete(activeTabId);
    assistantStreamsByTabId.delete(activeTabId);
    renderConversation();
    await safeSendRuntimeMessage({ type: 'bridge_chat_close', tabId: activeTabId });
  }

  function handleChatEvent(event) {
    const tabId = Number(event?.tabId);
    if (!Number.isFinite(tabId)) return;

    if (event.kind === 'assistant_delta') {
      appendAssistantDelta(tabId, String(event.sessionId || ''), String(event.text || ''));
      return;
    }

    if (event.kind === 'assistant_message') {
      const sessionId = String(event.sessionId || '');
      const text = String(event.text || '');
      if (!finalizeAssistantDelta(tabId, sessionId, text)) {
        appendMessage(tabId, 'assistant', text);
      }
      return;
    }

    if (event.kind === 'error') {
      appendMessage(tabId, 'system', `Error: ${String(event.text || 'Unknown error')}`);
      return;
    }

    if (event.kind === 'status') {
      appendMessage(tabId, 'system', String(event.text || 'Status update'));
    }
  }

  function getConversation(tabId) {
    let convo = conversationsByTabId.get(tabId);
    if (!convo) {
      convo = [];
      conversationsByTabId.set(tabId, convo);
    }
    return convo;
  }

  function renderConversation() {
    if (!chatListEl) return;
    chatListEl.innerHTML = '';

    if (activeTabId == null) {
      const empty = document.createElement('div');
      empty.className = 'cb-empty';
      empty.textContent = 'No active browser tab.';
      chatListEl.appendChild(empty);
      return;
    }

    const convo = getConversation(activeTabId);
    if (convo.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cb-empty';
      empty.textContent = 'No messages for this tab yet.';
      chatListEl.appendChild(empty);
      return;
    }

    for (const message of convo) {
      chatListEl.appendChild(createMessageElement(message.kind, message.text));
    }
    chatListEl.scrollTop = chatListEl.scrollHeight;
  }

  function createMessageElement(kind, text) {
    const item = document.createElement('div');
    item.className = 'cb-msg';
    if (kind === 'user') item.classList.add('cb-msg-user');
    else if (kind === 'assistant') item.classList.add('cb-msg-assistant');
    else item.classList.add('cb-msg-system');
    item.textContent = String(text || '').trim();
    return item;
  }

  function appendMessage(tabId, kind, text) {
    const cleaned = String(text || '').trim();
    if (cleaned === '') return;
    const convo = getConversation(tabId);
    convo.push({ kind, text: cleaned });
    if (tabId === activeTabId) renderConversation();
  }

  function appendAssistantDelta(tabId, sessionId, text) {
    const delta = String(text || '');
    if (delta === '') return;

    const convo = getConversation(tabId);
    let streams = assistantStreamsByTabId.get(tabId);
    if (!streams) {
      streams = new Map();
      assistantStreamsByTabId.set(tabId, streams);
    }

    let stream = sessionId !== '' ? streams.get(sessionId) : null;
    if (!stream) {
      stream = { index: convo.length, text: '' };
      convo.push({ kind: 'assistant', text: '' });
      if (sessionId !== '') streams.set(sessionId, stream);
    }

    stream.text += delta;
    convo[stream.index] = { kind: 'assistant', text: stream.text };
    if (tabId === activeTabId) renderConversation();
  }

  function finalizeAssistantDelta(tabId, sessionId, finalText) {
    if (sessionId === '') return false;
    const streams = assistantStreamsByTabId.get(tabId);
    const stream = streams?.get(sessionId);
    if (!stream) return false;

    const convo = getConversation(tabId);
    const cleanedFinal = String(finalText || '').trim();
    convo[stream.index] = { kind: 'assistant', text: cleanedFinal || stream.text };
    streams.delete(sessionId);
    if (streams.size === 0) assistantStreamsByTabId.delete(tabId);
    if (tabId === activeTabId) renderConversation();
    return true;
  }

  function getActiveAgentConfig() {
    return agentConfigs.find((config) => config.id === activeAgentId) || agentConfigs[0] || null;
  }

  function buildActiveAgentStatusText() {
    const active = getActiveAgentConfig();
    if (!active) return 'Agent: -';
    return `Agent: ${active.name || active.id}`;
  }

  function renderAgentList() {
    if (!agentListEl) return;
    agentListEl.innerHTML = '';
    if (!agentConfigs.some((item) => item.id === activeAgentId)) {
      activeAgentId = agentConfigs[0]?.id || DEFAULT_AGENT_ID;
    }

    for (const config of agentConfigs) {
      const row = document.createElement('div');
      row.className = 'cb-agent-item';

      const left = document.createElement('div');
      left.className = 'cb-agent-item-left';
      const name = document.createElement('span');
      name.className = 'cb-agent-name';
      const marker = config.id === activeAgentId ? ' [active]' : '';
      name.textContent = `${config.name || config.id}${marker}`;
      left.appendChild(name);

      const actionWrap = document.createElement('div');
      actionWrap.className = 'cb-agent-actions';

      const activateBtn = document.createElement('button');
      activateBtn.className = 'cb-btn';
      activateBtn.type = 'button';
      const isActive = config.id === activeAgentId;
      activateBtn.textContent = isActive ? 'Active' : 'Activate';
      if (isActive) activateBtn.classList.add('cb-btn-active');
      activateBtn.addEventListener('click', () => {
        if (isActive) return;
        activeAgentId = config.id;
        renderAgentList();
        renderActiveTabMeta();
        setSettingsStatus(`Activated: ${config.name || config.id}`);
        void saveSettings();
      });

      const editBtn = document.createElement('button');
      editBtn.className = 'cb-btn';
      editBtn.type = 'button';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        editingAgentId = config.id;
        populateAgentEditor(config.id);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'cb-btn cb-btn-danger';
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => {
        void handleDeleteAgentConfig(config.id);
      });

      actionWrap.appendChild(activateBtn);
      actionWrap.appendChild(editBtn);
      actionWrap.appendChild(deleteBtn);

      row.appendChild(left);
      row.appendChild(actionWrap);
      agentListEl.appendChild(row);
    }
  }

  function populateAgentEditor(agentId) {
    const config = agentConfigs.find((item) => item.id === agentId) || null;
    if (!config) {
      hideAgentEditor();
      return;
    }
    setAgentEditorVisible(true);
    editingAgentId = config.id;
    if (agentNameInputEl) agentNameInputEl.value = config.name || config.id;
    if (agentCommandInputEl) agentCommandInputEl.value = config.command || '';
    if (agentArgsInputEl) agentArgsInputEl.value = (config.args || []).join('\n');
    if (agentAdapterSelectEl) agentAdapterSelectEl.value = normalizeAdapterLabel(config.adapter);
    setSettingsStatus(`Editing: ${config.name || config.id}`);
  }

  function beginCreateAgentConfig() {
    setAgentEditorVisible(true);
    editingAgentId = null;
    if (agentNameInputEl) agentNameInputEl.value = '';
    if (agentCommandInputEl) agentCommandInputEl.value = '';
    if (agentArgsInputEl) agentArgsInputEl.value = '';
    if (agentAdapterSelectEl) agentAdapterSelectEl.value = ADAPTER_OPTIONS[0].value;
    setSettingsStatus('Creating new agent config');
  }

  function hideAgentEditor() {
    editingAgentId = null;
    if (agentNameInputEl) agentNameInputEl.value = '';
    if (agentCommandInputEl) agentCommandInputEl.value = '';
    if (agentArgsInputEl) agentArgsInputEl.value = '';
    if (agentAdapterSelectEl) agentAdapterSelectEl.value = ADAPTER_OPTIONS[0].value;
    setSettingsStatus('');
    setAgentEditorVisible(false);
  }

  function setAgentEditorVisible(visible) {
    if (!editorWrapEl) return;
    editorWrapEl.style.display = visible ? 'flex' : 'none';
  }

  async function handleSaveAgentConfig() {
    const draft = readAgentEditorDraft();
    if (!draft.ok) {
      setSettingsStatus(draft.error);
      return;
    }

    const spec = draft.value;
    if (editingAgentId) {
      const idx = agentConfigs.findIndex((item) => item.id === editingAgentId);
      if (idx !== -1) {
        const id = editingAgentId;
        agentConfigs[idx] = { ...spec, id };
        editingAgentId = id;
      } else {
        const id = makeUniqueAgentId(spec.name);
        agentConfigs.push({ ...spec, id });
        editingAgentId = id;
      }
    } else {
      const id = makeUniqueAgentId(spec.name);
      agentConfigs.push({ ...spec, id });
      editingAgentId = id;
    }

    if (!agentConfigs.some((item) => item.id === activeAgentId)) {
      activeAgentId = agentConfigs[0]?.id || DEFAULT_AGENT_ID;
    }
    renderAgentList();
    hideAgentEditor();
    renderActiveTabMeta();
    await saveSettings();
  }

  async function handleDeleteAgentConfig(targetId) {
    const idToDelete = String(targetId || editingAgentId || '').trim();
    if (idToDelete === '') {
      setSettingsStatus('No selected config to delete');
      return;
    }
    if (agentConfigs.length <= 1) {
      setSettingsStatus('At least one agent config is required');
      return;
    }
    const idx = agentConfigs.findIndex((item) => item.id === idToDelete);
    if (idx === -1) {
      setSettingsStatus('Selected config not found');
      return;
    }

    const removed = agentConfigs[idx];
    agentConfigs.splice(idx, 1);
    if (activeAgentId === removed.id) {
      activeAgentId = agentConfigs[0]?.id || DEFAULT_AGENT_ID;
    }

    renderAgentList();
    hideAgentEditor();
    renderActiveTabMeta();
    await saveSettings();
  }

  function readAgentEditorDraft() {
    const name = String(agentNameInputEl?.value || '').trim();
    const command = String(agentCommandInputEl?.value || '').trim();
    const args = String(agentArgsInputEl?.value || '')
      .split('\n')
      .map((item) => item.trim())
      .filter((item) => item !== '');
    const adapter = normalizeAdapterLabel(agentAdapterSelectEl?.value);

    if (name === '') return { ok: false, error: 'Name is required' };
    if (command === '') return { ok: false, error: 'Command is required' };
    if (!isSupportedAdapterLabel(adapter)) return { ok: false, error: 'Unsupported adapter' };

    return {
      ok: true,
      value: { name, command, args, adapter }
    };
  }

  function setSettingsStatus(text) {
    if (!settingsStatusEl) return;
    settingsStatusEl.textContent = String(text || '').trim();
  }

  function normalizeBridgeConfig(rawConfig) {
    const mode = normalizeBridgeMode(rawConfig?.mode);
    const hostRaw = String(rawConfig?.host || '').trim();
    const portRaw = Number(rawConfig?.port);
    const legacyHostPort =
      hostRaw !== '' && Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535
        ? `${hostRaw}:${portRaw}`
        : '';
    const rawHostPort = String(rawConfig?.hostPort || '').trim() || legacyHostPort;
    const hostPort = normalizeBridgeHostPort(rawHostPort) || '127.0.0.1:3456';
    const socketPath = String(rawConfig?.socketPath || '').trim();
    const token = String(rawConfig?.token || '').trim();
    return { mode, hostPort, socketPath, token };
  }

  function renderBridgeConfigInputs() {
    if (bridgeModeSelectEl) bridgeModeSelectEl.value = bridgeConfig.mode;
    if (bridgeHostPortInputEl) bridgeHostPortInputEl.value = bridgeConfig.hostPort;
    if (bridgeSocketPathInputEl) bridgeSocketPathInputEl.value = bridgeConfig.socketPath;
    if (bridgeTokenInputEl) bridgeTokenInputEl.value = bridgeConfig.token;
    updateBridgeTransportVisibility();
  }

  function readBridgeConfigDraft() {
    const mode = normalizeBridgeMode(bridgeModeSelectEl?.value || bridgeConfig.mode);
    const hostPortInput = String(bridgeHostPortInputEl?.value || '').trim();
    const hostPort = normalizeBridgeHostPort(hostPortInput);
    const socketPath = String(bridgeConfig.socketPath || '').trim();
    if (mode === 'http' && !hostPort) {
      return { ok: false, error: 'Host:Port must look like host:port (port 1..65535)' };
    }
    if (mode === 'ipc' && socketPath === '') {
      return { ok: false, error: 'Socket path is missing' };
    }
    if (bridgeConfig.token.trim() === '') {
      return { ok: false, error: 'Token is missing. Refresh token first.' };
    }
    return {
      ok: true,
      value: {
        mode,
        hostPort: hostPort || bridgeConfig.hostPort,
        socketPath,
        token: bridgeConfig.token
      }
    };
  }

  function normalizeBridgeMode(value) {
    return String(value || '').trim().toLowerCase() === 'ipc' ? 'ipc' : 'http';
  }

  function normalizeBridgeHostPort(value) {
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

  function updateBridgeTransportVisibility() {
    const mode = normalizeBridgeMode(bridgeModeSelectEl?.value || bridgeConfig.mode);
    if (bridgeHostPortRowEl) bridgeHostPortRowEl.style.display = mode === 'http' ? 'flex' : 'none';
    if (bridgeSocketPathRowEl) bridgeSocketPathRowEl.style.display = mode === 'ipc' ? 'flex' : 'none';
  }

  async function refreshBridgeConfigFromHost() {
    const response = await safeSendRuntimeMessage({ type: 'bridge_config_get' });
    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to read bridge config');
    }
    bridgeConfig = normalizeBridgeConfig(response.config);
    renderBridgeConfigInputs();
    return bridgeConfig;
  }

  async function handleBridgeConfigSave() {
    const draft = readBridgeConfigDraft();
    if (!draft.ok) {
      setSettingsStatus(draft.error);
      renderBridgeConfigInputs();
      return;
    }
    const response = await safeSendRuntimeMessage({
      type: 'bridge_config_set',
      config: draft.value
    });
    if (!response?.ok) {
      setSettingsStatus(response?.error || 'Failed to update bridge config');
      renderBridgeConfigInputs();
      return;
    }
    bridgeConfig = normalizeBridgeConfig(response.config);
    renderBridgeConfigInputs();
    const note = String(response.note || '').trim();
    setSettingsStatus(note || 'Bridge config saved');
  }

  async function handleRefreshBridgeToken() {
    if (bridgeTokenRefreshBtnEl) bridgeTokenRefreshBtnEl.disabled = true;
    try {
      const response = await safeSendRuntimeMessage({ type: 'bridge_config_refresh_token' });
      if (!response?.ok) {
        setSettingsStatus(response?.error || 'Failed to refresh token');
        return;
      }
      bridgeConfig = normalizeBridgeConfig(response.config);
      renderBridgeConfigInputs();
      setSettingsStatus('Token refreshed');
    } finally {
      if (bridgeTokenRefreshBtnEl) bridgeTokenRefreshBtnEl.disabled = false;
    }
  }

  function makeUniqueAgentId(name) {
    const base = slugifyName(name) || 'agent';
    let next = base;
    let index = 2;
    while (agentConfigs.some((item) => item.id === next)) {
      next = `${base}-${index}`;
      index += 1;
    }
    return next;
  }

  function slugifyName(name) {
    return String(name || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function isSupportedAdapterLabel(value) {
    return ADAPTER_OPTIONS.some((item) => item.value === value);
  }

  function normalizeAdapterLabel(value) {
    const raw = String(value || '').trim();
    if (raw === 'acp-rpc') return 'acpRpcAdapter';
    if (raw === 'stdio') return 'stdioAdapter';
    if (raw === 'acprpcadapter') return 'acpRpcAdapter';
    if (raw === 'stdioadapter') return 'stdioAdapter';
    if (isSupportedAdapterLabel(raw)) return raw;
    return 'stdioAdapter';
  }

  function toRuntimeAgentSpec(config) {
    return {
      command: String(config?.command || '').trim(),
      args: Array.isArray(config?.args) ? config.args.map((item) => String(item)) : [],
      adapter: normalizeAdapterLabel(config?.adapter)
    };
  }

  function normalizeAgentConfigs(value) {
    const list = Array.isArray(value) ? value : [];
    const output = [];
    const seen = new Set();
    for (const raw of list) {
      const normalized = normalizeAgentConfig(raw);
      if (!normalized) continue;
      if (seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      output.push(normalized);
    }
    const withBuiltins = ensureBuiltinAgentConfigs(output);
    if (withBuiltins.length === 0) return BUILTIN_AGENT_CONFIGS.map((config) => cloneAgentConfig(config));
    return withBuiltins;
  }

  function ensureBuiltinAgentConfigs(list) {
    const output = Array.isArray(list) ? list.map((item) => cloneAgentConfig(item)) : [];
    const existingIds = new Set(output.map((item) => item.id));
    for (const builtin of BUILTIN_AGENT_CONFIGS) {
      if (existingIds.has(builtin.id)) continue;
      output.push(cloneAgentConfig(builtin));
    }
    return output;
  }

  function normalizeAgentConfig(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || '').trim();
    const command = String(raw.command || '').trim();
    if (name === '' || command === '') return null;
    const idRaw = String(raw.id || '').trim() || slugifyName(name);
    const id = idRaw === '' ? null : idRaw;
    if (!id) return null;
    const args = Array.isArray(raw.args) ? raw.args.map((item) => String(item)) : [];
    const adapter = normalizeAdapterLabel(raw.adapter);
    return { id, name, command, args, adapter };
  }

  function cloneAgentConfig(config) {
    return {
      id: String(config.id),
      name: String(config.name),
      command: String(config.command),
      args: Array.isArray(config.args) ? config.args.map((item) => String(item)) : [],
      adapter: normalizeAdapterLabel(config.adapter)
    };
  }

  async function loadSettings() {
    try {
      const result = await safeStorageGet(SETTINGS_KEY);
      const settings = result?.[SETTINGS_KEY];
      agentConfigs = normalizeAgentConfigs(settings?.agents);
      const storedAgentId = String(settings?.agentId || '').trim();
      const valid = agentConfigs.some((config) => config.id === storedAgentId);
      activeAgentId = valid ? storedAgentId : (agentConfigs[0]?.id || DEFAULT_AGENT_ID);
      editingAgentId = null;
    } catch (_error) {
      activeAgentId = DEFAULT_AGENT_ID;
      editingAgentId = null;
      agentConfigs = BUILTIN_AGENT_CONFIGS.map((config) => cloneAgentConfig(config));
    }

    try {
      await refreshBridgeConfigFromHost();
    } catch (_error) {
      renderBridgeConfigInputs();
    }

    renderAgentList();
    hideAgentEditor();
    renderActiveTabMeta();
  }

  async function saveSettings() {
    await safeStorageSet({
      [SETTINGS_KEY]: {
        agentId: activeAgentId,
        agents: agentConfigs.map((config) => cloneAgentConfig(config))
      }
    });
  }

  function focusTextarea() {
    if (!textareaEl || textareaEl.disabled) return;
    try {
      textareaEl.focus({ preventScroll: true });
    } catch (_error) {
      textareaEl.focus();
    }
  }

  function hasRuntimeContext() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch (_error) {
      return false;
    }
  }

  async function safeSendRuntimeMessage(payload) {
    if (!hasRuntimeContext()) return null;
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (_error) {
      return null;
    }
  }

  async function safeStorageGet(key) {
    if (!hasRuntimeContext()) return null;
    try {
      return await chrome.storage.local.get(key);
    } catch (_error) {
      return null;
    }
  }

  async function safeStorageSet(value) {
    if (!hasRuntimeContext()) return;
    try {
      await chrome.storage.local.set(value);
    } catch (_error) {
      // Ignore storage failures from stale/inactive extension context.
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
