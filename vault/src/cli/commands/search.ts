import { VaultError } from '../../errors.js';
import { VaultSearch } from '../../search/vault-search.js';
import { LIMITS, MemoryKind } from '../../types.js';
import { normalizeTags } from '../../util/text.js';
import type { Command, CommandContext } from '../args.js';
import { renderTable } from '../table.js';

/** `search`: the same BM25 index the MCP server uses, over memories or (with --sources) raw sources. */
export const search: Command = {
  spec: {
    name: 'search',
    args: '<query…>',
    summary: 'Keyword (BM25) search over memories, or over sources with --sources',
    details:
      'Builds the in-memory index for this invocation (never persisted) and ranks by BM25 with Porter stemming; the same ranking vault_search and vault_source_search give an agent. Source search reads every body once to index it, so it takes longer on a large vault.',
    flags: [
      { name: 'sources', type: 'boolean', help: 'search raw sources (title + text) instead of memories' },
      { name: 'limit', type: 'string', placeholder: '<n>', help: `max hits (default ${LIMITS.searchDefault})` },
      { name: 'kind', type: 'string', placeholder: MemoryKind.options.join('|'), help: 'memories of this kind only' },
      { name: 'tag', type: 'string', multiple: true, placeholder: '<tag>', help: 'records carrying this tag only (repeatable)' },
    ],
  },
  async run(ctx: CommandContext): Promise<number> {
    const query = ctx.positionals.join(' ').trim();
    if (query === '') throw new VaultError('INVALID_ARGUMENT', 'search needs a query');
    const limit = ctx.flags.int('limit') ?? LIMITS.searchDefault;
    const kind = ctx.flags.choice('kind', MemoryKind.options);
    const tags = normalizeTags(ctx.flags.list('tag'));
    const store = ctx.openStore();
    try {
      const index = new VaultSearch(store);
      if (ctx.flags.bool('sources')) {
        await index.buildSourceIndex();
        const hits = index.searchSources(query, { limit, filter: (s) => tags.length === 0 || s.tags.some((t) => tags.includes(t)) });
        if (ctx.json) {
          ctx.print(`${JSON.stringify(hits.map((h) => ({ id: h.source.id, score: h.score, type: h.source.type, title: h.source.title, trust: h.source.origin.trust, turn: h.turn, snippet: h.snippet })))}\n`);
          return 0;
        }
        if (hits.length === 0) {
          ctx.print('no sources match\n');
          return 0;
        }
        ctx.print(
          renderTable(
            ['SCORE', 'ID', 'TYPE', 'TITLE', 'TURN', 'SNIPPET'],
            hits.map((h) => [h.score.toFixed(2), h.source.id, h.source.type, h.source.title, h.turn === undefined ? '-' : String(h.turn), h.snippet]),
            { 3: 40, 5: 100 },
          ),
        );
        return 0;
      }
      const hits = index.searchMemories(query, {
        limit,
        filter: (m) => (kind === undefined || m.kind === kind) && (tags.length === 0 || m.tags.some((t) => tags.includes(t))),
      });
      if (ctx.json) {
        ctx.print(`${JSON.stringify(hits.map((h) => ({ ...h.memory, score: h.score })))}\n`);
        return 0;
      }
      if (hits.length === 0) {
        ctx.print('no memories match\n');
        return 0;
      }
      ctx.print(
        renderTable(
          ['SCORE', 'ID', 'KIND', 'CONF', 'STATEMENT', 'BY'],
          hits.map((h) => [h.score.toFixed(2), h.memory.id, h.memory.kind, h.memory.confidence, h.memory.statement, h.memory.createdBy]),
          { 4: 80 },
        ),
      );
      return 0;
    } finally {
      store.close();
    }
  },
};
