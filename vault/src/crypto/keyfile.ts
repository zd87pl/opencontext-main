import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { VaultError } from '../errors.js';
import { KEY_FORMAT, KeyFile } from '../types.js';
import { b64, unb64 } from '../util/b64.js';
import { fileSize, writeFully } from '../util/fs.js';
import { sha256Hex } from '../util/canonical-json.js';
import { Sealer } from './envelope.js';

/** scrypt parameters for passphrase mode. N=2^17 needs maxmem ≥ 128 MiB or Node throws; 256 MiB leaves headroom. */
export const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024, saltBytes: 16 } as const;

const KEY_BYTES = 32;
const WRAP_POS = { gen: '', seq: 0, id: '', prev: '' } as const;
const PASSPHRASE_HINT =
  'set OPENCONTEXT_VAULT_PASSPHRASE, OPENCONTEXT_VAULT_PASSPHRASE_CMD, or pass --passphrase-file <path>';

/** Where a passphrase may come from, in precedence order; kept as data so `serve` can omit the prompt and the CLI can add it. */
export interface PassphraseSource {
  passphrase?: string; // from OPENCONTEXT_VAULT_PASSPHRASE or --passphrase-file contents
  /** OPENCONTEXT_VAULT_PASSPHRASE_CMD: split on runs of whitespace (no quoting), run with execFileSync (no shell), 5 s timeout, stdout trimmed of one trailing newline. */
  passphraseCmd?: string;
  /** CLI only: masked TTY prompt. Never provided by `serve`. */
  prompt?: (question: string) => string;
}

/** First 16 hex of sha256(key): the public identifier of a data key, safe to store in the plaintext manifest. */
export function keyIdOf(key: Buffer): string {
  return sha256Hex(key).slice(0, 16);
}

/** Resolve the passphrase from src in order: passphrase → passphraseCmd → prompt; undefined if none. The command runs without a shell so a config value can never become a shell injection. */
export function resolvePassphrase(src: PassphraseSource): string | undefined {
  if (src.passphrase !== undefined) return src.passphrase;
  if (src.passphraseCmd !== undefined && src.passphraseCmd.trim() !== '') {
    const argv = src.passphraseCmd.trim().split(/\s+/);
    const [cmd, ...args] = argv;
    if (cmd === undefined) return undefined;
    let out: string;
    try {
      out = execFileSync(cmd, args, {
        encoding: 'utf8',
        timeout: 5_000,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 1024 * 1024,
      });
    } catch (err) {
      // Never echo the command's arguments: a keychain session token or a lazy `echo <passphrase>` on the argv would
      // otherwise land in terminal scrollback and in the MCP host's log of our stderr.
      throw new VaultError('KEY_LOCKED', `passphrase command failed: ${describeSpawnFailure(cmd, err)}`, PASSPHRASE_HINT);
    }
    return out.replace(/\r?\n$/, '');
  }
  if (src.prompt) return src.prompt('Passphrase: ');
  return undefined;
}

/** "<program> exited with status 3" / "was killed by SIGKILL" / "timed out after 5 s" / "ENOENT": the program path and the outcome, never the argv. */
function describeSpawnFailure(cmd: string, err: unknown): string {
  const e = err as NodeJS.ErrnoException & { status?: number | null; signal?: NodeJS.Signals | null };
  if (e.code === 'ETIMEDOUT') return `${cmd} timed out after 5 s`;
  if (typeof e.code === 'string' && e.code !== '') return `${cmd}: ${e.code}`;
  if (typeof e.status === 'number') return `${cmd} exited with status ${e.status}`;
  if (typeof e.signal === 'string') return `${cmd} was killed by ${e.signal}`;
  return `${cmd} failed`;
}

function deriveKek(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  try {
    return scryptSync(passphrase, salt, KEY_BYTES, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem });
  } catch {
    throw new VaultError('CORRUPT', 'key file has unsupported scrypt parameters');
  }
}

/** Temp + rename in the key file's own directory (same filesystem → atomic); mode 0o600 from the first byte. Every failure is VaultError('IO'): a short write must never rename a truncated key file over the only copy of the data key. */
function writeKeyFileAtomic(path: string, keyFile: KeyFile): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let fd: number;
  try {
    fd = openSync(tmp, 'w', 0o600);
  } catch (err) {
    throw new VaultError('IO', `cannot write key file ${tmp}: ${(err as Error).message}`);
  }
  const bytes = Buffer.from(`${JSON.stringify(keyFile)}\n`, 'utf8');
  try {
    writeFully(fd, bytes);
    fsyncSync(fd);
    if (fileSize(fd) !== bytes.length) throw new Error('size on disk differs from what was written');
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw new VaultError('IO', `cannot write key file ${tmp}: ${(err as Error).message}`);
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw new VaultError('IO', `cannot replace key file ${path}: ${(err as Error).message}`);
  }
  fsyncDirOf(path);
}

function fsyncDirOf(path: string): void {
  try {
    const fd = openSync(dirname(path), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* not supported everywhere; the rename itself is still atomic */
  }
}

function buildKeyFile(vaultId: string, key: Buffer, passphrase: string | undefined, params?: { N: number; r: number; p: number }): KeyFile {
  const keyId = keyIdOf(key);
  if (passphrase === undefined) {
    return { format: KEY_FORMAT, version: 1, vaultId, keyId, kdf: 'none', key: b64(key) };
  }
  const p = params ?? { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
  const salt = randomBytes(SCRYPT.saltBytes);
  const kek = deriveKek(passphrase, salt, p);
  const sealer = new Sealer(kek, vaultId);
  kek.fill(0);
  const wrapped = sealer.seal('wrap', key, WRAP_POS);
  sealer.destroy();
  return { format: KEY_FORMAT, version: 1, vaultId, keyId, kdf: 'scrypt', salt: b64(salt), N: p.N, r: p.r, p: p.p, wrapped };
}

/** Create a new random data key and write the key file atomically (temp + rename) with mode 0o600 inside a 0o700 parent; refuses to overwrite (EXISTS). Returns the key. */
export function createKeyFile(path: string, vaultId: string, passphrase?: string): Buffer {
  if (existsSync(path)) {
    throw new VaultError('EXISTS', `key file already exists: ${path}`, 'pass --key-file <path> to use a different key file');
  }
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  writeKeyFileAtomic(path, buildKeyFile(vaultId, key, passphrase));
  return key;
}

function readKeyFile(path: string): KeyFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new VaultError('KEY_NOT_FOUND', `key file not found: ${path}`, 'run: opencontext-vault init, or pass --key-file <path>');
    }
    throw new VaultError('IO', `cannot read key file: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new VaultError('CORRUPT', `key file is not valid JSON: ${path}`);
  }
  const parsed = KeyFile.safeParse(raw);
  if (!parsed.success) throw new VaultError('CORRUPT', `key file has an invalid shape: ${path}`);
  return parsed.data;
}

/** Load and (if scrypt) unwrap. Errors: KEY_NOT_FOUND (hint: init or --key-file), KEY_LOCKED (scrypt file and no passphrase available; hint names OPENCONTEXT_VAULT_PASSPHRASE / _CMD / --passphrase-file), BAD_KEY (wrong passphrase or vaultId mismatch). Warns to stderr (via onWarn) when the mode is more open than 0600 on POSIX. */
export function loadKey(path: string, vaultId: string, src: PassphraseSource, onWarn?: (msg: string) => void): Buffer {
  const file = readKeyFile(path);
  if (process.platform !== 'win32' && onWarn) {
    try {
      const mode = statSync(path).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        onWarn(`key file ${path} has mode ${mode.toString(8).padStart(4, '0')}; expected 0600 (run: chmod 600 ${path})`);
      }
    } catch {
      /* stat failure is reported by the read above */
    }
  }
  if (file.vaultId !== vaultId) {
    throw new VaultError('BAD_KEY', 'key file belongs to a different vault', 'pass the matching --key-file <path>');
  }
  let key: Buffer;
  if (file.kdf === 'none') {
    key = unb64(file.key);
  } else {
    const passphrase = resolvePassphrase(src);
    if (passphrase === undefined) {
      throw new VaultError('KEY_LOCKED', 'key file is passphrase-protected and no passphrase was provided', PASSPHRASE_HINT);
    }
    const salt = unb64(file.salt);
    const kek = deriveKek(passphrase, salt, file);
    const sealer = new Sealer(kek, vaultId);
    kek.fill(0);
    try {
      key = sealer.open(file.wrapped, 'wrap', WRAP_POS);
    } catch (err) {
      if (VaultError.is(err, 'BAD_KEY')) throw new VaultError('BAD_KEY', 'wrong passphrase', PASSPHRASE_HINT);
      throw err;
    } finally {
      sealer.destroy();
    }
  }
  if (key.length !== KEY_BYTES) throw new VaultError('CORRUPT', 'key file holds a key of the wrong length');
  if (keyIdOf(key) !== file.keyId) throw new VaultError('CORRUPT', 'key file keyId does not match its key');
  return key;
}

/**
 * Rewrite the key file at `path` with a new data key, preserving the kdf mode and parameters of the file at `o.from`
 * (default: `path` itself; `rekey` stages its next key into a sibling file this way). In scrypt mode the passphrase
 * comes through `src`, or `o.newPassphrase` wraps the key under a different one (the documented passphrase change);
 * `o.newPassphrase` on a plain key file switches it to scrypt. Atomic, so a crash leaves either the old or the new file.
 */
export function rewriteKeyFile(path: string, vaultId: string, newKey: Buffer, src: PassphraseSource, o?: { from?: string; newPassphrase?: string }): void {
  const file = readKeyFile(o?.from ?? path);
  if (file.vaultId !== vaultId) {
    throw new VaultError('BAD_KEY', 'key file belongs to a different vault', 'pass the matching --key-file <path>');
  }
  if (newKey.length !== KEY_BYTES) throw new VaultError('BAD_KEY', `data key must be ${KEY_BYTES} bytes`);
  if (o?.newPassphrase !== undefined) {
    const params = file.kdf === 'scrypt' ? { N: file.N, r: file.r, p: file.p } : undefined;
    writeKeyFileAtomic(path, buildKeyFile(vaultId, newKey, o.newPassphrase, params));
    return;
  }
  if (file.kdf === 'none') {
    writeKeyFileAtomic(path, buildKeyFile(vaultId, newKey, undefined));
    return;
  }
  const passphrase = resolvePassphrase(src);
  if (passphrase === undefined) {
    throw new VaultError('KEY_LOCKED', 'key file is passphrase-protected and no passphrase was provided', PASSPHRASE_HINT);
  }
  writeKeyFileAtomic(path, buildKeyFile(vaultId, newKey, passphrase, { N: file.N, r: file.r, p: file.p }));
}

/** The plaintext header of a key file (kdf and keyId) without unwrapping anything; CORRUPT when the file is not a key file. */
export function peekKeyFile(path: string): { kdf: 'none' | 'scrypt'; keyId: string; vaultId: string } {
  const file = readKeyFile(path);
  return { kdf: file.kdf, keyId: file.keyId, vaultId: file.vaultId };
}

/**
 * Resolve the passphrase exactly once (when the key file at `path` needs one) and pin it, so that one value is proven
 * against the current key file before it wraps anything else. A later lookup or prompt can then never differ from the
 * one that was checked: this is what stops a typo at a second prompt from re-wrapping the key under an unknown value.
 */
export function pinPassphrase(path: string, src: PassphraseSource): PassphraseSource {
  if (peekKeyFile(path).kdf !== 'scrypt') return {};
  const passphrase = resolvePassphrase(src);
  if (passphrase === undefined) {
    throw new VaultError('KEY_LOCKED', 'key file is passphrase-protected and no passphrase was provided', PASSPHRASE_HINT);
  }
  return { passphrase };
}
