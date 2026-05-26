#!/usr/bin/env node

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentBridge, loadAgentRegistryFromEnv } = require('./agents');

const CONFIG_PATH =
  process.env.CHROME_BRIDGE_CONFIG_PATH || path.join(os.homedir(), '.chrome-bridge', 'config.json');
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 60000);
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 200);
const DEFAULT_MODE = 'http';
const DEFAULT_BIND = '127.0.0.1';
const DEFAULT_PORT = 3456;
const DEFAULT_SOCKET_BASENAME = 'bridge.sock';

const bridgeConfig = loadBridgeConfig();
const TRANSPORT_MODE = bridgeConfig.mode;
const STARTUP_HOST_PORT = bridgeConfig.hostPort;
const HTTP_ENDPOINT = splitHostPort(STARTUP_HOST_PORT);
if (!HTTP_ENDPOINT) {
  throw new Error(`Invalid hostPort in config: ${STARTUP_HOST_PORT}`);
}
const HOST_BIND = HTTP_ENDPOINT.host;
const HOST_PORT = HTTP_ENDPOINT.port;
const SOCKET_PATH = bridgeConfig.socketPath;
let AUTH_TOKEN = bridgeConfig.token;

const pendingByTaskId = new Map();
const recentEvents = [];
let inputBuffer = Buffer.alloc(0);
let extensionConnected = false;

function pushEvent(type, details) {
  recentEvents.push({ ts: new Date().toISOString(), type, details: details || {} });
  if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
}

function normalizeHost(value) {
  const host = String(value || '').trim();
  return host === '' ? null : host;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function normalizeToken(value) {
  const token = String(value || '').trim();
  return token === '' ? null : token;
}

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'http' || mode === 'ipc') return mode;
  return null;
}

function normalizeSocketPath(value) {
  const raw = String(value || '').trim();
  if (raw === '') return null;
  return path.resolve(raw);
}

function normalizeHostPort(value) {
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

function legacyHostPort(host, port) {
  const hostValue = normalizeHost(host);
  const portValue = normalizePort(port);
  if (!hostValue || !portValue) return null;
  return `${hostValue}:${portValue}`;
}

function splitHostPort(hostPort) {
  const normalized = normalizeHostPort(hostPort);
  if (!normalized) return null;
  const sep = normalized.lastIndexOf(':');
  return {
    host: normalized.slice(0, sep),
    port: Number(normalized.slice(sep + 1)),
    hostPort: normalized
  };
}

function readConfigFromDisk() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (_error) {
    return null;
  }
}

function writeConfigToDisk(config) {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${CONFIG_PATH}.tmp`, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(`${CONFIG_PATH}.tmp`, CONFIG_PATH);
}

function sanitizeConfig(value) {
  const configDir = path.dirname(CONFIG_PATH);
  const mode = normalizeMode(value?.mode) || DEFAULT_MODE;
  const hostPort =
    normalizeHostPort(value?.hostPort) ||
    legacyHostPort(value?.host, value?.port) ||
    `${DEFAULT_BIND}:${DEFAULT_PORT}`;
  const socketPath =
    normalizeSocketPath(value?.socketPath) || path.join(configDir, DEFAULT_SOCKET_BASENAME);
  const token = normalizeToken(value?.token) || crypto.randomUUID();
  return { mode, hostPort, socketPath, token };
}

function loadBridgeConfig() {
  const disk = sanitizeConfig(readConfigFromDisk());
  const mode = normalizeMode(process.env.CHROME_BRIDGE_MODE) || disk.mode;
  const envHostPort =
    normalizeHostPort(process.env.CHROME_BRIDGE_HOST_PORT) ||
    legacyHostPort(process.env.CHROME_BRIDGE_BIND, process.env.CHROME_BRIDGE_PORT);
  const hostPort = envHostPort || disk.hostPort;
  const socketPath = normalizeSocketPath(process.env.CHROME_BRIDGE_SOCKET_PATH) || disk.socketPath;
  const token = normalizeToken(process.env.CHROME_BRIDGE_TOKEN) || disk.token;
  const next = sanitizeConfig({ mode, hostPort, socketPath, token });
  writeConfigToDisk(next);
  return next;
}

function getBearerToken(req) {
  const raw = String(req.headers.authorization || '').trim();
  if (raw === '') return null;
  const match = raw.match(/^Bearer:?\s+(.+)$/i);
  if (!match) return null;
  const token = String(match[1] || '').trim();
  return token === '' ? null : token;
}

function ensureAuthorized(req, res) {
  const token = getBearerToken(req);
  if (token !== AUTH_TOKEN) {
    writeJson(res, 401, { ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

function sendConfigResult(taskId, payload) {
  sendNative({
    type: 'config_result',
    taskId,
    ...payload
  });
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
  const type = message?.type || null;
  pushEvent('native_in', { type, taskId: message?.taskId || null });

  switch (type) {
    case 'host_status':
      extensionConnected = true;
      return;
    case 'execution_result':
      if (message?.taskId) resolvePending(message.taskId, message);
      return;
    case 'chat_user_message':
      void agentBridge.handleUserMessage({
        tabId: message?.tabId,
        agentId: message?.agentId,
        agentSpec: message?.agentSpec,
        text: message?.text
      });
      return;
    case 'chat_close':
      agentBridge.closeSession(message?.tabId, 'closed_by_extension');
      return;
    case 'config_get': {
      const taskId = String(message?.taskId || '');
      if (taskId === '') return;
      sendConfigResult(taskId, {
        ok: true,
        config: {
          mode: bridgeConfig.mode,
          hostPort: bridgeConfig.hostPort,
          socketPath: bridgeConfig.socketPath,
          token: AUTH_TOKEN
        }
      });
      return;
    }
    case 'config_set': {
      const taskId = String(message?.taskId || '');
      if (taskId === '') return;
      const requested = message?.config;
      const mode = normalizeMode(requested?.mode) || bridgeConfig.mode;
      const hostPort =
        normalizeHostPort(requested?.hostPort) ||
        legacyHostPort(requested?.host, requested?.port) ||
        bridgeConfig.hostPort;
      const socketPath = normalizeSocketPath(requested?.socketPath) || bridgeConfig.socketPath;
      const token = normalizeToken(requested?.token) || AUTH_TOKEN;
      const restartRequired =
        mode !== TRANSPORT_MODE ||
        (mode === 'http' && hostPort !== STARTUP_HOST_PORT) ||
        (mode === 'ipc' && socketPath !== SOCKET_PATH);
      bridgeConfig.mode = mode;
      bridgeConfig.hostPort = hostPort;
      bridgeConfig.socketPath = socketPath;
      AUTH_TOKEN = token;
      writeConfigToDisk({ mode, hostPort, socketPath, token });
      sendConfigResult(taskId, {
        ok: true,
        config: { mode, hostPort, socketPath, token },
        restartRequired,
        note: restartRequired
          ? 'Bridge transport updated. Restarting native host to apply changes.'
          : 'Bridge config saved.'
      });
      return;
    }
    case 'config_refresh_token': {
      const taskId = String(message?.taskId || '');
      if (taskId === '') return;
      const token = crypto.randomUUID();
      AUTH_TOKEN = token;
      writeConfigToDisk({
        mode: bridgeConfig.mode,
        hostPort: bridgeConfig.hostPort,
        socketPath: bridgeConfig.socketPath,
        token
      });
      sendConfigResult(taskId, {
        ok: true,
        config: {
          mode: bridgeConfig.mode,
          hostPort: bridgeConfig.hostPort,
          socketPath: bridgeConfig.socketPath,
          token
        }
      });
      return;
    }
    default:
      return;
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
  if (TRANSPORT_MODE === 'ipc') {
    try {
      if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    } catch (_error) {
      // Best-effort cleanup.
    }
  }
  process.exit(0);
});

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

  if (command === 'list_frames') {
    const targetTabId =
      body?.targetTabId == null || body?.targetTabId === '' ? null : Number(body.targetTabId);
    const targetUrlPattern = String(body?.targetUrlPattern || '').trim() || null;
    return {
      type: 'list_frames',
      taskId,
      targetTabId: Number.isFinite(targetTabId) ? targetTabId : null,
      targetUrlPattern
    };
  }

  if (command === 'close_tab') {
    const targetTabId =
      body?.targetTabId == null || body?.targetTabId === '' ? null : Number(body.targetTabId);
    if (!Number.isFinite(targetTabId)) {
      throw new Error('`targetTabId` is required for `close_tab`');
    }

    return {
      type: 'close_tab',
      taskId,
      targetTabId
    };
  }

  if (command === 'capture_screenshot') {
    const targetTabId =
      body?.targetTabId == null || body?.targetTabId === '' ? null : Number(body.targetTabId);
    const targetUrlPattern = String(body?.targetUrlPattern || '').trim() || null;
    const format = String(body?.format || '').trim().toLowerCase() || 'png';
    const quality = body?.quality == null || body?.quality === '' ? null : Number(body.quality);
    const captureBeyondViewport =
      body?.captureBeyondViewport == null ? false : Boolean(body.captureBeyondViewport);

    if (!['png', 'jpeg', 'webp'].includes(format)) {
      throw new Error('`format` must be one of: png, jpeg, webp');
    }
    if (quality != null && (!Number.isFinite(quality) || quality < 0 || quality > 100)) {
      throw new Error('`quality` must be a number in range 0..100');
    }

    return {
      type: 'capture_screenshot',
      taskId,
      targetTabId: Number.isFinite(targetTabId) ? targetTabId : null,
      targetUrlPattern,
      format,
      quality: quality == null ? null : Math.round(quality),
      captureBeyondViewport
    };
  }

  if (command === 'capture_network') {
    const targetTabId =
      body?.targetTabId == null || body?.targetTabId === '' ? null : Number(body.targetTabId);
    const targetUrlPattern = String(body?.targetUrlPattern || '').trim() || null;
    const durationMs = body?.durationMs == null || body?.durationMs === '' ? 5000 : Number(body.durationMs);
    const maxEntries = body?.maxEntries == null || body?.maxEntries === '' ? 200 : Number(body.maxEntries);
    const includeBodies = body?.includeBodies === true;
    const reload = body?.reload === true;

    if (!Number.isFinite(durationMs) || durationMs < 250 || durationMs > 60000) {
      throw new Error('`durationMs` must be a number in range 250..60000');
    }
    if (!Number.isFinite(maxEntries) || maxEntries < 1 || maxEntries > 2000) {
      throw new Error('`maxEntries` must be a number in range 1..2000');
    }

    return {
      type: 'capture_network',
      taskId,
      targetTabId: Number.isFinite(targetTabId) ? targetTabId : null,
      targetUrlPattern,
      durationMs: Math.round(durationMs),
      maxEntries: Math.round(maxEntries),
      includeBodies,
      reload
    };
  }

  const code = String(body?.code || '').trim();
  if (code === '') throw new Error('`code` is required');

  const targetTabId =
    body?.targetTabId == null || body?.targetTabId === '' ? null : Number(body.targetTabId);
  const targetUrlPattern = String(body?.targetUrlPattern || '').trim() || null;
  const frameId = String(body?.frameId || '').trim() || null;
  const frameUrlPattern = String(body?.frameUrlPattern || '').trim() || null;
  if (frameId && frameUrlPattern) {
    throw new Error('`frameId` and `frameUrlPattern` are mutually exclusive');
  }

  return {
    type: 'execute_js',
    taskId,
    code,
    targetTabId: Number.isFinite(targetTabId) ? targetTabId : null,
    targetUrlPattern,
    frameId,
    frameUrlPattern
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ensureAuthorized(req, res)) return;

    const pathname = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && pathname === '/health') {
      writeJson(res, 200, {
        ok: true,
        mode: TRANSPORT_MODE,
        bind: HOST_BIND,
        port: HOST_PORT,
        socketPath: SOCKET_PATH,
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

function cleanupIpcSocket() {
  if (TRANSPORT_MODE !== 'ipc') return;
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  } catch (_error) {
    // Best-effort cleanup.
  }
}

process.on('SIGINT', () => {
  cleanupIpcSocket();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupIpcSocket();
  process.exit(0);
});

if (TRANSPORT_MODE === 'ipc') {
  try {
    fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
    if (fs.existsSync(SOCKET_PATH)) {
      const stat = fs.lstatSync(SOCKET_PATH);
      if (!stat.isSocket()) {
        throw new Error(`Refusing to overwrite non-socket path: ${SOCKET_PATH}`);
      }
      fs.unlinkSync(SOCKET_PATH);
    }
  } catch (error) {
    console.error(`[native-host] failed to prepare socket path: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  server.listen(SOCKET_PATH, () => {
    pushEvent('host_start', { mode: TRANSPORT_MODE, socketPath: SOCKET_PATH });
    pushEvent('agent_registry_loaded', { agentIds: agentBridge.getAgentIds() });
    pushEvent('auth_enabled', { configPath: CONFIG_PATH });
    console.error(`[native-host] listening on ipc://${SOCKET_PATH} (auth enabled)`);
  });

  server.on('close', cleanupIpcSocket);
} else {
  server.listen(HOST_PORT, HOST_BIND, () => {
    pushEvent('host_start', { mode: TRANSPORT_MODE, bind: HOST_BIND, port: HOST_PORT });
    pushEvent('agent_registry_loaded', { agentIds: agentBridge.getAgentIds() });
    pushEvent('auth_enabled', { configPath: CONFIG_PATH });
    console.error(`[native-host] listening on http://${HOST_BIND}:${HOST_PORT} (auth enabled)`);
  });
}
