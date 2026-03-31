const crypto = require('node:crypto');

const { createAcpRpcSession } = require('./adapters/acpRpcAdapter');
const { createCodexAcpSession } = require('./adapters/codexAcpAdapter');
const { createStdioSession } = require('./adapters/stdioAdapter');
const { parseArgsJson, resolveExecutable, stripAnsi } = require('./utils');

const DEFAULT_AGENT_ID = 'codex-acp';

function loadAgentRegistryFromEnv() {
  const defaultCommand = process.env.CODEX_ACP_COMMAND || 'codex-acp';
  const defaultArgs = parseArgsJson(process.env.CODEX_ACP_ARGS_JSON, []);

  const fallback = {
    [DEFAULT_AGENT_ID]: {
      adapter: process.env.CODEX_ACP_ADAPTER || 'acp-rpc',
      command: defaultCommand,
      args: defaultArgs,
      mode: process.env.CODEX_ACP_MODE || 'acp_rpc'
    }
  };

  const raw = process.env.AGENT_COMMANDS_JSON;
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    const output = {};

    for (const [agentId, spec] of Object.entries(parsed || {})) {
      if (!agentId || typeof spec !== 'object' || spec === null) continue;
      const command = String(spec.command || '').trim();
      if (command === '') continue;

      const args = Array.isArray(spec.args) ? spec.args.map((item) => String(item)) : [];
      const mode = String(spec.mode || spec.stdinMode || 'text').trim().toLowerCase() || 'text';
      const adapter = String(spec.adapter || '').trim().toLowerCase() || inferAdapter(agentId, mode);

      output[agentId] = { adapter, command, args, mode };
    }

    if (Object.keys(output).length === 0) return fallback;
    return output;
  } catch (_error) {
    return fallback;
  }
}

function inferAdapter(agentId, mode) {
  if (String(mode).toLowerCase() === 'acp_rpc') return 'acp-rpc';
  if (String(mode).toLowerCase() === 'codex_exec_json') return 'codex-acp';
  if (String(agentId).toLowerCase() === DEFAULT_AGENT_ID) return 'acp-rpc';
  return 'stdio';
}

function createAgentBridge({ agentRegistry, onEvent }) {
  const registry = agentRegistry || loadAgentRegistryFromEnv();
  const sessionsByTabId = new Map();

  function emit(tabId, sessionId, kind, text, extra) {
    onEvent({
      tabId,
      sessionId,
      kind,
      text,
      ...(extra || {})
    });
  }

  function resolveSpec(requestedAgentId) {
    const agentId = String(requestedAgentId || DEFAULT_AGENT_ID).trim() || DEFAULT_AGENT_ID;
    const spec = registry[agentId];
    if (spec) return { agentId, spec };

    const fallback = registry[DEFAULT_AGENT_ID];
    if (!fallback) {
      throw new Error(`Unsupported agent and no default available: ${agentId}`);
    }

    return { agentId: DEFAULT_AGENT_ID, spec: fallback };
  }

  function createSession(tabId, requestedAgentId) {
    const { agentId, spec } = resolveSpec(requestedAgentId);
    if (!spec || !spec.command) {
      throw new Error(`Unsupported agent: ${String(requestedAgentId || '')}`);
    }

    const sessionId = crypto.randomUUID();
    const command = resolveExecutable(spec.command);
    const args = spec.args || [];
    const mode = String(spec.mode || 'text').trim().toLowerCase() || 'text';
    const adapter = String(spec.adapter || inferAdapter(agentId, mode)).trim().toLowerCase();

    const baseContext = {
      tabId,
      sessionId,
      agentId,
      command,
      args,
      mode,
      stripAnsi,
      emit: (kind, text, extra) => emit(tabId, sessionId, kind, text, extra)
    };

    let driver;
    if (adapter === 'acp-rpc') {
      driver = createAcpRpcSession(baseContext);
    } else if (adapter === 'codex-acp') {
      driver = createCodexAcpSession(baseContext);
    } else if (adapter === 'stdio') {
      driver = createStdioSession(baseContext);
    } else {
      throw new Error(`Unsupported adapter: ${adapter}`);
    }

    const record = {
      tabId,
      sessionId,
      agentId,
      adapter,
      driver,
      closed: false
    };
    sessionsByTabId.set(tabId, record);
    return record;
  }

  function ensureSession(tabId, requestedAgentId) {
    const desiredAgent = String(requestedAgentId || DEFAULT_AGENT_ID).trim() || DEFAULT_AGENT_ID;
    const existing = sessionsByTabId.get(tabId);

    if (existing && !existing.closed && existing.agentId === desiredAgent) {
      return existing;
    }

    if (existing && !existing.closed && existing.agentId !== desiredAgent) {
      closeSession(tabId, 'switch_agent');
    }

    return createSession(tabId, desiredAgent);
  }

  async function handleUserMessage({ tabId, agentId, text }) {
    const numericTabId = Number(tabId);
    if (!Number.isFinite(numericTabId)) return;

    const payload = String(text || '').trim();
    if (payload === '') {
      emit(numericTabId, null, 'error', 'Cannot send empty message');
      return;
    }

    try {
      const session = ensureSession(numericTabId, agentId);
      await session.driver.sendUserMessage(payload);
    } catch (error) {
      emit(numericTabId, null, 'error', error instanceof Error ? error.message : String(error));
    }
  }

  function closeSession(tabId, reason) {
    const numericTabId = Number(tabId);
    if (!Number.isFinite(numericTabId)) return false;

    const session = sessionsByTabId.get(numericTabId);
    if (!session) return false;

    sessionsByTabId.delete(numericTabId);
    session.closed = true;
    session.driver.close(reason);
    return true;
  }

  function closeAllSessions(reason) {
    for (const tabId of Array.from(sessionsByTabId.keys())) {
      closeSession(tabId, reason);
    }
  }

  return {
    handleUserMessage,
    closeSession,
    closeAllSessions,
    getSessionCount: () => sessionsByTabId.size,
    getAgentIds: () => Object.keys(registry)
  };
}

module.exports = {
  DEFAULT_AGENT_ID,
  loadAgentRegistryFromEnv,
  createAgentBridge
};
