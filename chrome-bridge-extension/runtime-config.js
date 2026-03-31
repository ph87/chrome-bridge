(function initChromeBridgeRuntimeConfig() {
  const DEFAULTS = {
    defaultAgentId: 'codex-acp',
    autoContextEnabled: true,
    autoContextCommand: 'page'
  };

  globalThis.ChromeBridgeRuntimeConfig = {
    ...DEFAULTS,
    ...(globalThis.ChromeBridgeRuntimeConfig || {})
  };
})();
