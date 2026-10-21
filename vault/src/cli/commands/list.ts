import { MemoryKind, type MemoryFilter } from '../../types.js';
import { normalizeTags } from '../../util/text.js';
import { parseSince, type Command, type CommandContext } from '../args.js';
import { renderTable } from '../table.js';

const DEFAULT_LIMIT = 50;

/** `list`: memories as a table, newest update first. */
export const list: Command = {
  spec: {
    name: 'list',
    args: '',
    summary: 'List memories (newest first) with kind, confidence, author and provenance counts',
    details:
      'Filters combine. SRC is the number of cited sources and VERIFIED how many of those citations were found verbatim in the cited turn. --created-by shows everything one client wrote (what `forget --created-by` would remove).',
    flags: [
      { name: 'kind', type: 'string', placeholder: MemoryKind.options.join('|'), help: 'this kind only' },
      { name: 'tag', type: 'string', multiple: true, placeholder: '<tag>', help: 'carrying this tag (repeatable, any-of)' },
      { name: 'created-by', type: 'string', placeholder: '<label>', help: 'written by this grant label, "cli" or "import"' },
      { name: 'status', type: 'string', placeholder: 'active|superseded|all', help: 'default active' },
      { name: 'since', type: 'string', placeholder: '<ISO|24h>', help: 'updated at or after this time (ISO date or 30m/24h/7d)' },
      { name: 'limit', type: 'string', placeholder: '<n>', help: `max rows (default ${DEFAULT_LIMIT})` },
    ],
  },
  run(ctx: CommandContext): number {
    const filter: MemoryFilter = {};
    const kind = ctx.flags.choice('kind', MemoryKind.options);
    if (kind !== undefined) filter.kind = kind;
    const tags = normalizeTags(ctx.flags.list('tag'));
    if (tags.length > 0) filter.tags = tags;
    const createdBy = ctx.flags.str('created-by');
    if (createdBy !== undefined) filter.createdBy = createdBy;
    const status = ctx.flags.choice('status', ['active', 'superseded', 'all'] as const);
    if (status !== undefined) filter.status = status;
    const since = ctx.flags.str('since');
    if (since !== undefined) filter.since = parseSince(since, ctx.now);
    const limit = ctx.flags.int('limit') ?? DEFAULT_LIMIT;
    const store = ctx.openStore();
    try {
      const all = store.listMemories(filter);
      const memories = all.slice(0, limit);
      if (ctx.json) {
        ctx.print(`${JSON.stringify({ total: all.length, memories })}\n`);
        return 0;
      }
      if (memories.length === 0) {
        ctx.print('no memories\n');
        return 0;
      }
      ctx.print(
        renderTable(
          ['ID', 'KIND', 'CONF', 'STATEMENT', 'BY', 'SRC', 'VERIFIED'],
          memories.map((m) => [m.id, m.kind, m.confidence, m.statement, m.createdBy, String(m.sources.length), String(m.sources.filter((s) => s.verified).length)]),
          { 3: 80 },
        ),
      );
      if (all.length > memories.length) ctx.info(`… ${all.length - memories.length} more (use --limit)\n`);
      return 0;
    } finally {
      store.close();
    }
  },
};
