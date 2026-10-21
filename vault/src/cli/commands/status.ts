import { readFileSync, statSync } from 'node:fs';
import { VaultSearch } from '../../search/vault-search.js';
import { liveSessions } from '../../store/sessions.js';
import type { Command, CommandContext } from '../args.js';
import { renderPairs } from '../table.js';

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The key file's kdf and mode from the file itself; read here (not through the store) because status must describe what is on disk. */
function keyInfo(keyFile: string): { kdf: string; mode: string } {
  let kdf = 'unknown';
  let mode = '-';
  try {
    kdf = String((JSON.parse(readFileSync(keyFile, 'utf8')) as { kdf?: string }).kdf ?? 'unknown');
  } catch {
    /* reported through the store's own error if it matters */
  }
  try {
    mode = process.platform === 'win32' ? 'n/a (Windows)' : (statSync(keyFile).mode & 0o777).toString(8).padStart(4, '0');
  } catch {
    /* same */
  }
  return { kdf, mode };
}

/** `status`: everything about this vault on one screen, including live server processes and the last logged call. */
export const status: Command = {
  spec: {
    name: 'status',
    args: '',
    summary: 'Paths, key mode, counts, disk use, grants, live sessions and the last audit entry',
    details: 'Also reports how long the memory search index took to build for this vault (what every `serve` pays at startup; the source index is built in the background).',
    flags: [],
  },
  run(ctx: CommandContext): number {
    const store = ctx.openStore();
    try {
      const stats = store.stats();
      const key = keyInfo(ctx.keyFile);
      const grants = store.listGrants();
      const sessions = liveSessions(ctx.vaultDir);
      const [last] = store.readAudit({ limit: 1 });
      const started = process.hrtime.bigint();
      new VaultSearch(store);
      const indexMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (ctx.json) {
        ctx.print(`${JSON.stringify({ vaultDir: ctx.vaultDir, keyFile: ctx.keyFile, vaultId: store.vaultId, keyId: store.keyId, key, stats, grants: grants.map((g) => ({ label: g.label, scopes: g.scopes, tags: g.tags ?? [] })), sessions, lastAudit: last ?? null, memoryIndexMs: indexMs })}\n`);
        return 0;
      }
      ctx.print(
        renderPairs([
          ['vault', ctx.vaultDir],
          ['key', `${ctx.keyFile} (kdf ${key.kdf}, id ${store.keyId}, mode ${key.mode})`],
          ['vault id', store.vaultId],
          ['memories', `${stats.memories} (${stats.activeMemories} active)`],
          ['sources', `${stats.sources} (${stats.unreviewedSources} unreviewed, ${human(stats.sourceBytes)} of text)`],
          ['grants', grants.length === 0 ? 'none' : grants.map((g) => `${g.label}: ${g.scopes.join(',')}${g.tags !== undefined ? ` [${g.tags.join(',')}]` : ''}`).join('; ')],
          ['audit', `${stats.auditEntries} entries${last !== undefined ? `; last ${last.at} ${last.grant?.label ?? (last.event === 'cli' ? 'cli' : '-')} ${last.event} ${last.name} ${last.outcome}` : ''}`],
          ['sessions', sessions.length === 0 ? 'none live' : sessions.map((s) => `pid ${s.pid} (${s.label ?? 'no grant'}) since ${s.startedAt}`).join('; ')],
          ['disk', human(stats.diskBytes)],
          ['index', `memory index built in ${indexMs.toFixed(1)} ms`],
        ]),
      );
      return 0;
    } finally {
      store.close();
    }
  },
};
