import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeSet, Memory, Source, SourceContent, SourceMeta } from '../src/types.js';
import { type SearchStoreView, VaultSearch } from '../src/search/vault-search.js';

// ---------------------------------------------------------------------------
// Fixtures: a fake SearchStoreView (no vault on disk) and record builders
// ---------------------------------------------------------------------------
const NOW = '2026-10-20T10:00:00.000Z';
const hex16 = (n: number): string => n.toString(16).padStart(16, '0');

function makeMemory(n: number, p: Partial<Memory> = {}): Memory {
  return {
    id: `mem_${hex16(n)}`,
    kind: 'preference',
    statement: `User prefers memory number ${n}.`,
    subject: 'user',
    tags: [],
    confidence: 'stated',
    sources: [],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'cli',
    status: 'active',
    ...p,
  };
}

function conversation(turns: string[]): SourceContent {
  return { kind: 'conversation', turns: turns.map((text, i) => ({ i, role: i % 2 === 0 ? 'user' : 'assistant', text })) };
}

function makeSource(n: number, p: { title?: string; content?: SourceContent; type?: SourceMeta['type']; tags?: string[] } = {}): Source {
  const content = p.content ?? conversation([`turn zero of source ${n}`, `turn one of source ${n}`]);
  const json = JSON.stringify(content);
  return {
    id: `src_${hex16(n)}`,
    type: p.type ?? 'chatgpt',
    kind: content.kind,
    title: p.title ?? `Source ${n}`,
    origin: { importer: 'chatgpt@1', path: '/tmp/x.json', externalId: String(n), trust: 'imported' },
    tags: p.tags ?? [],
    createdAt: NOW,
    importedAt: NOW,
    sha256: createHash('sha256').update(json).digest('hex'),
    bytes: Buffer.byteLength(json),
    turnCount: content.kind === 'conversation' ? content.turns.length : 1,
    hasRaw: false,
    notes: [],
    review: { status: 'unreviewed' },
    content,
  };
}

function metaOf(s: Source): SourceMeta {
  const { content: _content, ...meta } = s;
  return meta;
}

class FakeStore implements SearchStoreView {
  readonly memories = new Map<string, Memory>();
  readonly sources = new Map<string, Source>();
  readonly getSourceCalls: string[] = [];
  /** Ids whose getSource throws, to simulate a CORRUPT body. */
  readonly broken = new Set<string>();

  listMemories(f?: { status?: 'active' }): Memory[] {
    return [...this.memories.values()].filter((m) => f?.status === undefined || m.status === f.status);
  }
  listSources(): SourceMeta[] {
    return [...this.sources.values()].map(metaOf);
  }
  getSource(id: string): Source | undefined {
    this.getSourceCalls.push(id);
    if (this.broken.has(id)) throw new Error('simulated corrupt body');
    return this.sources.get(id);
  }
  putMemory(m: Memory): Memory {
    this.memories.set(m.id, m);
    return m;
  }
  putSource(s: Source): SourceMeta {
    this.sources.set(s.id, s);
    return metaOf(s);
  }
}

const noChanges = (): ChangeSet => ({
  memoriesPut: [],
  memoriesDeleted: [],
  sourcesPut: [],
  sourcesDeleted: [],
  grantsChanged: false,
  reloaded: false,
});

const ids = <T extends { memory?: Memory; source?: SourceMeta }>(hits: T[]): string[] =>
  hits.map((h) => h.memory?.id ?? h.source?.id ?? '');

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------
describe('VaultSearch memories', () => {
  it('indexes active memories at construction (statement, subject, tags) and skips superseded ones', () => {
    const store = new FakeStore();
    store.putMemory(makeMemory(1, { statement: 'User prefers tabs over spaces in Go.', tags: ['coding', 'go'] }));
    store.putMemory(makeMemory(2, { statement: 'User lives in Lisbon.', subject: 'user', kind: 'fact' }));
    store.putMemory(makeMemory(3, { statement: 'User used to prefer spaces.', status: 'superseded', supersededBy: `mem_${hex16(1)}` }));
    store.putMemory(makeMemory(4, { statement: 'Alice is a Rust expert.', subject: 'Alice', kind: 'skill', tags: ['rust'] }));
    const search = new VaultSearch(store);

    const tabs = search.searchMemories('tabs', { limit: 10 });
    expect(ids(tabs)).toEqual([`mem_${hex16(1)}`]);
    expect(tabs[0]?.score).toBeGreaterThan(0);
    expect(tabs[0]?.memory.statement).toBe('User prefers tabs over spaces in Go.');
    // superseded memory is not indexed even though its statement matches
    expect(ids(search.searchMemories('spaces', { limit: 10 }))).toEqual([`mem_${hex16(1)}`]);
    // subject and tags are searchable
    expect(ids(search.searchMemories('alice', { limit: 10 }))).toEqual([`mem_${hex16(4)}`]);
    expect(ids(search.searchMemories('coding', { limit: 10 }))).toEqual([`mem_${hex16(1)}`]);
    expect(search.searchMemories('nothing-here', { limit: 10 })).toEqual([]);
    expect(search.sourcesReady).toBe(false);
  });

  it('applies the memory filter predicate and the limit', () => {
    const store = new FakeStore();
    for (let i = 1; i <= 5; i++) store.putMemory(makeMemory(i, { statement: `User likes vault item ${i}.`, tags: i % 2 ? ['odd'] : ['even'] }));
    const search = new VaultSearch(store);
    const odd = search.searchMemories('vault', { limit: 10, filter: (m) => m.tags.includes('odd') });
    expect(ids(odd).sort()).toEqual([1, 3, 5].map((n) => `mem_${hex16(n)}`));
    expect(search.searchMemories('vault', { limit: 2 })).toHaveLength(2);
  });

  it('applyChanges adds, replaces, supersedes and deletes memories incrementally', () => {
    const store = new FakeStore();
    store.putMemory(makeMemory(1, { statement: 'User prefers tabs.' }));
    const search = new VaultSearch(store);

    search.applyChanges({ ...noChanges(), memoriesPut: [makeMemory(2, { statement: 'User prefers dark mode.' })] });
    expect(ids(search.searchMemories('dark mode', { limit: 10 }))).toEqual([`mem_${hex16(2)}`]);

    // replace: same id, new statement
    search.applyChanges({ ...noChanges(), memoriesPut: [makeMemory(2, { statement: 'User prefers light mode.' })] });
    expect(ids(search.searchMemories('dark', { limit: 10 }))).toEqual([]);
    expect(ids(search.searchMemories('light', { limit: 10 }))).toEqual([`mem_${hex16(2)}`]);

    // supersede: the old record is re-put as superseded → dropped from the index
    search.applyChanges({
      ...noChanges(),
      memoriesPut: [
        makeMemory(1, { statement: 'User prefers tabs.', status: 'superseded', supersededBy: `mem_${hex16(3)}` }),
        makeMemory(3, { statement: 'User prefers tabs, strongly.', supersedes: `mem_${hex16(1)}` }),
      ],
    });
    expect(ids(search.searchMemories('tabs', { limit: 10 }))).toEqual([`mem_${hex16(3)}`]);

    search.applyChanges({ ...noChanges(), memoriesDeleted: [`mem_${hex16(3)}`, 'mem_0000000000000000'] });
    expect(search.searchMemories('tabs', { limit: 10 })).toEqual([]);
    expect(ids(search.searchMemories('light', { limit: 10 }))).toEqual([`mem_${hex16(2)}`]);
  });

  it('applyChanges with reloaded rebuilds the memory index from the store and schedules a source build', async () => {
    const store = new FakeStore();
    store.putMemory(makeMemory(1, { statement: 'User prefers tabs.' }));
    store.putSource(makeSource(1, { content: conversation(['original body']) }));
    const search = new VaultSearch(store);
    await search.buildSourceIndex();
    expect(search.sourcesReady).toBe(true);

    // another process compacted: the store now holds different records
    store.memories.delete(`mem_${hex16(1)}`);
    store.putMemory(makeMemory(2, { statement: 'User prefers spaces.' }));
    store.sources.delete(`src_${hex16(1)}`);
    store.putSource(makeSource(2, { content: conversation(['replacement body']) }));

    search.applyChanges({ ...noChanges(), reloaded: true });
    expect(search.searchMemories('tabs', { limit: 10 })).toEqual([]);
    expect(ids(search.searchMemories('spaces', { limit: 10 }))).toEqual([`mem_${hex16(2)}`]);
    expect(search.sourcesReady).toBe(false);

    await search.buildSourceIndex(); // joins the scheduled build
    expect(search.sourcesReady).toBe(true);
    expect(ids(search.searchSources('original', { limit: 10 }))).toEqual([]);
    expect(ids(search.searchSources('replacement', { limit: 10 }))).toEqual([`src_${hex16(2)}`]);
  });
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
describe('VaultSearch sources', () => {
  it('buildSourceIndex works in chunks of 25 separated by setImmediate and reads each body at most once', async () => {
    const store = new FakeStore();
    for (let i = 1; i <= 60; i++) store.putSource(makeSource(i, { content: conversation([`chunk body ${i}`]) }));
    const search = new VaultSearch(store);
    const setImmediateSpy = vi.spyOn(globalThis, 'setImmediate');

    const build = search.buildSourceIndex();
    expect(search.sourcesReady).toBe(false);
    // the first chunk of 25 is indexed synchronously; the rest waits for the event loop
    const firstChunkReads = [...store.getSourceCalls];
    expect(firstChunkReads).toHaveLength(25);
    const partial = search.searchSources('chunk', { limit: 100 }); // snippets read bodies too, hence the bookkeeping
    expect(partial).toHaveLength(25);
    expect(search.buildSourceIndex()).toBe(build); // concurrent calls share one build

    const mark = store.getSourceCalls.length;
    await build;
    const laterChunkReads = store.getSourceCalls.slice(mark);
    expect(search.sourcesReady).toBe(true);
    expect(setImmediateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const indexReads = [...firstChunkReads, ...laterChunkReads];
    expect(indexReads).toHaveLength(60); // every body read exactly once while indexing
    expect(new Set(indexReads).size).toBe(60);
    expect(search.searchSources('chunk', { limit: 100 })).toHaveLength(60);

    // idempotent: a second build reads nothing
    const before = store.getSourceCalls.length;
    await search.buildSourceIndex();
    expect(search.sourcesReady).toBe(true);
    expect(store.getSourceCalls).toHaveLength(before);
  });

  it('searchSources returns the best turn with a «»-highlighted snippet, or the title when only it matches', async () => {
    const store = new FakeStore();
    store.putSource(
      makeSource(1, {
        title: 'Go formatting',
        content: conversation(['how should I format Go?', 'gofmt uses tabs…', 'ok', 'I always use tabs in Go, fight me']),
      }),
    );
    store.putSource(makeSource(2, { title: 'Budget review', content: conversation(['we spent too much on cloud', 'agreed']) }));
    store.putSource(makeSource(3, { title: 'Notes', type: 'markdown', content: { kind: 'document', mediaType: 'text/markdown', text: '# Notes\n\nRemember to rotate the vault key.' } }));
    const search = new VaultSearch(store);
    await search.buildSourceIndex();

    const tabs = search.searchSources('tabs', { limit: 10 });
    expect(ids(tabs)).toEqual([`src_${hex16(1)}`]);
    expect(tabs[0]?.turn).toBe(1); // earliest turn among equals
    expect(tabs[0]?.snippet).toBe('gofmt uses «tabs»…');
    expect(tabs[0]?.score).toBeGreaterThan(0);
    expect(tabs[0]?.source.title).toBe('Go formatting');
    expect(tabs[0]?.source).not.toHaveProperty('content');

    const fight = search.searchSources('tabs fight', { limit: 10 });
    expect(fight[0]?.turn).toBe(3); // two distinct terms beat one
    expect(fight[0]?.snippet).toBe('I always use «tabs» in Go, «fight» me');

    const budget = search.searchSources('budget', { limit: 10 });
    expect(ids(budget)).toEqual([`src_${hex16(2)}`]);
    expect(budget[0]?.turn).toBeUndefined();
    expect(budget[0]).not.toHaveProperty('turn');
    expect(budget[0]?.snippet).toBe('«Budget» review');

    const doc = search.searchSources('rotate key', { limit: 10 });
    expect(ids(doc)).toEqual([`src_${hex16(3)}`]);
    expect(doc[0]?.turn).toBeUndefined();
    expect(doc[0]?.snippet).toBe('# Notes Remember to «rotate» the vault «key».');

    expect(search.searchSources('', { limit: 10 })).toEqual([]);
  });

  it('applies the source filter predicate and the limit', async () => {
    const store = new FakeStore();
    store.putSource(makeSource(1, { type: 'chatgpt', content: conversation(['shared word']) }));
    store.putSource(makeSource(2, { type: 'claude', content: conversation(['shared word']) }));
    store.putSource(makeSource(3, { type: 'claude', tags: ['coding'], content: conversation(['shared word']) }));
    const search = new VaultSearch(store);
    await search.buildSourceIndex();
    expect(ids(search.searchSources('shared', { limit: 10 })).sort()).toEqual([1, 2, 3].map((n) => `src_${hex16(n)}`));
    expect(ids(search.searchSources('shared', { limit: 10, filter: (s) => s.type === 'claude' })).sort()).toEqual([2, 3].map((n) => `src_${hex16(n)}`));
    expect(ids(search.searchSources('shared', { limit: 10, filter: (s) => s.tags.includes('coding') }))).toEqual([`src_${hex16(3)}`]);
    expect(search.searchSources('shared', { limit: 1 })).toHaveLength(1);
  });

  it('applyChanges indexes new sources, skips body reads for meta-only updates and drops deleted ones', async () => {
    const store = new FakeStore();
    const search = new VaultSearch(store);
    await search.buildSourceIndex();

    const s1 = makeSource(1, { content: conversation(['the first body']) });
    store.putSource(s1);
    const reads = (): number => store.getSourceCalls.filter((id) => id === s1.id).length;
    search.applyChanges({ ...noChanges(), sourcesPut: [metaOf(s1)] });
    expect(reads()).toBe(1); // indexed synchronously: no build is running
    expect(ids(search.searchSources('first', { limit: 10 }))).toEqual([`src_${hex16(1)}`]);
    expect(reads()).toBe(2); // + one read for the snippet

    // meta-only change (review status): same sha256 → no body read for indexing, new meta served
    const reviewed: Source = { ...s1, review: { status: 'reviewed', at: NOW, by: 'cli' } };
    store.putSource(reviewed);
    search.applyChanges({ ...noChanges(), sourcesPut: [metaOf(reviewed)] });
    expect(reads()).toBe(2);
    const hit = search.searchSources('first', { limit: 10 })[0];
    expect(hit?.source.review.status).toBe('reviewed');
    expect(reads()).toBe(3); // only the snippet read

    // body change: new sha256 → re-read and re-indexed
    const updated = { ...makeSource(1, { content: conversation(['a brand new body']) }), review: reviewed.review };
    store.putSource(updated);
    search.applyChanges({ ...noChanges(), sourcesPut: [metaOf(updated)] });
    expect(ids(search.searchSources('first', { limit: 10 }))).toEqual([]);
    expect(ids(search.searchSources('brand new', { limit: 10 }))).toEqual([`src_${hex16(1)}`]);

    store.sources.delete(s1.id);
    search.applyChanges({ ...noChanges(), sourcesDeleted: [s1.id, 'src_0000000000000000'] });
    expect(search.searchSources('brand new', { limit: 10 })).toEqual([]);
  });

  it('indexSource/dropSource work directly, and a body that vanished at query time falls back to the title', async () => {
    const store = new FakeStore();
    const search = new VaultSearch(store);
    const s = makeSource(7, { title: 'Vault design', content: conversation(['we chose aes gcm for the vault']) });
    store.putSource(s);
    search.indexSource(s);
    expect(search.searchSources('gcm', { limit: 10 })[0]?.snippet).toBe('we chose aes «gcm» for the vault');
    expect(search.searchSources('vault', { limit: 10 })[0]?.snippet).toBe('we chose aes gcm for the «vault»');
    // body no longer readable (deleted elsewhere between refresh and query): snippet comes from the title
    store.sources.delete(s.id);
    expect(search.searchSources('vault', { limit: 10 })[0]?.snippet).toBe('«Vault» design');
    search.dropSource(s.id);
    expect(search.searchSources('gcm', { limit: 10 })).toEqual([]);
  });

  it('skips a source whose body cannot be read and still completes the build', async () => {
    const store = new FakeStore();
    store.putSource(makeSource(1, { content: conversation(['readable body']) }));
    store.putSource(makeSource(2, { content: conversation(['readable body']) }));
    store.broken.add(`src_${hex16(1)}`);
    const search = new VaultSearch(store);
    await expect(search.buildSourceIndex()).resolves.toBeUndefined();
    expect(search.sourcesReady).toBe(true);
    expect(ids(search.searchSources('readable', { limit: 10 }))).toEqual([`src_${hex16(2)}`]);
    // once repaired, the next build picks it up
    store.broken.clear();
    await search.buildSourceIndex();
    expect(ids(search.searchSources('readable', { limit: 10 })).sort()).toEqual([1, 2].map((n) => `src_${hex16(n)}`));
  });

  it('a source put while a build is running is picked up before the build resolves', async () => {
    const store = new FakeStore();
    for (let i = 1; i <= 30; i++) store.putSource(makeSource(i, { content: conversation([`bulk body ${i}`]) }));
    const search = new VaultSearch(store);
    const build = search.buildSourceIndex();
    const late = makeSource(99, { content: conversation(['late arrival']) });
    store.putSource(late);
    search.applyChanges({ ...noChanges(), sourcesPut: [metaOf(late)] });
    await build;
    expect(search.sourcesReady).toBe(true);
    expect(store.getSourceCalls.filter((id) => id === late.id)).toHaveLength(1); // read once, by the build's second pass
    expect(ids(search.searchSources('late arrival', { limit: 10 }))).toEqual([`src_${hex16(99)}`]);
  });
});

// ---------------------------------------------------------------------------
// Performance smoke test (logged; skipped under CI=1)
// ---------------------------------------------------------------------------
describe('VaultSearch performance', () => {
  it.skipIf(process.env.CI === '1')('indexes 5 MB of synthetic conversation text in under 2 s', async () => {
    const words = ['the', 'user', 'prefers', 'tabs', 'over', 'spaces', 'in', 'go', 'vault', 'memory', 'encrypted', 'conversation',
      'project', 'opencontext', 'foundry', 'solidity', 'rust', 'running', 'generalizations', 'relational', 'happiness', '世界', 'wörld',
      'alice', 'lisbon', 'march', 'british', 'english', 'always', 'never', 'gofmt', 'uses', 'fight', 'me', 'remember', 'rotate', 'key'];
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const store = new FakeStore();
    let bytes = 0;
    for (let n = 1; bytes < 5_000_000; n++) {
      const turns: string[] = [];
      for (let t = 0; t < 20; t++) {
        const parts: string[] = [];
        while (parts.join(' ').length < 1200) parts.push(words[Math.floor(rnd() * words.length)] ?? 'x');
        turns.push(parts.join(' '));
      }
      const s = makeSource(n, { content: conversation(turns) });
      bytes += s.bytes;
      store.putSource(s);
    }
    const search = new VaultSearch(store);
    const t0 = performance.now();
    await search.buildSourceIndex();
    const ms = performance.now() - t0;
    const q0 = performance.now();
    const hits = search.searchSources('vault memory encrypted', { limit: 5 });
    const queryMs = performance.now() - q0;
    console.log(`[perf] indexed ${store.sources.size} sources / ${(bytes / 1e6).toFixed(1)} MB in ${ms.toFixed(0)} ms; top-5 query with snippets ${queryMs.toFixed(0)} ms`);
    expect(hits).toHaveLength(5);
    expect(ms).toBeLessThan(2000);
  });
});
