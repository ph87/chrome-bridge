function resolveExecutable(command) {
  const cleaned = String(command || '').trim();
  if (cleaned === '') {
    throw new Error('Agent command is empty');
  }
  return cleaned;
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1B\[[0-9;]*m/g, '');
}

module.exports = {
  resolveExecutable,
  stripAnsi
};
