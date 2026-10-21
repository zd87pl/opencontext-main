import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelopeToLine, type Sealer } from '../src/crypto/envelope.js';
import { createKeyFile, loadKey } from '../src/crypto/keyfile.js';
import { hashToken, newToken } from '../src/crypto/token.js';
import { VaultError } from '../src/errors.js';
import { newId } from '../src/ids.js';
import { Journal } from '../src/store/journal.js';
import { VaultStore } from '../src/store/vault-store.js';
import { LIMITS, type AuditEntry, type Grant, type Manifest } from '../src/types.js';
import { canonicalJson } from '../src/util/canonical-json.js';
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
  return {
    at: new Date().toISOString(),
    pid: process.pid,
    grant: null,
    client: null,
    event: 'tool',
    name: 'vault_search',
    args: { query: 'x' },
    outcome: 'ok',
    ms: 1,
    ...partial,
  };
}

function grant(label: string, token = newToken()): Grant {
  return { id: newId('grt'), label, tokenHash: hashToken(token), scopes: ['read'], createdAt: new Date().toISOString() };
}

describe('VaultStore', () => {
  let v: ReturnType<typeof tmpVault>;
  beforeEach(() => {
    v = tmpVault();
  });
  afterEach(() => {
    v.cleanup();
  });

  describe('init / open / exists', () => {
    it('creates the layout with restrictive modes and refuses a second init', () => {
      const { dir, keyFile, store } = v;
      expect(VaultStore.exists(dir)).toBe(true);
      expect(VaultStore.exists(join(dir, 'nope'))).toBe(false);
      for (const f of ['vault.json', 'memories.jsonl', 'sources.jsonl', 'grants.jsonl', 'audit.jsonl']) expect(existsSync(join(dir, f))).toBe(true);
      for (const d of ['sources', 'sessions', 'tmp']) expect(statSync(join(dir, d)).isDirectory()).toBe(true);
      if (process.platform !== 'win32') {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        expect(statSync(join(dir, 'sources')).mode & 0o777).toBe(0o700);
        expect(statSync(keyFile).mode & 0o777).toBe(0o600);
      }
      expect(keyFile.startsWith(`${dir}/`)).toBe(false); // sibling, never inside
      expect(keyFile).toBe(`${dir}.key`);
      const manifest = JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')) as Manifest;
      expect(manifest).toMatchObject({ format: 'opencontext-vault', version: 1, vaultId: store.vaultId, keyId: store.keyId });
      expect(Object.keys(manifest)).toEqual(['format', 'version', 'vaultId', 'createdAt', 'keyId', 'keyCheck', 'gens']);
      expect(readFileSync(join(dir, 'vault.json'), 'utf8').endsWith('}\n')).toBe(true);
      expect(store.manifest.gens.memories).toMatch(/^[0-9a-f]{16}$/);
      expect(store.session).toMatch(/^ses_[0-9a-f]{16}$/);
      expect(code(() => VaultStore.init({ dir, keyFile }))).toBe('EXISTS');
      expect(code(() => VaultStore.init({ dir, keyFile: join(dir, '..', 'other.key') }))).toBe('EXISTS');
    });

    it('open: VAULT_NOT_FOUND, KEY_NOT_FOUND, CORRUPT manifest', () => {
      expect(code(() => VaultStore.open({ dir: join(v.dir, 'missing'), keyFile: v.keyFile }))).toBe('VAULT_NOT_FOUND');
      expect(code(() => VaultStore.open({ dir: v.dir, keyFile: join(v.dir, '..', 'missing.key') }))).toBe('KEY_NOT_FOUND');
      const second = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
      expect(second.vaultId).toBe(v.store.vaultId);
      expect(second.session).not.toBe(v.store.session);
      second.close();
      writeFileSync(join(v.dir, 'vault.json'), '{"format":"nope"}');
      expect(code(() => VaultStore.open({ dir: v.dir, keyFile: v.keyFile }))).toBe('CORRUPT');
    });

    it('keyId mismatch is reported with both ids before any GCM failure', () => {
      const otherKey = join(v.dir, '..', 'other.key');
      createKeyFile(otherKey, v.store.vaultId); // right vault id, wrong key
      let err: unknown;
      try {
        VaultStore.open({ dir: v.dir, keyFile: otherKey });
      } catch (e) {
        err = e;
      }
      expect(VaultError.is(err, 'BAD_KEY')).toBe(true);
      const e = err as VaultError;
      expect(e.message).toContain('does not match this vault');
      expect(e.message).toContain(v.store.keyId);
      expect(e.hint).toContain('--key-file');
      // a key file from a different vault is also BAD_KEY
      createKeyFile(join(v.dir, '..', 'foreign.key'), 'c3c0a3f1c4d5e6f7a8b9c0d1e2f3a4b5');
      expect(code(() => VaultStore.open({ dir: v.dir, keyFile: join(v.dir, '..', 'foreign.key') }))).toBe('BAD_KEY');
    });

    it('passphrase vaults open with the passphrase and refuse without it', () => {
      const p = tmpVault({ passphrase: 'pw-123' });
      try {
        p.store.putMemory(makeMemory());
        p.store.close();
        expect(code(() => VaultStore.open({ dir: p.dir, keyFile: p.keyFile }))).toBe('KEY_LOCKED');
        expect(code(() => VaultStore.open({ dir: p.dir, keyFile: p.keyFile, passphrase: { passphrase: 'nope' } }))).toBe('BAD_KEY');
        const s = VaultStore.open({ dir: p.dir, keyFile: p.keyFile, passphrase: { passphrase: 'pw-123' } });
        expect(s.listMemories()).toHaveLength(1);
        expect(p.env.OPENCONTEXT_VAULT_PASSPHRASE).toBe('pw-123');
        s.close();
      } finally {
        p.cleanup();
      }
    });

    it('close() makes the store unusable', () => {
      const s = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
      s.close();
      s.close();
      expect(code(() => s.listMemories())).toBe('IO');
      expect(code(() => s.refresh())).toBe('IO');
    });
  });

  describe('memories', () => {
    it('put / get / list / filter', () => {
      const { store } = v;
      const a = store.putMemory(makeMemory({ statement: 'User prefers tabs.', kind: 'preference', tags: ['coding', 'go'], updatedAt: '2026-01-01T00:00:00.000Z', createdBy: 'cli' }));
      const b = store.putMemory(makeMemory({ statement: 'Alice is a co-founder.', kind: 'relationship', subject: 'Alice', updatedAt: '2026-02-01T00:00:00.000Z', createdBy: 'claude' }));
      const c = store.putMemory(makeMemory({ statement: 'Old thing.', status: 'superseded', updatedAt: '2026-03-01T00:00:00.000Z', tags: ['coding'] }));
      expect(store.getMemory(a.id)).toEqual(a);
      expect(store.getMemory('mem_0000000000000000')).toBeUndefined();
      expect(store.listMemories().map((m) => m.id)).toEqual([b.id, a.id]); // active only, updatedAt desc
      expect(store.listMemories({ status: 'all' }).map((m) => m.id)).toEqual([c.id, b.id, a.id]);
      expect(store.listMemories({ status: 'superseded' }).map((m) => m.id)).toEqual([c.id]);
      expect(store.listMemories({ kind: 'preference' }).map((m) => m.id)).toEqual([a.id]);
      expect(store.listMemories({ tags: ['go', 'nope'] }).map((m) => m.id)).toEqual([a.id]);
      expect(store.listMemories({ tags: [] }).length).toBe(2);
      expect(store.listMemories({ subject: 'alice' }).map((m) => m.id)).toEqual([b.id]);
      expect(store.listMemories({ createdBy: 'claude' }).map((m) => m.id)).toEqual([b.id]);
      expect(store.listMemories({ since: '2026-01-15T00:00:00.000Z' }).map((m) => m.id)).toEqual([b.id]);
      expect(code(() => store.listMemories({ since: 'yesterday' }))).toBe('INVALID_ARGUMENT');
      // re-put replaces (last line wins)
      const a2 = store.putMemory({ ...a, statement: 'User prefers tabs over spaces.' });
      expect(store.getMemory(a.id)?.statement).toBe(a2.statement);
      expect(store.listMemories({ status: 'all' })).toHaveLength(3);
    });

    it('validates with the Memory schema and reports the issue path', () => {
      const { store } = v;
      let err: unknown;
      try {
        store.putMemory(makeMemory({ statement: 'line\nbreak' }));
      } catch (e) {
        err = e;
      }
      expect(VaultError.is(err, 'INVALID_ARGUMENT')).toBe(true);
      expect((err as VaultError).message).toContain('statement');
      expect(code(() => store.putMemory({ ...makeMemory(), extra: 1 } as unknown as ReturnType<typeof makeMemory>))).toBe('INVALID_ARGUMENT');
      expect(code(() => store.putMemory(makeMemory({ tags: ['Bad Tag'] })))).toBe('INVALID_ARGUMENT');
      expect(store.listMemories()).toHaveLength(0);
    });

    it('supersede chain: two puts, then deleteMemories removes every older version', () => {
      const { store } = v;
      const v1 = store.putMemory(makeMemory({ statement: 'User lives in Berlin.' }));
      const v2 = makeMemory({ statement: 'User lives in Lisbon.', supersedes: v1.id });
      store.putMemory({ ...v1, status: 'superseded', supersededBy: v2.id });
      store.putMemory(v2);
      const v3 = makeMemory({ statement: 'User lives in Porto.', supersedes: v2.id });
      store.putMemory({ ...v2, status: 'superseded', supersededBy: v3.id });
      store.putMemory(v3);
      expect(store.listMemories().map((m) => m.id)).toEqual([v3.id]);
      expect(store.getMemory(v1.id)?.supersededBy).toBe(v2.id);
      expect(store.getMemory(v2.id)?.supersedes).toBe(v1.id);
      const unrelated = store.putMemory(makeMemory({ statement: 'Unrelated.' }));
      const deleted = store.deleteMemories([v3.id, 'mem_0000000000000000']);
      expect(new Set(deleted)).toEqual(new Set([v3.id, v2.id, v1.id]));
      expect(store.listMemories({ status: 'all' }).map((m) => m.id)).toEqual([unrelated.id]);
      expect(store.deleteMemories(['mem_0000000000000000'])).toEqual([]);
    });

    it('deleteMemories compacts: the ciphertext line (and the id) leaves memories.jsonl', () => {
      const { store, dir } = v;
      const keep = store.putMemory(makeMemory({ statement: 'Keep me.' }));
      const gone = store.putMemory(makeMemory({ statement: 'Forget me.' }));
      const before = store.manifest.gens.memories;
      expect(readFileSync(join(dir, 'memories.jsonl'), 'utf8')).toContain(gone.id);
      expect(store.deleteMemories([gone.id])).toEqual([gone.id]);
      const text = readFileSync(join(dir, 'memories.jsonl'), 'utf8');
      expect(text).not.toContain(gone.id);
      expect(text).toContain(keep.id);
      expect(text.split('\n')).toHaveLength(3); // header + 1 live line + ""
      expect(store.manifest.gens.memories).not.toBe(before);
      expect((JSON.parse(readFileSync(join(dir, 'vault.json'), 'utf8')) as Manifest).gens.memories).toBe(store.manifest.gens.memories);
      expect(Journal.verifyChain(join(dir, 'memories.jsonl'))).toMatchObject({ ok: true, lines: 1, gen: store.manifest.gens.memories });
      expect(store.verify().ok).toBe(true);
    });

    it('findDuplicate is exact after normalization (polarity differs → distinct)', () => {
      const { store } = v;
      const m = store.putMemory(makeMemory({ statement: 'User prefers tabs over spaces.', subject: 'User' }));
      expect(store.findDuplicate('user prefers TABS over   spaces', 'user')?.id).toBe(m.id);
      expect(store.findDuplicate('User prefers tabs over spaces!', 'USER')?.id).toBe(m.id);
      expect(store.findDuplicate('User prefers spaces over tabs.', 'user')).toBeUndefined();
      expect(store.findDuplicate('User prefers tabs over spaces.', 'alice')).toBeUndefined();
      expect(store.findDuplicate('User prefers tabs.', 'user')).toBeUndefined();
      store.putMemory({ ...m, status: 'superseded' });
      expect(store.findDuplicate('User prefers tabs over spaces.', 'user')).toBeUndefined();
    });
  });

  describe('sources', () => {
    it('put / get / update / delete, derived fields recomputed, bodies encrypted on disk', () => {
      const { store, dir } = v;
      const src = makeSource({ turnsText: ['I always use tabs in Go, fight me', 'Noted.'], title: 'Go formatting' });
      const meta = store.putSource({ ...src, sha256: 'f'.repeat(64), bytes: 1, turnCount: 99, hasRaw: true });
      expect(meta.sha256).toBe(src.sha256);
      expect(meta.bytes).toBe(src.bytes);
      expect(meta.turnCount).toBe(2);
      expect(meta.hasRaw).toBe(false);
      expect(Object.keys(meta)).not.toContain('content');
      const bodyFile = join(dir, 'sources', `${src.id}.enc`);
      expect(existsSync(bodyFile)).toBe(true);
      expect(readFileSync(bodyFile, 'utf8')).not.toContain('fight me');
      expect(readFileSync(join(dir, 'sources.jsonl'), 'utf8')).not.toContain('Go formatting');
      expect(store.getSourceMeta(src.id)).toEqual(meta);
      expect(store.getSource(src.id)).toEqual({ ...meta, content: src.content });
      expect(store.getSourceContent(src.id)).toEqual(src.content);
      expect(store.findSourceBySha(src.sha256)?.id).toBe(src.id);
      expect(store.findSourceBySha('0'.repeat(64))).toBeUndefined();
      expect(store.getSource('src_0000000000000000')).toBeUndefined();
      expect(store.getSourceContent('src_0000000000000000')).toBeUndefined();

      // metadata update keeps the body-derived fields and refuses a sha change
      const reviewed = store.updateSourceMeta({ ...meta, review: { status: 'reviewed', memoriesCreated: 2 }, bytes: 5 });
      expect(reviewed.review.status).toBe('reviewed');
      expect(reviewed.bytes).toBe(meta.bytes);
      expect(store.getSourceMeta(src.id)?.review.status).toBe('reviewed');
      expect(code(() => store.updateSourceMeta({ ...meta, sha256: '0'.repeat(64) }))).toBe('INVALID_ARGUMENT');
      expect(code(() => store.updateSourceMeta({ ...meta, id: 'src_0000000000000000' }))).toBe('NOT_FOUND');
      expect(code(() => store.putSource({ ...src, title: '' }))).toBe('INVALID_ARGUMENT');

      // re-put with new content replaces the body (same id)
      const updated = makeSource({ turnsText: ['new text'], title: 'Go formatting v2' });
      expect(updated.id).toBe(src.id);
      const meta2 = store.putSource(updated);
      expect(meta2.sha256).not.toBe(meta.sha256);
      expect(store.getSourceContent(src.id)).toEqual(updated.content);
      expect(store.listSources()).toHaveLength(1);
      expect(store.verify({ bodies: true })).toMatchObject({ ok: true, bodies: { checked: 1, bad: [] } });

      // delete: del + compact + unlink
      expect(store.deleteSources([src.id, 'src_0000000000000000'])).toEqual([src.id]);
      expect(existsSync(bodyFile)).toBe(false);
      expect(store.getSource(src.id)).toBeUndefined();
      expect(readFileSync(join(dir, 'sources.jsonl'), 'utf8')).not.toContain(src.id);
      expect(store.deleteSources([src.id])).toEqual([]);
    });

    it('list filters and ordering', () => {
      const { store } = v;
      const a = store.putSource(makeSource({ origin: { importer: 'test@1', path: '', externalId: 'a', trust: 'imported' }, type: 'chatgpt', createdAt: '2025-01-01T00:00:00.000Z', tags: ['work'] }));
      const b = store.putSource(makeSource({ origin: { importer: 'test@1', path: '', externalId: 'b', trust: 'agent-supplied' }, type: 'agent', createdAt: '2025-06-01T00:00:00.000Z', review: { status: 'reviewed' } }));
      expect(store.listSources().map((s) => s.id)).toEqual([b.id, a.id]);
      expect(store.listSources({ type: 'chatgpt' }).map((s) => s.id)).toEqual([a.id]);
      expect(store.listSources({ tags: ['work'] }).map((s) => s.id)).toEqual([a.id]);
      expect(store.listSources({ review: 'unreviewed' }).map((s) => s.id)).toEqual([a.id]);
      expect(store.listSources({ review: 'all' })).toHaveLength(2);
      expect(store.listSources({ since: '2025-03-01T00:00:00.000Z' }).map((s) => s.id)).toEqual([b.id]);
    });

    it('body before meta: a failure between the body write and the meta append leaves no dangling meta', () => {
      const { store, dir, keyFile } = v;
      const src = makeSource({ turnsText: ['body first'] });
      const spy = vi.spyOn(Journal.prototype, 'append').mockImplementationOnce(() => {
        throw new Error('disk full');
      });
      try {
        expect(code(() => store.putSource(src))).toBe('IO');
      } finally {
        spy.mockRestore();
      }
      expect(existsSync(join(dir, 'sources', `${src.id}.enc`))).toBe(true); // body landed first
      expect(store.getSourceMeta(src.id)).toBeUndefined(); // meta never written
      expect(existsSync(join(dir, '.lock'))).toBe(false); // lock released on failure
      const fresh = VaultStore.open({ dir, keyFile });
      expect(fresh.listSources()).toHaveLength(0);
      for (const meta of fresh.listSources()) expect(existsSync(join(dir, 'sources', `${meta.id}.enc`))).toBe(true);
      fresh.close();
      // the retry succeeds and reuses the id
      expect(store.putSource(src).id).toBe(src.id);
      expect(store.getSourceContent(src.id)).toEqual(src.content);
      expect(readdirSync(join(dir, 'tmp'))).toEqual([]); // no staging leftovers
    });

    it('body hash mismatch → CORRUPT; missing body → CORRUPT; verify({bodies}) lists them', () => {
      const { store, dir } = v;
      const src = makeSource({ turnsText: ['original'] });
      store.putSource(src);
      const other = makeSource({ turnsText: ['tampered'] });
      const sealer = (store as unknown as { sealer: Sealer }).sealer;
      const env = sealer.seal('source-body', JSON.stringify(other.content), { gen: '', seq: 0, id: src.id, prev: '' });
      writeFileSync(join(dir, 'sources', `${src.id}.enc`), `${envelopeToLine(env)}\n`);
      const reopened = VaultStore.open({ dir, keyFile: v.keyFile }); // cold cache
      try {
        let err: unknown;
        try {
          reopened.getSource(src.id);
        } catch (e) {
          err = e;
        }
        expect(VaultError.is(err, 'CORRUPT')).toBe(true);
        expect((err as VaultError).message).toContain('does not match its record');
        expect(reopened.verify({ bodies: true })).toMatchObject({ ok: false, bodies: { checked: 1, bad: [src.id] } });
        rmSync(join(dir, 'sources', `${src.id}.enc`));
        expect(code(() => reopened.getSourceContent(src.id))).toBe('CORRUPT');
        expect(code(() => reopened.verifyQuote(src.id, 'x'))).toBe('CORRUPT'); // a missing body is damage, not "unverified"
      } finally {
        reopened.close();
      }
    });

    it('verifyQuote: NFKC, whitespace collapse, case-sensitive, turn selection, documents', () => {
      const { store } = v;
      const conv = makeSource({ turnsText: ['I always use   tabs in Go,\nfight me', 'The ﬁle is Ａ'] });
      store.putSource(conv);
      expect(store.verifyQuote(conv.id, 'always use tabs in Go, fight', 0)).toBe(true);
      expect(store.verifyQuote(conv.id, '  always   use tabs  ', 0)).toBe(true);
      expect(store.verifyQuote(conv.id, 'Always use tabs', 0)).toBe(false); // case-sensitive
      expect(store.verifyQuote(conv.id, 'the file is A', 1)).toBe(false);
      expect(store.verifyQuote(conv.id, 'The file is A', 1)).toBe(true); // NFKC: ﬁ → fi, Ａ → A
      expect(store.verifyQuote(conv.id, 'The ﬁle is Ａ', 1)).toBe(true);
      expect(store.verifyQuote(conv.id, 'tabs in Go', 1)).toBe(false); // wrong turn
      expect(store.verifyQuote(conv.id, 'tabs in Go')).toBe(true); // any turn when none given
      expect(store.verifyQuote(conv.id, 'tabs in Go', 7)).toBe(false); // missing turn
      expect(store.verifyQuote(conv.id, '   ', 0)).toBe(false);
      expect(store.verifyQuote('src_0000000000000000', 'x', 0)).toBe(false);
      const doc = makeSource({ content: { kind: 'document', mediaType: 'text/markdown', text: '# Notes\n\nShip the   vault by November.' }, origin: { importer: 'test@1', path: '', externalId: 'doc', trust: 'imported' } });
      store.putSource(doc);
      expect(store.verifyQuote(doc.id, 'Ship the vault by November')).toBe(true);
      expect(store.verifyQuote(doc.id, 'Ship the vault by November', 3)).toBe(true); // turn ignored for documents
      expect(store.verifyQuote(doc.id, 'ship the vault')).toBe(false);
    });

    it('putMemory recomputes sources[].verified; provenance survives source deletion', () => {
      const { store } = v;
      const conv = makeSource({ turnsText: ['I always use tabs in Go, fight me', 'ok'] });
      store.putSource(conv);
      const m = store.putMemory(
        makeMemory({
          sources: [
            { sourceId: conv.id, turn: 0, quote: 'tabs in Go', verified: false },
            { sourceId: conv.id, turn: 1, quote: 'tabs in Go', verified: true },
            { sourceId: conv.id, turn: 0, verified: true },
          ],
        }),
      );
      expect(m.sources.map((s) => s.verified)).toEqual([true, false, false]);
      store.deleteSources([conv.id]);
      expect(store.getMemory(m.id)?.sources).toHaveLength(3);
      const prov = store.verifyProvenance();
      expect(prov.checked).toBe(1);
      expect(prov.changed).toEqual([m.id]);
      expect(prov.orphaned).toEqual([`${m.id}:${conv.id}`, `${m.id}:${conv.id}`, `${m.id}:${conv.id}`]);
      expect(store.getMemory(m.id)?.sources[0]?.verified).toBe(true); // not written without fix
      const fixed = store.verifyProvenance({ fix: true });
      expect(fixed.changed).toEqual([m.id]);
      expect(store.getMemory(m.id)?.sources.map((s) => s.verified)).toEqual([false, false, false]);
      expect(store.verifyProvenance()).toEqual({ checked: 1, changed: [], orphaned: prov.orphaned });
    });

    it('LRU keeps at most LIMITS.bodyCache bodies in memory', () => {
      const { store } = v;
      const n = LIMITS.bodyCache + 8;
      const ids: string[] = [];
      for (let i = 0; i < n; i += 1) {
        const s = makeSource({ origin: { importer: 'test@1', path: '', externalId: `conv-${i}`, trust: 'imported' }, turnsText: [`turn ${i}`] });
        store.putSource(s);
        ids.push(s.id);
      }
      const cache = (store as unknown as { bodies: { size: number } }).bodies;
      expect(cache.size).toBeLessThanOrEqual(LIMITS.bodyCache);
      for (const id of ids) expect(store.getSource(id)?.content).toBeDefined();
      expect(cache.size).toBe(LIMITS.bodyCache);
      expect(store.listSources()).toHaveLength(n);
      expect(store.getSourceContent(ids[0] ?? '')).toEqual({ kind: 'conversation', turns: [{ i: 0, role: 'user', text: 'turn 0' }] });
      expect(cache.size).toBe(LIMITS.bodyCache);
    });
  });

  describe('grants', () => {
    it('put / list / byLabel / byTokenHash (constant-time scan) / delete + compact / EXISTS on duplicate label', () => {
      const { store, dir } = v;
      const t1 = newToken();
      const g1 = store.putGrant(grant('claude-desktop', t1));
      const g2 = store.putGrant(grant('cursor'));
      expect(store.listGrants().map((g) => g.label)).toEqual(['claude-desktop', 'cursor']);
      expect(store.getGrantByLabel('cursor')?.id).toBe(g2.id);
      expect(store.getGrantByLabel('nope')).toBeUndefined();
      expect(store.getGrantByTokenHash(hashToken(t1))?.id).toBe(g1.id);
      expect(store.getGrantByTokenHash(hashToken(newToken()))).toBeUndefined();
      expect(store.getGrantByTokenHash('short')).toBeUndefined();
      expect(code(() => store.putGrant(grant('cursor')))).toBe('EXISTS');
      // rotate = same id, new hash
      const t2 = newToken();
      store.putGrant({ ...g1, tokenHash: hashToken(t2) });
      expect(store.getGrantByTokenHash(hashToken(t1))).toBeUndefined();
      expect(store.getGrantByTokenHash(hashToken(t2))?.label).toBe('claude-desktop');
      expect(code(() => store.putGrant({ ...g1, scopes: [] }))).toBe('INVALID_ARGUMENT');
      store.deleteGrant(g2.id);
      expect(store.listGrants()).toHaveLength(1);
      expect(readFileSync(join(dir, 'grants.jsonl'), 'utf8')).not.toContain(g2.id);
      expect(code(() => store.deleteGrant(g2.id))).toBe('NOT_FOUND');
      expect(store.verify().ok).toBe(true);
    });
  });

  describe('audit', () => {
    it('append assigns id + session; read filters and keeps the newest; tail resumes by byte', () => {
      const { store, dir } = v;
      const e1 = store.appendAudit(auditEntry({ at: '2026-10-20T10:00:00.000Z', name: 'vault_search' }));
      expect(e1.id).toMatch(/^aud_[0-9a-f]{16}$/);
      expect(e1.session).toBe(store.session);
      const e2 = store.appendAudit(auditEntry({ at: '2026-10-20T11:00:00.000Z', event: 'tool', name: 'vault_remember', outcome: 'denied', error: 'DENIED', grant: { id: newId('grt'), label: 'cursor' } }));
      const e3 = store.appendAudit(auditEntry({ at: '2026-10-20T12:00:00.000Z', event: 'session_start', name: 'session', client: { name: 'test-client', version: '1.0.0' } }));
      expect(code(() => store.appendAudit(auditEntry({ outcome: 'nope' as AuditEntry['outcome'] })))).toBe('INVALID_ARGUMENT');
      expect(store.readAudit().map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
      expect(store.readAudit({ limit: 2 }).map((e) => e.id)).toEqual([e2.id, e3.id]);
      expect(store.readAudit({ since: '2026-10-20T10:30:00.000Z' }).map((e) => e.id)).toEqual([e2.id, e3.id]);
      expect(store.readAudit({ label: 'cursor' }).map((e) => e.id)).toEqual([e2.id]);
      expect(store.readAudit({ event: 'session_start' }).map((e) => e.id)).toEqual([e3.id]);
      expect(store.readAudit({ outcome: 'denied' }).map((e) => e.id)).toEqual([e2.id]);
      expect(store.readAudit({ outcome: 'ok', limit: 1 }).map((e) => e.id)).toEqual([e3.id]);
      expect(readFileSync(join(dir, 'audit.jsonl'), 'utf8')).not.toContain('vault_remember');

      const t1 = store.tailAudit(0);
      expect(t1.entries.map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
      expect(t1.byte).toBe(statSync(join(dir, 'audit.jsonl')).size);
      expect(store.tailAudit(t1.byte)).toEqual({ entries: [], byte: t1.byte });
      const e4 = store.appendAudit(auditEntry({ name: 'vault_forget' }));
      const t2 = store.tailAudit(t1.byte);
      expect(t2.entries.map((e) => e.id)).toEqual([e4.id]);
      expect(t2.byte).toBeGreaterThan(t1.byte);
      // a bogus offset restarts from the top instead of failing
      expect(store.tailAudit(t1.byte + 3).entries).toHaveLength(4);
      expect(store.tailAudit(10_000_000).entries).toHaveLength(4);
      expect(store.stats().auditEntries).toBe(4);
    });

    it('audit survives compact() (never compacted) and chains verify', () => {
      const { store, dir } = v;
      for (let i = 0; i < 5; i += 1) store.appendAudit(auditEntry({ name: `call-${i}` }));
      const gen = store.manifest.gens.audit;
      store.compact();
      expect(store.manifest.gens.audit).toBe(gen);
      expect(store.readAudit()).toHaveLength(5);
      expect(Journal.verifyChain(join(dir, 'audit.jsonl'))).toMatchObject({ ok: true, lines: 5, gen });
    });
  });

  describe('integrity', () => {
    it('manifest gens mismatch → CORRUPT on open and on refresh', () => {
      const { store, dir, keyFile } = v;
      store.putMemory(makeMemory());
      const manifestPath = join(dir, 'vault.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
      writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, gens: { ...manifest.gens, memories: 'ffffffffffffffff' } }, null, 2)}\n`);
      let err: unknown;
      try {
        VaultStore.open({ dir, keyFile });
      } catch (e) {
        err = e;
      }
      expect(VaultError.is(err, 'CORRUPT')).toBe(true);
      expect((err as VaultError).hint).toContain('verify');
      expect(code(() => store.refresh())).toBe('CORRUPT');
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      expect(store.refresh().reloaded).toBe(false);
      expect(store.verify().ok).toBe(true);
    });

    it('refresh detects a rewrite that stat() cannot see (same inode, same size, same mtime)', () => {
      const { store: a, dir, keyFile } = v;
      a.putMemory(makeMemory({ statement: 'Only record.' }));
      a.compact();
      // Pin every file to a whole-second mtime so the in-place rewrite below can restore it exactly.
      const pinned = 1_700_000_000;
      const files = ['memories.jsonl', 'sources.jsonl', 'grants.jsonl', 'vault.json'];
      for (const f of files) utimesSync(join(dir, f), pinned, pinned);
      const b = VaultStore.open({ dir, keyFile });
      try {
        expect(b.refresh().reloaded).toBe(false);
        // Produce the next generation's bytes in a copy of the vault (same key, same vaultId)…
        const copy = join(dir, '..', 'copy');
        cpSync(dir, copy, { recursive: true });
        const c = VaultStore.open({ dir: copy, keyFile });
        c.compact(); // rewrites memories, sources and grants (new gens, same sizes) and the manifest
        c.close();
        // …and write them IN PLACE over the originals, keeping inode, size and mtime identical to what `b` cached.
        for (const f of files) {
          const bytes = readFileSync(join(copy, f));
          const before = statSync(join(dir, f));
          expect(bytes.length).toBe(before.size);
          writeFileSync(join(dir, f), bytes);
          utimesSync(join(dir, f), pinned, pinned);
          const after = statSync(join(dir, f));
          expect([after.ino, after.size, after.mtimeMs]).toEqual([before.ino, before.size, pinned * 1000]);
        }
        const manifest = readFileSync(join(dir, 'vault.json'));
        const newGen = (JSON.parse(manifest.toString('utf8')) as Manifest).gens.memories;
        expect(newGen).not.toBe(b.manifest.gens.memories);
        const change = b.refresh();
        expect(change.reloaded).toBe(true);
        expect(b.manifest.gens.memories).toBe(newGen);
        expect(b.listMemories().map((m) => m.statement)).toEqual(['Only record.']);
        expect(b.verify().ok).toBe(true);
        expect(a.refresh().reloaded).toBe(true);
        expect(a.putMemory(makeMemory({ statement: 'Still writable.' })).id).toBeDefined();
        expect(b.refresh().memoriesPut.map((m) => m.statement)).toEqual(['Still writable.']);
        expect(Journal.verifyChain(join(dir, 'memories.jsonl'))).toMatchObject({ ok: true, lines: 2, gen: newGen });
      } finally {
        b.close();
      }
    });

    it('a journal swapped for an older generation is detected by verify()', () => {
      const { store, dir } = v;
      store.putMemory(makeMemory());
      const old = readFileSync(join(dir, 'memories.jsonl'));
      store.compact();
      writeFileSync(join(dir, 'memories.jsonl'), old);
      const r = store.verify();
      expect(r.ok).toBe(false);
      expect(r.journals.memories.ok).toBe(false);
      expect(r.journals.memories.reason).toMatch(/generation/);
      expect(r.journals.sources.ok).toBe(true);
    });

    it('refresh: tail-read of another instance\'s appends, gen-change reload, keyId-change key reload', () => {
      const { store, dir, keyFile } = v;
      const other = VaultStore.open({ dir, keyFile });
      try {
        expect(store.refresh()).toEqual({ memoriesPut: [], memoriesDeleted: [], sourcesPut: [], sourcesDeleted: [], grantsChanged: false, reloaded: false });
        const m = other.putMemory(makeMemory({ statement: 'From the other process.' }));
        const s = other.putSource(makeSource());
        const g = other.putGrant(grant('x'));
        const c1 = store.refresh();
        expect(c1.reloaded).toBe(false);
        expect(c1.memoriesPut.map((x) => x.id)).toEqual([m.id]);
        expect(c1.sourcesPut.map((x) => x.id)).toEqual([s.id]);
        expect(c1.grantsChanged).toBe(true);
        expect(store.getMemory(m.id)?.statement).toBe('From the other process.');
        expect(store.getGrantByLabel('x')?.id).toBe(g.id);
        expect(store.refresh().memoriesPut).toEqual([]);

        // own writes are reported too (so this process's indexes see them)
        const own = store.putMemory(makeMemory({ statement: 'Mine.' }));
        expect(store.refresh().memoriesPut.map((x) => x.id)).toEqual([own.id]);

        // deletes
        other.deleteMemories([m.id]);
        const c2 = store.refresh();
        expect(c2.reloaded).toBe(true); // deleteMemories compacts → new gen → full reload
        expect(store.getMemory(m.id)).toBeUndefined();
        expect(store.getMemory(own.id)).toBeDefined();
        other.deleteSources([s.id]);
        expect(store.refresh().reloaded).toBe(true);
        expect(store.getSourceMeta(s.id)).toBeUndefined();

        // compaction by the other process → reloaded
        other.putMemory(makeMemory({ statement: 'Before compact.' }));
        other.compact();
        const c3 = store.refresh();
        expect(c3.reloaded).toBe(true);
        expect(store.listMemories()).toHaveLength(2);
        expect(store.manifest.gens).toEqual(other.manifest.gens);

        // rekey by the other process → key reload, data intact
        const oldKeyId = store.keyId;
        other.rekey({});
        expect(other.keyId).not.toBe(oldKeyId);
        const c4 = store.refresh();
        expect(c4.reloaded).toBe(true);
        expect(store.keyId).toBe(other.keyId);
        expect(store.listMemories().map((x) => x.statement).sort()).toEqual(['Before compact.', 'Mine.']);
        // `other` never drained its ChangeSet: it holds everything it saw or wrote since open (puts it tailed, its own put)
        expect(other.refresh().memoriesPut.map((x) => x.statement).sort()).toEqual(['Before compact.', 'Mine.']);
        expect(store.putMemory(makeMemory({ statement: 'After rekey.' })).id).toBeDefined();
        expect(other.refresh().memoriesPut.map((x) => x.statement)).toEqual(['After rekey.']);
        expect(store.verify({ bodies: true }).ok).toBe(true);
      } finally {
        other.close();
      }
    });

    it('rekey: new key opens, old key is BAD_KEY, chains verify, bodies readable, passphrase mode preserved', () => {
      const { store, dir, keyFile } = v;
      const oldKey = loadKey(keyFile, store.vaultId, {});
      const src = makeSource({ turnsText: ['keep this readable'] });
      store.putSource(src);
      const m = store.putMemory(makeMemory({ sources: [{ sourceId: src.id, turn: 0, quote: 'keep this', verified: false }] }));
      store.putGrant(grant('g'));
      store.appendAudit(auditEntry());
      const gensBefore = { ...store.manifest.gens };
      const oldKeyId = store.keyId;
      store.rekey({});
      expect(store.keyId).not.toBe(oldKeyId);
      for (const name of ['memories', 'sources', 'grants', 'audit'] as const) expect(store.manifest.gens[name]).not.toBe(gensBefore[name]);
      expect(store.verify({ bodies: true })).toMatchObject({ ok: true, bodies: { checked: 1, bad: [] } });
      expect(store.getMemory(m.id)?.sources[0]?.verified).toBe(true);
      expect(store.getSourceContent(src.id)).toEqual(src.content);
      expect(store.readAudit()).toHaveLength(1);
      expect(store.listGrants()).toHaveLength(1);
      expect(existsSync(join(dir, '.lock'))).toBe(false);

      const reopened = VaultStore.open({ dir, keyFile });
      expect(reopened.keyId).toBe(store.keyId);
      expect(reopened.getSource(src.id)?.content).toEqual(src.content);
      expect(reopened.listMemories()).toHaveLength(1);
      reopened.close();

      const oldKeyFile = join(dir, '..', 'old.key');
      writeFileSync(oldKeyFile, JSON.stringify({ format: 'opencontext-vault-key', version: 1, vaultId: store.vaultId, keyId: oldKeyId, kdf: 'none', key: oldKey.toString('base64') }), { mode: 0o600 });
      expect(code(() => VaultStore.open({ dir, keyFile: oldKeyFile }))).toBe('BAD_KEY');

      // after rekey the old ciphertext is gone from every live file
      for (const f of ['memories.jsonl', 'sources.jsonl', 'grants.jsonl', 'audit.jsonl']) {
        expect(Journal.verifyChain(join(dir, f)).ok).toBe(true);
      }

      // passphrase mode: rekey needs the passphrase and keeps scrypt
      const p = tmpVault({ passphrase: 'pw' });
      try {
        p.store.putMemory(makeMemory());
        const keyIdBefore = p.store.keyId;
        expect(code(() => p.store.rekey({}))).toBe('KEY_LOCKED');
        // a refused rekey must leave the vault exactly as it was (no journal re-sealed with a key nobody holds)
        expect(p.store.keyId).toBe(keyIdBefore);
        expect(p.store.verify({ bodies: true }).ok).toBe(true);
        expect(p.store.listMemories()).toHaveLength(1);
        expect(code(() => p.store.rekey({ passphrase: 'wrong' }))).toBe('BAD_KEY');
        p.store.rekey({ passphrase: 'pw' });
        expect((JSON.parse(readFileSync(p.keyFile, 'utf8')) as { kdf: string }).kdf).toBe('scrypt');
        const s = VaultStore.open({ dir: p.dir, keyFile: p.keyFile, passphrase: { passphrase: 'pw' } });
        expect(s.listMemories()).toHaveLength(1);
        s.close();
      } finally {
        p.cleanup();
      }
    });

    it('stats counts everything', () => {
      const { store } = v;
      expect(store.stats()).toMatchObject({ memories: 0, activeMemories: 0, sources: 0, unreviewedSources: 0, sourceBytes: 0, grants: 0, auditEntries: 0 });
      const s1 = store.putSource(makeSource({ origin: { importer: 'test@1', path: '', externalId: '1', trust: 'imported' } }));
      const s2 = store.putSource(makeSource({ origin: { importer: 'test@1', path: '', externalId: '2', trust: 'imported' }, review: { status: 'reviewed' } }));
      store.putMemory(makeMemory());
      store.putMemory(makeMemory({ status: 'superseded' }));
      store.putGrant(grant('g'));
      store.appendAudit(auditEntry());
      store.appendAudit(auditEntry());
      const st = store.stats();
      expect(st).toMatchObject({ memories: 2, activeMemories: 1, sources: 2, unreviewedSources: 1, sourceBytes: s1.bytes + s2.bytes, grants: 1, auditEntries: 2 });
      expect(st.diskBytes).toBeGreaterThan(s1.bytes + s2.bytes);
    });

    it('a half-written source body (torn envelope) is CORRUPT, not a crash', () => {
      const { store, dir } = v;
      const src = makeSource();
      store.putSource(src);
      writeFileSync(join(dir, 'sources', `${src.id}.enc`), '{"v":1,"k":"source-body"');
      const fresh = VaultStore.open({ dir, keyFile: v.keyFile });
      expect(code(() => fresh.getSource(src.id))).toBe('CORRUPT');
      fresh.close();
    });
  });

  describe('two instances in one process converge', () => {
    it('interleaved put/delete/compact', () => {
      const a = v.store;
      const b = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
      try {
        const ids: string[] = [];
        for (let i = 0; i < 20; i += 1) {
          const s = i % 2 === 0 ? a : b;
          ids.push(s.putMemory(makeMemory({ statement: `Statement ${i}.` })).id);
          if (i % 5 === 4) (i % 2 === 0 ? b : a).deleteMemories([ids[i - 2] ?? '']);
          if (i % 7 === 6) (i % 2 === 0 ? a : b).compact();
        }
        a.refresh();
        b.refresh();
        expect(canonicalJson(a.listMemories({ status: 'all' }))).toBe(canonicalJson(b.listMemories({ status: 'all' })));
        expect(a.listMemories().length).toBe(16);
        expect(a.verify().ok).toBe(true);
        expect(b.verify().ok).toBe(true);
      } finally {
        b.close();
      }
    });
  });
});

describe('tmp-vault helpers', () => {
  it('makeSource is deterministic per externalId and makeMemory is valid', () => {
    const a = makeSource({ origin: { importer: 'test@1', path: '', externalId: 'same', trust: 'imported' } });
    const b = makeSource({ origin: { importer: 'test@1', path: '', externalId: 'same', trust: 'imported' }, turnsText: ['other'] });
    expect(a.id).toBe(b.id);
    expect(a.sha256).not.toBe(b.sha256);
    expect(a.id).toMatch(/^src_[0-9a-f]{16}$/);
    expect(makeMemory().id).toMatch(/^mem_[0-9a-f]{16}$/);
    const root = mkdtempSync(join(tmpdir(), 'ocv-x-'));
    rmSync(root, { recursive: true, force: true });
    expect(randomBytes(1).length).toBe(1);
  });
});
