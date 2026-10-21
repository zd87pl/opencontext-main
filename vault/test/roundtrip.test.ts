import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPortable, writePortable } from '../src/exporters/portable.js';
import { runImport } from '../src/importers/run.js';
import type { VaultStore } from '../src/store/vault-store.js';
import { type Memory, type MemoryKind, type Source, type SourceContent, type SourceType, type Turn } from '../src/types.js';
import { canonicalJson, sha256Hex } from '../src/util/canonical-json.js';
import { tmpVault } from './helpers/tmp-vault.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const GENERATOR = '@opencontext/vault 0.1.0-roundtrip';

/** mulberry32: small, seedable, good enough to make a failure reproducible from the printed seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['User', 'prefers', 'tabs', 'Zoë', '日本語', '🚀', 'é', 'Lisbon', 'ß', 'Ωmega', 'naïve', 'über', 'fight', 'me', 'café', 'λ', '"quoted"', 'back\\slash', 'tab\there', 'ok'];
const KINDS: MemoryKind[] = ['fact', 'preference', 'skill', 'goal', 'relationship', 'event', 'instruction'];
const TYPES: SourceType[] = ['chatgpt', 'claude', 'gemini', 'markdown', 'text', 'agent', 'vault'];
const TAGS = ['coding', 'go', 'personal', 'a.b', 'x:y', 'z_1', 'lisbon', 'r-2'];
const BY = ['cli', 'import', 'claude-desktop', 'cursor'];

interface Gen {
  r: () => number;
  pick<T>(arr: readonly T[]): T;
  int(max: number): number;
  hex(n: number): string;
  date(): string;
  words(min: number, max: number, newlines?: boolean): string;
  json(depth: number): unknown;
}

function gen(seed: number): Gen {
  const r = rng(seed);
  const g: Gen = {
    r,
    pick: (arr) => {
      const v = arr[Math.floor(r() * arr.length)];
      if (v === undefined) throw new Error('empty pick');
      return v;
    },
    int: (max) => Math.floor(r() * (max + 1)),
    hex: (n) => {
      let s = '';
      for (let i = 0; i < n; i += 1) s += Math.floor(r() * 16).toString(16);
      return s;
    },
    date: () => new Date(Date.UTC(2020 + g.int(6), g.int(11), 1 + g.int(27), g.int(23), g.int(59), g.int(59), g.int(999))).toISOString(),
    words: (min, max, newlines = false) => {
      const n = min + g.int(max - min);
      const out: string[] = [];
      for (let i = 0; i < n; i += 1) out.push(g.pick(WORDS));
      return out.join(newlines && r() < 0.3 ? '\n' : ' ');
    },
    json: (depth) => {
      const k = g.int(depth > 0 ? 6 : 3);
      switch (k) {
        case 0:
          return null;
        case 1:
          return r() < 0.5;
        case 2:
          return g.int(1000) - 500 + (r() < 0.5 ? 0 : 0.25);
        case 3:
          return g.words(0, 5, true);
        case 4: {
          const arr: unknown[] = [];
          for (let i = g.int(3); i > 0; i -= 1) arr.push(g.json(depth - 1));
          return arr;
        }
        default: {
          const obj: Record<string, unknown> = {};
          for (let i = g.int(4); i > 0; i -= 1) obj[`${g.pick(['title', 'mapping', 'z', 'a', 'ünï', '日本'])}${i}`] = g.json(depth - 1);
          return obj;
        }
      }
    },
  };
  return g;
}

function genContent(g: Gen): SourceContent {
  const raw = g.r() < 0.6 ? { raw: g.json(3) } : {};
  if (g.r() < 0.35) {
    return { kind: 'document', mediaType: g.pick(['text/markdown', 'text/plain']), text: g.words(0, 40, true), ...raw };
  }
  const turns: Turn[] = [];
  for (let i = 0, n = g.int(6); i < n; i += 1) {
    turns.push({
      i,
      role: g.pick(['user', 'assistant', 'system', 'tool']),
      text: g.r() < 0.1 ? '' : g.words(1, 30, true),
      ...(g.r() < 0.6 ? { at: g.date() } : {}),
      ...(g.r() < 0.2 ? { omitted: [g.pick(['image', 'tool_use:dalle', 'audio'])] } : {}),
    });
  }
  return { kind: 'conversation', turns, ...raw };
}

function genSource(g: Gen): Source {
  const content = genContent(g);
  const tags = [...new Set(Array.from({ length: g.int(3) }, () => g.pick(TAGS)))];
  const status = g.pick(['unreviewed', 'reviewed', 'skipped'] as const);
  return {
    id: `src_${g.hex(16)}`,
    type: g.pick(TYPES),
    kind: content.kind,
    title: g.words(1, 8),
    origin: { importer: g.pick(['chatgpt@1', 'claude@1', 'document@1', 'agent@1']), path: `/tmp/${g.words(1, 2)}`, externalId: g.hex(8), trust: g.pick(['imported', 'agent-supplied']) },
    tags,
    createdAt: g.date(),
    importedAt: g.date(),
    sha256: sha256Hex(canonicalJson(content)),
    bytes: Buffer.byteLength(JSON.stringify(content), 'utf8'),
    turnCount: content.kind === 'conversation' ? content.turns.length : 1,
    hasRaw: content.raw !== undefined,
    notes: Array.from({ length: g.int(2) }, () => g.words(2, 6)),
    review: status === 'unreviewed' ? { status } : { status, at: g.date(), by: g.pick(BY), ...(g.r() < 0.5 ? { memoriesCreated: g.int(5) } : {}), ...(g.r() < 0.5 ? { note: g.words(1, 5) } : {}) },
    content,
  };
}

function quoteFrom(g: Gen, sources: Source[]): { sourceId: string; turn?: number; quote?: string; verified: boolean } {
  if (g.r() < 0.15 || sources.length === 0) return { sourceId: `src_${g.hex(16)}`, ...(g.r() < 0.5 ? { quote: g.words(1, 3) } : {}), verified: false };
  const src = g.pick(sources);
  if (src.content.kind === 'document') {
    const words = src.content.text.split(/\s+/).filter((w) => w !== '');
    const quote = words.length > 0 && g.r() < 0.7 ? words.slice(0, 1 + g.int(2)).join(' ') : g.words(1, 3);
    return { sourceId: src.id, quote, verified: false };
  }
  const turn = src.content.turns.length > 0 ? g.pick(src.content.turns) : undefined;
  const words = turn ? turn.text.split(/\s+/).filter((w) => w !== '') : [];
  const quote = words.length > 0 && g.r() < 0.7 ? words.slice(0, 1 + g.int(2)).join(' ') : g.words(1, 3);
  return { sourceId: src.id, ...(turn && g.r() < 0.8 ? { turn: turn.i } : {}), ...(g.r() < 0.9 ? { quote } : {}), verified: false };
}

function genMemory(g: Gen, sources: Source[]): Memory {
  const created = g.date();
  return {
    id: `mem_${g.hex(16)}`,
    kind: g.pick(KINDS),
    statement: g.words(1, 20).replace(/[\n\r]/g, ' ') || 'x',
    subject: g.pick(['user', 'Alice', 'project:vault', 'Zoë']),
    tags: [...new Set(Array.from({ length: g.int(3) }, () => g.pick(TAGS)))],
    confidence: g.pick(['stated', 'inferred']),
    ...(g.r() < 0.3 ? { validFrom: g.date() } : {}),
    ...(g.r() < 0.2 ? { validUntil: g.date() } : {}),
    sources: Array.from({ length: g.int(3) }, () => quoteFrom(g, sources)),
    createdAt: created,
    updatedAt: g.r() < 0.5 ? created : g.date(),
    createdBy: g.pick(BY),
    status: 'active',
  };
}

/** Random vault with every shape the format allows, including supersede chains written the way the store writes them. */
function seedVault(store: VaultStore, seed: number): { memories: number; sources: number } {
  const g = gen(seed);
  const sources: Source[] = [];
  for (let i = 0, n = g.int(5); i < n; i += 1) sources.push(genSource(g));
  for (const s of sources) store.putSource(s);
  const memories: Memory[] = [];
  for (let i = 0, n = 1 + g.int(7); i < n; i += 1) memories.push(genMemory(g, sources));
  for (const m of memories) store.putMemory(m);
  // supersede chains: old → new (two puts, old first, as vault_remember does)
  for (let i = 0; i + 1 < memories.length && g.r() < 0.5; i += 2) {
    const old = memories[i];
    const next = memories[i + 1];
    if (!old || !next) continue;
    store.putMemory({ ...old, status: 'superseded', supersededBy: next.id });
    store.putMemory({ ...next, supersedes: old.id });
  }
  return { memories: memories.length, sources: sources.length };
}

async function exportToFile(store: VaultStore, path: string, now: () => Date): Promise<void> {
  const out = createWriteStream(path, { mode: 0o600 });
  await writePortable(store, out, { generator: GENERATOR, now });
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.end(resolve);
  });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function vault(): ReturnType<typeof tmpVault> {
  const v = tmpVault();
  cleanups.push(v.cleanup);
  return v;
}

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ocv-rt-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

describe('portable round trip', () => {
  it('export → import into an empty vault → export is deep-equal under canonicalJson, 50 seeded iterations', async () => {
    const dir = scratch();
    const now = (): Date => new Date('2026-10-20T12:00:00.000Z');
    let totalMemories = 0;
    let totalSources = 0;
    for (let seed = 1; seed <= 50; seed += 1) {
      const a = vault();
      const counts = seedVault(a.store, seed * 7919);
      totalMemories += counts.memories;
      totalSources += counts.sources;
      const exportA = buildPortable(a.store, { generator: GENERATOR, now });
      const file = join(dir, `export-${seed}.json`);
      await exportToFile(a.store, file, now);
      const b = vault();
      const report = await runImport(b.store, [file], { now });
      expect(report, `seed ${seed}`).toMatchObject({ added: counts.sources, memoriesAdded: counts.memories, skipped: 0, memoriesSkipped: 0, ignored: [] });
      const exportB = buildPortable(b.store, { generator: GENERATOR, now });
      expect(canonicalJson(exportB.memories), `seed ${seed}: memories`).toBe(canonicalJson(exportA.memories));
      expect(canonicalJson(exportB.sources), `seed ${seed}: sources`).toBe(canonicalJson(exportA.sources));
      expect(exportB.vaultId).not.toBe(exportA.vaultId);
      expect(exportB.format).toBe(exportA.format);
      a.cleanup();
      b.cleanup();
    }
    expect(totalMemories).toBeGreaterThan(50);
    expect(totalSources).toBeGreaterThan(50);
  }, 180_000);

  it('vendor fixtures imported → exported → re-imported → exported are equal', async () => {
    const dir = scratch();
    const now = (): Date => new Date('2026-10-20T12:00:00.000Z');
    const a = vault();
    const imported = await runImport(a.store, [`${FIXTURES}chatgpt`, `${FIXTURES}claude`, `${FIXTURES}gemini`, `${FIXTURES}notes`, `${FIXTURES}portable/export.json`], { now, tags: ['fixture'] });
    expect(imported.added).toBe(4 + 6 + 3 + 4 + 1);
    expect(imported.memoriesAdded).toBe(1);
    const exportA = buildPortable(a.store, { generator: GENERATOR, now });
    expect(exportA.sources).toHaveLength(18);
    const file = join(dir, 'fixtures.json');
    await exportToFile(a.store, file, now);
    const b = vault();
    const report = await runImport(b.store, [file], { now });
    expect(report).toMatchObject({ added: 18, memoriesAdded: 1, skipped: 0, ignored: [] });
    const exportB = buildPortable(b.store, { generator: GENERATOR, now });
    expect(canonicalJson(exportB.memories)).toBe(canonicalJson(exportA.memories));
    expect(canonicalJson(exportB.sources)).toBe(canonicalJson(exportA.sources));
    // and a third hop stays stable byte-for-byte apart from the header
    const file2 = join(dir, 'fixtures-2.json');
    await exportToFile(b.store, file2, now);
    const c = vault();
    await runImport(c.store, [file2], { now });
    const exportC = buildPortable(c.store, { generator: GENERATOR, now });
    expect(canonicalJson(exportC.sources)).toBe(canonicalJson(exportA.sources));
  }, 60_000);

  it('importing into a non-empty vault skips existing ids and keeps the rest', async () => {
    const dir = scratch();
    const now = (): Date => new Date('2026-10-20T12:00:00.000Z');
    const a = vault();
    seedVault(a.store, 4242);
    const file = join(dir, 'a.json');
    await exportToFile(a.store, file, now);
    const b = vault();
    const extra = seedVault(b.store, 999);
    const first = await runImport(b.store, [file], { now });
    const second = await runImport(b.store, [file], { now });
    expect(second).toMatchObject({ added: 0, memoriesAdded: 0, skipped: first.added, memoriesSkipped: first.memoriesAdded });
    expect(b.store.listSources()).toHaveLength(first.added + extra.sources);
    expect(b.store.listMemories({ status: 'all' })).toHaveLength(first.memoriesAdded + extra.memories);
  });
});
