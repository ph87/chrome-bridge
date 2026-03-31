(function initChatCommands() {
  importScripts('commands/help.js', 'commands/page.js');

  const runtimeConfig = globalThis.ChromeBridgeRuntimeConfig || {};
  const autoContextCommand = String(runtimeConfig.autoContextCommand || '').trim().toLowerCase();

  const HANDLERS = {
    help: globalThis.ChromeBridgeCommandHelp,
    page: globalThis.ChromeBridgeCommandPage
  };

  globalThis.ChromeBridgeCommands = {
    parse(text) {
      const raw = String(text || '').trim();
      if (!raw.startsWith('/')) return null;

      const firstSpaceIdx = raw.indexOf(' ');
      const head = firstSpaceIdx === -1 ? raw : raw.slice(0, firstSpaceIdx);
      const args = firstSpaceIdx === -1 ? '' : raw.slice(firstSpaceIdx + 1).trim();
      const name = head.slice(1).trim().toLowerCase();
      if (name === '') return null;

      return { name, args, raw };
    },

    async handle(command, ctx) {
      const handler = HANDLERS[command?.name];
      if (!handler) {
        await ctx.forwardEvent({
          kind: 'error',
          text: `Unknown command: /${command?.name || ''}. Use /help.`
        });
        return { accepted: false };
      }

      return handler(command, ctx);
    },

    getAutoPersistContext(ctx) {
      if (autoContextCommand === '') return null;
      const handler = HANDLERS[autoContextCommand];
      if (!handler || typeof handler.getAutoPersistContext !== 'function') return null;
      return handler.getAutoPersistContext({ name: autoContextCommand, args: '', raw: '' }, ctx);
    }
  };
})();
