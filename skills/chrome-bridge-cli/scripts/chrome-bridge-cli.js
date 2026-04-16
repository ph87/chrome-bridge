#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_PATH =
  process.env.CHROME_BRIDGE_CONFIG_PATH || path.join(os.homedir(), '.chrome-bridge', 'config.json');

function usage() {
  process.stdout.write(`Usage:
  chrome-bridge-cli.js --health
  chrome-bridge-cli.js --events
  chrome-bridge-cli.js --code "document.title='EXEC_OK'" [--target-tab 123] [--target-url-pattern google.com] [--frame-id <id> | --frame-url-pattern <pattern>] [--timeout-ms 20000]
  chrome-bridge-cli.js --open-url "https://example.com" [--target-tab 123] [--target-url-pattern example.com]
  chrome-bridge-cli.js --close-tab 123 [--timeout-ms 20000]
`);
}

function fail(message, withUsage = false) {
  process.stderr.write(`${message}\n`);
  if (withUsage) usage();
  process.exit(1);
}

function loadRuntimeConfig() {
  const hostUrl = String(process.env.HOST_URL || '').trim();
  const authToken = String(process.env.HOST_TOKEN || '').trim();
  if (hostUrl !== '' && authToken !== '') return { hostUrl, authToken };

  if (!fs.existsSync(CONFIG_PATH)) {
    fail(`Error: missing config file: ${CONFIG_PATH}\nRun setup first: ./scripts/setup.sh <EXTENSION_ID>`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    fail(`Error: failed to parse config file: ${CONFIG_PATH}\n${error instanceof Error ? error.message : String(error)}`);
  }

  const host = String(parsed?.host || '').trim() || '127.0.0.1';
  const port = Number(parsed?.port);
  const token = String(parsed?.token || '').trim();

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`Invalid port in ${CONFIG_PATH}`);
  }
  if (token === '') {
    fail(`Missing token in ${CONFIG_PATH}`);
  }

  return {
    hostUrl: hostUrl || `http://${host}:${port}`,
    authToken: authToken || token
  };
}

async function requestGet(runtimeConfig, endpoint) {
  const res = await fetch(`${runtimeConfig.hostUrl}${endpoint}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${runtimeConfig.authToken}`
    }
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${body}`);
  }
  process.stdout.write(body);
}

async function requestPost(runtimeConfig, payload) {
  const res = await fetch(`${runtimeConfig.hostUrl}/command`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${runtimeConfig.authToken}`
    },
    body: JSON.stringify(payload)
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${body}`);
  }
  process.stdout.write(body);
}

async function main(argv) {
  let code = '';
  let openUrl = '';
  let closeTab = '';
  let targetTab = '';
  let targetUrlPattern = '';
  let frameId = '';
  let frameUrlPattern = '';
  let timeoutMs = '';
  let mode = 'command';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--code') {
      code = argv[++i] ?? '';
      continue;
    }
    if (arg === '--open-url') {
      openUrl = argv[++i] ?? '';
      continue;
    }
    if (arg === '--close-tab') {
      closeTab = argv[++i] ?? '';
      continue;
    }
    if (arg === '--target-tab') {
      targetTab = argv[++i] ?? '';
      continue;
    }
    if (arg === '--target-url-pattern') {
      targetUrlPattern = argv[++i] ?? '';
      continue;
    }
    if (arg === '--timeout-ms') {
      timeoutMs = argv[++i] ?? '';
      continue;
    }
    if (arg === '--frame-id') {
      frameId = argv[++i] ?? '';
      continue;
    }
    if (arg === '--frame-url-pattern') {
      frameUrlPattern = argv[++i] ?? '';
      continue;
    }
    if (arg === '--health') {
      mode = 'health';
      continue;
    }
    if (arg === '--events') {
      mode = 'events';
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      usage();
      return;
    }
    fail(`Unknown arg: ${arg}`, true);
  }

  const runtimeConfig = loadRuntimeConfig();

  if (mode === 'health') {
    await requestGet(runtimeConfig, '/health');
    return;
  }

  if (mode === 'events') {
    await requestGet(runtimeConfig, '/events');
    return;
  }

  let command = null;
  if (closeTab !== '') {
    if (code !== '' || openUrl !== '') {
      fail('Error: --close-tab cannot be combined with --code or --open-url', true);
    }
    if (targetUrlPattern !== '') {
      fail('Error: --close-tab cannot be combined with --target-url-pattern', true);
    }
    targetTab = closeTab;
    command = 'close_tab';
  } else {
    if (code === '' && openUrl !== '') {
      code = `window.open('${openUrl}', '_blank');`;
    }
    if (code === '') {
      fail('Error: provide --code, --open-url, or --close-tab', true);
    }
  }

  const payload = {
    command,
    code,
    targetTabId: targetTab === '' ? null : Number(targetTab),
    targetUrlPattern: targetUrlPattern === '' ? null : targetUrlPattern,
    frameId: frameId === '' ? null : String(frameId),
    frameUrlPattern: frameUrlPattern === '' ? null : String(frameUrlPattern),
    timeoutMs: timeoutMs === '' ? null : Number(timeoutMs)
  };

  if (payload.frameId && payload.frameUrlPattern) {
    fail('Error: --frame-id and --frame-url-pattern are mutually exclusive', true);
  }

  await requestPost(runtimeConfig, payload);
}

void main(process.argv.slice(2)).catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
