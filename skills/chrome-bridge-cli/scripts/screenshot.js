#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

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
    '  node scripts/screenshot.js [--output <path>] [--format png|jpeg|webp] [--quality 0-100] [--full-page] [common options]',
    '',
    usageCommon()
  ].join('\n');
}

function resolveOutputPath(rawOutput, format) {
  const ext = format === 'jpeg' ? 'jpg' : format;
  if (!rawOutput) {
    return path.resolve(`/tmp/chrome-bridge-screenshot-${Date.now()}.${ext}`);
  }

  const resolved = path.resolve(rawOutput);
  const parsed = path.parse(resolved);
  if (parsed.ext) return resolved;
  return `${resolved}.${ext}`;
}

async function main() {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { common, local } = parseArgs(process.argv.slice(2), {
    '--output': (argv, i, out) => {
      const val = argv[i + 1];
      if (!val) throw new Error('Missing value for --output');
      out.output = val;
      return i + 1;
    },
    '-o': (argv, i, out) => {
      const val = argv[i + 1];
      if (!val) throw new Error('Missing value for -o');
      out.output = val;
      return i + 1;
    },
    '--format': (argv, i, out) => {
      const val = String(argv[i + 1] || '').trim().toLowerCase();
      if (!['png', 'jpeg', 'webp'].includes(val)) {
        throw new Error(`Invalid --format: ${argv[i + 1]}`);
      }
      out.format = val;
      return i + 1;
    },
    '--quality': (argv, i, out) => {
      const raw = argv[i + 1];
      const val = Number(raw);
      if (!Number.isFinite(val) || val < 0 || val > 100) {
        throw new Error(`Invalid --quality: ${raw}`);
      }
      out.quality = Math.round(val);
      return i + 1;
    },
    '--full-page': (_argv, i, out) => {
      out.captureBeyondViewport = true;
      return i;
    }
  });

  const commandResult = await sendCommand({
    command: 'capture_screenshot',
    format: local.format || 'png',
    quality: local.quality == null ? null : local.quality,
    captureBeyondViewport: local.captureBeyondViewport === true,
    ...common
  });

  if (commandResult?.ok !== true) {
    fail(`capture_screenshot request failed: ${JSON.stringify(commandResult)}`);
  }

  const executionResult = commandResult.executionResult;
  if (!executionResult || executionResult.ok !== true) {
    const errorText = executionResult?.error || 'Unknown screenshot error';
    fail(`capture_screenshot failed: ${errorText}`);
  }

  const value = executionResult.result?.value || {};
  const dataBase64 = String(value.dataBase64 || '');
  if (dataBase64 === '') {
    fail('capture_screenshot returned empty image data');
  }

  const format = String(value.format || local.format || 'png').toLowerCase();
  const outputPath = resolveOutputPath(local.output, format);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const buffer = Buffer.from(dataBase64, 'base64');
  fs.writeFileSync(outputPath, buffer);

  printJson({
    ok: true,
    path: outputPath,
    bytes: buffer.length,
    format,
    mimeType: value.mimeType || null,
    targetTabId: value.targetTabId ?? null,
    targetTabUrl: value.targetTabUrl ?? null,
    captureBeyondViewport: value.captureBeyondViewport === true
  });
}

main().catch((err) => fail(`screenshot.js failed: ${err.message}`));
