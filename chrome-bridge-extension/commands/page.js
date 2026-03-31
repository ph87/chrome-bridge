(function initPageCommand() {
  function buildPersistContext(ctx) {
    const tabId = ctx?.tab?.id;
    if (tabId == null) return null;

    const tabUrl = String(ctx?.tab?.url || '').trim() || 'unknown';
    const tabTitle = String(ctx?.tab?.title || '').trim() || 'unknown';
    const contextPrefix = [
      'Command context: /page',
      `Target tab id: ${tabId}`,
      `Target tab url: ${tabUrl}`,
      `Target tab title: ${tabTitle}`,
      'Interpretation: the user wants actions on this exact tab unless they explicitly ask otherwise.',
      'Execution rule: you must use the "chrome-bridge-skill" to inspect and interact with any mentioned web page.'
    ].join('\n');
    if (contextPrefix === '') return null;
    return {
      scope: 'tab',
      prefix: contextPrefix
    };
  }

  globalThis.ChromeBridgeCommandPage = async function handlePageCommand(command, ctx) {
    const request = String(command?.args || '').trim();
    if (request === '') {
      await ctx.forwardEvent({
        kind: 'error',
        text: 'Usage: /page <instruction>'
      });
      return { accepted: false };
    }

    const persistContext = buildPersistContext(ctx);
    if (!persistContext) {
      await ctx.forwardEvent({
        kind: 'error',
        text: 'Unable to build /page context for this tab.'
      });
      return { accepted: false };
    }

    const bridgedPrompt = [persistContext.prefix, `User request: ${request}`].join('\n');

    ctx.sendToNative({
      type: 'chat_user_message',
      tabId: ctx.tab.id,
      agentId: ctx.agentId,
      text: bridgedPrompt
    });

    return {
      accepted: true,
      persistContext
    };
  };

  globalThis.ChromeBridgeCommandPage.getAutoPersistContext = function getAutoPersistContext(_command, ctx) {
    return buildPersistContext(ctx);
  };
})();
