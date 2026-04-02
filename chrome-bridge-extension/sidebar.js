(() => {
  if (window.__chromeBridgeSidebarLoaded) return;
  window.__chromeBridgeSidebarLoaded = true;

  const ROOT_ID = 'chrome-bridge-chat-root';
  const STYLE_ID = 'chrome-bridge-chat-style';
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
  const DRAG_MARGIN = 8;
  const MIN_PANEL_WIDTH = 320;
  const MIN_PANEL_HEIGHT = 360;

  let rootEl = null;
  let listEl = null;
  let textareaEl = null;
  let contentEl = null;
  let settingsEl = null;
  let resizeHandleEl = null;
  let gearBtnEl = null;
  let minimizeBtnEl = null;
  let maximizeBtnEl = null;
  let agentListEl = null;
  let editorWrapEl = null;
  let agentNameInputEl = null;
  let agentCommandInputEl = null;
  let agentArgsInputEl = null;
  let agentAdapterSelectEl = null;
  let settingsStatusEl = null;
  let statusEl = null;
  let isOpen = false;
  let isMinimized = false;
  let ignoreIncomingEventsWhileClosed = false;
  let activeAgentId = DEFAULT_AGENT_ID;
  let editingAgentId = null;
  let agentConfigs = BUILTIN_AGENT_CONFIGS.map((config) => cloneAgentConfig(config));
  let panelPosition = null;
  let panelSize = null;
  const assistantStreamsBySessionId = new Map();

  if (!hasRuntimeContext()) return;

  ensureStyle();
  window.addEventListener('resize', () => {
    if (!isOpen) return;
    applyPanelSize(panelSize);
    applyPanelPosition(panelPosition);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'bridge_sidebar_ping') {
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === 'bridge_toggle_sidebar') {
      toggleSidebar();
      sendResponse({ ok: true, open: isOpen });
      return;
    }

    if (message?.type === 'bridge_chat_event') {
      handleChatEvent(message.event || {});
      sendResponse({ ok: true });
      return;
    }
  });

  void loadSettings();

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('sidebar.css');
    document.documentElement.appendChild(link);
  }

  function toggleSidebar() {
    if (!isOpen) {
      openSidebar();
      return;
    }
    closeSidebar();
  }

  function openSidebar() {
    ensureRoot();
    isOpen = true;
    ignoreIncomingEventsWhileClosed = false;
    applyPanelSize(panelSize);
    applyPanelPosition(panelPosition);
    setMinimized(false);
    if (textareaEl && !isMinimized) textareaEl.focus();
  }

  function closeSidebar() {
    isOpen = false;
    ignoreIncomingEventsWhileClosed = true;
    rootEl?.remove();
    rootEl = null;
    resizeHandleEl = null;
    gearBtnEl = null;
    minimizeBtnEl = null;
    maximizeBtnEl = null;
    isMinimized = false;
    void safeSendRuntimeMessage({ type: 'bridge_chat_close' });
  }

  function ensureRoot() {
    if (rootEl) return;

    rootEl = document.createElement('aside');
    rootEl.id = ROOT_ID;

    const header = document.createElement('div');
    header.className = 'cb-header';

    const title = document.createElement('div');
    title.className = 'cb-title';
    title.textContent = 'Bridge Chat';

    const actions = document.createElement('div');
    actions.className = 'cb-actions';

    gearBtnEl = document.createElement('button');
    gearBtnEl.className = 'cb-icon-btn cb-btn-gear';
    gearBtnEl.type = 'button';
    gearBtnEl.textContent = '⚙️';
    gearBtnEl.title = 'Settings';
    gearBtnEl.addEventListener('click', showSettings);

    minimizeBtnEl = document.createElement('button');
    minimizeBtnEl.className = 'cb-icon-btn cb-btn-minimize';
    minimizeBtnEl.type = 'button';
    minimizeBtnEl.textContent = '➖';
    minimizeBtnEl.title = 'Minimize';
    minimizeBtnEl.addEventListener('click', () => setMinimized(true));

    maximizeBtnEl = document.createElement('button');
    maximizeBtnEl.className = 'cb-icon-btn cb-btn-maximize';
    maximizeBtnEl.type = 'button';
    maximizeBtnEl.textContent = '🔲';
    maximizeBtnEl.title = 'Maximize';
    maximizeBtnEl.addEventListener('click', () => setMinimized(false));

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cb-icon-btn';
    closeBtn.type = 'button';
    closeBtn.textContent = '❌';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', closeSidebar);

    actions.appendChild(gearBtnEl);
    actions.appendChild(minimizeBtnEl);
    actions.appendChild(maximizeBtnEl);
    actions.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(actions);
    setupDrag(header);

    contentEl = document.createElement('div');
    contentEl.className = 'cb-body';

    listEl = document.createElement('div');
    listEl.className = 'cb-chat-list';

    const inputWrap = document.createElement('div');
    inputWrap.className = 'cb-input-wrap';

    statusEl = document.createElement('div');
    statusEl.className = 'cb-status';
    statusEl.textContent = buildActiveAgentStatusText();

    textareaEl = document.createElement('textarea');
    textareaEl.className = 'cb-textarea';
    textareaEl.placeholder = 'Ask the selected agent...';
    textareaEl.addEventListener('keydown', (event) => {
      const enterToSend = event.key === 'Enter' && !event.shiftKey;
      if (!enterToSend) return;
      event.preventDefault();
      void submitMessage();
    });

    inputWrap.appendChild(statusEl);
    inputWrap.appendChild(textareaEl);

    contentEl.appendChild(listEl);
    contentEl.appendChild(inputWrap);

    settingsEl = createSettingsPanel();

    rootEl.appendChild(header);
    rootEl.appendChild(contentEl);
    rootEl.appendChild(settingsEl);
    resizeHandleEl = document.createElement('div');
    resizeHandleEl.className = 'cb-resize-handle';
    resizeHandleEl.title = 'Resize';
    rootEl.appendChild(resizeHandleEl);
    setupResize(resizeHandleEl);
    setMinimized(false);

    document.documentElement.appendChild(rootEl);
  }

  function setMinimized(next) {
    isMinimized = Boolean(next);
    if (!rootEl) return;
    rootEl.classList.toggle('cb-minimized', isMinimized);
  }

  function setupDrag(handleEl) {
    if (!rootEl || !handleEl) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const shouldIgnoreTarget = (target) => {
      if (!(target instanceof Element)) return false;
      return Boolean(target.closest('button, input, select, textarea, a, [role="button"]'));
    };

    const onMouseMove = (event) => {
      if (!dragging || !rootEl) return;

      const dx = event.clientX - startX;
      const dy = event.clientY - startY;

      const width = rootEl.offsetWidth || 0;
      const height = rootEl.offsetHeight || 0;
      const maxLeft = Math.max(DRAG_MARGIN, window.innerWidth - width - DRAG_MARGIN);
      const maxTop = Math.max(DRAG_MARGIN, window.innerHeight - height - DRAG_MARGIN);

      const nextLeft = clamp(startLeft + dx, DRAG_MARGIN, maxLeft);
      const nextTop = clamp(startTop + dy, DRAG_MARGIN, maxTop);

      rootEl.style.left = `${nextLeft}px`;
      rootEl.style.top = `${nextTop}px`;
      rootEl.style.right = 'auto';
      panelPosition = { left: nextLeft, top: nextTop };
    };

    const stopDragging = () => {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', stopDragging);
      void saveSettings();
    };

    handleEl.addEventListener('mousedown', (event) => {
      if (!rootEl) return;
      if (event.button !== 0) return;
      if (shouldIgnoreTarget(event.target)) return;

      const rect = rootEl.getBoundingClientRect();
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      event.preventDefault();
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', stopDragging);
    });
  }

  function setupResize(handleEl) {
    if (!rootEl || !handleEl) return;

    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;

    const onMouseMove = (event) => {
      if (!resizing || !rootEl) return;

      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      const nextWidth = startWidth + dx;
      const nextHeight = startHeight + dy;

      applyPanelSize({ width: nextWidth, height: nextHeight });
      applyPanelPosition(panelPosition);
    };

    const stopResizing = () => {
      if (!resizing) return;
      resizing = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', stopResizing);
      void saveSettings();
    };

    handleEl.addEventListener('mousedown', (event) => {
      if (!rootEl) return;
      if (event.button !== 0) return;

      resizing = true;
      startX = event.clientX;
      startY = event.clientY;
      startWidth = rootEl.offsetWidth;
      startHeight = rootEl.offsetHeight;

      event.preventDefault();
      event.stopPropagation();
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', stopResizing);
    });
  }

  function createSettingsPanel() {
    const settings = document.createElement('div');
    settings.className = 'cb-settings';

    const headRow = document.createElement('div');
    headRow.className = 'cb-settings-head';
    const activeLabel = document.createElement('label');
    activeLabel.className = 'cb-label';
    activeLabel.textContent = 'Agent Configs (single active)';
    const newBtn = document.createElement('button');
    newBtn.className = 'cb-btn';
    newBtn.type = 'button';
    newBtn.textContent = 'New';
    newBtn.addEventListener('click', () => {
      beginCreateAgentConfig();
    });
    headRow.appendChild(activeLabel);
    headRow.appendChild(newBtn);

    const activeRow = document.createElement('div');
    activeRow.className = 'cb-settings-row';
    agentListEl = document.createElement('div');
    agentListEl.className = 'cb-agent-list';
    activeRow.appendChild(agentListEl);

    editorWrapEl = document.createElement('div');
    editorWrapEl.className = 'cb-editor';

    const nameRow = document.createElement('div');
    nameRow.className = 'cb-settings-row';
    const nameLabel = document.createElement('label');
    nameLabel.className = 'cb-label';
    nameLabel.textContent = 'Name';
    agentNameInputEl = document.createElement('input');
    agentNameInputEl.className = 'cb-input';
    agentNameInputEl.type = 'text';
    agentNameInputEl.placeholder = 'My Agent';
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(agentNameInputEl);

    const commandRow = document.createElement('div');
    commandRow.className = 'cb-settings-row';
    const commandLabel = document.createElement('label');
    commandLabel.className = 'cb-label';
    commandLabel.textContent = 'Command';
    agentCommandInputEl = document.createElement('input');
    agentCommandInputEl.className = 'cb-input';
    agentCommandInputEl.type = 'text';
    agentCommandInputEl.placeholder = '/path/to/bin or command';
    commandRow.appendChild(commandLabel);
    commandRow.appendChild(agentCommandInputEl);

    const argsRow = document.createElement('div');
    argsRow.className = 'cb-settings-row';
    const argsLabel = document.createElement('label');
    argsLabel.className = 'cb-label';
    argsLabel.textContent = 'Arguments (one per line)';
    agentArgsInputEl = document.createElement('textarea');
    agentArgsInputEl.className = 'cb-args';
    agentArgsInputEl.placeholder = '--flag\nvalue';
    argsRow.appendChild(argsLabel);
    argsRow.appendChild(agentArgsInputEl);

    const adapterRow = document.createElement('div');
    adapterRow.className = 'cb-settings-row';
    const adapterLabel = document.createElement('label');
    adapterLabel.className = 'cb-label';
    adapterLabel.textContent = 'Adapter';
    agentAdapterSelectEl = document.createElement('select');
    agentAdapterSelectEl.className = 'cb-select';
    for (const option of ADAPTER_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      agentAdapterSelectEl.appendChild(opt);
    }
    adapterRow.appendChild(adapterLabel);
    adapterRow.appendChild(agentAdapterSelectEl);

    const actions = document.createElement('div');
    actions.className = 'cb-settings-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'cb-btn';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      void handleSaveAgentConfig();
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cb-btn';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      hideAgentEditor();
    });

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);

    settingsStatusEl = document.createElement('div');
    settingsStatusEl.className = 'cb-settings-status';

    const note = document.createElement('div');
    note.className = 'cb-settings-note';
    note.textContent = 'Adapter maps: acpRpcAdapter -> acp-rpc, stdioAdapter -> stdio.';

    const backBtn = document.createElement('button');
    backBtn.className = 'cb-back';
    backBtn.type = 'button';
    backBtn.textContent = 'Back to chat';
    backBtn.addEventListener('click', showChat);

    editorWrapEl.appendChild(nameRow);
    editorWrapEl.appendChild(commandRow);
    editorWrapEl.appendChild(argsRow);
    editorWrapEl.appendChild(adapterRow);
    editorWrapEl.appendChild(actions);
    editorWrapEl.appendChild(settingsStatusEl);
    editorWrapEl.appendChild(note);

    settings.appendChild(headRow);
    settings.appendChild(activeRow);
    settings.appendChild(editorWrapEl);
    settings.appendChild(backBtn);

    renderAgentList();
    hideAgentEditor();
    return settings;
  }

  function showSettings() {
    if (!settingsEl || !contentEl) return;
    contentEl.style.display = 'none';
    settingsEl.style.display = 'flex';
  }

  function showChat() {
    if (!settingsEl || !contentEl) return;
    settingsEl.style.display = 'none';
    contentEl.style.display = 'flex';
  }

  async function submitMessage() {
    if (!textareaEl) return;
    const text = String(textareaEl.value || '').trim();
    if (text === '') return;

    const activeAgent = getActiveAgentConfig();
    if (!activeAgent) {
      appendMessage('system', 'Error: No active agent config');
      return;
    }

    appendMessage('user', text);
    textareaEl.value = '';

    try {
      const response = await safeSendRuntimeMessage({
        type: 'bridge_chat_send',
        text,
        agentId: activeAgent.id,
        agentSpec: toRuntimeAgentSpec(activeAgent)
      });
      if (!response?.ok) {
        throw new Error(response?.error || 'Failed to send message');
      }
    } catch (error) {
      appendMessage('system', `Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      textareaEl.focus();
    }
  }

  function handleChatEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (!isOpen && ignoreIncomingEventsWhileClosed) return;

    if (event.kind === 'assistant_delta') {
      appendAssistantDelta(String(event.sessionId || ''), String(event.text || ''));
      return;
    }

    if (event.kind === 'assistant_message') {
      const sessionId = String(event.sessionId || '');
      const text = String(event.text || '');
      if (!finalizeAssistantDelta(sessionId, text)) {
        appendMessage('assistant', text);
      }
      return;
    }

    if (event.kind === 'error') {
      appendMessage('system', `Error: ${String(event.text || 'Unknown error')}`);
      return;
    }

    if (event.kind === 'status') {
      appendMessage('system', String(event.text || 'Status update'));
      return;
    }
  }

  function appendMessage(kind, text) {
    if (!isOpen) openSidebar();
    if (!listEl) return;

    const cleaned = String(text || '').trim();
    if (cleaned === '') return;

    const item = document.createElement('div');
    item.className = 'cb-msg';
    if (kind === 'user') item.classList.add('cb-msg-user');
    else if (kind === 'assistant') item.classList.add('cb-msg-assistant');
    else item.classList.add('cb-msg-system');

    item.textContent = cleaned;
    listEl.appendChild(item);
    listEl.scrollTop = listEl.scrollHeight;
  }

  function appendAssistantDelta(sessionId, text) {
    if (!isOpen) openSidebar();
    if (!listEl) return;

    const delta = String(text || '');
    if (delta === '') return;

    let stream = sessionId !== '' ? assistantStreamsBySessionId.get(sessionId) : null;
    if (!stream) {
      const item = document.createElement('div');
      item.className = 'cb-msg cb-msg-assistant';
      listEl.appendChild(item);
      stream = { item, text: '' };
      if (sessionId !== '') {
        assistantStreamsBySessionId.set(sessionId, stream);
      }
    }

    stream.text += delta;
    stream.item.textContent = stream.text;
    listEl.scrollTop = listEl.scrollHeight;
  }

  function finalizeAssistantDelta(sessionId, finalText) {
    if (sessionId === '') return false;
    const stream = assistantStreamsBySessionId.get(sessionId);
    if (!stream) return false;

    const cleanedFinal = String(finalText || '').trim();
    if (cleanedFinal !== '') {
      stream.item.textContent = cleanedFinal;
    }
    assistantStreamsBySessionId.delete(sessionId);
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
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
      activateBtn.textContent = isActive ? '🔴' : '⚫️';
      if (isActive) activateBtn.classList.add('cb-btn-active');
      activateBtn.addEventListener('click', () => {
        if (isActive) return;
        activeAgentId = config.id;
        if (statusEl) statusEl.textContent = buildActiveAgentStatusText();
        setSettingsStatus(`Activated: ${config.name || config.id}`);
        void saveSettings();
        renderAgentList();
      });

      const editBtn = document.createElement('button');
      editBtn.className = 'cb-btn';
      editBtn.type = 'button';
      editBtn.textContent = '⚙';
      editBtn.addEventListener('click', () => {
        editingAgentId = config.id;
        populateAgentEditor(config.id);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'cb-btn cb-btn-danger';
      deleteBtn.type = 'button';
      deleteBtn.textContent = '𐄂';
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
    if (agentAdapterSelectEl) {
      agentAdapterSelectEl.value = normalizeAdapterLabel(config.adapter);
    }
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
    if (statusEl) statusEl.textContent = buildActiveAgentStatusText();
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
    if (statusEl) statusEl.textContent = buildActiveAgentStatusText();
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
      value: {
        name,
        command,
        args,
        adapter
      }
    };
  }

  function setSettingsStatus(text) {
    if (!settingsStatusEl) return;
    settingsStatusEl.textContent = String(text || '').trim();
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
      panelPosition = normalizePanelPosition(settings?.panelPosition);
      panelSize = normalizePanelSize(settings?.panelSize);
    } catch (_error) {
      activeAgentId = DEFAULT_AGENT_ID;
      editingAgentId = null;
      agentConfigs = BUILTIN_AGENT_CONFIGS.map((config) => cloneAgentConfig(config));
      panelPosition = null;
      panelSize = null;
    }

    renderAgentList();
    hideAgentEditor();
    if (statusEl) statusEl.textContent = buildActiveAgentStatusText();
    if (rootEl) {
      applyPanelSize(panelSize);
      applyPanelPosition(panelPosition);
    }
  }

  async function saveSettings() {
    await safeStorageSet({
      [SETTINGS_KEY]: {
        agentId: activeAgentId,
        agents: agentConfigs.map((config) => cloneAgentConfig(config)),
        panelPosition: panelPosition,
        panelSize: panelSize
      }
    });
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

  function applyPanelSize(size) {
    if (!rootEl) return;
    const validSize = normalizePanelSize(size);
    if (!validSize) {
      rootEl.style.width = '';
      rootEl.style.height = '';
      panelSize = null;
      return;
    }

    const maxWidth = Math.max(MIN_PANEL_WIDTH, window.innerWidth - DRAG_MARGIN * 2);
    const maxHeight = Math.max(MIN_PANEL_HEIGHT, window.innerHeight - DRAG_MARGIN * 2);
    const width = clamp(validSize.width, MIN_PANEL_WIDTH, maxWidth);
    const height = clamp(validSize.height, MIN_PANEL_HEIGHT, maxHeight);

    rootEl.style.width = `${width}px`;
    rootEl.style.height = `${height}px`;
    panelSize = { width, height };
  }

  function applyPanelPosition(position) {
    if (!rootEl) return;
    const validPosition = normalizePanelPosition(position);
    if (!validPosition) {
      rootEl.style.left = '';
      rootEl.style.top = '';
      rootEl.style.right = '12px';
      return;
    }

    const width = rootEl.offsetWidth || 0;
    const height = rootEl.offsetHeight || 0;
    const maxLeft = Math.max(DRAG_MARGIN, window.innerWidth - width - DRAG_MARGIN);
    const maxTop = Math.max(DRAG_MARGIN, window.innerHeight - height - DRAG_MARGIN);
    const left = clamp(validPosition.left, DRAG_MARGIN, maxLeft);
    const top = clamp(validPosition.top, DRAG_MARGIN, maxTop);

    rootEl.style.left = `${left}px`;
    rootEl.style.top = `${top}px`;
    rootEl.style.right = 'auto';
    panelPosition = { left, top };
  }

  function normalizePanelPosition(value) {
    if (!value || typeof value !== 'object') return null;
    const left = Number(value.left);
    const top = Number(value.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  }

  function normalizePanelSize(value) {
    if (!value || typeof value !== 'object') return null;
    const width = Number(value.width);
    const height = Number(value.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return { width, height };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
