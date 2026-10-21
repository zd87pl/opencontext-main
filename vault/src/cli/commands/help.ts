import type { Command, CommandContext } from '../args.js';

/** `help`: the generated reference (the same text the README carries between its cli markers). */
export const help: Command = {
  spec: {
    name: 'help',
    args: '[command]',
    summary: 'Show this reference, or the details of one command',
    details: 'Generated from the command table, so it cannot drift from what the binary accepts; test/cli-help.test.ts checks the README copy against it.',
    flags: [],
  },
  run(ctx: CommandContext): number {
    ctx.print(ctx.helpText(ctx.positionals[0]));
    return 0;
  },
};
