(function initHelpCommand() {
  function buildLines() {
    return [
      'Available commands:',
      '/page <instruction> - run with current tab context (tab id/url/title).',
      'Auto mode: first non-command message in a tab auto-binds current page context.'
    ];
  }

  globalThis.ChromeBridgeCommandHelp = async function handleHelpCommand(_command, ctx) {
    await ctx.forwardEvent({
      kind: 'assistant_message',
      text: buildLines().join('\n')
    });
    return { accepted: false };
  };
})();
