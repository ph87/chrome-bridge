#!/usr/bin/env node

const {
  parseArgs,
  sendCommand,
  printJson,
  fail
} = require('./_bridge_client');

function usage() {
  return [
    'Usage:',
    '  node scripts/list_frames.js [common options]',
    '',
    'Lists all CDP frames for the target tab.',
    '',
    'Common options:',
    '  --target-tab <id>',
    '  --target-url-pattern <pattern>',
    '  --timeout-ms <ms>'
  ].join('\n');
}

async function main() {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { common, positionals } = parseArgs(process.argv.slice(2));
  if (positionals.length > 0) {
    fail(`${usage()}\n\nError: list_frames.js does not accept positional arguments`);
  }
  if (common.frameId || common.frameUrlPattern) {
    fail(`${usage()}\n\nError: list_frames.js does not accept --frame-id or --frame-url-pattern`);
  }

  const result = await sendCommand({
    command: 'list_frames',
    targetTabId: common.targetTabId,
    targetUrlPattern: common.targetUrlPattern,
    timeoutMs: common.timeoutMs
  });
  printJson(result);
}

main().catch((err) => fail(`list_frames.js failed: ${err.message}`));
