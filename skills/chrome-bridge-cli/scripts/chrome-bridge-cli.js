#!/usr/bin/env node

const {
  sendGet,
  sendCommand
} = require('./_bridge_client');

function usage() {
  process.stdout.write(`Usage:
  chrome-bridge-cli.js --health
  chrome-bridge-cli.js --events
  chrome-bridge-cli.js --code "document.title='EXEC_OK'" [--target-tab 123] [--target-url-pattern google.com] [--frame-id <id> | --frame-url-pattern <pattern>] [--timeout-ms 20000]
  chrome-bridge-cli.js --open-url "https://example.com" [--target-tab 123] [--target-url-pattern example.com]
  chrome-bridge-cli.js --close-tab 123 [--timeout-ms 20000]
  chrome-bridge-cli.js --capture-network [--duration-ms 5000] [--max-entries 200] [--include-bodies] [--reload] [--target-tab 123 | --target-url-pattern example.com]
`);
}

function fail(message, withUsage = false) {
  process.stderr.write(`${message}\n`);
  if (withUsage) usage();
  process.exit(1);
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
  let durationMs = '';
  let maxEntries = '';
  let includeBodies = false;
  let reload = false;
  let mode = 'command';
  let captureNetwork = false;

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
    if (arg === '--duration-ms') {
      durationMs = argv[++i] ?? '';
      continue;
    }
    if (arg === '--max-entries') {
      maxEntries = argv[++i] ?? '';
      continue;
    }
    if (arg === '--include-bodies') {
      includeBodies = true;
      continue;
    }
    if (arg === '--reload') {
      reload = true;
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
    if (arg === '--capture-network') {
      captureNetwork = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      usage();
      return;
    }
    fail(`Unknown arg: ${arg}`, true);
  }

  if (mode === 'health') {
    const body = await sendGet('/health');
    process.stdout.write(`${JSON.stringify(body)}\n`);
    return;
  }

  if (mode === 'events') {
    const body = await sendGet('/events');
    process.stdout.write(`${JSON.stringify(body)}\n`);
    return;
  }

  let command = null;
  if (captureNetwork) {
    if (code !== '' || openUrl !== '' || closeTab !== '') {
      fail('Error: --capture-network cannot be combined with --code, --open-url, or --close-tab', true);
    }
    if (frameId !== '' || frameUrlPattern !== '') {
      fail('Error: --capture-network does not support --frame-id or --frame-url-pattern', true);
    }
    command = 'capture_network';
  } else if (closeTab !== '') {
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
    timeoutMs: timeoutMs === '' ? null : Number(timeoutMs),
    durationMs: durationMs === '' ? null : Number(durationMs),
    maxEntries: maxEntries === '' ? null : Number(maxEntries),
    includeBodies,
    reload
  };

  if (payload.frameId && payload.frameUrlPattern) {
    fail('Error: --frame-id and --frame-url-pattern are mutually exclusive', true);
  }

  const body = await sendCommand(payload);
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

void main(process.argv.slice(2)).catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
