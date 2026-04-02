(function initChromeBridgeRuntimeConfig() {
  const DEFAULTS = {
    defaultAgentId: '',
    autoContextEnabled: true,
    autoContextCommand: 'page'
  };

  globalThis.ChromeBridgeRuntimeConfig = {
    ...DEFAULTS,
    ...(globalThis.ChromeBridgeRuntimeConfig || {})
  };
})();
