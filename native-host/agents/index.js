const crypto = require('node:crypto');

const { createAcpRpcSession } = require('./adapters/acpRpcAdapter');
const { createStdioSession } = require('./adapters/stdioAdapter');
const { resolveExecutable, stripAnsi } = require('./utils');

const ADAPTER_FACTORIES = {
  'acp-rpc': createAcpRpcSession,
  stdio: createStdioSession
};

function loadAgentRegistryFromEnv() {
  const raw = process.env.AGENT_COMMANDS_JSON;
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) || {};
    const entries = Object.entries(parsed);
    const registry = {};
    for (const [agentId, spec] of entries) {
      if (!agentId) continue;
      try {
        registry[agentId] = parseAgentSpec(spec);
      } catch (_error) {
        // Ignore invalid registry entries.
      }
    }
    return registry;
  } catch (_error) {
    return {};
  }
}

function parseAgentSpec(rawSpec) {
  const command = String(rawSpec?.command || '').trim();
  if (command === '') throw new Error('Missing command');
  const adapter = String(rawSpec?.adapter || '').trim();
  if (!ADAPTER_FACTORIES[adapter]) throw new Error(`Unsupported adapter: ${adapter}`);
  const args = Array.isArray(rawSpec?.args) ? rawSpec.args.map((item) => String(item)) : [];
  const mode = String(rawSpec?.mode || rawSpec?.stdinMode || 'text').trim().toLowerCase() || 'text';
  return { command, adapter, args, mode };
}

function buildSpecKey(agentId, spec) {
  return JSON.stringify({
    agentId: String(agentId),
    adapter: String(spec.adapter),
    command: String(spec.command),
    args: Array.isArray(spec?.args) ? spec.args.map((item) => String(item)) : [],
    mode: String(spec.mode || '')
  });
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

  function resolveSpec(requestedAgentId, requestedAgentSpec) {
    const providedId = String(requestedAgentId || '').trim();
    if (requestedAgentSpec) {
      const agentId = providedId || 'selected-agent';
      return { agentId, spec: parseAgentSpec(requestedAgentSpec) };
    }

    if (providedId !== '') {
      const spec = registry[providedId];
      if (spec) return { agentId: providedId, spec };
      throw new Error(`Unsupported agent: ${providedId}`);
    }

    throw new Error('No selected agent. Please choose an agent in sidebar settings.');
  }

  function createSession(tabId, resolved) {
    const { agentId, spec } = resolved;
    const sessionId = crypto.randomUUID();
    const command = resolveExecutable(spec.command);
    const adapter = spec.adapter;
    const args = spec.args || [];
    const mode = spec.mode || 'text';

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

    const factory = ADAPTER_FACTORIES[adapter];
    if (!factory) throw new Error(`Unsupported adapter: ${adapter}`);
    const driver = factory(baseContext);

    const record = {
      tabId,
      sessionId,
      agentId,
      adapter,
      specKey: buildSpecKey(agentId, spec),
      driver,
      closed: false
    };
    sessionsByTabId.set(tabId, record);
    return record;
  }

  function ensureSession(tabId, requestedAgentId, requestedAgentSpec) {
    const resolved = resolveSpec(requestedAgentId, requestedAgentSpec);
    const desiredAgent = resolved.agentId;
    const desiredSpecKey = buildSpecKey(resolved.agentId, resolved.spec);
    const existing = sessionsByTabId.get(tabId);

    if (existing && !existing.closed && existing.agentId === desiredAgent && existing.specKey === desiredSpecKey) {
      return existing;
    }

    if (existing && !existing.closed) {
      closeSession(tabId, 'switch_agent');
    }

    return createSession(tabId, resolved);
  }

  async function handleUserMessage({ tabId, agentId, agentSpec, text }) {
    const numericTabId = Number(tabId);
    if (!Number.isFinite(numericTabId)) return;

    const payload = String(text || '').trim();
    if (payload === '') return;

    try {
      const session = ensureSession(numericTabId, agentId, agentSpec);
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
  loadAgentRegistryFromEnv,
  createAgentBridge
};
