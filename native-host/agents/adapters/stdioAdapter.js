const readline = require('node:readline');
const { spawn } = require('node:child_process');

function createStdioSession({ tabId, sessionId, agentId, command, args, mode, emit }) {
  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });

  const session = {
    tabId,
    id: sessionId,
    agentId,
    mode,
    child,
    closed: false
  };

  child.on('error', (error) => {
    if (session.closed) return;
    emit('error', `Failed to start agent ${agentId}: ${String(error.message || error)}`);
    close('spawn_error');
  });

  child.on('exit', (code, signal) => {
    if (session.closed) return;
    session.closed = true;
    emit('status', `Agent session ended (code=${code == null ? 'null' : code}, signal=${signal || 'none'})`);
  });

  if (child.stdout) {
    const outReader = readline.createInterface({ input: child.stdout });
    outReader.on('line', (line) => {
      const text = String(line || '').trim();
      if (text === '') return;
      emit('assistant_message', text);
    });
  }

  if (child.stderr) {
    const errReader = readline.createInterface({ input: child.stderr });
    errReader.on('line', (line) => {
      const text = String(line || '').trim();
      if (text === '') return;
      emit('status', `[agent stderr] ${text}`);
    });
  }

  emit('status', `Connected to ${agentId}`);

  async function sendUserMessage(text) {
    if (!child.stdin || child.stdin.destroyed) {
      throw new Error('Agent session stdin is unavailable');
    }

    const payload = String(text || '').trim();
    if (payload === '') throw new Error('Cannot send empty message');

    if (mode === 'jsonl') {
      child.stdin.write(`${JSON.stringify({ type: 'user_message', content: payload })}\n`);
      return;
    }

    child.stdin.write(`${payload}\n`);
  }

  function close(reason) {
    if (session.closed) return;
    session.closed = true;

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
  createStdioSession
};
