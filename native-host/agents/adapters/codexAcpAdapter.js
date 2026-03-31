const readline = require('node:readline');
const { spawn } = require('node:child_process');

const MAX_HISTORY_ITEMS = 24;

function buildPrompt(history) {
  const lines = [
    'Continue this chat conversation and answer as the assistant.',
    'Keep the answer concise and helpful.',
    '',
    'Conversation:'
  ];

  for (const item of history) {
    const role = item.role === 'assistant' ? 'Assistant' : 'User';
    lines.push(`${role}: ${item.text}`);
  }

  lines.push('Assistant:');
  return lines.join('\n');
}

function trimHistory(history) {
  if (history.length <= MAX_HISTORY_ITEMS) return history;
  return history.slice(-MAX_HISTORY_ITEMS);
}

function extractTextFromItem(item) {
  if (typeof item?.text === 'string') return item.text;
  if (!Array.isArray(item?.content)) return '';

  const parts = [];
  for (const entry of item.content) {
    if (typeof entry === 'string') {
      parts.push(entry);
      continue;
    }
    if (typeof entry?.text === 'string') {
      parts.push(entry.text);
    }
  }
  return parts.join('');
}

function extractDeltaText(event) {
  const delta = event?.delta;
  if (typeof delta === 'string') return delta;
  if (typeof delta?.text === 'string') return delta.text;
  if (typeof delta?.output_text === 'string') return delta.output_text;

  const itemDelta = event?.item?.delta;
  if (typeof itemDelta === 'string') return itemDelta;
  if (typeof itemDelta?.text === 'string') return itemDelta.text;
  if (typeof itemDelta?.output_text === 'string') return itemDelta.output_text;

  return '';
}

function createCodexAcpSession({ tabId, sessionId, agentId, command, args, emit, stripAnsi }) {
  const session = {
    tabId,
    id: sessionId,
    agentId,
    command,
    args,
    closed: false,
    child: null,
    pending: false,
    history: []
  };

  emit('status', `Connected to ${agentId}`);

  async function sendUserMessage(text) {
    if (session.closed) {
      throw new Error('Agent session already closed');
    }

    if (session.pending) {
      emit('status', 'Previous request still running');
      return;
    }

    const payload = String(text || '').trim();
    if (payload === '') {
      throw new Error('Cannot send empty message');
    }

    session.pending = true;
    session.history.push({ role: 'user', text: payload });
    session.history = trimHistory(session.history);

    const prompt = buildPrompt(session.history);
    const child = spawn(session.command, [...session.args, prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });
    session.child = child;

    const assistantParts = [];
    const rawStdout = [];
    const stderrLines = [];
    let streamedText = '';

    if (child.stdout) {
      const outReader = readline.createInterface({ input: child.stdout });
      outReader.on('line', (line) => {
        const trimmed = String(line || '').trim();
        if (trimmed === '') return;
        rawStdout.push(trimmed);

        try {
          const parsed = JSON.parse(trimmed);
          if (parsed?.type === 'item.delta') {
            const deltaText = extractDeltaText(parsed);
            if (deltaText !== '') {
              streamedText += deltaText;
              emit('assistant_delta', deltaText);
            }
          }

          const isAssistantMessage =
            parsed?.type === 'item.completed' &&
            parsed?.item?.type === 'agent_message' &&
            extractTextFromItem(parsed.item) !== '';
          if (isAssistantMessage) {
            assistantParts.push(extractTextFromItem(parsed.item));
          }
        } catch (_error) {
          // Ignore non-JSON lines.
        }
      });
    }

    if (child.stderr) {
      const errReader = readline.createInterface({ input: child.stderr });
      errReader.on('line', (line) => {
        const cleaned = stripAnsi(line).trim();
        if (cleaned === '') return;
        stderrLines.push(cleaned);
        emit('status', `[agent stderr] ${cleaned}`);
      });
    }

    child.on('error', (error) => {
      session.pending = false;
      session.child = null;
      if (session.closed) return;
      emit('error', `Failed to run codex exec: ${String(error.message || error)}`);
    });

    child.on('exit', (code) => {
      session.pending = false;
      session.child = null;
      if (session.closed) return;

      const reply = assistantParts.join('\n').trim();
      if (reply !== '') {
        session.history.push({ role: 'assistant', text: reply });
        session.history = trimHistory(session.history);
        emit('assistant_message', reply, { streamed: streamedText !== '' });
        return;
      }

      if (Number(code) !== 0) {
        const tail = stderrLines.length > 0 ? stderrLines[stderrLines.length - 1] : 'Unknown error';
        emit('error', `codex exec failed: ${tail}`);
        return;
      }

      const fallback = rawStdout.filter((line) => !line.startsWith('{')).join('\n').trim();
      if (fallback !== '') {
        session.history.push({ role: 'assistant', text: fallback });
        session.history = trimHistory(session.history);
        emit('assistant_message', fallback, { streamed: streamedText !== '' });
        return;
      }

      emit('error', 'No assistant message returned');
    });
  }

  function close(reason) {
    if (session.closed) return;
    session.closed = true;

    if (session.child && !session.child.killed) {
      session.child.kill('SIGTERM');
    }

    emit('status', `Disconnected (${reason || 'closed'})`);
  }

  return {
    sendUserMessage,
    close
  };
}

module.exports = {
  createCodexAcpSession
};
