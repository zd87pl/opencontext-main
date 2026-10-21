import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, readSync, renameSync, statSync, truncateSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { envelopeToLine, lineToEnvelope, type Sealer } from '../crypto/envelope.js';
import { VaultError } from '../errors.js';
import { JournalHeader, JournalOp, type Envelope, type EnvelopeKind, type JournalName } from '../types.js';
import { sha256Hex } from '../util/canonical-json.js';
import { fileSize, writeFully } from '../util/fs.js';

/** One decoded journal line; lineHash is what the next line's `prev` must equal. */
export interface JournalLine {
  seq: number;
  id: string;
  op: JournalOp;
  lineHash: string;
}
/** What a read produced; `reloaded` tells the store to rebuild its view instead of applying `lines` incrementally. */
export interface TailResult {
  lines: JournalLine[];
  reloaded: boolean;
  gen: string;
}

/** Which envelope kind each journal carries; the AAD binds it so a line can never be moved between journals. */
export const JOURNAL_KINDS: Readonly<Record<JournalName, EnvelopeKind>> = {
  memories: 'memory',
  sources: 'source-meta',
  grants: 'grant',
  audit: 'audit',
};

const VERIFY_HINT = 'run: opencontext-vault verify';
const NL = 0x0a;

function corrupt(name: JournalName, line: number, reason: string): VaultError {
  return new VaultError('CORRUPT', `journal ${name}: line ${line}: ${reason}`, VERIFY_HINT);
}

/** fsync the directory so a rename is durable; ignored where the platform does not support it (Windows). */
function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* not supported on every platform; the rename itself is still atomic */
  }
}

function parseHeader(buf: Buffer, name: JournalName): { header: JournalHeader; end: number } {
  const nl = buf.indexOf(NL);
  if (buf.length === 0) throw new VaultError('CORRUPT', `journal ${name}: file is empty`, VERIFY_HINT);
  if (nl < 0) throw corrupt(name, 1, 'header line is not terminated');
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8', 0, nl));
  } catch {
    throw corrupt(name, 1, 'header is not valid JSON');
  }
  const parsed = JournalHeader.safeParse(raw);
  if (!parsed.success) throw corrupt(name, 1, 'header has an invalid shape');
  if (parsed.data.journal !== name) throw corrupt(name, 1, `header names journal "${parsed.data.journal}"`);
  return { header: parsed.data, end: nl + 1 };
}

/**
 * One append-only encrypted JSONL file. Line 1 is the plaintext JournalHeader; every later line is an Envelope whose
 * AAD binds (vaultId, kind, gen, seq, id, prev). Readers verify seq is contiguous from 1 and that prev equals the
 * sha256 of the previous line; a break anywhere but a torn LAST line is VaultError('CORRUPT', …, 'run: opencontext-vault verify').
 * A torn last line (no trailing \n or undecodable) is ignored and reported once via onWarn; the next append overwrites it
 * (the writer truncates the file to the last complete line under the lock before appending).
 * Files are opened per operation (never held open) so another process can rename a compacted file over this one.
 * `lazy` (the audit journal): loadAll/tail verify the chain of every line (header, seq, prev, k, envelope shape) but
 * GCM-open only the last complete line of each scan and return no decoded lines — the store never replays audit
 * entries into memory, and decrypting a 100k-entry log on every open cost seconds and hundreds of MB. Readers that
 * need the entries (readAudit, rekey) construct a non-lazy Journal.
 */
export class Journal {
  private genValue = '';
  private seq = 0;
  private hash = 'genesis';
  /** Bytes covered by the header plus every complete, verified line. */
  private offset = 0;
  /** File size at the last scan, including any torn remainder beyond `offset`. */
  private scanned = 0;
  private ino = -1;
  private mtime = -1;
  private loaded = false;
  private tornWarnedAt = -1;

  constructor(
    public readonly path: string,
    public readonly name: JournalName,
    public readonly kind: EnvelopeKind,
    private readonly sealer: Sealer,
    private readonly onWarn?: (m: string) => void,
    private readonly lazy = false,
  ) {}

  /** Create with a fresh header. EXISTS if present. The header is plaintext so `verify` can run without the key. */
  static create(path: string, name: JournalName, vaultId: string, gen: string): void {
    const header: JournalHeader = { journal: name, v: 1, vaultId, gen };
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new VaultError('EXISTS', `journal already exists: ${path}`);
      }
      throw new VaultError('IO', `cannot create journal ${path}: ${(err as Error).message}`);
    }
    try {
      writeFully(fd, Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'));
      fsyncSync(fd);
    } catch (err) {
      throw new VaultError('IO', `cannot create journal ${path}: ${(err as Error).message}`);
    } finally {
      closeSync(fd);
    }
  }

  private stat(): { ino: number; size: number; mtime: number } {
    try {
      const st = statSync(this.path);
      return { ino: Number(st.ino), size: st.size, mtime: st.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VaultError('CORRUPT', `journal ${this.name}: file is missing`, VERIFY_HINT);
      }
      throw new VaultError('IO', `cannot stat journal ${this.path}: ${(err as Error).message}`);
    }
  }

  private readAll(): Buffer {
    try {
      return readFileSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VaultError('CORRUPT', `journal ${this.name}: file is missing`, VERIFY_HINT);
      }
      throw new VaultError('IO', `cannot read journal ${this.path}: ${(err as Error).message}`);
    }
  }

  private readFrom(start: number, size: number): Buffer {
    const buf = Buffer.alloc(Math.max(0, size - start));
    if (buf.length === 0) return buf;
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch (err) {
      throw new VaultError('IO', `cannot read journal ${this.path}: ${(err as Error).message}`);
    }
    try {
      let done = 0;
      while (done < buf.length) {
        const n = readSync(fd, buf, done, buf.length - done, start + done);
        if (n === 0) break;
        done += n;
      }
      return done === buf.length ? buf : buf.subarray(0, done);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Decode complete lines in `buf` (which starts at file byte `base`), continuing the chain from the current cursor.
   * Advances the cursor past every verified line; stops at a torn tail. `fileSize` is what the scan covered.
   */
  private decode(buf: Buffer, base: number, fileSize: number): JournalLine[] {
    const lines: JournalLine[] = [];
    let pos = 0;
    for (;;) {
      const nl = buf.indexOf(NL, pos);
      if (nl < 0) break;
      const text = buf.toString('utf8', pos, nl);
      const isLast = buf.indexOf(NL, nl + 1) < 0;
      const lineNo = this.seq + 2; // header is line 1; seq n sits on line n + 1
      let env: Envelope;
      try {
        env = lineToEnvelope(text);
      } catch (err) {
        if (isLast && VaultError.is(err, 'CORRUPT')) break; // torn tail: undecodable JSON on the final line
        throw corrupt(this.name, lineNo, 'line is not a valid envelope');
      }
      if (env.seq !== this.seq + 1) throw corrupt(this.name, lineNo, `expected seq ${this.seq + 1}, found ${env.seq}`);
      if (env.prev !== this.hash) throw corrupt(this.name, lineNo, 'prev hash does not match the previous line');
      if (env.k !== this.kind) throw corrupt(this.name, lineNo, `expected kind "${this.kind}", found "${env.k}"`);
      if (!this.lazy || isLast) {
        let plaintext: Buffer;
        try {
          plaintext = this.sealer.open(env, this.kind, { gen: this.genValue, seq: env.seq, id: env.id, prev: env.prev });
        } catch (err) {
          if (VaultError.is(err, 'BAD_KEY')) throw corrupt(this.name, lineNo, 'line failed authentication');
          throw corrupt(this.name, lineNo, 'line is not a valid envelope');
        }
        let op: JournalOp;
        try {
          const parsed = JournalOp.safeParse(JSON.parse(plaintext.toString('utf8')));
          if (!parsed.success) throw new Error('shape');
          op = parsed.data;
        } catch {
          throw corrupt(this.name, lineNo, 'line payload is not a journal op');
        }
        if (op.op === 'del' && op.id !== env.id) throw corrupt(this.name, lineNo, 'del id does not match the envelope id');
        if (!this.lazy) lines.push({ seq: env.seq, id: env.id, op, lineHash: sha256Hex(text) });
      }
      this.seq = env.seq;
      this.hash = sha256Hex(text);
      pos = nl + 1;
      this.offset = base + pos;
    }
    this.scanned = fileSize;
    if (this.scanned > this.offset && this.tornWarnedAt !== this.offset) {
      this.tornWarnedAt = this.offset;
      this.onWarn?.(`journal ${this.name}: ignoring a torn last line (the next write will truncate it)`);
    }
    return lines;
  }

  /** Read header + all lines, validate chain. Sets internal cursor (byte offset, lastSeq, lastHash, gen). Always `reloaded: true` because the caller's view must be rebuilt from scratch. */
  loadAll(): TailResult {
    const st = this.stat();
    const buf = this.readAll();
    const { header, end } = parseHeader(buf, this.name);
    if (header.vaultId !== this.sealer.vaultId) throw corrupt(this.name, 1, 'header belongs to a different vault');
    this.genValue = header.gen;
    this.seq = 0;
    this.hash = 'genesis';
    this.offset = end;
    this.scanned = end;
    this.ino = st.ino;
    this.mtime = st.mtime;
    this.loaded = true;
    this.tornWarnedAt = -1;
    const lines = this.decode(buf.subarray(end), end, buf.length);
    return { lines, reloaded: true, gen: this.genValue };
  }

  private headerGen(): string {
    const head = this.readFrom(0, 4096);
    const nl = head.indexOf(NL);
    if (nl < 0) return '';
    try {
      const parsed = JournalHeader.safeParse(JSON.parse(head.toString('utf8', 0, nl)));
      return parsed.success ? parsed.data.gen : '';
    } catch {
      return '';
    }
  }

  /** stat(); if the file was replaced (inode or header gen changed) or size < cursor → loadAll() with reloaded:true; if size grew → decode only new bytes. Cheap when unchanged (one stat). Any stat difference at all re-reads the header, because a rewrite can reuse the inode and land on the same size. */
  tail(): TailResult {
    if (!this.loaded) return this.loadAll();
    const st = this.stat();
    if (st.ino !== this.ino || st.size < this.offset) return this.loadAll();
    // While a torn remainder is pending, size equality proves nothing: a sibling may have truncated it and appended a
    // real line of exactly the same length, which must be read (and never truncated away by our next append).
    const torn = this.scanned > this.offset;
    if (!torn && st.size === this.scanned && st.mtime === this.mtime) return { lines: [], reloaded: false, gen: this.genValue };
    if (this.headerGen() !== this.genValue) return this.loadAll();
    this.mtime = st.mtime;
    if (!torn && st.size === this.scanned) return { lines: [], reloaded: false, gen: this.genValue };
    const buf = this.readFrom(this.offset, st.size);
    const lines = this.decode(buf, this.offset, this.offset + buf.length);
    return { lines, reloaded: false, gen: this.genValue };
  }

  /** Must be called inside withLock. Re-tails first (so seq/prev are current), then writes one line + "\n" and fsyncs. Returns the line written. */
  append(id: string, op: JournalOp): JournalLine {
    if (op.op === 'del' && op.id !== id) throw new VaultError('INVALID_ARGUMENT', 'del op id must match the line id');
    this.tail();
    if (this.scanned > this.offset) {
      try {
        truncateSync(this.path, this.offset);
      } catch (err) {
        throw new VaultError('IO', `cannot truncate torn line in ${this.path}: ${(err as Error).message}`);
      }
      this.scanned = this.offset;
    }
    const seq = this.seq + 1;
    const prev = this.hash;
    const env = this.sealer.seal(this.kind, JSON.stringify(op), { gen: this.genValue, seq, id, prev });
    const text = envelopeToLine(env);
    const bytes = Buffer.from(`${text}\n`, 'utf8');
    let fd: number;
    try {
      fd = openSync(this.path, 'a');
    } catch (err) {
      throw new VaultError('IO', `cannot open journal ${this.path}: ${(err as Error).message}`);
    }
    try {
      writeFully(fd, bytes);
      fsyncSync(fd);
      if (fileSize(fd) !== this.offset + bytes.length) throw new Error('size on disk differs from what was written');
    } catch (err) {
      // Put the file back exactly where it was so the torn bytes never remain behind a call that reports failure.
      try {
        ftruncateSync(fd, this.offset);
      } catch {
        /* the next writer truncates the torn tail under the lock anyway */
      }
      throw new VaultError('IO', `cannot append to journal ${this.path}: ${(err as Error).message}`);
    } finally {
      closeSync(fd);
    }
    this.seq = seq;
    this.hash = sha256Hex(text);
    this.offset += bytes.length;
    this.scanned = this.offset;
    try {
      this.mtime = this.stat().mtime;
    } catch {
      /* the next tail() will simply re-read the header */
    }
    return { seq, id, op, lineHash: this.hash };
  }

  /** Must be called inside withLock. Writes <path>.tmp with a new gen and one `put` per `live` record (in the given order), fsyncs, renames over, fsyncs dir. Returns the new gen. */
  rewrite(live: Array<{ id: string; record: unknown }>, newGen: string): string {
    const tmp = `${this.path}.tmp`;
    const header: JournalHeader = { journal: this.name, v: 1, vaultId: this.sealer.vaultId, gen: newGen };
    let fd: number;
    try {
      fd = openSync(tmp, 'w', 0o600);
    } catch (err) {
      throw new VaultError('IO', `cannot write ${tmp}: ${(err as Error).message}`);
    }
    let seq = 0;
    let hash = 'genesis';
    let total = 0;
    try {
      const headerLine = Buffer.from(`${JSON.stringify(header)}\n`, 'utf8');
      writeFully(fd, headerLine);
      total += headerLine.length;
      for (const { id, record } of live) {
        seq += 1;
        const op: JournalOp = { op: 'put', record };
        const env = this.sealer.seal(this.kind, JSON.stringify(op), { gen: newGen, seq, id, prev: hash });
        const text = envelopeToLine(env);
        const bytes = Buffer.from(`${text}\n`, 'utf8');
        writeFully(fd, bytes);
        total += bytes.length;
        hash = sha256Hex(text);
      }
      fsyncSync(fd);
      if (fileSize(fd) !== total) throw new Error('size on disk differs from what was written');
    } catch (err) {
      closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      if (err instanceof VaultError) throw err;
      throw new VaultError('IO', `cannot write ${tmp}: ${(err as Error).message}`);
    }
    closeSync(fd);
    try {
      renameSync(tmp, this.path);
    } catch (err) {
      throw new VaultError('IO', `cannot replace journal ${this.path}: ${(err as Error).message}`);
    }
    fsyncDir(dirname(this.path));
    this.genValue = newGen;
    this.seq = seq;
    this.hash = hash;
    this.offset = total;
    this.scanned = total;
    const st = this.stat();
    this.ino = st.ino;
    this.mtime = st.mtime;
    this.loaded = true;
    this.tornWarnedAt = -1;
    return newGen;
  }

  /** Key-less chain verification: header, seq contiguity, prev hashes, envelope shape. Does not decrypt, so anyone holding only the files can check them. */
  static verifyChain(path: string): { ok: boolean; lines: number; gen: string; brokenAtLine?: number; reason?: string } {
    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch (err) {
      return { ok: false, lines: 0, gen: '', brokenAtLine: 0, reason: `cannot read file: ${(err as Error).message}` };
    }
    const nl = buf.indexOf(NL);
    if (nl < 0) return { ok: false, lines: 0, gen: '', brokenAtLine: 1, reason: 'missing or unterminated header' };
    let header: JournalHeader;
    try {
      const parsed = JournalHeader.safeParse(JSON.parse(buf.toString('utf8', 0, nl)));
      if (!parsed.success) throw new Error('shape');
      header = parsed.data;
    } catch {
      return { ok: false, lines: 0, gen: '', brokenAtLine: 1, reason: 'header is not a valid journal header' };
    }
    const kind = JOURNAL_KINDS[header.journal];
    let seq = 0;
    let hash = 'genesis';
    let pos = nl + 1;
    let lineNo = 1;
    for (;;) {
      const end = buf.indexOf(NL, pos);
      if (end < 0) break;
      lineNo += 1;
      const text = buf.toString('utf8', pos, end);
      const isLast = buf.indexOf(NL, end + 1) < 0;
      let env: Envelope;
      try {
        env = lineToEnvelope(text);
      } catch {
        if (isLast) break; // torn tail is tolerated, exactly as readers tolerate it
        return { ok: false, lines: seq, gen: header.gen, brokenAtLine: lineNo, reason: 'line is not a valid envelope' };
      }
      if (env.seq !== seq + 1) {
        return { ok: false, lines: seq, gen: header.gen, brokenAtLine: lineNo, reason: `expected seq ${seq + 1}, found ${env.seq}` };
      }
      if (env.prev !== hash) {
        return { ok: false, lines: seq, gen: header.gen, brokenAtLine: lineNo, reason: 'prev hash does not match the previous line' };
      }
      if (env.k !== kind) {
        return { ok: false, lines: seq, gen: header.gen, brokenAtLine: lineNo, reason: `expected kind "${kind}", found "${env.k}"` };
      }
      seq = env.seq;
      hash = sha256Hex(text);
      pos = end + 1;
    }
    return { ok: true, lines: seq, gen: header.gen };
  }

  get gen(): string {
    return this.genValue;
  }
  get lastSeq(): number {
    return this.seq;
  }
  get byteOffset(): number {
    return this.offset;
  }
}
