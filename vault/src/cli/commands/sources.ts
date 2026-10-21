import { ReviewStatus, SourceType, type SourceFilter } from '../../types.js';
import type { Command, CommandContext } from '../args.js';
import { renderTable } from '../table.js';

const DEFAULT_LIMIT = 50;

/** `sources`: the raw-source table, newest first, with trust and review state. */
export const sources: Command = {
  spec: {
    name: 'sources',
    args: '',
    summary: 'List sources (imported conversations and documents) with trust and review state',
    details: 'TRUST is "imported" for files you imported and "agent-supplied" for sources an MCP client filed with vault_source_add (those cannot be verified against anything). RAW says whether the untouched vendor record was kept.',
    flags: [
      { name: 'review', type: 'string', placeholder: ReviewStatus.options.join('|'), help: 'this review state only' },
      { name: 'type', type: 'string', placeholder: SourceType.options.join('|'), help: 'this source type only' },
      { name: 'limit', type: 'string', placeholder: '<n>', help: `max rows (default ${DEFAULT_LIMIT})` },
    ],
  },
  run(ctx: CommandContext): number {
    const filter: SourceFilter = {};
    const review = ctx.flags.choice('review', ReviewStatus.options);
    if (review !== undefined) filter.review = review;
    const type = ctx.flags.choice('type', SourceType.options);
    if (type !== undefined) filter.type = type;
    const limit = ctx.flags.int('limit') ?? DEFAULT_LIMIT;
    const store = ctx.openStore();
    try {
      const all = store.listSources(filter);
      const shown = all.slice(0, limit);
      if (ctx.json) {
        ctx.print(`${JSON.stringify({ total: all.length, sources: shown })}\n`);
        return 0;
      }
      if (shown.length === 0) {
        ctx.print('no sources\n');
        ctx.info('run: opencontext-vault import <export folder>\n');
        return 0;
      }
      ctx.print(
        renderTable(
          ['ID', 'TYPE', 'TRUST', 'TITLE', 'TURNS', 'CREATED', 'REVIEW', 'RAW'],
          shown.map((s) => [s.id, s.type, s.origin.trust, s.title, String(s.turnCount), s.createdAt.slice(0, 10), s.review.status, s.hasRaw ? 'yes' : 'no']),
          { 3: 50 },
        ),
      );
      if (all.length > shown.length) ctx.info(`… ${all.length - shown.length} more (use --limit)\n`);
      return 0;
    } finally {
      store.close();
    }
  },
};
