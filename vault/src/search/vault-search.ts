import type { ChangeSet, Memory, Source, SourceMeta } from '../types.js';
import { Bm25Index } from './bm25.js';
import { bestSnippet } from './snippet.js';

/** The slice of VaultStore the index needs; small on purpose so search is tested against a fake store. */
export interface SearchStoreView {
  listMemories(f?: { status?: 'active' }): Memory[];
  listSources(): SourceMeta[];
  getSource(id: string): Source | undefined;
}

interface SourceEntry {
  meta: SourceMeta;
  /** sha256 of the body currently in the index; null until the body has been read and indexed. */
  indexedSha: string | null;
}

/** Sources per setImmediate slice of the background build: small enough to keep an MCP call responsive. */
const CHUNK = 25;

/**
 * Keyword search over memories and sources. The memory index is tiny and built synchronously in the constructor;
 * the source index can be hundreds of megabytes of conversation text, so it is built in the background in chunks
 * of CHUNK sources with a setImmediate between them, reading bodies through store.getSource (the store's LRU keeps
 * RAM bounded). Every source entry remembers the sha256 of the body it indexed, which makes buildSourceIndex()
 * idempotent (a second run reads nothing) and lets meta-only changes (review status) skip the body read.
 */
export class VaultSearch {
  private memoryIndex = new Bm25Index();
  private readonly sourceIndex = new Bm25Index();
  private readonly memories = new Map<string, Memory>();
  private readonly sources = new Map<string, SourceEntry>();
  private ready = false;
  private building: Promise<void> | null = null;
  /** Set when the listing changed under a running build so it makes another pass before resolving. */
  private rerun = false;

  constructor(private readonly store: SearchStoreView) {
    this.rebuildMemories();
  }

  /**
   * Sync the source index with store.listSources(): index new or changed bodies, drop vanished ids. Concurrent
   * calls share one build; a change applied while it runs schedules one more pass. Resolves when the index is
   * complete. A body that cannot be read is skipped (it stays unindexed and is retried on the next build) so one
   * bad file never kills the server's background build.
   */
  buildSourceIndex(): Promise<void> {
    if (this.building !== null) {
      this.rerun = true;
      return this.building;
    }
    this.ready = false;
    const run = async (): Promise<void> => {
      try {
        do {
          this.rerun = false;
          await this.syncSources();
        } while (this.rerun);
        this.ready = true;
      } finally {
        // Cleared synchronously, before the promise settles, so no caller can observe a finished-but-pending build.
        this.building = null;
      }
    };
    this.building = run();
    return this.building;
  }

  /** true once a build has completed and no later change has invalidated it. */
  get sourcesReady(): boolean {
    return this.ready && this.building === null;
  }

  /**
   * Apply what VaultStore.refresh() reported. Puts add or replace, deletions remove, and `reloaded` (compaction or
   * rekey elsewhere) rebuilds the memory index now and schedules a source re-sync — cheap, because unchanged
   * bodies are recognised by sha256 and not re-read.
   */
  applyChanges(c: ChangeSet): void {
    for (const m of c.memoriesPut) this.indexMemory(m);
    for (const id of c.memoriesDeleted) this.dropMemory(id);
    for (const meta of c.sourcesPut) this.putSourceMeta(meta);
    for (const id of c.sourcesDeleted) this.dropSource(id);
    if (c.reloaded) {
      this.rebuildMemories();
      // Fire-and-forget: syncSources() already swallows per-body failures, so nothing is lost by not awaiting.
      void this.buildSourceIndex().catch(() => undefined);
    }
  }

  /** Index an active memory (statement, subject and tags); a superseded one is dropped instead. */
  indexMemory(m: Memory): void {
    if (m.status !== 'active') {
      this.dropMemory(m.id);
      return;
    }
    this.memories.set(m.id, m);
    this.memoryIndex.add(m.id, memoryText(m));
  }

  dropMemory(id: string): void {
    this.memories.delete(id);
    this.memoryIndex.remove(id);
  }

  /** Index a source with its body in hand (title + every turn text, or title + document text). */
  indexSource(s: Source): void {
    const { content, ...meta } = s;
    const text = content.kind === 'conversation' ? content.turns.map((t) => t.text).join('\n') : content.text;
    this.sourceIndex.add(s.id, `${s.title}\n${text}`);
    this.sources.set(s.id, { meta, indexedSha: s.sha256 });
  }

  dropSource(id: string): void {
    this.sources.delete(id);
    this.sourceIndex.remove(id);
  }

  searchMemories(
    query: string,
    o: { limit: number; filter?: (m: Memory) => boolean },
  ): Array<{ memory: Memory; score: number }> {
    const filter = o.filter;
    const hits = this.memoryIndex.search(query, {
      limit: o.limit,
      filter:
        filter === undefined
          ? undefined
          : (id) => {
              const m = this.memories.get(id);
              return m !== undefined && filter(m);
            },
    });
    const out: Array<{ memory: Memory; score: number }> = [];
    for (const h of hits) {
      const memory = this.memories.get(h.id);
      if (memory !== undefined) out.push({ memory, score: h.score });
    }
    return out;
  }

  /**
   * Ranks indexed sources, then computes a snippet for the top-k only: the turn whose best window holds the most
   * distinct query terms (earliest wins ties), falling back to the title when only the title matched. Bodies are
   * read through store.getSource at query time, never held by the index.
   */
  searchSources(
    query: string,
    o: { limit: number; filter?: (s: SourceMeta) => boolean },
  ): Array<{ source: SourceMeta; score: number; snippet: string; turn?: number }> {
    const filter = o.filter;
    const terms = this.sourceIndex.terms(query);
    const hits = this.sourceIndex.search(query, {
      limit: o.limit,
      filter:
        filter === undefined
          ? undefined
          : (id) => {
              const e = this.sources.get(id);
              return e !== undefined && filter(e.meta);
            },
    });
    const out: Array<{ source: SourceMeta; score: number; snippet: string; turn?: number }> = [];
    for (const h of hits) {
      const entry = this.sources.get(h.id);
      if (entry === undefined) continue;
      const { snippet, turn } = this.snippetFor(entry.meta, terms);
      out.push(turn === undefined ? { source: entry.meta, score: h.score, snippet } : { source: entry.meta, score: h.score, snippet, turn });
    }
    return out;
  }

  private snippetFor(meta: SourceMeta, terms: string[]): { snippet: string; turn?: number } {
    const s = this.tryGetSource(meta.id);
    if (s === undefined) return { snippet: bestSnippet(meta.title, terms).text };
    if (s.content.kind === 'document') {
      const body = bestSnippet(s.content.text, terms);
      if (body.hits > 0) return { snippet: body.text };
      const title = bestSnippet(meta.title, terms);
      return { snippet: title.hits > 0 ? title.text : body.text };
    }
    let best: { snippet: string; turn: number; hits: number } | undefined;
    for (const t of s.content.turns) {
      if (t.text.trim() === '') continue;
      const sn = bestSnippet(t.text, terms);
      if (best === undefined || sn.hits > best.hits) best = { snippet: sn.text, turn: t.i, hits: sn.hits };
      if (best.hits === terms.length) break;
    }
    if (best !== undefined && best.hits > 0) return { snippet: best.snippet, turn: best.turn };
    const title = bestSnippet(meta.title, terms);
    if (title.hits > 0 || best === undefined) return { snippet: title.text };
    return { snippet: best.snippet, turn: best.turn };
  }

  /** A changed SourceMeta from refresh(): same sha → meta-only update; new sha → (re)index the body. */
  private putSourceMeta(meta: SourceMeta): void {
    const known = this.sources.get(meta.id);
    if (known !== undefined && known.indexedSha === meta.sha256) {
      known.meta = meta;
      return;
    }
    this.sources.set(meta.id, { meta, indexedSha: known?.indexedSha ?? null });
    if (this.building !== null) {
      this.rerun = true; // the running build will pick it up on its next pass
      return;
    }
    const s = this.tryGetSource(meta.id);
    if (s !== undefined) this.indexSource(s);
  }

  private async syncSources(): Promise<void> {
    const listed = this.store.listSources();
    const listedIds = new Set(listed.map((s) => s.id));
    for (const id of [...this.sources.keys()]) if (!listedIds.has(id)) this.dropSource(id);
    for (let i = 0; i < listed.length; i++) {
      if (i > 0 && i % CHUNK === 0) await yieldToLoop();
      const meta = listed[i];
      const known = this.sources.get(meta.id);
      if (known !== undefined && known.indexedSha === meta.sha256) {
        known.meta = meta;
        continue;
      }
      this.sources.set(meta.id, { meta, indexedSha: known?.indexedSha ?? null });
      const s = this.tryGetSource(meta.id);
      if (s !== undefined) this.indexSource(s);
    }
  }

  private tryGetSource(id: string): Source | undefined {
    try {
      return this.store.getSource(id);
    } catch {
      return undefined;
    }
  }

  private rebuildMemories(): void {
    this.memoryIndex = new Bm25Index();
    this.memories.clear();
    for (const m of this.store.listMemories({ status: 'active' })) if (m.status === 'active') this.indexMemory(m);
  }
}

function memoryText(m: Memory): string {
  return `${m.statement} ${m.subject} ${m.tags.join(' ')}`;
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
