const readline = require('node:readline');
const { spawn } = require('node:child_process');
const path = require('node:path');

function createAcpRpcSession({ tabId, sessionId, agentId, command, args, emit, stripAnsi }) {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });

  const state = {
    closed: false,
    initialized: false,
    pendingPrompt: false,
    currentPromptText: '',
    rpcSeq: 1,
    sessionHandle: null,
    rpcPending: new Map()
  };

  const projectRoot =
    String(process.env.CHROME_BRIDGE_PROJECT_ROOT || '').trim() ||
    path.resolve(__dirname, '..', '..', '..');

  function safeEmit(kind, text, extra) {
    if (state.closed) return;
    emit(kind, text, extra);
  }

  function rejectAllPending(errorMessage) {
    const pending = Array.from(state.rpcPending.values());
    state.rpcPending.clear();
    for (const item of pending) {
      item.reject(new Error(errorMessage));
    }
  }

  function sendRpc(method, params) {
    if (!child.stdin || child.stdin.destroyed) {
      return Promise.reject(new Error('ACP stdin is unavailable'));
    }

    const id = state.rpcSeq++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params: params || {}
    };

    return new Promise((resolve, reject) => {
      state.rpcPending.set(id, { resolve, reject });
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        state.rpcPending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function handleRpcResponse(message) {
    const pending = state.rpcPending.get(message.id);
    if (!pending) return;
    state.rpcPending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(String(message.error.message || 'ACP RPC error')));
      return;
    }

    pending.resolve(message.result || {});
  }

  function handleSessionUpdate(message) {
    const update = message?.params?.update;
    const updateType = String(update?.sessionUpdate || '');

    if (updateType === 'agent_message_chunk') {
      const text = String(update?.content?.text || '');
      if (text !== '') {
        state.currentPromptText += text;
        safeEmit('assistant_delta', text);
      }
      return;
    }

    if (updateType === 'usage_update') {
      return;
    }

    if (updateType === 'available_commands_update') {
      return;
    }
  }

  function isNoisyStderrLine(line) {
    const text = String(line || '').toLowerCase();
    if (text === '') return true;
    if (text.includes('could not update path')) return true;
    if (text.includes('failed to install system skills')) return true;
    if (text.includes('failed to write models cache')) return true;
    if (text.includes('failed to renew cache ttl')) return true;
    if (text.includes('failed to record rollout items')) return true;
    return false;
  }

  if (child.stdout) {
    const outReader = readline.createInterface({ input: child.stdout });
    outReader.on('line', (line) => {
      const raw = String(line || '').trim();
      if (raw === '') return;

      try {
        const message = JSON.parse(raw);
        if (typeof message?.id === 'number') {
          handleRpcResponse(message);
          return;
        }

        if (message?.method === 'session/update') {
          handleSessionUpdate(message);
        }
      } catch (_error) {
        // Ignore non-JSON output.
      }
    });
  }

  if (child.stderr) {
    const errReader = readline.createInterface({ input: child.stderr });
    errReader.on('line', (line) => {
      const cleaned = stripAnsi(line).trim();
      if (cleaned === '') return;
      if (isNoisyStderrLine(cleaned)) return;
      safeEmit('status', `[agent stderr] ${cleaned}`);
    });
  }

  child.on('error', (error) => {
    if (state.closed) return;
    safeEmit('error', `Failed to start ACP agent: ${String(error.message || error)}`);
    rejectAllPending(String(error.message || error));
  });

  child.on('exit', (code, signal) => {
    if (state.closed) return;
    state.closed = true;
    rejectAllPending(`ACP agent exited (code=${code == null ? 'null' : code}, signal=${signal || 'none'})`);
    safeEmit('status', `Agent session ended (code=${code == null ? 'null' : code}, signal=${signal || 'none'})`);
  });

  async function initialize() {
    if (state.initialized) return;

    await sendRpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: 'chrome-bridge',
        version: '0.1.0'
      }
    });

    const session = await sendRpc('session/new', {
      cwd: projectRoot,
      mcpServers: []
    });

    state.sessionHandle = String(session?.sessionId || '').trim();
    if (state.sessionHandle === '') {
      throw new Error('ACP session/new did not return sessionId');
    }

    state.initialized = true;
    safeEmit('status', `Connected to ${agentId}`);
  }

  async function sendUserMessage(text) {
    if (state.closed) throw new Error('ACP session already closed');
    if (state.pendingPrompt) {
      safeEmit('status', 'Previous request still running');
      return;
    }

    const payload = String(text || '').trim();
    if (payload === '') throw new Error('Cannot send empty message');

    await initialize();

    state.pendingPrompt = true;
    state.currentPromptText = '';
    try {
      await sendRpc('session/prompt', {
        sessionId: state.sessionHandle,
        prompt: [
          {
            type: 'text',
            text: payload
          }
        ]
      });

      const finalText = state.currentPromptText.trim();
      if (finalText === '') {
        safeEmit('error', 'No assistant message returned');
      } else {
        safeEmit('assistant_message', finalText, { streamed: true });
      }
    } finally {
      state.pendingPrompt = false;
      state.currentPromptText = '';
    }
  }

  function close(reason) {
    if (state.closed) return;
    state.closed = true;
    rejectAllPending('ACP session closed');

    if (child && !child.killed) {
      child.kill('SIGTERM');
    }

    emit('status', `Disconnected (${reason || 'closed'})`);
  }

  return {
    sendUserMessage,
    close
  };
}

module.exports = {
  createAcpRpcSession
};
