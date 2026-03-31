(() => {
  if (window.__chromeBridgeSidebarLoaded) return;
  window.__chromeBridgeSidebarLoaded = true;

  const ROOT_ID = 'chrome-bridge-chat-root';
  const STYLE_ID = 'chrome-bridge-chat-style';
  const SPLIT_CLASS = 'chrome-bridge-split-layout';
  const SETTINGS_KEY = 'chromeBridgeChatSettings';
  const DEFAULT_AGENT_ID = 'codex-acp';
  const AGENT_OPTIONS = [{ id: 'codex-acp', label: 'codex-acp' }];

  let rootEl = null;
  let listEl = null;
  let textareaEl = null;
  let contentEl = null;
  let settingsEl = null;
  let agentSelectEl = null;
  let statusEl = null;
  let isOpen = false;
  let activeAgentId = DEFAULT_AGENT_ID;
  const assistantStreamsBySessionId = new Map();

  ensureStyle();

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

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html.${SPLIT_CLASS},
      body.${SPLIT_CLASS} {
        margin-right: clamp(320px, 25vw, 460px) !important;
        width: auto !important;
        transition: margin-right 160ms ease;
      }
      #${ROOT_ID} {
        all: initial;
        position: fixed;
        top: 0;
        right: 0;
        width: clamp(320px, 25vw, 460px);
        height: 100vh;
        background: #f9fafb;
        border-left: 1px solid #d1d5db;
        z-index: 2147483647;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #111827;
        display: flex;
        flex-direction: column;
      }
      #${ROOT_ID} * { box-sizing: border-box; }
      .cb-header {
        height: 48px;
        border-bottom: 1px solid #e5e7eb;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 10px;
        background: #ffffff;
      }
      .cb-title {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.02em;
      }
      .cb-actions {
        display: flex;
        gap: 6px;
      }
      .cb-icon-btn {
        border: 1px solid #d1d5db;
        background: #fff;
        border-radius: 6px;
        width: 30px;
        height: 30px;
        cursor: pointer;
        font-size: 15px;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        padding: 0;
      }
      .cb-body {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
      }
      .cb-chat-list {
        flex: 1;
        overflow: auto;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .cb-msg {
        border-radius: 10px;
        padding: 8px 10px;
        font-size: 12px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .cb-msg-user {
        background: #2563eb;
        color: #ffffff;
        align-self: flex-end;
        max-width: 92%;
      }
      .cb-msg-assistant {
        background: #e5e7eb;
        color: #111827;
        align-self: flex-start;
        max-width: 100%;
      }
      .cb-msg-system {
        background: #f3f4f6;
        color: #4b5563;
        border: 1px dashed #d1d5db;
      }
      .cb-input-wrap {
        border-top: 1px solid #e5e7eb;
        padding: 10px;
        background: #fff;
      }
      .cb-status {
        font-size: 11px;
        color: #6b7280;
        margin-bottom: 8px;
        min-height: 14px;
      }
      .cb-textarea {
        width: 100%;
        min-height: 74px;
        max-height: 180px;
        resize: vertical;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        padding: 8px;
        font-size: 12px;
        outline: none;
      }
      .cb-settings {
        display: none;
        flex: 1;
        padding: 12px;
        gap: 10px;
        flex-direction: column;
      }
      .cb-settings-row {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .cb-label {
        font-size: 12px;
        font-weight: 600;
      }
      .cb-select {
        height: 34px;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        padding: 0 8px;
        font-size: 12px;
      }
      .cb-settings-note {
        font-size: 11px;
        color: #6b7280;
      }
      .cb-back {
        height: 32px;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        background: #ffffff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
      }
    `;
    document.documentElement.appendChild(style);
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
    document.documentElement.classList.add(SPLIT_CLASS);
    document.body?.classList.add(SPLIT_CLASS);
    if (textareaEl) textareaEl.focus();
  }

  function closeSidebar() {
    isOpen = false;
    rootEl?.remove();
    rootEl = null;
    document.documentElement.classList.remove(SPLIT_CLASS);
    document.body?.classList.remove(SPLIT_CLASS);
    void chrome.runtime.sendMessage({ type: 'bridge_chat_close' }).catch(() => {});
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

    const gearBtn = document.createElement('button');
    gearBtn.className = 'cb-icon-btn';
    gearBtn.type = 'button';
    gearBtn.textContent = '⚙️';
    gearBtn.title = 'Settings';
    gearBtn.addEventListener('click', showSettings);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cb-icon-btn';
    closeBtn.type = 'button';
    closeBtn.textContent = '❌';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', closeSidebar);

    actions.appendChild(gearBtn);
    actions.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(actions);

    contentEl = document.createElement('div');
    contentEl.className = 'cb-body';

    listEl = document.createElement('div');
    listEl.className = 'cb-chat-list';

    const inputWrap = document.createElement('div');
    inputWrap.className = 'cb-input-wrap';

    statusEl = document.createElement('div');
    statusEl.className = 'cb-status';
    statusEl.textContent = `Agent: ${activeAgentId}`;

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

    document.documentElement.appendChild(rootEl);
  }

  function createSettingsPanel() {
    const settings = document.createElement('div');
    settings.className = 'cb-settings';

    const row = document.createElement('div');
    row.className = 'cb-settings-row';

    const label = document.createElement('label');
    label.className = 'cb-label';
    label.textContent = 'LLM Agent';

    agentSelectEl = document.createElement('select');
    agentSelectEl.className = 'cb-select';

    for (const option of AGENT_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = option.id;
      opt.textContent = option.label;
      agentSelectEl.appendChild(opt);
    }

    agentSelectEl.value = activeAgentId;
    agentSelectEl.addEventListener('change', () => {
      activeAgentId = agentSelectEl.value || DEFAULT_AGENT_ID;
      if (statusEl) statusEl.textContent = `Agent: ${activeAgentId}`;
      void saveSettings();
    });

    const note = document.createElement('div');
    note.className = 'cb-settings-note';
    note.textContent = 'More agents can be added later. Current implementation supports codex-acp.';

    const backBtn = document.createElement('button');
    backBtn.className = 'cb-back';
    backBtn.type = 'button';
    backBtn.textContent = 'Back to chat';
    backBtn.addEventListener('click', showChat);

    row.appendChild(label);
    row.appendChild(agentSelectEl);
    settings.appendChild(row);
    settings.appendChild(note);
    settings.appendChild(backBtn);

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

    appendMessage('user', text);
    textareaEl.value = '';

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'bridge_chat_send',
        text,
        agentId: activeAgentId
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

  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(SETTINGS_KEY);
      const settings = result?.[SETTINGS_KEY];
      const storedAgentId = String(settings?.agentId || '').trim();
      const valid = AGENT_OPTIONS.some((opt) => opt.id === storedAgentId);
      activeAgentId = valid ? storedAgentId : DEFAULT_AGENT_ID;
    } catch (_error) {
      activeAgentId = DEFAULT_AGENT_ID;
    }

    if (agentSelectEl) agentSelectEl.value = activeAgentId;
    if (statusEl) statusEl.textContent = `Agent: ${activeAgentId}`;
  }

  async function saveSettings() {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { agentId: activeAgentId }
    });
  }
})();
