#!/usr/bin/env node

const {
  usageCommon,
  parseArgs,
  sendCommand,
  printJson,
  fail
} = require('./_bridge_client');

function usage() {
  return [
    'Usage:',
    '  node scripts/network.js [--duration-ms <ms>] [--max-entries <n>] [--include-bodies] [--reload] [common options]',
    '',
    'Captures network requests and responses for the target tab during the given time window.',
    '',
    usageCommon()
  ].join('\n');
}

async function main() {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { common, local, positionals } = parseArgs(process.argv.slice(2), {
    '--duration-ms': (argv, i, out) => {
      const raw = argv[i + 1];
      const val = Number(raw);
      if (!Number.isFinite(val) || val < 250 || val > 60000) {
        throw new Error(`Invalid --duration-ms: ${raw}`);
      }
      out.durationMs = Math.round(val);
      return i + 1;
    },
    '--max-entries': (argv, i, out) => {
      const raw = argv[i + 1];
      const val = Number(raw);
      if (!Number.isFinite(val) || val < 1 || val > 2000) {
        throw new Error(`Invalid --max-entries: ${raw}`);
      }
      out.maxEntries = Math.round(val);
      return i + 1;
    },
    '--include-bodies': (_argv, i, out) => {
      out.includeBodies = true;
      return i;
    },
    '--reload': (_argv, i, out) => {
      out.reload = true;
      return i;
    }
  });

  if (positionals.length > 0) {
    fail(`${usage()}\n\nError: network.js does not accept positional arguments`);
  }
  if (common.frameId || common.frameUrlPattern) {
    fail(`${usage()}\n\nError: network.js does not accept --frame-id or --frame-url-pattern`);
  }

  const result = await sendCommand({
    command: 'capture_network',
    durationMs: local.durationMs == null ? 5000 : local.durationMs,
    maxEntries: local.maxEntries == null ? 200 : local.maxEntries,
    includeBodies: local.includeBodies === true,
    reload: local.reload === true,
    targetTabId: common.targetTabId,
    targetUrlPattern: common.targetUrlPattern,
    timeoutMs: common.timeoutMs
  });
  printJson(result);
}

main().catch((err) => fail(`network.js failed: ${err.message}`));
