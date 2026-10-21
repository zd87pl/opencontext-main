import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sealer, lineToEnvelope } from '../src/crypto/envelope.js';
import { VaultError } from '../src/errors.js';
import { newGen } from '../src/ids.js';
import { JOURNAL_KINDS, Journal } from '../src/store/journal.js';
import { type JournalOp } from '../src/types.js';
import { sha256Hex } from '../src/util/canonical-json.js';

const VAULT_ID = 'b2b0a3f1c4d5e6f7a8b9c0d1e2f3a4b5';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof VaultError ? err.code : `non-vault:${String(err)}`;
  }
}

function put(id: string, n: number): JournalOp {
  return { op: 'put', record: { id, n } };
}

describe('Journal', () => {
  let root: string;
  let path: string;
  let sealer: Sealer;
  let warnings: string[];
  const open = (): Journal => new Journal(path, 'memories', JOURNAL_KINDS.memories, sealer, (m) => warnings.push(m));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ocv-journal-'));
    path = join(root, 'memories.jsonl');
    sealer = new Sealer(randomBytes(32), VAULT_ID);
    warnings = [];
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('create writes a plaintext header and refuses to overwrite', () => {
    const gen = newGen();
    Journal.create(path, 'memories', VAULT_ID, gen);
    const text = readFileSync(path, 'utf8');
    expect(text).toBe(`${JSON.stringify({ journal: 'memories', v: 1, vaultId: VAULT_ID, gen })}\n`);
    expect(code(() => Journal.create(path, 'memories', VAULT_ID, newGen()))).toBe('EXISTS');
    const j = open();
    const r = j.loadAll();
    expect(r).toEqual({ lines: [], reloaded: true, gen });
    expect(j.gen).toBe(gen);
    expect(j.lastSeq).toBe(0);
    expect(j.byteOffset).toBe(Buffer.byteLength(text));
  });

  it('append / loadAll / tail with seq contiguity and a prev chain', () => {
    const gen = newGen();
    Journal.create(path, 'memories', VAULT_ID, gen);
    const writer = open();
    writer.loadAll();
    const l1 = writer.append('mem_1', put('mem_1', 1));
    const l2 = writer.append('mem_2', put('mem_2', 2));
    const l3 = writer.append('mem_1', { op: 'del', id: 'mem_1', at: '2026-10-20T10:00:00.000Z' });
    expect([l1.seq, l2.seq, l3.seq]).toEqual([1, 2, 3]);
    expect(writer.lastSeq).toBe(3);

    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines).toHaveLength(5); // header + 3 + trailing ""
    const e1 = lineToEnvelope(lines[1] ?? '');
    const e2 = lineToEnvelope(lines[2] ?? '');
    const e3 = lineToEnvelope(lines[3] ?? '');
    expect(e1.prev).toBe('genesis');
    expect(e2.prev).toBe(sha256Hex(lines[1] ?? ''));
    expect(e3.prev).toBe(sha256Hex(lines[2] ?? ''));
    expect(l1.lineHash).toBe(sha256Hex(lines[1] ?? ''));
    expect(e1.k).toBe('memory');
    expect(readFileSync(path, 'utf8').includes('"n":1')).toBe(false); // encrypted

    const reader = open();
    const all = reader.loadAll();
    expect(all.reloaded).toBe(true);
    expect(all.lines.map((l) => [l.seq, l.id, l.op.op])).toEqual([
      [1, 'mem_1', 'put'],
      [2, 'mem_2', 'put'],
      [3, 'mem_1', 'del'],
    ]);
    expect(all.lines[0]?.op).toEqual(put('mem_1', 1));

    expect(reader.tail()).toEqual({ lines: [], reloaded: false, gen });
    writer.append('mem_3', put('mem_3', 3));
    const t = reader.tail();
    expect(t.reloaded).toBe(false);
    expect(t.lines.map((l) => l.seq)).toEqual([4]);
    expect(reader.lastSeq).toBe(4);
    expect(reader.byteOffset).toBe(writer.byteOffset);
    expect(reader.tail().lines).toEqual([]);
  });

  it('tail() on a never-loaded journal loads everything', () => {
    Journal.create(path, 'memories', VAULT_ID, newGen());
    const w = open();
    w.append('a', put('a', 1));
    const r = open().tail();
    expect(r.reloaded).toBe(true);
    expect(r.lines).toHaveLength(1);
  });

  it('a replayed line → CORRUPT', () => {
    Journal.create(path, 'memories', VAULT_ID, newGen());
    const w = open();
    w.append('a', put('a', 1));
    w.append('b', put('b', 2));
    const lines = readFileSync(path, 'utf8').split('\n');
    appendFileSync(path, `${lines[2]}\n`); // replay seq 2 at the tail (complete line)
    expect(code(() => open().loadAll())).toBe('CORRUPT');
    expect(code(() => w.tail())).toBe('CORRUPT');
    const v = Journal.verifyChain(path);
    expect(v.ok).toBe(false);
    expect(v.brokenAtLine).toBe(4);
  });

  it('a deleted middle line → CORRUPT', () => {
    Journal.create(path, 'memories', VAULT_ID, newGen());
    const w = open();
    for (let i = 1; i <= 3; i += 1) w.append(`m${i}`, put(`m${i}`, i));
    const lines = readFileSync(path, 'utf8').split('\n');
    writeFileSync(path, `${[lines[0], lines[1], lines[3]].join('\n')}\n`);
    expect(code(() => open().loadAll())).toBe('CORRUPT');
    expect(Journal.verifyChain(path)).toMatchObject({ ok: false, brokenAtLine: 3 });
  });

  it('swapped lines → CORRUPT', () => {
    Journal.create(path, 'memories', VAULT_ID, newGen());
    const w = open();
    for (let i = 1; i <= 3; i += 1) w.append(`m${i}`, put(`m${i}`, i));
    const lines = readFileSync(path, 'utf8').split('\n');
    writeFileSync(path, `${[lines[0], lines[2], lines[1], lines[3]].join('\n')}\n`);
    expect(code(() => open().loadAll())).toBe('CORRUPT');
    expect(Journal.verifyChain(path).ok).toBe(false);
  });

  it('a line moved to another journal or edited in place → CORRUPT (AAD)', () => {
    Journal.create(path, 'memories', VAULT_ID, newGen());
    const w = open();
    w.append('a', put('a', 1));
    const lines = readFileSync(path, 'utf8').split('\n');
    const env = lineToEnvelope(lines[1] ?? '');
    // Same envelope with the id field changed: chain + shape are still fine, only the AAD catches it.
    const forged = JSON.stringify({ ...env, id: 'b' });
    writeFileSync(path, `${lines[0]}\n${forged}\n${lines[2]}\n`); // complete first line, then a torn-looking tail
    writeFileSync(path, `${lines[0]}\n${forged}\n`);
    expect(Journal.verifyChain(path).ok).toBe(true); // key-less check cannot see it…
    expect(code(() => open().loadAll())).toBe('CORRUPT'); // …but the reader can
  });

  it('a torn last line is tolerated once, warned once, and overwritten by the next append', () => {
    const gen = newGen();
    Journal.create(path, 'memories', VAULT_ID, gen);
    const w = open();
    w.append('a', put('a', 1));
    const good = readFileSync(path, 'utf8');
    appendFileSync(path, '{"v":1,"k":"memory","seq":2,"id":"b","prev":"'); // crashed mid-write, no newline
    const r = open();
    const loaded = r.loadAll();
    expect(loaded.lines.map((l) => l.id)).toEqual(['a']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/torn/);
    expect(r.tail().lines).toEqual([]);
    expect(warnings).toHaveLength(1); // not re-reported on an unchanged file
    expect(Journal.verifyChain(path)).toMatchObject({ ok: true, lines: 1, gen });

    // The next append truncates to the last complete line, then appends seq 2.
    const line = r.append('c', put('c', 3));
    expect(line.seq).toBe(2);
    const text = readFileSync(path, 'utf8');
    expect(text.startsWith(good)).toBe(true);
    expect(text.split('\n')).toHaveLength(4);
    expect(open().loadAll().lines.map((l) => l.id)).toEqual(['a', 'c']);
    expect(Journal.verifyChain(path)).toMatchObject({ ok: true, lines: 2 });
  });

  it('an undecodable complete last line is also treated as torn; an undecodable middle line is CORRUPT', () => {
    Journal.create(path, 'memories', VAULT_ID, newGen());
    const w = open();
    w.append('a', put('a', 1));
    appendFileSync(path, 'garbage-line\n');
    expect(open().loadAll().lines).toHaveLength(1);
    w.append('b', put('b', 2)); // truncates the garbage
    expect(open().loadAll().lines).toHaveLength(2);
    const lines = readFileSync(path, 'utf8').split('\n');
    writeFileSync(path, `${lines[0]}\ngarbage-line\n${lines[2]}\n`);
    expect(code(() => open().loadAll())).toBe('CORRUPT');
  });

  it('rewrite changes gen, restarts seq at 1 and keeps the given order', () => {
    const gen = newGen();
    Journal.create(path, 'memories', VAULT_ID, gen);
    const w = open();
    for (let i = 1; i <= 5; i += 1) w.append(`m${i}`, put(`m${i}`, i));
    const g2 = newGen();
    expect(w.rewrite([{ id: 'm5', record: { id: 'm5', n: 5 } }, { id: 'm2', record: { id: 'm2', n: 2 } }], g2)).toBe(g2);
    expect(w.gen).toBe(g2);
    expect(w.lastSeq).toBe(2);
    const text = readFileSync(path, 'utf8');
    expect(JSON.parse(text.split('\n')[0] ?? '{}')).toMatchObject({ gen: g2 });
    const r = open();
    const loaded = r.loadAll();
    expect(loaded.gen).toBe(g2);
    expect(loaded.lines.map((l) => [l.seq, l.id])).toEqual([
      [1, 'm5'],
      [2, 'm2'],
    ]);
    expect(Journal.verifyChain(path)).toMatchObject({ ok: true, lines: 2, gen: g2 });
    // the writer can keep appending on the new gen
    expect(w.append('m6', put('m6', 6)).seq).toBe(3);
    expect(r.tail().lines.map((l) => l.seq)).toEqual([3]);
    // an empty rewrite is a valid empty journal
    w.rewrite([], newGen());
    expect(open().loadAll().lines).toEqual([]);
  });

  it('a reader whose file was replaced by a rewrite reloads with reloaded:true', () => {
    Journal.create(path, 'memories', VAULT_ID, newGen());
    const w = open();
    w.append('a', put('a', 1));
    const r = open();
    r.loadAll();
    w.append('b', put('b', 2));
    w.rewrite([{ id: 'b', record: { id: 'b', n: 2 } }], newGen());
    const t = r.tail();
    expect(t.reloaded).toBe(true);
    expect(t.lines.map((l) => l.id)).toEqual(['b']);
    expect(r.gen).toBe(w.gen);
  });

  it('header problems: wrong journal name, other vault, missing file, wrong kind', () => {
    Journal.create(path, 'memories', VAULT_ID, newGen());
    expect(code(() => new Journal(path, 'sources', JOURNAL_KINDS.sources, sealer).loadAll())).toBe('CORRUPT');
    const other = new Sealer(randomBytes(32), 'c3c0a3f1c4d5e6f7a8b9c0d1e2f3a4b5');
    expect(code(() => new Journal(path, 'memories', JOURNAL_KINDS.memories, other).loadAll())).toBe('CORRUPT');
    expect(code(() => new Journal(join(root, 'absent.jsonl'), 'memories', JOURNAL_KINDS.memories, sealer).loadAll())).toBe('CORRUPT');
    const w = open();
    w.append('a', put('a', 1));
    expect(code(() => new Journal(path, 'memories', JOURNAL_KINDS.grants, sealer).loadAll())).toBe('CORRUPT');
    expect(code(() => new Journal(path, 'memories', JOURNAL_KINDS.memories, new Sealer(randomBytes(32), VAULT_ID)).loadAll())).toBe('CORRUPT');
    writeFileSync(path, '');
    expect(code(() => open().loadAll())).toBe('CORRUPT');
    writeFileSync(path, '{"journal":"memories"');
    expect(code(() => open().loadAll())).toBe('CORRUPT');
  });

  it('verifyChain without a key reports ok, line count, gen and the first break', () => {
    const gen = newGen();
    Journal.create(path, 'memories', VAULT_ID, gen);
    expect(Journal.verifyChain(path)).toEqual({ ok: true, lines: 0, gen });
    const w = open();
    for (let i = 1; i <= 4; i += 1) w.append(`m${i}`, put(`m${i}`, i));
    expect(Journal.verifyChain(path)).toEqual({ ok: true, lines: 4, gen });
    const lines = readFileSync(path, 'utf8').split('\n');
    const env = lineToEnvelope(lines[3] ?? '');
    const forged = JSON.stringify({ ...env, prev: 'f'.repeat(64) });
    writeFileSync(path, `${[lines[0], lines[1], lines[2], forged, lines[4]].join('\n')}\n`);
    const v = Journal.verifyChain(path);
    expect(v.ok).toBe(false);
    expect(v.lines).toBe(2);
    expect(v.brokenAtLine).toBe(4);
    expect(v.reason).toMatch(/prev/);
    expect(Journal.verifyChain(join(root, 'absent.jsonl')).ok).toBe(false);
    writeFileSync(path, 'nonsense\n');
    expect(Journal.verifyChain(path)).toMatchObject({ ok: false, brokenAtLine: 1 });
  });

  it('a sibling that replaced the torn tail with a real line of the same length is seen, never truncated away', () => {
    Journal.create(path, 'memories', VAULT_ID, newGen());
    const a = open();
    a.loadAll();
    const b = open();
    b.append('a', put('a', 1)); // seq 1 is shorter (prev "genesis"); every later line of this shape has the same length
    const sizeBefore = readFileSync(path).length;
    b.append('b', put('b', 2));
    const lineLength = readFileSync(path).length - sizeBefore;
    a.tail();
    // A crashed writer left a torn tail of exactly one line's length; A observes it…
    appendFileSync(path, 'x'.repeat(lineLength));
    expect(a.tail().lines).toEqual([]);
    expect(warnings).toHaveLength(1);
    // …B (another process, under the lock) truncates it and appends a real line of the same length.
    b.append('c', put('c', 3));
    expect(readFileSync(path).length).toBe(sizeBefore + 2 * lineLength);
    // A must decode B's line instead of judging "nothing new" from the size alone…
    const seen = a.tail();
    expect(seen.lines.map((l) => l.id)).toEqual(['c']);
    expect(a.lastSeq).toBe(3);
    // …so A's own append continues the chain instead of truncating B's committed record.
    a.append('d', put('d', 4));
    expect(open().loadAll().lines.map((l) => l.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(Journal.verifyChain(path)).toMatchObject({ ok: true, lines: 4 });
    expect(b.tail().lines.map((l) => l.id)).toEqual(['d']);
  });

  it('lazy mode verifies the chain and the newest line without decrypting the rest', () => {
    const gen = newGen();
    Journal.create(path, 'memories', VAULT_ID, gen);
    const w = open();
    for (let i = 1; i <= 5; i += 1) w.append(`m${i}`, put(`m${i}`, i));
    const lazy = new Journal(path, 'memories', JOURNAL_KINDS.memories, sealer, undefined, true);
    const r = lazy.loadAll();
    expect(r).toEqual({ lines: [], reloaded: true, gen });
    expect(lazy.lastSeq).toBe(5);
    expect(lazy.byteOffset).toBe(w.byteOffset);
    w.append('m6', put('m6', 6));
    expect(lazy.tail()).toEqual({ lines: [], reloaded: false, gen });
    expect(lazy.lastSeq).toBe(6);
    // a wrong key fails on the newest line; a broken chain in the middle fails without any key
    const other = new Journal(path, 'memories', JOURNAL_KINDS.memories, new Sealer(randomBytes(32), VAULT_ID), undefined, true);
    expect(code(() => other.loadAll())).toBe('CORRUPT');
    const lines = readFileSync(path, 'utf8').split('\n');
    const env = lineToEnvelope(lines[3] ?? '');
    writeFileSync(path, `${[lines[0], lines[1], lines[2], JSON.stringify({ ...env, prev: 'f'.repeat(64) }), ...lines.slice(4)].join('\n')}`);
    expect(code(() => new Journal(path, 'memories', JOURNAL_KINDS.memories, sealer, undefined, true).loadAll())).toBe('CORRUPT');
  });

  it('append rejects a del whose id differs from the line id', () => {
    Journal.create(path, 'memories', VAULT_ID, newGen());
    const w = open();
    expect(code(() => w.append('a', { op: 'del', id: 'b', at: '2026-10-20T10:00:00.000Z' }))).toBe('INVALID_ARGUMENT');
  });
});
