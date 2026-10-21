import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sealer, aad, envelopeToLine, lineToEnvelope } from '../src/crypto/envelope.js';
import { SCRYPT, createKeyFile, keyIdOf, loadKey, resolvePassphrase, rewriteKeyFile } from '../src/crypto/keyfile.js';
import { hashToken, hashesEqual, looksLikeToken, newToken } from '../src/crypto/token.js';
import { VaultError } from '../src/errors.js';
import { TOKEN_HASH_DOMAIN, type Envelope, type EnvelopeKind } from '../src/types.js';
import { unb64 } from '../src/util/b64.js';
import { sha256Hex } from '../src/util/canonical-json.js';

const VAULT_ID = 'b2b0a3f1c4d5e6f7a8b9c0d1e2f3a4b5';
const POS = { gen: '0123456789abcdef', seq: 7, id: 'mem_3f9a1c77e02b4d10', prev: 'genesis' };
const FIXTURE_CMD = join(import.meta.dirname, 'fixtures', 'core', 'passphrase-cmd.mjs');

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof VaultError ? err.code : `non-vault:${String(err)}`;
  }
}

function flipByteInB64(field: string, index = 0): string {
  const bytes = unb64(field);
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  return bytes.toString('base64');
}

describe('envelope', () => {
  const key = randomBytes(32);
  const sealer = new Sealer(key, VAULT_ID);

  it('aad is exactly the documented 7-line string', () => {
    const a = aad(VAULT_ID, 'memory', 'g', 3, 'mem_x', 'p');
    expect(a.toString('utf8')).toBe(`opencontext-vault/1\n${VAULT_ID}\nmemory\ng\n3\nmem_x\np`);
  });

  it('seals and opens a round trip (string and bytes)', () => {
    const env = sealer.seal('memory', 'hello 世界', POS);
    expect(env).toMatchObject({ v: 1, k: 'memory', seq: 7, id: POS.id, prev: 'genesis' });
    expect(unb64(env.iv).length).toBe(12);
    expect(unb64(env.tag).length).toBe(16);
    expect(sealer.open(env, 'memory', POS).toString('utf8')).toBe('hello 世界');
    const bytes = randomBytes(1000);
    const env2 = sealer.seal('source-body', bytes, { gen: '', seq: 0, id: 'src_1', prev: '' });
    expect(sealer.open(env2, 'source-body', { gen: '', seq: 0, id: 'src_1', prev: '' }).equals(bytes)).toBe(true);
    const empty = sealer.seal('check', '', { gen: '', seq: 0, id: '', prev: '' });
    expect(sealer.open(empty, 'check', { gen: '', seq: 0, id: '', prev: '' }).length).toBe(0);
  });

  it('wrong key → BAD_KEY', () => {
    const env = sealer.seal('memory', 'secret', POS);
    const other = new Sealer(randomBytes(32), VAULT_ID);
    expect(code(() => other.open(env, 'memory', POS))).toBe('BAD_KEY');
  });

  it('flipped byte in ct, tag or iv → BAD_KEY', () => {
    const env = sealer.seal('memory', 'secret payload', POS);
    expect(code(() => sealer.open({ ...env, ct: flipByteInB64(env.ct, 3) }, 'memory', POS))).toBe('BAD_KEY');
    expect(code(() => sealer.open({ ...env, tag: flipByteInB64(env.tag, 15) }, 'memory', POS))).toBe('BAD_KEY');
    expect(code(() => sealer.open({ ...env, iv: flipByteInB64(env.iv, 0) }, 'memory', POS))).toBe('BAD_KEY');
    expect(sealer.open(env, 'memory', POS).toString()).toBe('secret payload');
  });

  it('AAD mismatch on each of vaultId/kind/gen/seq/id/prev → BAD_KEY', () => {
    const env = sealer.seal('memory', 'bound', POS);
    const otherVault = new Sealer(key, 'c3c0a3f1c4d5e6f7a8b9c0d1e2f3a4b5');
    expect(code(() => otherVault.open(env, 'memory', POS))).toBe('BAD_KEY');
    // the kind is bound by the AAD: relabelled and read as what it now claims to be, the tag no longer verifies…
    expect(code(() => sealer.open({ ...env, k: 'grant' }, 'grant', POS))).toBe('BAD_KEY');
    // …and a reader that expects one kind refuses an envelope of another before decrypting anything (SPEC.md B.4)
    expect(code(() => sealer.open({ ...env, k: 'grant' }, 'memory', POS))).toBe('CORRUPT');
    expect(code(() => sealer.open(env, 'grant', POS))).toBe('CORRUPT');
    expect(code(() => sealer.open(env, 'memory', { ...POS, gen: 'fedcba9876543210' }))).toBe('BAD_KEY');
    expect(code(() => sealer.open(env, 'memory', { ...POS, seq: 8 }))).toBe('BAD_KEY');
    expect(code(() => sealer.open(env, 'memory', { ...POS, id: 'mem_3f9a1c77e02b4d11' }))).toBe('BAD_KEY');
    expect(code(() => sealer.open(env, 'memory', { ...POS, prev: 'a'.repeat(64) }))).toBe('BAD_KEY');
    expect(sealer.open(env, 'memory', POS).toString()).toBe('bound');
  });

  it('malformed fields → CORRUPT', () => {
    const env = sealer.seal('memory', 'x', POS);
    expect(code(() => sealer.open({ ...env, iv: 'not base64!' }, 'memory', POS))).toBe('CORRUPT');
    expect(code(() => sealer.open({ ...env, iv: Buffer.alloc(8).toString('base64') }, 'memory', POS))).toBe('CORRUPT');
    expect(code(() => sealer.open({ ...env, tag: Buffer.alloc(8).toString('base64') }, 'memory', POS))).toBe('CORRUPT');
    expect(code(() => sealer.open({ ...env, v: 2 } as unknown as Envelope, 'memory', POS))).toBe('CORRUPT');
    expect(code(() => sealer.open({ ...env, k: 'nope' as EnvelopeKind }, 'memory', POS))).toBe('CORRUPT');
  });

  it('a check envelope presented as a wrap (and vice versa) is refused: standalone readers enforce the kind too', () => {
    const standalone = { gen: '', seq: 0, id: '', prev: '' };
    const check = sealer.seal('check', 'ok', standalone);
    const wrap = sealer.seal('wrap', randomBytes(32), standalone);
    expect(code(() => sealer.open(check, 'wrap', standalone))).toBe('CORRUPT');
    expect(code(() => sealer.open(wrap, 'check', standalone))).toBe('CORRUPT');
    // relabelling cannot help either: the AAD was computed with the original kind
    expect(code(() => sealer.open({ ...check, k: 'wrap' }, 'wrap', standalone))).toBe('BAD_KEY');
    expect(sealer.open(check, 'check', standalone).toString()).toBe('ok');
  });

  it('distinct IVs across 10k seals', () => {
    const ivs = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) ivs.add(sealer.seal('audit', 'x', POS).iv);
    expect(ivs.size).toBe(10_000);
  });

  it('keyId is the first 16 hex of sha256(key); destroy() disables the sealer', () => {
    const k = randomBytes(32);
    const s = new Sealer(k, VAULT_ID);
    expect(s.keyId).toBe(createHash('sha256').update(k).digest('hex').slice(0, 16));
    expect(s.keyId).toBe(keyIdOf(k));
    s.destroy();
    expect(() => s.seal('check', 'ok', { gen: '', seq: 0, id: '', prev: '' })).toThrow(VaultError);
    expect(code(() => new Sealer(randomBytes(16), VAULT_ID))).toBe('BAD_KEY');
  });

  it('the Sealer copies the key, so zeroing the caller buffer does not break it', () => {
    const k = randomBytes(32);
    const s = new Sealer(k, VAULT_ID);
    const env = s.seal('check', 'ok', { gen: '', seq: 0, id: '', prev: '' });
    k.fill(0);
    expect(s.open(env, 'check', { gen: '', seq: 0, id: '', prev: '' }).toString()).toBe('ok');
  });

  it('envelopeToLine has a stable key order and lineToEnvelope validates', () => {
    const env = sealer.seal('grant', 'g', POS);
    const shuffled: Envelope = { tag: env.tag, ct: env.ct, iv: env.iv, prev: env.prev, id: env.id, seq: env.seq, k: env.k, v: env.v };
    const line = envelopeToLine(shuffled);
    expect(Object.keys(JSON.parse(line) as object)).toEqual(['v', 'k', 'seq', 'id', 'prev', 'iv', 'ct', 'tag']);
    expect(line).toBe(envelopeToLine(env));
    expect(line.includes('\n')).toBe(false);
    expect(lineToEnvelope(line)).toEqual(env);
    expect(code(() => lineToEnvelope('{not json'))).toBe('CORRUPT');
    expect(code(() => lineToEnvelope('{"v":1}'))).toBe('CORRUPT');
    expect(code(() => lineToEnvelope(`${line.slice(0, -1)},"extra":1}`))).toBe('CORRUPT');
  });
});

describe('envelope test vectors (test/vectors/envelope-vectors.json)', () => {
  interface Vector {
    name: string;
    vaultId: string;
    k: EnvelopeKind;
    gen: string;
    seq: number;
    id: string;
    prev: string;
    aad: string;
    aadHex: string;
    ivHex: string;
    plaintext?: string;
    plaintextHex?: string;
    ctBase64: string;
    tagBase64: string;
    envelope: Envelope;
    line: string;
    lineSha256: string;
  }
  const doc = JSON.parse(readFileSync(join(import.meta.dirname, 'vectors', 'envelope-vectors.json'), 'utf8')) as {
    keyHex: string;
    keyId: string;
    vaultId: string;
    vectors: Vector[];
  };
  const key = Buffer.from(doc.keyHex, 'hex');
  const sealer = new Sealer(key, doc.vaultId);

  it('has at least five vectors covering every envelope kind the vault writes', () => {
    expect(doc.vectors.length).toBeGreaterThanOrEqual(5);
    expect(new Set(doc.vectors.map((v) => v.k))).toEqual(new Set(['check', 'memory', 'source-body', 'wrap']));
    expect(keyIdOf(key)).toBe(doc.keyId);
  });

  for (const v of doc.vectors) {
    it(`re-derives "${v.name}" from the raw primitive and opens it with the Sealer`, () => {
      const a = aad(v.vaultId, v.k, v.gen, v.seq, v.id, v.prev);
      expect(a.toString('utf8')).toBe(v.aad);
      expect(a.toString('hex')).toBe(v.aadHex);
      const plaintext = v.plaintextHex !== undefined ? Buffer.from(v.plaintextHex, 'hex') : Buffer.from(v.plaintext ?? '', 'utf8');
      const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(v.ivHex, 'hex'), { authTagLength: 16 });
      cipher.setAAD(a);
      const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      expect(ct.toString('base64')).toBe(v.ctBase64);
      expect(cipher.getAuthTag().toString('base64')).toBe(v.tagBase64);
      expect(v.envelope).toEqual({ v: 1, k: v.k, seq: v.seq, id: v.id, prev: v.prev, iv: Buffer.from(v.ivHex, 'hex').toString('base64'), ct: v.ctBase64, tag: v.tagBase64 });
      expect(envelopeToLine(v.envelope)).toBe(v.line);
      expect(sha256Hex(v.line)).toBe(v.lineSha256);
      expect(sealer.open(lineToEnvelope(v.line), v.k, { gen: v.gen, seq: v.seq, id: v.id, prev: v.prev }).equals(plaintext)).toBe(true);
    });
  }

  it('chains: the seq-2 vector cites the sha256 of the seq-1 line', () => {
    const first = doc.vectors.find((v) => v.k === 'memory' && v.seq === 1);
    const second = doc.vectors.find((v) => v.k === 'memory' && v.seq === 2);
    expect(first && second).toBeTruthy();
    expect(second?.prev).toBe(first?.lineSha256);
    expect(first?.prev).toBe('genesis');
  });
});

describe('key file', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ocv-key-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('kdf none: create + load, mode 0600 inside a 0700 parent, refuses overwrite', () => {
    const path = join(root, 'nested', 'vault.key');
    const key = createKeyFile(path, VAULT_ID);
    expect(key.length).toBe(32);
    const file = JSON.parse(readFileSync(path, 'utf8')) as { kdf: string; keyId: string; vaultId: string; format: string };
    expect(file).toMatchObject({ format: 'opencontext-vault-key', kdf: 'none', vaultId: VAULT_ID, keyId: keyIdOf(key) });
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, 'nested')).mode & 0o777).toBe(0o700);
    }
    const warnings: string[] = [];
    expect(loadKey(path, VAULT_ID, {}, (m) => warnings.push(m)).equals(key)).toBe(true);
    expect(warnings).toEqual([]);
    expect(code(() => createKeyFile(path, VAULT_ID))).toBe('EXISTS');
    expect(loadKey(path, VAULT_ID, {}).equals(key)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('kdf scrypt: create + load with the passphrase; wrong passphrase → BAD_KEY; missing → KEY_LOCKED', () => {
    const path = join(root, 'vault.key');
    const t0 = performance.now();
    const key = createKeyFile(path, VAULT_ID, 'correct horse battery staple');
    const ms = Math.round(performance.now() - t0);
    process.stderr.write(`scrypt N=${SCRYPT.N} r=${SCRYPT.r} p=${SCRYPT.p} maxmem=${SCRYPT.maxmem / 1024 / 1024}MiB: ${ms} ms on ${process.platform}/${process.arch}\n`);
    const file = JSON.parse(readFileSync(path, 'utf8')) as { kdf: string; N: number; r: number; p: number; wrapped: { k: string } };
    expect(file).toMatchObject({ kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    expect(file.wrapped.k).toBe('wrap');
    expect(readFileSync(path, 'utf8').includes(key.toString('base64'))).toBe(false);
    expect(loadKey(path, VAULT_ID, { passphrase: 'correct horse battery staple' }).equals(key)).toBe(true);
    expect(code(() => loadKey(path, VAULT_ID, { passphrase: 'wrong' }))).toBe('BAD_KEY');
    expect(code(() => loadKey(path, VAULT_ID, {}))).toBe('KEY_LOCKED');
    try {
      loadKey(path, VAULT_ID, {});
    } catch (err) {
      expect((err as VaultError).hint).toMatch(/OPENCONTEXT_VAULT_PASSPHRASE/);
      expect((err as VaultError).hint).toMatch(/OPENCONTEXT_VAULT_PASSPHRASE_CMD/);
      expect((err as VaultError).hint).toMatch(/--passphrase-file/);
    }
    // the prompt is the last resort
    expect(loadKey(path, VAULT_ID, { prompt: () => 'correct horse battery staple' }).equals(key)).toBe(true);
  });

  it('PASSPHRASE_CMD runs a fixture via execFile; "; echo pwned" does not reach a shell', () => {
    const path = join(root, 'vault.key');
    const key = createKeyFile(path, VAULT_ID, 'fixture-pass-phrase');
    const cmd = `${process.execPath} ${FIXTURE_CMD}`;
    expect(resolvePassphrase({ passphraseCmd: cmd })).toBe('fixture-pass-phrase');
    expect(loadKey(path, VAULT_ID, { passphraseCmd: cmd }).equals(key)).toBe(true);
    const injected = `${process.execPath} ${FIXTURE_CMD} ; echo pwned`;
    const out = resolvePassphrase({ passphraseCmd: injected });
    expect(out).toBe('fixture-pass-phrase');
    expect(out?.includes('pwned')).toBe(false);
    expect(loadKey(path, VAULT_ID, { passphraseCmd: injected }).equals(key)).toBe(true);
    // a failing command is reported as KEY_LOCKED with the env hint, never as a crash
    expect(code(() => resolvePassphrase({ passphraseCmd: '/nonexistent/passphrase-helper' }))).toBe('KEY_LOCKED');
    // a failing command reports the program and its exit status, never its arguments (they may carry a session token)
    const failing = `${process.execPath} -e process.exit(3) -- --session SUPER-SECRET-SESSION`;
    let failure: unknown;
    try {
      resolvePassphrase({ passphraseCmd: failing });
    } catch (err) {
      failure = err;
    }
    expect(VaultError.is(failure, 'KEY_LOCKED')).toBe(true);
    expect((failure as VaultError).message).not.toContain('SUPER-SECRET');
    expect((failure as VaultError).message).toContain('exited with status 3');
    expect((failure as VaultError).message).toContain(process.execPath);
    // precedence: explicit passphrase wins over the command, which wins over the prompt
    expect(resolvePassphrase({ passphrase: 'p', passphraseCmd: cmd, prompt: () => 'q' })).toBe('p');
    expect(resolvePassphrase({ passphraseCmd: cmd, prompt: () => 'q' })).toBe('fixture-pass-phrase');
    expect(resolvePassphrase({ prompt: () => 'q' })).toBe('q');
    expect(resolvePassphrase({})).toBeUndefined();
  });

  it('warns when the key file mode is more open than 0600', () => {
    if (process.platform === 'win32') return;
    const path = join(root, 'vault.key');
    createKeyFile(path, VAULT_ID);
    chmodSync(path, 0o644);
    const warnings: string[] = [];
    loadKey(path, VAULT_ID, {}, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/0644/);
    expect(warnings[0]).toMatch(/chmod 600/);
  });

  it('errors: KEY_NOT_FOUND with hint, BAD_KEY on vault mismatch, CORRUPT on garbage', () => {
    const missing = join(root, 'nope.key');
    expect(code(() => loadKey(missing, VAULT_ID, {}))).toBe('KEY_NOT_FOUND');
    try {
      loadKey(missing, VAULT_ID, {});
    } catch (err) {
      expect((err as VaultError).hint).toMatch(/init/);
      expect((err as VaultError).hint).toMatch(/--key-file/);
    }
    const path = join(root, 'vault.key');
    createKeyFile(path, VAULT_ID);
    expect(code(() => loadKey(path, 'd4d0a3f1c4d5e6f7a8b9c0d1e2f3a4b5', {}))).toBe('BAD_KEY');
    const garbage = join(root, 'garbage.key');
    writeFileSync(garbage, 'not json');
    expect(code(() => loadKey(garbage, VAULT_ID, {}))).toBe('CORRUPT');
    writeFileSync(garbage, JSON.stringify({ format: 'opencontext-vault-key', version: 1, vaultId: VAULT_ID, keyId: 'x', kdf: 'none', key: 'AAAA' }));
    expect(code(() => loadKey(garbage, VAULT_ID, {}))).toBe('CORRUPT');
  });

  it('rewriteKeyFile keeps the kdf mode and is atomic', () => {
    const plain = join(root, 'plain.key');
    const k1 = createKeyFile(plain, VAULT_ID);
    const k2 = randomBytes(32);
    rewriteKeyFile(plain, VAULT_ID, k2, {});
    expect(loadKey(plain, VAULT_ID, {}).equals(k2)).toBe(true);
    expect(loadKey(plain, VAULT_ID, {}).equals(k1)).toBe(false);
    expect((JSON.parse(readFileSync(plain, 'utf8')) as { kdf: string }).kdf).toBe('none');

    const locked = join(root, 'locked.key');
    createKeyFile(locked, VAULT_ID, 'pw');
    const k3 = randomBytes(32);
    expect(code(() => rewriteKeyFile(locked, VAULT_ID, k3, {}))).toBe('KEY_LOCKED');
    rewriteKeyFile(locked, VAULT_ID, k3, { passphrase: 'pw' });
    expect((JSON.parse(readFileSync(locked, 'utf8')) as { kdf: string }).kdf).toBe('scrypt');
    expect(loadKey(locked, VAULT_ID, { passphrase: 'pw' }).equals(k3)).toBe(true);
    expect(code(() => rewriteKeyFile(join(root, 'absent.key'), VAULT_ID, k3, {}))).toBe('KEY_NOT_FOUND');
    if (process.platform !== 'win32') expect(statSync(locked).mode & 0o777).toBe(0o600);
  });
});

describe('token', () => {
  it('newToken format: ocv_ + 32 base64url chars, unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const t = newToken();
      expect(t).toMatch(/^ocv_[A-Za-z0-9_-]{32}$/);
      expect(t.length).toBe(36);
      expect(looksLikeToken(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(1000);
  });

  it('hashToken is stable, domain-separated and 64 hex', () => {
    const t = 'ocv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(createHash('sha256').update(`${TOKEN_HASH_DOMAIN}${t}`).digest('hex'));
    expect(hashToken(t)).not.toBe(sha256Hex(t));
    expect(hashToken(t)).not.toBe(hashToken(`${t.slice(0, -1)}B`));
  });

  it('hashesEqual compares constant-time and tolerates length mismatch', () => {
    const a = hashToken('ocv_x');
    expect(hashesEqual(a, a)).toBe(true);
    expect(hashesEqual(a, hashToken('ocv_y'))).toBe(false);
    expect(hashesEqual(a, a.slice(1))).toBe(false);
    expect(hashesEqual('', '')).toBe(true);
  });

  it('looksLikeToken rejects near misses', () => {
    expect(looksLikeToken('ocv_short')).toBe(false);
    expect(looksLikeToken('ocv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toBe(false);
    expect(looksLikeToken('xcv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
    expect(looksLikeToken(' ocv_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
  });
});
