import type { Command, CommandContext } from '../args.js';

/** `compact`: rewrite the memories, sources and grants journals with only live records (the audit journal is never compacted). */
export const compact: Command = {
  spec: {
    name: 'compact',
    args: '',
    summary: 'Rewrite the memories, sources and grants journals without superseded lines',
    details:
      'Deleted records already leave the live files when they are forgotten; compact also drops the older versions of updated records (re-imports, review changes). Safe while servers run: they reload on the generation change. The audit journal is append-only and never compacted. Logged in the audit journal as a cli event.',
    flags: [],
  },
  run(ctx: CommandContext): number {
    const store = ctx.openStore();
    try {
      const before = store.manifest.gens;
      store.compact();
      const after = store.manifest.gens;
      ctx.audit(store, 'compact', { gens: after });
      if (ctx.json) ctx.print(`${JSON.stringify({ before, after })}\n`);
      else ctx.print(`compacted: memories ${before.memories} → ${after.memories}, sources ${before.sources} → ${after.sources}, grants ${before.grants} → ${after.grants}\n`);
      return 0;
    } finally {
      store.close();
    }
  },
};
