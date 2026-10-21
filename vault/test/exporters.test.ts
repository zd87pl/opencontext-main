import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeMarkdown } from '../src/exporters/markdown.js';
import { buildPortable, writePortable } from '../src/exporters/portable.js';
import { newId } from '../src/ids.js';
import { parsePortable } from '../src/importers/portable.js';
import { runImport } from '../src/importers/run.js';
import { type Grant, type Memory, PortableExportV1 } from '../src/types.js';
import { canonicalJson, sha256Hex } from '../src/util/canonical-json.js';
import { makeMemory, makeSource, tmpVault } from './helpers/tmp-vault.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const NOW = (): Date => new Date('2026-10-20T12:34:56.000Z');
const GENERATOR = '@opencontext/vault 0.1.0-test';

class Sink extends Writable {
  private readonly chunks: Buffer[] = [];
  constructor(private readonly slow = false) {
    super({ highWaterMark: slow ? 16 : undefined });
  }
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    if (this.slow) setTimeout(cb, 1);
    else cb();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

class SyncSink {
  text = '';
  write(chunk: string | Uint8Array): boolean {
    this.text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }
}

let v: ReturnType<typeof tmpVault>;
let grant: Grant;
let preference: Memory;
let older: Memory;
let goSourceId = '';

beforeEach(async () => {
  v = tmpVault();
  const { store } = v;
  await runImport(store, [`${FIXTURES}chatgpt`, `${FIXTURES}claude/conversations.json`], { now: NOW });
  goSourceId = store.listSources().find((s) => s.title === 'Go formatting')?.id ?? '';
  if (goSourceId === '') throw new Error('fixture import failed');
  grant = store.putGrant({ id: newId('grt'), label: 'claude-desktop', tokenHash: sha256Hex('not-a-real-token'), scopes: ['read'], createdAt: '2026-10-20T10:00:00.000Z' });
  older = store.putMemory(
    makeMemory({ kind: 'preference', statement: 'User prefers spaces in Go.', createdAt: '2026-10-19T10:00:00.000Z', updatedAt: '2026-10-19T10:00:00.000Z', status: 'superseded' }),
  );
  preference = store.putMemory(
    makeMemory({
      kind: 'preference',
      statement: 'User prefers tabs over spaces in Go.',
      tags: ['coding', 'go'],
      sources: [{ sourceId: goSourceId, turn: 5, quote: 'I always use tabs in Go, fight me', verified: false }],
      createdAt: '2026-10-20T11:00:00.000Z',
      updatedAt: '2026-10-20T11:00:00.000Z',
      createdBy: 'claude-desktop',
      supersedes: older.id,
    }),
  );
  store.putMemory({ ...older, supersededBy: preference.id });
  store.putMemory(makeMemory({ kind: 'instruction', statement: 'Always answer in British English.', createdAt: '2026-10-20T11:05:00.000Z', updatedAt: '2026-10-20T11:05:00.000Z', sources: [{ sourceId: 'src_00000000000000ff', verified: false }] }));
  store.putMemory(makeMemory({ kind: 'fact', statement: 'User lives in Lisbon.', createdAt: '2026-10-20T11:06:00.000Z', updatedAt: '2026-10-20T11:06:00.000Z' }));
});
afterEach(() => v.cleanup());

describe('writePortable', () => {
  it('streams bytes identical to JSON.stringify(buildPortable(), null, 2) + "\\n"', async () => {
    const sink = new Sink();
    const counts = await writePortable(v.store, sink, { generator: GENERATOR, now: NOW });
    const expected = `${JSON.stringify(buildPortable(v.store, { generator: GENERATOR, now: NOW }), null, 2)}\n`;
    expect(sink.text()).toBe(expected);
    expect(counts).toEqual({ memories: 4, sources: 7 });
    expect(sink.text().endsWith('\n')).toBe(true);
    expect(sink.text().startsWith('{\n  "format": "opencontext-vault-export",\n  "version": 1,\n  "exportedAt": "2026-10-20T12:34:56.000Z",\n  "vaultId": "')).toBe(true);
  });

  it('survives backpressure from a slow writable', async () => {
    const sink = new Sink(true);
    await writePortable(v.store, sink, { generator: GENERATOR, now: NOW });
    expect(sink.text()).toBe(`${JSON.stringify(buildPortable(v.store, { generator: GENERATOR, now: NOW }), null, 2)}\n`);
  });

  it('is valid against the schema, in schema key order, with all statuses and full bodies', async () => {
    const sink = new Sink();
    await writePortable(v.store, sink, { generator: GENERATOR, now: NOW });
    const parsed = parsePortable(JSON.parse(sink.text()));
    expect(PortableExportV1.safeParse(parsed).success).toBe(true);
    expect(Object.keys(parsed)).toEqual(['format', 'version', 'exportedAt', 'vaultId', 'generator', 'memories', 'sources']);
    expect(parsed.vaultId).toBe(v.store.vaultId);
    expect(parsed.generator).toBe(GENERATOR);
    expect(parsed.memories.map((m) => m.status).sort()).toEqual(['active', 'active', 'active', 'superseded']);
    const pref = parsed.memories.find((m) => m.id === preference.id);
    expect(Object.keys(pref ?? {})).toEqual(['id', 'kind', 'statement', 'subject', 'tags', 'confidence', 'sources', 'createdAt', 'updatedAt', 'createdBy', 'status', 'supersedes']);
    expect(pref?.sources[0]?.verified).toBe(true);
    // oldest first, ties by id
    const created = parsed.memories.map((m) => m.createdAt);
    expect(created).toEqual([...created].sort());
    const go = parsed.sources.find((s) => s.id === goSourceId);
    expect(Object.keys(go ?? {}).slice(-2)).toEqual(['review', 'content']);
    expect(go?.content.kind === 'conversation' ? go.content.turns.length : 0).toBe(7);
    expect(go?.content.raw).toBeDefined();
    expect(go?.hasRaw).toBe(true);
    expect(go?.sha256).toBe(sha256Hex(canonicalJson(go?.content)));
  });

  it('never contains grants, token hashes, keys or audit entries', async () => {
    v.store.appendAudit({ at: '2026-10-20T12:00:00.000Z', pid: process.pid, grant: { id: grant.id, label: grant.label }, client: null, event: 'cli', name: 'export', args: { secretArg: 'AUDIT-ONLY-7f3a' }, outcome: 'ok', ms: 1 });
    const sink = new Sink();
    await writePortable(v.store, sink, { generator: GENERATOR, now: NOW });
    const text = sink.text();
    expect(text).not.toContain(grant.tokenHash);
    expect(text).not.toContain(grant.id);
    expect(text).not.toContain('AUDIT-ONLY-7f3a');
    expect(text).not.toContain('ocv_');
    expect(text).not.toContain('"grants"');
    expect(text).not.toContain(v.store.keyId);
  });

  it('includeRaw:false drops raw and recomputes the body-derived fields consistently', async () => {
    const sink = new Sink();
    await writePortable(v.store, sink, { generator: GENERATOR, now: NOW, includeRaw: false });
    const text = sink.text();
    expect(text).toBe(`${JSON.stringify(buildPortable(v.store, { generator: GENERATOR, now: NOW, includeRaw: false }), null, 2)}\n`);
    expect(text).not.toContain('"raw"');
    const parsed = parsePortable(JSON.parse(text));
    for (const s of parsed.sources) {
      expect(s.hasRaw).toBe(false);
      expect(s.content.raw).toBeUndefined();
      expect(s.sha256).toBe(sha256Hex(canonicalJson(s.content)));
      expect(s.bytes).toBe(Buffer.byteLength(JSON.stringify(s.content), 'utf8'));
    }
    // lossy: the stored sources still carry raw
    expect(v.store.getSourceMeta(goSourceId)?.hasRaw).toBe(true);
  });

  it('writes empty arrays for an empty vault', async () => {
    const empty = tmpVault();
    try {
      const sink = new Sink();
      const counts = await writePortable(empty.store, sink, { generator: GENERATOR, now: NOW });
      expect(counts).toEqual({ memories: 0, sources: 0 });
      expect(sink.text()).toContain('"memories": [],\n  "sources": []\n}\n');
      expect(sink.text()).toBe(`${JSON.stringify(buildPortable(empty.store, { generator: GENERATOR, now: NOW }), null, 2)}\n`);
      expect(() => parsePortable(JSON.parse(sink.text()))).not.toThrow();
    } finally {
      empty.cleanup();
    }
  });

  it('keeps documents and conversation sources alike, bodies read through the store', async () => {
    v.store.putSource(makeSource({ id: 'src_00000000000000aa', title: 'A doc', type: 'markdown', content: { kind: 'document', mediaType: 'text/markdown', text: '# Doc\n\nHello' } }));
    const built = buildPortable(v.store, { generator: GENERATOR, now: NOW });
    const doc = built.sources.find((s) => s.id === 'src_00000000000000aa');
    expect(doc?.content).toEqual({ kind: 'document', mediaType: 'text/markdown', text: '# Doc\n\nHello' });
    expect(doc?.turnCount).toBe(1);
  });
});

describe('writeMarkdown', () => {
  function render(o: { full?: boolean; includeSuperseded?: boolean } = {}): string {
    const sink = new SyncSink();
    writeMarkdown(v.store, sink as unknown as NodeJS.WritableStream, { ...o, now: NOW });
    return sink.text;
  }

  it('has the §4.5 shape: dated header, kind sections in profile order, provenance, sources as blockquotes', () => {
    const md = render();
    expect(md.startsWith('# Memory export — 2026-10-20\n')).toBe(true);
    const sections = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(sections).toEqual(['Instructions', 'Preferences', 'Facts', 'Sources']);
    expect(md).toMatch(/^- \[stated\] User prefers tabs over spaces in Go\. — from \*ChatGPT: "Go formatting"\* \(2024-03-02\) `mem_[0-9a-f]{16}`$/m);
    expect(md).toMatch(/^- \[stated\] Always answer in British English\. — from \*forgotten source\* `mem_[0-9a-f]{16}`$/m);
    expect(md).toMatch(/^- \[stated\] User lives in Lisbon\. `mem_[0-9a-f]{16}`$/m);
    expect(md).toContain(`\n### Go formatting (chatgpt, 2024-03-02, 7 turns) \`${goSourceId}\`\n`);
    expect(md).toContain('> **user:** how should I format Go?\n');
    expect(md).toContain('> **system:** User profile:\n> I am Zed');
    expect(md).toContain('_[omitted: image]_');
    expect(md).not.toContain('User prefers spaces in Go.');
  });

  it('truncates long sources at 2000 chars unless --full, and lists superseded versions on request', () => {
    v.store.putSource(makeSource({ id: 'src_00000000000000ac', title: 'A long doc', type: 'text', content: { kind: 'document', mediaType: 'text/plain', text: 'word '.repeat(600) } }));
    const md = render();
    expect(md).toContain('…(truncated at 2000 chars; use --full)');
    const full = render({ full: true });
    expect(full).not.toContain('truncated at 2000 chars');
    expect(full.length).toBeGreaterThan(md.length);
    const withOld = render({ includeSuperseded: true });
    expect(withOld).toMatch(/^- \[stated\] User prefers spaces in Go\. `mem_[0-9a-f]{16}` _\(superseded\)_$/m);
  });

  it('is not re-importable (deliberately) and renders documents verbatim', () => {
    v.store.putSource(makeSource({ id: 'src_00000000000000ab', title: 'A doc', type: 'markdown', content: { kind: 'document', mediaType: 'text/markdown', text: 'line one\nline two' } }));
    const md = render();
    expect(md).toContain('### A doc (markdown, ');
    expect(md).toContain(', document) `src_00000000000000ab`\n> line one\n> line two\n');
    expect(() => parsePortable(md as unknown)).toThrow();
  });
});
