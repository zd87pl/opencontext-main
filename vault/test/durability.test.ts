import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sealer, envelopeToLine, lineToEnvelope } from '../src/crypto/envelope.js';
import { createKeyFile, loadKey, rewriteKeyFile } from '../src/crypto/keyfile.js';
import { VaultError } from '../src/errors.js';
import { buildPortable } from '../src/exporters/portable.js';
import { newGen } from '../src/ids.js';
import { JOURNAL_KINDS, Journal } from '../src/store/journal.js';
import { VaultStore } from '../src/store/vault-store.js';
import { type AuditEntry, type Manifest } from '../src/types.js';
import { makeMemory, makeSource, tmpVault } from './helpers/tmp-vault.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof VaultError ? err.code : `non-vault:${String(err)}`;
  }
}

function auditEntry(partial?: Partial<Omit<AuditEntry, 'id' | 'session'>>): Omit<AuditEntry, 'id' | 'session'> {
  return { at: new Date().toISOString(), pid: process.pid, grant: null, client: null, event: 'tool', name: 'vault_search', args: { query: 'x' }, outcome: 'ok', ms: 1, ...partial };
}

function manifestOf(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')) as Manifest;
}

function writeManifest(dir: string, m: Manifest): void {
  writeFileSync(join(dir, 'vault.json'), `${JSON.stringify(m, null, 2)}\n`);
}

/** A journal's live records as compaction would write them (last put/del per id wins). */
function liveOf(path: string, name: 'memories' | 'sources' | 'grants', sealer: Sealer): Array<{ id: string; record: unknown }> {
  const live = new Map<string, unknown>();
  for (const line of new Journal(path, name, JOURNAL_KINDS[name], sealer).loadAll().lines) {
    if (line.op.op === 'put') live.set(line.id, line.op.record);
    else live.delete(line.id);
  }
  return [...live].map(([id, record]) => ({ id, record }));
}

describe('large source bodies', () => {
  let v: ReturnType<typeof tmpVault>;
  beforeEach(() => {
    v = tmpVault();
  });
  afterEach(() => v.cleanup());

  it('a 5 MB document is written, read back, verified, exported and survives rekey (no regex stack overflow on base64)', () => {
    const text = 'x'.repeat(5_000_000);
    const big = makeSource({ content: { kind: 'document', mediaType: 'text/plain', text }, origin: { importer: 'test@1', path: '', externalId: 'big', trust: 'imported' } });
    v.store.putSource(big);
    expect(v.store.getSourceContent(big.id)).toEqual(big.content);
    expect(v.store.verify({ bodies: true })).toMatchObject({ ok: true, bodies: { checked: 1, bad: [] } });
    const portable = buildPortable(v.store, { generator: 'test' });
    expect(portable.sources[0]?.content).toEqual(big.content);
    v.store.rekey({});
    const reopened = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
    expect(reopened.getSourceContent(big.id)?.kind).toBe('document');
    expect(reopened.verify({ bodies: true }).ok).toBe(true);
    reopened.close();
  });
});

describe('rekey is crash-safe', () => {
  let v: ReturnType<typeof tmpVault>;
  beforeEach(() => {
    v = tmpVault();
  });
  afterEach(() => v.cleanup());

  function seed(): { src: ReturnType<typeof makeSource>; memId: string } {
    const src = makeSource({ turnsText: ['keep this readable', 'and this'] });
    v.store.putSource(src);
    const other = makeSource({ origin: { importer: 'test@1', path: '', externalId: 'other', trust: 'imported' }, turnsText: ['second body'] });
    v.store.putSource(other);
    const memId = v.store.putMemory(makeMemory({ sources: [{ sourceId: src.id, turn: 0, quote: 'keep this', verified: false }] })).id;
    v.store.appendAudit(auditEntry());
    return { src, memId };
  }

  it('an unreadable body aborts the rekey before anything is re-sealed; the vault opens exactly as before', () => {
    const { src } = seed();
    const before = manifestOf(v.dir);
    const keyBefore = readFileSync(v.keyFile, 'utf8');
    unlinkSync(join(v.dir, 'sources', `${src.id}.enc`));
    expect(code(() => v.store.rekey({}))).toBe('CORRUPT');
    expect(manifestOf(v.dir)).toEqual(before);
    expect(readFileSync(v.keyFile, 'utf8')).toBe(keyBefore);
    expect(existsSync(`${v.keyFile}.next`)).toBe(false);
    for (const name of ['memories', 'sources', 'grants', 'audit'] as const) {
      expect(Journal.verifyChain(join(v.dir, `${name}.jsonl`))).toMatchObject({ ok: true, gen: before.gens[name] });
    }
    const reopened = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
    expect(reopened.listMemories()).toHaveLength(1);
    expect(reopened.verify({ bodies: true })).toMatchObject({ ok: false, bodies: { checked: 2, bad: [src.id] } });
    reopened.close();
  });

  it('a rekey interrupted after the next key was staged (journals and bodies half re-sealed) is finished by the next open', () => {
    const { src, memId } = seed();
    const vaultId = v.store.vaultId;
    const oldKeyId = v.store.keyId;
    const oldKeyBytes = loadKey(v.keyFile, vaultId, {});
    v.store.close();
    // Reproduce the crash state by hand: the staged key exists, memories.jsonl and one body are already under it,
    // sources/grants/audit and the other body are still under the old key, the manifest is untouched.
    const newKey = randomBytes(32);
    const next = `${v.keyFile}.next`;
    rewriteKeyFile(next, vaultId, newKey, {}, { from: v.keyFile });
    const oldSealer = new Sealer(loadKey(v.keyFile, vaultId, {}), vaultId);
    const newSealer = new Sealer(newKey, vaultId);
    const memPath = join(v.dir, 'memories.jsonl');
    new Journal(memPath, 'memories', JOURNAL_KINDS.memories, newSealer).rewrite(liveOf(memPath, 'memories', oldSealer), newGen());
    const bodyPath = join(v.dir, 'sources', `${src.id}.enc`);
    const env = lineToEnvelope(readFileSync(bodyPath, 'utf8').trimEnd());
    const plaintext = oldSealer.open(env, 'source-body', { gen: '', seq: 0, id: src.id, prev: '' });
    writeFileSync(bodyPath, `${envelopeToLine(newSealer.seal('source-body', plaintext, { gen: '', seq: 0, id: src.id, prev: '' }))}\n`);
    expect(manifestOf(v.dir).keyId).toBe(oldKeyId);

    const warnings: string[] = [];
    const resumed = VaultStore.open({ dir: v.dir, keyFile: v.keyFile, onWarn: (m) => warnings.push(m) });
    expect(warnings.some((w) => w.includes('finished an interrupted rekey'))).toBe(true);
    expect(existsSync(next)).toBe(false);
    expect(resumed.keyId).toBe(newSealer.keyId);
    expect(manifestOf(v.dir).keyId).toBe(newSealer.keyId);
    expect(resumed.getMemory(memId)?.sources[0]?.verified).toBe(true);
    expect(resumed.getSourceContent(src.id)).toEqual(src.content);
    expect(resumed.listSources()).toHaveLength(2);
    expect(resumed.readAudit()).toHaveLength(1);
    expect(resumed.verify({ bodies: true })).toMatchObject({ ok: true, bodies: { checked: 2, bad: [] } });
    resumed.close();
    // the old key opens nothing any more
    const oldKeyFile = join(v.dir, '..', 'old.key');
    writeFileSync(oldKeyFile, JSON.stringify({ format: 'opencontext-vault-key', version: 1, vaultId, keyId: oldKeyId, kdf: 'none', key: oldKeyBytes.toString('base64') }));
    expect(code(() => VaultStore.open({ dir: v.dir, keyFile: oldKeyFile }))).toBe('BAD_KEY');
  });

  it('a rekey interrupted after the manifest was written but before the key file was promoted is finished by the next open', () => {
    seed();
    const vaultId = v.store.vaultId;
    const oldKeyText = readFileSync(v.keyFile, 'utf8');
    v.store.rekey({});
    const newKeyId = v.store.keyId;
    v.store.close();
    // Crash state: manifest names the new key, the key file still holds the old one, the staged file holds the new one.
    const next = `${v.keyFile}.next`;
    writeFileSync(next, readFileSync(v.keyFile, 'utf8'), { mode: 0o600 });
    writeFileSync(v.keyFile, oldKeyText, { mode: 0o600 });
    expect(manifestOf(v.dir).keyId).toBe(newKeyId);
    const warnings: string[] = [];
    const resumed = VaultStore.open({ dir: v.dir, keyFile: v.keyFile, onWarn: (m) => warnings.push(m) });
    expect(resumed.keyId).toBe(newKeyId);
    expect(existsSync(next)).toBe(false);
    expect((JSON.parse(readFileSync(v.keyFile, 'utf8')) as { keyId: string }).keyId).toBe(newKeyId);
    expect(warnings.some((w) => w.includes('finished an interrupted rekey'))).toBe(true);
    expect(resumed.verify({ bodies: true }).ok).toBe(true);
    expect(resumed.listMemories()).toHaveLength(1);
    resumed.close();
    // a staged file of another vault is neither used nor deleted
    const foreign = `${v.keyFile}.next`;
    createKeyFile(foreign, 'c3c0a3f1c4d5e6f7a8b9c0d1e2f3a4b5');
    expect(code(() => VaultStore.open({ dir: v.dir, keyFile: v.keyFile }))).toBe('CORRUPT');
    expect(existsSync(foreign)).toBe(true);
    unlinkSync(foreign);
    // a staged key of this vault that nothing was re-sealed under yet (rekey died right after staging) is simply completed
    const staged = createKeyFile(foreign, vaultId);
    const completed = VaultStore.open({ dir: v.dir, keyFile: v.keyFile, onWarn: () => undefined });
    expect(completed.keyId).toBe(new Sealer(staged, vaultId).keyId);
    expect(existsSync(foreign)).toBe(false);
    expect(completed.listMemories()).toHaveLength(1);
    expect(completed.verify({ bodies: true }).ok).toBe(true);
    completed.close();
  });

  it('passphrase mode: the passphrase is resolved once, proven before any re-seal, and a wrong answer changes nothing', () => {
    const p = tmpVault({ passphrase: 'pw' });
    try {
      p.store.putMemory(makeMemory());
      const keyIdBefore = p.store.keyId;
      const manifestBefore = manifestOf(p.dir);
      let asked = 0;
      expect(
        code(() =>
          p.store.rekey({
            prompt: () => {
              asked += 1;
              return 'typo';
            },
          }),
        ),
      ).toBe('BAD_KEY');
      expect(asked).toBe(1);
      expect(manifestOf(p.dir)).toEqual(manifestBefore);
      expect(existsSync(`${p.keyFile}.next`)).toBe(false);
      expect(p.store.keyId).toBe(keyIdBefore);
      asked = 0;
      p.store.rekey({
        prompt: () => {
          asked += 1;
          return 'pw';
        },
      });
      expect(asked).toBe(1);
      expect(VaultStore.open({ dir: p.dir, keyFile: p.keyFile, passphrase: { passphrase: 'pw' } }).listMemories()).toHaveLength(1);
      expect(code(() => VaultStore.open({ dir: p.dir, keyFile: p.keyFile, passphrase: { passphrase: 'typo' } }))).toBe('BAD_KEY');
    } finally {
      p.cleanup();
    }
  });

  it('rekey with newPassphrase changes the passphrase (and turns a plain key file into a passphrase-protected one)', () => {
    v.store.putMemory(makeMemory());
    v.store.rekey({}, { newPassphrase: 'first' });
    expect((JSON.parse(readFileSync(v.keyFile, 'utf8')) as { kdf: string }).kdf).toBe('scrypt');
    expect(existsSync(`${v.keyFile}.next`)).toBe(false);
    expect(code(() => VaultStore.open({ dir: v.dir, keyFile: v.keyFile }))).toBe('KEY_LOCKED');
    const a = VaultStore.open({ dir: v.dir, keyFile: v.keyFile, passphrase: { passphrase: 'first' } });
    expect(a.listMemories()).toHaveLength(1);
    a.rekey({ passphrase: 'first' }, { newPassphrase: 'second' });
    a.close();
    expect(code(() => VaultStore.open({ dir: v.dir, keyFile: v.keyFile, passphrase: { passphrase: 'first' } }))).toBe('BAD_KEY');
    const b = VaultStore.open({ dir: v.dir, keyFile: v.keyFile, passphrase: { passphrase: 'second' } });
    expect(b.listMemories()).toHaveLength(1);
    expect(b.verify({ bodies: true }).ok).toBe(true);
    b.close();
  });
});

describe('compaction is crash-safe', () => {
  let v: ReturnType<typeof tmpVault>;
  beforeEach(() => {
    v = tmpVault();
  });
  afterEach(() => v.cleanup());

  it('a journal renamed into place before the manifest write (its gen announced as pending) opens, is finalized, and verifies', () => {
    const keep = v.store.putMemory(makeMemory({ statement: 'User keeps this.' }));
    const gone = v.store.putMemory(makeMemory({ statement: 'User drops this.' }));
    v.store.deleteMemories([gone.id]);
    const after = manifestOf(v.dir);
    expect(after.pendingGens).toBeUndefined();
    const landedGen = after.gens.memories;
    // The exact state between the rename and the manifest write: vault.json still names the previous gen, with the new one pending.
    writeManifest(v.dir, { ...after, gens: { ...after.gens, memories: 'ffffffffffffffff' }, pendingGens: { memories: landedGen } });
    expect(v.store.verify().ok).toBe(true);
    const reopened = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
    expect(reopened.listMemories().map((m) => m.id)).toEqual([keep.id]);
    const finalized = manifestOf(v.dir);
    expect(finalized.gens.memories).toBe(landedGen);
    expect(finalized.pendingGens).toBeUndefined();
    expect(Object.keys(finalized)).toEqual(['format', 'version', 'vaultId', 'createdAt', 'keyId', 'keyCheck', 'gens']);
    expect(reopened.verify().ok).toBe(true);
    reopened.close();
    // a pending gen the journal never reached is simply dropped
    writeManifest(v.dir, { ...finalized, pendingGens: { memories: 'eeeeeeeeeeeeeeee' } });
    const again = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
    expect(manifestOf(v.dir).pendingGens).toBeUndefined();
    expect(again.listMemories()).toHaveLength(1);
    again.close();
    // a gen that is neither current nor pending is still a rollback
    writeManifest(v.dir, { ...finalized, gens: { ...finalized.gens, memories: 'dddddddddddddddd' }, pendingGens: { memories: 'eeeeeeeeeeeeeeee' } });
    expect(code(() => VaultStore.open({ dir: v.dir, keyFile: v.keyFile }))).toBe('CORRUPT');
  });

  it('stale staging files are removed on open', () => {
    v.store.close();
    writeFileSync(join(v.dir, 'tmp', 'vault.json.123.abcd.tmp'), '{}');
    writeFileSync(join(v.dir, 'memories.jsonl.tmp'), 'half');
    VaultStore.open({ dir: v.dir, keyFile: v.keyFile }).close();
    expect(existsSync(join(v.dir, 'tmp', 'vault.json.123.abcd.tmp'))).toBe(false);
    expect(existsSync(join(v.dir, 'memories.jsonl.tmp'))).toBe(false);
  });
});

describe('init can be retried', () => {
  it('a failed init removes what it created, and an existing key file is refused with a hint that names the retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'ocv-init-'));
    try {
      const dir = join(root, 'vault');
      const keyFile = join(root, 'vault.key');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, 'memories.jsonl'), 'left over from a crash'); // makes Journal.create fail after the key file exists
      expect(code(() => VaultStore.init({ dir, keyFile }))).toBe('EXISTS');
      expect(existsSync(keyFile)).toBe(false);
      expect(existsSync(join(dir, 'vault.json'))).toBe(false);
      unlinkSync(join(dir, 'memories.jsonl'));
      const store = VaultStore.init({ dir, keyFile });
      expect(store.listMemories()).toEqual([]);
      store.close();
      // a key file without a vault: EXISTS, with the hint about a failed init
      const dir2 = join(root, 'vault2');
      let err: unknown;
      try {
        VaultStore.init({ dir: dir2, keyFile });
      } catch (e) {
        err = e;
      }
      expect(VaultError.is(err, 'EXISTS')).toBe(true);
      expect((err as VaultError).hint).toContain('previous init');
      expect(existsSync(dir2)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns (and reports the real mode) when the directory already existed with a wider mode, and when the key file sits inside it', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ocv-init-'));
    try {
      const dir = join(root, 'vault');
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o755);
      const warnings: string[] = [];
      const store = VaultStore.init({ dir, keyFile: join(dir, 'vault.key'), onWarn: (m) => warnings.push(m) });
      store.close();
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      expect(warnings.some((w) => w.includes('0755'))).toBe(true);
      expect(warnings.some((w) => w.includes('inside the vault directory'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('stale views and stale flags', () => {
  let v: ReturnType<typeof tmpVault>;
  beforeEach(() => {
    v = tmpVault();
  });
  afterEach(() => v.cleanup());

  it('a body forgotten or replaced by another process is a stale view, not CORRUPT', () => {
    const src = makeSource({ turnsText: ['first version'] });
    v.store.putSource(src);
    const other = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
    try {
      other.listSources();
      v.store.deleteSources([src.id]);
      expect(other.getSourceContent(src.id)).toBeUndefined();
      expect(other.listSources()).toHaveLength(0);
      const replaced = makeSource({ turnsText: ['second version'] });
      v.store.putSource(replaced);
      other.refresh();
      v.store.putSource(makeSource({ turnsText: ['third version'] }));
      expect(other.getSourceContent(src.id)).toEqual({ kind: 'conversation', turns: [{ i: 0, role: 'user', text: 'third version' }] });
      expect(other.verify({ bodies: true }).ok).toBe(true);
    } finally {
      other.close();
    }
  });

  it('replacing a source body re-verifies every citation to it immediately', () => {
    const src = makeSource({ turnsText: ['I love tabs'] });
    v.store.putSource(src);
    const m = v.store.putMemory(makeMemory({ sources: [{ sourceId: src.id, turn: 0, quote: 'I love tabs', verified: false }] }));
    expect(v.store.getMemory(m.id)?.sources[0]?.verified).toBe(true);
    v.store.putSource(makeSource({ turnsText: ['I hate tabs, never use them'] }));
    expect(v.store.getMemory(m.id)?.sources[0]?.verified).toBe(false);
    expect(v.store.verifyProvenance().changed).toEqual([]);
    v.store.putSource(makeSource({ turnsText: ['I love tabs', 'still'] }));
    expect(v.store.getMemory(m.id)?.sources[0]?.verified).toBe(true);
  });

  it('deleteMemories stops the supersede chain at the first version the caller may not see', () => {
    const old = v.store.putMemory(makeMemory({ statement: 'User lives in Porto.', tags: ['private'] }));
    const nu = v.store.putMemory(makeMemory({ statement: 'User lives in Lisbon.', tags: ['scratch'], supersedes: old.id }));
    v.store.putMemory({ ...old, status: 'superseded', supersededBy: nu.id });
    const forgotten = v.store.deleteMemories([nu.id], (m) => m.tags.includes('scratch'));
    expect(forgotten).toEqual([nu.id]);
    expect(v.store.getMemory(old.id)?.status).toBe('superseded');
    expect(v.store.deleteMemories([old.id])).toEqual([old.id]);
  });
});

describe('audit journal reads', () => {
  let v: ReturnType<typeof tmpVault>;
  beforeEach(() => {
    v = tmpVault();
  });
  afterEach(() => v.cleanup());

  it('readAudit with a limit scans backwards and matches the full read, filters included, tolerates a torn tail, and detects a tampered line', () => {
    for (let i = 0; i < 30; i += 1) {
      v.store.appendAudit(auditEntry({ name: `call-${i}`, grant: i % 3 === 0 ? { id: 'grt_0000000000000000', label: 'bot' } : null, outcome: i % 5 === 0 ? 'denied' : 'ok', at: new Date(1_700_000_000_000 + i * 1000).toISOString() }));
    }
    const all = v.store.readAudit();
    expect(all).toHaveLength(30);
    expect(v.store.readAudit({ limit: 5 })).toEqual(all.slice(25));
    expect(v.store.readAudit({ limit: 100 })).toEqual(all);
    expect(v.store.readAudit({ limit: 0 })).toEqual([]);
    expect(v.store.readAudit({ limit: 4, label: 'bot' })).toEqual(all.filter((e) => e.grant?.label === 'bot').slice(-4));
    expect(v.store.readAudit({ limit: 2, outcome: 'denied' })).toEqual(all.filter((e) => e.outcome === 'denied').slice(-2));
    const since = new Date(1_700_000_000_000 + 20_000).toISOString();
    expect(v.store.readAudit({ limit: 3, since })).toEqual(all.filter((e) => e.at >= since).slice(-3));
    expect(v.store.stats().auditEntries).toBe(30);
    // a torn tail is skipped by both readers
    const path = join(v.dir, 'audit.jsonl');
    appendFileSync(path, '{"v":1,"k":"audit","seq":31,"id":"aud_1","prev":"');
    const fresh = VaultStore.open({ dir: v.dir, keyFile: v.keyFile, onWarn: () => undefined });
    expect(fresh.readAudit({ limit: 2 })).toEqual(all.slice(28));
    expect(fresh.readAudit()).toHaveLength(30);
    fresh.close();
    // a flipped byte inside the newest line: CORRUPT from both readers and at open (the lazy reader opens the newest line)
    const lines = readFileSync(path, 'utf8').split('\n');
    const last = lineToEnvelope(lines[30] ?? '');
    const ct = Buffer.from(last.ct, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 1;
    lines[30] = envelopeToLine({ ...last, ct: ct.toString('base64') });
    writeFileSync(path, `${lines.slice(0, 31).join('\n')}\n`);
    expect(code(() => v.store.readAudit({ limit: 1 }))).toBe('CORRUPT');
    expect(code(() => VaultStore.open({ dir: v.dir, keyFile: v.keyFile }))).toBe('CORRUPT');
  });

  it('a tampered line in the middle of the audit journal is caught at open without decrypting the log', () => {
    for (let i = 0; i < 10; i += 1) v.store.appendAudit(auditEntry({ name: `call-${i}` }));
    const path = join(v.dir, 'audit.jsonl');
    const lines = readFileSync(path, 'utf8').split('\n');
    const env = lineToEnvelope(lines[5] ?? '');
    lines[5] = envelopeToLine({ ...env, id: 'aud_0000000000000000' });
    writeFileSync(path, lines.join('\n'));
    expect(code(() => VaultStore.open({ dir: v.dir, keyFile: v.keyFile }))).toBe('CORRUPT');
  });
});
