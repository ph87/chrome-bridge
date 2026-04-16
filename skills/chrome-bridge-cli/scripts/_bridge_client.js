#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_PATH =
  process.env.CHROME_BRIDGE_CONFIG_PATH || path.join(os.homedir(), '.chrome-bridge', 'config.json');

function loadConfig() {
  let parsed = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to read config at ${CONFIG_PATH}. Run setup first (./scripts/setup.sh <EXTENSION_ID>). ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const host = String(parsed.host || '').trim() || '127.0.0.1';
  const port = Number(parsed.port);
  const token = String(parsed.token || '').trim();

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port in config: ${parsed.port}`);
  }
  if (token === '') {
    throw new Error('Missing token in config');
  }

  return { host, port, token };
}

let runtimeConfigCache = null;

function getRuntimeConfig() {
  if (runtimeConfigCache) return runtimeConfigCache;
  const config = loadConfig();
  runtimeConfigCache = {
    hostUrl: process.env.HOST_URL || `http://${config.host}:${config.port}`,
    token: process.env.HOST_TOKEN || config.token
  };
  return runtimeConfigCache;
}

function usageCommon() {
  return [
    'Common options:',
    '  --target-tab <id>',
    '  --target-url-pattern <pattern>',
    '  --frame-id <cdp frame id>',
    '  --frame-url-pattern <pattern>',
    '  --timeout-ms <ms>'
  ].join('\n');
}

function parseArgs(argv, handlers = {}) {
  const common = {
    targetTabId: null,
    targetUrlPattern: null,
    frameId: null,
    frameUrlPattern: null,
    timeoutMs: null
  };
  const local = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--target-tab') {
      const raw = argv[++i];
      const val = Number(raw);
      if (!Number.isFinite(val)) throw new Error(`Invalid --target-tab: ${raw}`);
      common.targetTabId = val;
      continue;
    }

    if (arg === '--target-url-pattern') {
      const val = argv[++i];
      if (!val) throw new Error('Missing value for --target-url-pattern');
      common.targetUrlPattern = val;
      continue;
    }

    if (arg === '--timeout-ms') {
      const raw = argv[++i];
      const val = Number(raw);
      if (!Number.isFinite(val) || val <= 0) throw new Error(`Invalid --timeout-ms: ${raw}`);
      common.timeoutMs = val;
      continue;
    }

    if (arg === '--frame-id') {
      const val = String(argv[++i] || '').trim();
      if (val === '') throw new Error('Missing value for --frame-id');
      common.frameId = val;
      continue;
    }

    if (arg === '--frame-url-pattern') {
      const val = String(argv[++i] || '').trim();
      if (val === '') throw new Error('Missing value for --frame-url-pattern');
      common.frameUrlPattern = val;
      continue;
    }

    const handler = handlers[arg];
    if (handler) {
      i = handler(argv, i, local);
      continue;
    }

    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    positionals.push(arg);
  }

  return { common, local, positionals };
}

async function sendCode({ code, targetTabId, targetUrlPattern, frameId, frameUrlPattern, timeoutMs }) {
  return sendCommand({
    code,
    targetTabId,
    targetUrlPattern,
    frameId: frameId || null,
    frameUrlPattern: frameUrlPattern || null,
    timeoutMs
  });
}

async function sendCommand(payload) {
  const runtimeConfig = getRuntimeConfig();
  const res = await fetch(`${runtimeConfig.hostUrl}/command`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${runtimeConfig.token}`
    },
    body: JSON.stringify(payload)
  });

  let json;
  try {
    json = await res.json();
  } catch {
    const text = await res.text();
    throw new Error(`Host returned non-JSON response: ${text}`);
  }
  return json;
}

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

module.exports = {
  usageCommon,
  parseArgs,
  sendCommand,
  sendCode,
  printJson,
  fail
};
