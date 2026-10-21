import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sealer } from '../src/crypto/envelope.js';
import { createKeyFile, loadKey, rewriteKeyFile } from '../src/crypto/keyfile.js';
import { VaultError } from '../src/errors.js';
import { newGen } from '../src/ids.js';
import { JOURNAL_KINDS, Journal } from '../src/store/journal.js';
import { withLock } from '../src/store/lock.js';
import { VaultStore } from '../src/store/vault-store.js';
import { makeMemory } from './helpers/tmp-vault.js';

/**
 * A disk that accepts part of a buffer and then nothing: the first write lands all but one byte, every later write
 * returns 0 (what the kernel does when the last free block fills mid-line). Node's bare writeSync returns the short
 * count without an error, which is exactly what the vault's writers used to ignore.
 */
const shortWrites = { armed: false, calls: 0 };
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const writeSync: typeof real.writeSync = ((fd: number, data: Buffer | string, ...rest: unknown[]): number => {
    if (!shortWrites.armed) return (real.writeSync as (...a: unknown[]) => number)(fd, data, ...rest);
    shortWrites.calls += 1;
    if (shortWrites.calls > 1) return 0;
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const offset = typeof rest[0] === 'number' ? rest[0] : 0;
    const length = typeof rest[1] === 'number' ? rest[1] : buf.length - offset;
    const n = Math.max(0, length - 1);
    return real.writeSync(fd, buf, offset, n);
  }) as typeof real.writeSync;
  return { ...real, writeSync };
});

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof VaultError ? err.code : `non-vault:${String(err)}`;
  }
}

const VAULT_ID = 'b2b0a3f1c4d5e6f7a8b9c0d1e2f3a4b5';

describe('short writes are failures, never silent success', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ocv-short-'));
    shortWrites.armed = false;
    shortWrites.calls = 0;
  });
  afterEach(() => {
    shortWrites.armed = false;
    rmSync(root, { recursive: true, force: true });
  });

  it('Journal.append throws IO and leaves the file exactly as it was (no torn line behind a reported failure)', () => {
    const path = join(root, 'memories.jsonl');
    Journal.create(path, 'memories', VAULT_ID, newGen());
    const sealer = new Sealer(randomBytes(32), VAULT_ID);
    const w = new Journal(path, 'memories', JOURNAL_KINDS.memories, sealer);
    w.append('a', { op: 'put', record: { id: 'a' } });
    const before = readFileSync(path);
    shortWrites.armed = true;
    expect(code(() => w.append('b', { op: 'put', record: { id: 'b' } }))).toBe('IO');
    shortWrites.armed = false;
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(w.lastSeq).toBe(1);
    const r = new Journal(path, 'memories', JOURNAL_KINDS.memories, sealer);
    expect(r.loadAll().lines.map((l) => l.id)).toEqual(['a']);
    // the same writer recovers once the disk has room
    expect(w.append('c', { op: 'put', record: { id: 'c' } }).seq).toBe(2);
    expect(r.tail().lines.map((l) => l.id)).toEqual(['c']);
  });

  it('Journal.rewrite throws IO and never renames a truncated file over the live journal', () => {
    const path = join(root, 'memories.jsonl');
    const gen = newGen();
    Journal.create(path, 'memories', VAULT_ID, gen);
    const sealer = new Sealer(randomBytes(32), VAULT_ID);
    const w = new Journal(path, 'memories', JOURNAL_KINDS.memories, sealer);
    for (let i = 0; i < 3; i += 1) w.append(`m${i}`, { op: 'put', record: { id: `m${i}` } });
    const before = readFileSync(path);
    shortWrites.armed = true;
    expect(code(() => w.rewrite([{ id: 'm2', record: { id: 'm2' } }], newGen()))).toBe('IO');
    shortWrites.armed = false;
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(Journal.verifyChain(path)).toMatchObject({ ok: true, lines: 3, gen });
  });

  it('VaultStore.putMemory reports IO, holds no lock afterwards and keeps the in-memory view honest', () => {
    const dir = join(root, 'vault');
    const keyFile = join(root, 'vault.key');
    const store = VaultStore.init({ dir, keyFile });
    try {
      store.putMemory(makeMemory({ statement: 'Before the disk filled.' }));
      shortWrites.armed = true;
      expect(code(() => store.putMemory(makeMemory({ statement: 'Lost on a full disk.' })))).toBe('IO');
      shortWrites.armed = false;
      expect(existsSync(join(dir, '.lock'))).toBe(false);
      expect(store.listMemories().map((m) => m.statement)).toEqual(['Before the disk filled.']);
      const fresh = VaultStore.open({ dir, keyFile, onWarn: () => undefined });
      expect(fresh.listMemories().map((m) => m.statement)).toEqual(['Before the disk filled.']);
      expect(fresh.verify().ok).toBe(true);
      fresh.close();
      store.putMemory(makeMemory({ statement: 'After space was freed.' }));
      expect(store.listMemories()).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it('a short write of the key file is IO and the previous key file stays intact', () => {
    const path = join(root, 'vault.key');
    const key = createKeyFile(path, VAULT_ID);
    const before = readFileSync(path, 'utf8');
    shortWrites.armed = true;
    expect(code(() => rewriteKeyFile(path, VAULT_ID, randomBytes(32), {}))).toBe('IO');
    shortWrites.armed = false;
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(loadKey(path, VAULT_ID, {}).equals(key)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('a failed lock write is IO and leaves no empty .lock behind', () => {
    const dir = join(root, 'd');
    mkdirSync(dir, { recursive: true });
    shortWrites.armed = true;
    shortWrites.calls = 1; // the very first write already returns 0
    expect(code(() => withLock(dir, () => 'never'))).toBe('IO');
    shortWrites.armed = false;
    expect(existsSync(join(dir, '.lock'))).toBe(false);
    expect(withLock(dir, () => 'ok', { waitMs: 0 })).toBe('ok');
  });
});
