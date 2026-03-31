const fs = require('node:fs');
const path = require('node:path');

function parseArgsJson(raw, fallback) {
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    return parsed.map((item) => String(item));
  } catch (_error) {
    return fallback;
  }
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function resolveExecutable(command) {
  const cleaned = String(command || '').trim();
  if (cleaned === '') {
    throw new Error('Agent command is empty');
  }

  if (cleaned.includes('/')) {
    if (isExecutable(cleaned)) return cleaned;
    throw new Error(`Agent command is not executable: ${cleaned}`);
  }

  const envPath = String(process.env.PATH || '');
  const searchDirs = [
    ...envPath.split(path.delimiter).filter(Boolean),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ];

  for (const dir of searchDirs) {
    const candidate = path.join(dir, cleaned);
    if (isExecutable(candidate)) return candidate;
  }

  throw new Error(
    `Executable not found: ${cleaned}. Set CODEX_ACP_COMMAND to an absolute path, for example /opt/homebrew/bin/${cleaned}`
  );
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1B\[[0-9;]*m/g, '');
}

module.exports = {
  parseArgsJson,
  resolveExecutable,
  stripAnsi
};
