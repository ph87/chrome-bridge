#!/usr/bin/env node

const http = require('node:http');
const crypto = require('node:crypto');

const { createAgentBridge, loadAgentRegistryFromEnv } = require('./agents');

const HOST_BIND = process.env.CHROME_BRIDGE_BIND || '127.0.0.1';
const HOST_PORT = Number(process.env.CHROME_BRIDGE_PORT || 3456);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 60000);
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 200);

const pendingByTaskId = new Map();
const recentEvents = [];
let inputBuffer = Buffer.alloc(0);
let extensionConnected = false;

function pushEvent(type, details) {
  recentEvents.push({ ts: new Date().toISOString(), type, details: details || {} });
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
}

function sendNative(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
  pushEvent('native_out', { type: message.type || null, taskId: message.taskId || null });
}

const AGENT_REGISTRY = loadAgentRegistryFromEnv();
const agentBridge = createAgentBridge({
  agentRegistry: AGENT_REGISTRY,
  onEvent: (event) => {
    sendNative({ type: 'chat_event', ...event });
  }
});

function resolvePending(taskId, payload) {
  const pending = pendingByTaskId.get(taskId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingByTaskId.delete(taskId);
  pending.resolve(payload);
}

function rejectAllPending(reason) {
  for (const pending of pendingByTaskId.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(reason));
  }
  pendingByTaskId.clear();
}

function handleNativeMessage(message) {
  pushEvent('native_in', { type: message?.type || null, taskId: message?.taskId || null });

  if (message?.type === 'host_status') {
    extensionConnected = true;
    return;
  }

  if (message?.type === 'execution_result' && message?.taskId) {
    resolvePending(message.taskId, message);
    return;
  }

  if (message?.type === 'chat_user_message') {
    void agentBridge.handleUserMessage({
      tabId: message?.tabId,
      agentId: message?.agentId,
      text: message?.text
    });
    return;
  }

  if (message?.type === 'chat_close') {
    agentBridge.closeSession(message?.tabId, 'closed_by_extension');
  }
}

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length >= 4) {
    const length = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + length) return;

    const rawBody = inputBuffer.slice(4, 4 + length).toString('utf8');
    inputBuffer = inputBuffer.slice(4 + length);

    try {
      const message = JSON.parse(rawBody);
      handleNativeMessage(message);
    } catch (error) {
      pushEvent('native_bad_json', { error: String(error) });
    }
  }
});

process.stdin.on('end', () => {
  pushEvent('stdin_end');
  agentBridge.closeAllSessions('native_pipe_ended');
  rejectAllPending('Native messaging pipe ended');
  process.exit(0);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  return JSON.parse(raw);
}

function normalizeCommandBody(body) {
  const taskId = String(body?.taskId || crypto.randomUUID());
  const command = String(body?.command || '').trim().toLowerCase();

  if (command === 'list_tabs') {
    return {
      type: 'list_tabs',
      taskId
    };
  }

  const code = String(body?.code || '').trim();
  if (code === '') throw new Error('`code` is required');

  const targetTabId =
    body?.targetTabId == null || body?.targetTabId === '' ? null : Number(body.targetTabId);
  const targetUrlPattern = String(body?.targetUrlPattern || '').trim() || null;

  return {
    type: 'execute_js',
    taskId,
    code,
    targetTabId: Number.isFinite(targetTabId) ? targetTabId : null,
    targetUrlPattern
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && pathname === '/health') {
      writeJson(res, 200, {
        ok: true,
        bind: HOST_BIND,
        port: HOST_PORT,
        extensionConnected,
        pendingTasks: pendingByTaskId.size,
        chatSessions: agentBridge.getSessionCount()
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/events') {
      writeJson(res, 200, { ok: true, events: recentEvents });
      return;
    }

    if (req.method === 'POST' && pathname === '/command') {
      const body = await readJsonBody(req);
      const command = normalizeCommandBody(body);
      const timeoutMs = Number(body?.timeoutMs) > 0 ? Number(body.timeoutMs) : REQUEST_TIMEOUT_MS;
      const waitForResult = body?.waitForResult !== false;

      sendNative(command);

      if (!waitForResult) {
        writeJson(res, 202, { ok: true, accepted: true, taskId: command.taskId });
        return;
      }

      const executionResult = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingByTaskId.delete(command.taskId);
          reject(new Error(`Timed out waiting for task ${command.taskId}`));
        }, timeoutMs);

        pendingByTaskId.set(command.taskId, { resolve, reject, timeout });
      });

      writeJson(res, 200, { ok: true, taskId: command.taskId, executionResult });
      return;
    }

    writeJson(res, 404, { ok: false, error: 'Not Found' });
  } catch (error) {
    writeJson(res, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(HOST_PORT, HOST_BIND, () => {
  pushEvent('host_start', { bind: HOST_BIND, port: HOST_PORT });
  pushEvent('agent_registry_loaded', { agentIds: agentBridge.getAgentIds() });
  console.error(`[native-host] listening on http://${HOST_BIND}:${HOST_PORT}`);
});
