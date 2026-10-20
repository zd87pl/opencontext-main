import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Sealer, envelopeToLine, lineToEnvelope } from '../crypto/envelope.js';
import { createKeyFile, keyIdOf, loadKey, resolvePassphrase, rewriteKeyFile, type PassphraseSource } from '../crypto/keyfile.js';
import { hashesEqual } from '../crypto/token.js';
import { VaultError } from '../errors.js';
import { newGen, newId, newVaultId, nowIso } from '../ids.js';
import {
  AuditEntry,
  Grant,
  LIMITS,
  Manifest,
  Memory,
  Source,
  SourceContent,
  SourceMeta,
  VAULT_FORMAT,
  VAULT_VERSION,
  type ChangeSet,
  type JournalName,
  type MemoryFilter,
  type SourceFilter,
  type VaultStats,
} from '../types.js';
import { canonicalJson, sha256Hex } from '../util/canonical-json.js';
import { Lru } from '../util/lru.js';
import { normalizeForQuote, normalizeStatement } from '../util/text.js';
import { JOURNAL_KINDS, Journal, type JournalLine } from './journal.js';
import { withLock } from './lock.js';
import { vaultFiles } from './paths.js';

/** How to find and unlock a vault; `now` is injectable so tests get deterministic timestamps. */
export interface OpenOptions {
  dir: string;
  keyFile: string;
  passphrase?: PassphraseSource;
  onWarn?: (msg: string) => void; // stderr in serve/CLI; never stdout
  now?: () => Date;
}

type Files = ReturnType<typeof vaultFiles>;
type Journals = Record<JournalName, Journal>;

const JOURNAL_NAMES: readonly JournalName[] = ['memories', 'sources', 'grants', 'audit'];
const COMPACTABLE: readonly JournalName[] = ['memories', 'sources', 'grants'];
const STANDALONE = { gen: '', seq: 0, id: '', prev: '' } as const;
const VERIFY_HINT = 'run: opencontext-vault verify';

function emptyChangeSet(): ChangeSet {
  return { memoriesPut: [], memoriesDeleted: [], sourcesPut: [], sourcesDeleted: [], grantsChanged: false, reloaded: false };
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* not supported everywhere; rename is still atomic */
  }
}

/** Stage in tmp/ (same filesystem) then rename so readers see either the old file or the whole new one, never a partial write. */
function writeAtomic(tmpDir: string, finalPath: string, data: string | Buffer, mode = 0o600): void {
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const tmp = join(tmpDir, `${basename(finalPath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number;
  try {
    fd = openSync(tmp, 'w', mode);
  } catch (err) {
    throw new VaultError('IO', `cannot write ${tmp}: ${(err as Error).message}`);
  }
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw new VaultError('IO', `cannot write ${tmp}: ${(err as Error).message}`);
  }
  closeSync(fd);
  try {
    renameSync(tmp, finalPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw new VaultError('IO', `cannot replace ${finalPath}: ${(err as Error).message}`);
  }
  fsyncDir(dirname(finalPath));
}

/** Returns the raw text too: the store compares it to detect compaction/rekey, because stat() alone cannot (same size, reused inode, same coarse mtime). */
function readManifest(path: string): { manifest: Manifest; text: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new VaultError('VAULT_NOT_FOUND', `no vault at ${dirname(path)}`, 'run: opencontext-vault init');
    }
    throw new VaultError('IO', `cannot read ${path}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new VaultError('CORRUPT', 'vault.json is not valid JSON', VERIFY_HINT);
  }
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) throw new VaultError('CORRUPT', 'vault.json has an invalid shape', VERIFY_HINT);
  return { manifest: parsed.data, text };
}

function parseTime(value: string, what: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new VaultError('INVALID_ARGUMENT', `invalid ${what}: not a date`);
  return ms;
}

function issuePath(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  const first = issues[0];
  if (!first) return 'invalid';
  const path = first.path.map(String).join('.');
  return `${path || '(root)'}: ${first.message}`;
}

function statKey(path: string): string {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

function diskBytes(dir: string): number {
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) total += diskBytes(p);
      else total += st.size;
    } catch {
      /* raced with a delete */
    }
  }
  return total;
}

/**
 * The single source of truth for one vault directory. Synchronous (node:fs sync APIs) by design: personal-scale data,
 * no intra-process races, trivially testable. Holds decrypted memories, source metas and grants in memory; source BODIES
 * are loaded on demand through an LRU of LIMITS.bodyCache (so a 500 MB import never has to fit in RAM).
 * Multi-process: every mutation runs inside withLock(dir); refresh() is called by the server before every call and by
 * the CLI before every command, and takes the lock only when a change is detected (so it never observes a half-written
 * compaction or rekey).
 */
export class VaultStore {
  readonly dir: string;
  readonly keyFile: string;
  readonly vaultId: string;
  /** ses_… for this process. */
  readonly session: string;

  private manifestValue: Manifest;
  private sealer: Sealer;
  private journals: Journals;
  private readonly files: Files;
  private readonly passphraseSrc: PassphraseSource;
  private readonly onWarn: ((msg: string) => void) | undefined;
  private readonly now: () => Date;
  private readonly memories = new Map<string, Memory>();
  private readonly sources = new Map<string, SourceMeta>();
  private readonly grants = new Map<string, Grant>();
  private readonly bodies = new Lru<string, SourceContent>(LIMITS.bodyCache);
  private pending = emptyChangeSet();
  private snapshot = new Map<string, string>();
  /** Exact bytes of vault.json as last applied; any difference means a compaction or rekey happened elsewhere. */
  private manifestText = '';
  private closed = false;

  private constructor(o: OpenOptions, manifest: Manifest, sealer: Sealer, passphraseSrc: PassphraseSource) {
    this.dir = o.dir;
    this.keyFile = o.keyFile;
    this.vaultId = manifest.vaultId;
    this.session = newId('ses');
    this.manifestValue = manifest;
    this.sealer = sealer;
    this.files = vaultFiles(o.dir);
    this.passphraseSrc = passphraseSrc;
    this.onWarn = o.onWarn;
    this.now = o.now ?? (() => new Date());
    this.journals = this.makeJournals(sealer);
    withLock(this.dir, () => this.syncLocked(true));
    // The initial load is the baseline, not a change since the caller's last refresh().
    this.pending = emptyChangeSet();
  }

  /** Creates dir (0o700), tmp/ and sources/ (0o700), sessions/, manifest, key file (sibling by default), four empty journals. EXISTS if dir contains vault.json. */
  static init(o: OpenOptions & { passphraseForNewKey?: string }): VaultStore {
    const files = vaultFiles(o.dir);
    if (existsSync(files.manifest)) {
      throw new VaultError('EXISTS', `vault already initialized at ${o.dir}`, 'pass --vault-dir <dir> to create a second vault');
    }
    const created = !existsSync(o.dir);
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    if (created) {
      try {
        chmodSync(o.dir, 0o700);
      } catch {
        /* Windows: permissions are not enforced */
      }
    }
    for (const sub of [files.tmpDir, files.sourcesDir, files.sessionsDir]) {
      mkdirSync(sub, { recursive: true, mode: 0o700 });
    }
    const vaultId = newVaultId();
    const key = createKeyFile(o.keyFile, vaultId, o.passphraseForNewKey);
    const sealer = new Sealer(key, vaultId);
    key.fill(0);
    const gens = { memories: newGen(), sources: newGen(), grants: newGen(), audit: newGen() };
    for (const name of JOURNAL_NAMES) Journal.create(files[name], name, vaultId, gens[name]);
    const manifest = Manifest.parse({
      format: VAULT_FORMAT,
      version: VAULT_VERSION,
      vaultId,
      createdAt: nowIso(o.now),
      keyId: sealer.keyId,
      keyCheck: sealer.seal('check', 'ok', STANDALONE),
      gens,
    });
    writeAtomic(files.tmpDir, files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    const src = o.passphrase ?? (o.passphraseForNewKey !== undefined ? { passphrase: o.passphraseForNewKey } : {});
    return new VaultStore(o, manifest, sealer, src);
  }

  /** VAULT_NOT_FOUND | KEY_NOT_FOUND | KEY_LOCKED | BAD_KEY (keyId mismatch or keyCheck fails) | CORRUPT. */
  static open(o: OpenOptions): VaultStore {
    const files = vaultFiles(o.dir);
    if (!existsSync(files.manifest)) {
      throw new VaultError('VAULT_NOT_FOUND', `no vault at ${o.dir}`, 'run: opencontext-vault init');
    }
    const { manifest } = readManifest(files.manifest);
    const src = o.passphrase ?? {};
    const sealer = VaultStore.openSealer(o.keyFile, manifest, src, o.onWarn);
    return new VaultStore(o, manifest, sealer, src);
  }

  static exists(dir: string): boolean {
    return existsSync(vaultFiles(dir).manifest);
  }

  /** Load the key file and prove it is the vault's key (keyId, then the manifest keyCheck) before touching any journal. */
  private static openSealer(keyFile: string, manifest: Manifest, src: PassphraseSource, onWarn?: (m: string) => void): Sealer {
    const key = loadKey(keyFile, manifest.vaultId, src, onWarn);
    const keyId = keyIdOf(key);
    if (keyId !== manifest.keyId) {
      key.fill(0);
      throw new VaultError(
        'BAD_KEY',
        `key ${keyId} does not match this vault (it expects key ${manifest.keyId})`,
        `pass the matching key file with --key-file <path> (current: ${keyFile})`,
      );
    }
    const sealer = new Sealer(key, manifest.vaultId);
    key.fill(0);
    let check: Buffer;
    try {
      check = sealer.open(manifest.keyCheck, STANDALONE);
    } catch (err) {
      sealer.destroy();
      if (VaultError.is(err, 'BAD_KEY')) throw new VaultError('BAD_KEY', 'key check failed: this key does not decrypt the vault', VERIFY_HINT);
      throw err;
    }
    if (check.toString('utf8') !== 'ok') {
      sealer.destroy();
      throw new VaultError('CORRUPT', 'manifest key check has unexpected content', VERIFY_HINT);
    }
    return sealer;
  }

  private makeJournals(sealer: Sealer): Journals {
    return {
      memories: new Journal(this.files.memories, 'memories', JOURNAL_KINDS.memories, sealer, this.onWarn),
      sources: new Journal(this.files.sources, 'sources', JOURNAL_KINDS.sources, sealer, this.onWarn),
      grants: new Journal(this.files.grants, 'grants', JOURNAL_KINDS.grants, sealer, this.onWarn),
      audit: new Journal(this.files.audit, 'audit', JOURNAL_KINDS.audit, sealer, this.onWarn),
    };
  }

  get manifest(): Manifest {
    return this.manifestValue;
  }

  get keyId(): string {
    return this.sealer.keyId;
  }

  private assertOpen(): void {
    if (this.closed) throw new VaultError('IO', 'vault store is closed');
  }

  // ---------------------------------------------------------------------------
  // Synchronization with the files
  // ---------------------------------------------------------------------------

  private journalPaths(): string[] {
    return [this.files.memories, this.files.sources, this.files.grants, this.files.audit];
  }

  private takeSnapshot(): void {
    this.snapshot = new Map(this.journalPaths().map((p) => [p, statKey(p)]));
  }

  /**
   * Cheap, lock-free change detection: the manifest's bytes (every compaction/rekey rewrites them) plus a stat of each
   * journal (every append grows it). Appends are monotonic within a gen, so size catches them; rewrites are caught by the
   * manifest even when the new file has the same size, a reused inode and the same coarse mtime.
   */
  private changedSinceSnapshot(): boolean {
    let text: string;
    try {
      text = readFileSync(this.files.manifest, 'utf8');
    } catch {
      return true;
    }
    if (text !== this.manifestText) return true;
    for (const p of this.journalPaths()) {
      if (this.snapshot.get(p) !== statKey(p)) return true;
    }
    return false;
  }

  /** Inside the lock: re-read the manifest, reload the key if another process rekeyed, tail or reload every journal, apply the lines. */
  private syncLocked(full: boolean): void {
    const { manifest, text } = readManifest(this.files.manifest);
    if (manifest.vaultId !== this.vaultId) throw new VaultError('CORRUPT', 'vault.json now names a different vault', VERIFY_HINT);
    let reloadAll = full;
    if (manifest.keyId !== this.sealer.keyId) {
      const sealer = VaultStore.openSealer(this.keyFile, manifest, this.passphraseSrc, this.onWarn);
      this.sealer.destroy();
      this.sealer = sealer;
      this.journals = this.makeJournals(sealer);
      reloadAll = true;
    }
    for (const name of JOURNAL_NAMES) {
      const journal = this.journals[name];
      let result = reloadAll ? journal.loadAll() : journal.tail();
      if (journal.gen !== manifest.gens[name]) {
        // A rewrite can be invisible to stat() (same size, reused inode, coarse mtime): re-read the header before judging.
        result = journal.loadAll();
        if (journal.gen !== manifest.gens[name]) {
          throw new VaultError('CORRUPT', `journal ${name}: generation does not match vault.json (rolled back or corrupt)`, VERIFY_HINT);
        }
      }
      if (result.reloaded) this.rebuild(name, result.lines);
      else this.applyLines(name, result.lines);
    }
    this.manifestValue = manifest;
    this.manifestText = text;
    this.takeSnapshot();
  }

  private rebuild(name: JournalName, lines: JournalLine[]): void {
    if (name === 'audit') return;
    if (name === 'memories') {
      this.memories.clear();
      this.pending.memoriesPut = [];
      this.pending.memoriesDeleted = [];
    } else if (name === 'sources') {
      this.sources.clear();
      this.bodies.clear();
      this.pending.sourcesPut = [];
      this.pending.sourcesDeleted = [];
    } else {
      this.grants.clear();
    }
    this.pending.reloaded = true;
    for (const line of lines) this.applyLine(name, line, false);
  }

  private applyLines(name: JournalName, lines: JournalLine[]): void {
    for (const line of lines) this.applyLine(name, line, true);
  }

  private applyLine(name: JournalName, line: JournalLine, track: boolean): void {
    const { op } = line;
    switch (name) {
      case 'memories': {
        if (op.op === 'put') {
          const parsed = Memory.safeParse(op.record);
          if (!parsed.success) throw new VaultError('CORRUPT', `journal memories: seq ${line.seq} holds an invalid record`, VERIFY_HINT);
          this.memories.set(parsed.data.id, parsed.data);
          if (track) {
            this.pending.memoriesPut = this.pending.memoriesPut.filter((m) => m.id !== parsed.data.id);
            this.pending.memoriesPut.push(parsed.data);
            this.pending.memoriesDeleted = this.pending.memoriesDeleted.filter((id) => id !== parsed.data.id);
          }
        } else {
          this.memories.delete(op.id);
          if (track) {
            this.pending.memoriesPut = this.pending.memoriesPut.filter((m) => m.id !== op.id);
            if (!this.pending.memoriesDeleted.includes(op.id)) this.pending.memoriesDeleted.push(op.id);
          }
        }
        return;
      }
      case 'sources': {
        if (op.op === 'put') {
          const parsed = SourceMeta.safeParse(op.record);
          if (!parsed.success) throw new VaultError('CORRUPT', `journal sources: seq ${line.seq} holds an invalid record`, VERIFY_HINT);
          const previous = this.sources.get(parsed.data.id);
          if (previous && previous.sha256 !== parsed.data.sha256) this.bodies.delete(parsed.data.id);
          this.sources.set(parsed.data.id, parsed.data);
          if (track) {
            this.pending.sourcesPut = this.pending.sourcesPut.filter((s) => s.id !== parsed.data.id);
            this.pending.sourcesPut.push(parsed.data);
            this.pending.sourcesDeleted = this.pending.sourcesDeleted.filter((id) => id !== parsed.data.id);
          }
        } else {
          this.sources.delete(op.id);
          this.bodies.delete(op.id);
          if (track) {
            this.pending.sourcesPut = this.pending.sourcesPut.filter((s) => s.id !== op.id);
            if (!this.pending.sourcesDeleted.includes(op.id)) this.pending.sourcesDeleted.push(op.id);
          }
        }
        return;
      }
      case 'grants': {
        if (op.op === 'put') {
          const parsed = Grant.safeParse(op.record);
          if (!parsed.success) throw new VaultError('CORRUPT', `journal grants: seq ${line.seq} holds an invalid record`, VERIFY_HINT);
          this.grants.set(parsed.data.id, parsed.data);
        } else {
          this.grants.delete(op.id);
        }
        if (track) this.pending.grantsChanged = true;
        return;
      }
      case 'audit':
        return;
    }
  }

  /** Every mutation: lock → bring the in-memory view up to date → do the work → remember the files' state. */
  private mutate<T>(fn: (touch: () => void) => T): T {
    this.assertOpen();
    return withLock(this.dir, (touch) => {
      this.syncLocked(false);
      const result = fn(touch);
      this.takeSnapshot();
      return result;
    });
  }

  /** Append one op and mirror it into the in-memory view (and the pending ChangeSet, so this process's own writes reach its indexes too). */
  private appendOp(name: JournalName, id: string, op: JournalLine['op']): JournalLine {
    let line: JournalLine;
    try {
      line = this.journals[name].append(id, op);
    } catch (err) {
      if (err instanceof VaultError) throw err;
      throw new VaultError('IO', `cannot write journal ${name}: ${(err as Error).message}`);
    }
    this.applyLine(name, line, true);
    return line;
  }

  private compactJournals(names: readonly JournalName[], touch: () => void): void {
    const gens = { ...this.manifestValue.gens };
    for (const name of names) {
      if (name === 'audit') continue;
      const live: Array<{ id: string; record: unknown }> =
        name === 'memories'
          ? [...this.memories.values()].map((m) => ({ id: m.id, record: m }))
          : name === 'sources'
            ? [...this.sources.values()].map((s) => ({ id: s.id, record: s }))
            : [...this.grants.values()].map((g) => ({ id: g.id, record: g }));
      gens[name] = this.journals[name].rewrite(live, newGen());
      touch();
    }
    this.writeManifest({ ...this.manifestValue, gens });
  }

  private writeManifest(manifest: Manifest): void {
    const parsed = Manifest.parse(manifest);
    const text = `${JSON.stringify(parsed, null, 2)}\n`;
    writeAtomic(this.files.tmpDir, this.files.manifest, text);
    this.manifestValue = parsed;
    this.manifestText = text;
  }

  /** See class doc. Also reloads the key file when manifest.keyId changed (another process ran rekey); throws BAD_KEY if the new key cannot be loaded. Returns everything applied since the last call, including this process's own writes. */
  refresh(): ChangeSet {
    this.assertOpen();
    if (this.changedSinceSnapshot()) withLock(this.dir, () => this.syncLocked(false));
    const out = this.pending;
    this.pending = emptyChangeSet();
    return out;
  }

  /** Destroys the sealer and clears caches; the instance is unusable afterwards. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sealer.destroy();
    this.memories.clear();
    this.sources.clear();
    this.grants.clear();
    this.bodies.clear();
    this.pending = emptyChangeSet();
  }

  // ---------------------------------------------------------------------------
  // Memories
  // ---------------------------------------------------------------------------

  /** updatedAt desc; status defaults to 'active'. */
  listMemories(f?: MemoryFilter): Memory[] {
    this.assertOpen();
    const status = f?.status ?? 'active';
    const subject = f?.subject?.toLowerCase();
    const since = f?.since !== undefined ? parseTime(f.since, 'since') : undefined;
    const tags = f?.tags;
    const out = [...this.memories.values()].filter(
      (m) =>
        (status === 'all' || m.status === status) &&
        (f?.kind === undefined || m.kind === f.kind) &&
        (tags === undefined || tags.length === 0 || m.tags.some((t) => tags.includes(t))) &&
        (subject === undefined || m.subject.toLowerCase() === subject) &&
        (f?.createdBy === undefined || m.createdBy === f.createdBy) &&
        (since === undefined || Date.parse(m.updatedAt) >= since),
    );
    return out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
  }

  getMemory(id: string): Memory | undefined {
    this.assertOpen();
    return this.memories.get(id);
  }

  /** Validates with Memory schema (throws INVALID_ARGUMENT with the zod issue path), recomputes every sources[].verified via verifyQuote, appends `put`. */
  putMemory(m: Memory): Memory {
    const parsed = Memory.safeParse(m);
    if (!parsed.success) throw new VaultError('INVALID_ARGUMENT', `invalid memory: ${issuePath(parsed.error.issues)}`);
    return this.mutate(() => {
      const record: Memory = {
        ...parsed.data,
        sources: parsed.data.sources.map((ref) => ({
          ...ref,
          verified: ref.quote !== undefined && this.verifyQuote(ref.sourceId, ref.quote, ref.turn),
        })),
      };
      this.appendOp('memories', record.id, { op: 'put', record });
      return record;
    });
  }

  /** Appends `del` for each id AND every older version reachable through `supersedes`, then compacts memories.jsonl so the ciphertext leaves the live file. Returns all deleted ids; unknown ids are ignored (caller reports them). */
  deleteMemories(ids: string[]): string[] {
    return this.mutate((touch) => {
      const toDelete: string[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        let cur: string | undefined = id;
        while (cur !== undefined && !seen.has(cur)) {
          const m = this.memories.get(cur);
          if (!m) break;
          seen.add(cur);
          toDelete.push(cur);
          cur = m.supersedes;
        }
      }
      if (toDelete.length === 0) return [];
      const at = nowIso(this.now);
      for (const id of toDelete) this.appendOp('memories', id, { op: 'del', id, at });
      this.compactJournals(['memories'], touch);
      return toDelete;
    });
  }

  /** Active memory whose normalizeStatement(statement) and lowercased subject equal the arguments. Exact only. */
  findDuplicate(statement: string, subject: string): Memory | undefined {
    this.assertOpen();
    const key = normalizeStatement(statement);
    const subj = normalizeForQuote(subject).toLowerCase();
    for (const m of this.memories.values()) {
      if (m.status !== 'active') continue;
      if (normalizeStatement(m.statement) === key && normalizeForQuote(m.subject).toLowerCase() === subj) return m;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------------

  /** createdAt desc; review defaults to 'all'. */
  listSources(f?: SourceFilter): SourceMeta[] {
    this.assertOpen();
    const review = f?.review ?? 'all';
    const since = f?.since !== undefined ? parseTime(f.since, 'since') : undefined;
    const tags = f?.tags;
    const out = [...this.sources.values()].filter(
      (s) =>
        (f?.type === undefined || s.type === f.type) &&
        (tags === undefined || tags.length === 0 || s.tags.some((t) => tags.includes(t))) &&
        (review === 'all' || s.review.status === review) &&
        (since === undefined || Date.parse(s.createdAt) >= since),
    );
    return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  }

  getSourceMeta(id: string): SourceMeta | undefined {
    this.assertOpen();
    return this.sources.get(id);
  }

  /** meta + body. Body is read from sources/<id>.enc, decrypted, sha256-checked against meta.sha256 (mismatch → CORRUPT "body does not match its record"), cached in the LRU. */
  getSource(id: string): Source | undefined {
    const meta = this.getSourceMeta(id);
    if (!meta) return undefined;
    const content = this.getSourceContent(id);
    if (!content) return undefined;
    return { ...meta, content };
  }

  getSourceContent(id: string): SourceContent | undefined {
    this.assertOpen();
    const meta = this.sources.get(id);
    if (!meta) return undefined;
    const cached = this.bodies.get(id);
    if (cached) return cached;
    const content = this.readBody(meta, this.sealer);
    this.bodies.set(id, content);
    return content;
  }

  private bodyPath(id: string): string {
    return join(this.files.sourcesDir, `${id}.enc`);
  }

  /** Decrypt and integrity-check one body from disk (no cache), with the given sealer so rekey can read with the old key. */
  private readBody(meta: SourceMeta, sealer: Sealer): SourceContent {
    let text: string;
    try {
      text = readFileSync(this.bodyPath(meta.id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VaultError('CORRUPT', `source body missing: ${meta.id}`, VERIFY_HINT);
      }
      throw new VaultError('IO', `cannot read source body ${meta.id}: ${(err as Error).message}`);
    }
    const env = lineToEnvelope(text.replace(/\r?\n$/, ''));
    let plaintext: Buffer;
    try {
      plaintext = sealer.open(env, { gen: '', seq: 0, id: meta.id, prev: '' });
    } catch (err) {
      if (VaultError.is(err, 'BAD_KEY')) throw new VaultError('CORRUPT', `source body ${meta.id} failed authentication`, VERIFY_HINT);
      throw err;
    }
    let content: SourceContent;
    try {
      const parsed = SourceContent.safeParse(JSON.parse(plaintext.toString('utf8')));
      if (!parsed.success) throw new Error('shape');
      content = parsed.data;
    } catch {
      throw new VaultError('CORRUPT', `source body ${meta.id} is not a valid source content`, VERIFY_HINT);
    }
    if (sha256Hex(canonicalJson(content)) !== meta.sha256) {
      throw new VaultError('CORRUPT', `source body ${meta.id} does not match its record`, VERIFY_HINT);
    }
    return content;
  }

  private writeBody(id: string, content: SourceContent, sealer: Sealer): void {
    const env = sealer.seal('source-body', JSON.stringify(content), { gen: '', seq: 0, id, prev: '' });
    writeAtomic(this.files.tmpDir, this.bodyPath(id), `${envelopeToLine(env)}\n`);
  }

  findSourceBySha(sha256: string): SourceMeta | undefined {
    this.assertOpen();
    for (const s of this.sources.values()) if (s.sha256 === sha256) return s;
    return undefined;
  }

  /** Writes sources/<id>.enc.tmp → fsync → rename BEFORE appending the meta `put` (a meta never references a missing body). Replaces an existing body for the same id (re-import update). sha256/bytes/turnCount/hasRaw are recomputed from the content so a meta can never disagree with its body. */
  putSource(s: Source): SourceMeta {
    const parsed = Source.safeParse(s);
    if (!parsed.success) throw new VaultError('INVALID_ARGUMENT', `invalid source: ${issuePath(parsed.error.issues)}`);
    const { content, ...meta } = parsed.data;
    const record = SourceMeta.parse({
      ...meta,
      sha256: sha256Hex(canonicalJson(content)),
      bytes: Buffer.byteLength(JSON.stringify(content), 'utf8'),
      turnCount: content.kind === 'conversation' ? content.turns.length : 1,
      hasRaw: content.raw !== undefined,
    });
    return this.mutate(() => {
      const existing = this.sources.get(record.id);
      if (!existing || existing.sha256 !== record.sha256 || !existsSync(this.bodyPath(record.id))) {
        this.writeBody(record.id, content, this.sealer);
      }
      this.appendOp('sources', record.id, { op: 'put', record });
      this.bodies.set(record.id, content);
      return record;
    });
  }

  /** Metadata-only update (tags, review state, title…). The body-derived fields are kept from the stored record so they stay truthful. */
  updateSourceMeta(m: SourceMeta): SourceMeta {
    const parsed = SourceMeta.safeParse(m);
    if (!parsed.success) throw new VaultError('INVALID_ARGUMENT', `invalid source meta: ${issuePath(parsed.error.issues)}`);
    return this.mutate(() => {
      const existing = this.sources.get(parsed.data.id);
      if (!existing) throw new VaultError('NOT_FOUND', `source not found: ${parsed.data.id}`);
      if (parsed.data.sha256 !== existing.sha256) {
        throw new VaultError('INVALID_ARGUMENT', 'sha256 cannot change through updateSourceMeta; use putSource with the new content');
      }
      const record: SourceMeta = { ...parsed.data, bytes: existing.bytes, turnCount: existing.turnCount, hasRaw: existing.hasRaw };
      this.appendOp('sources', record.id, { op: 'put', record });
      return record;
    });
  }

  /** `del` + compact sources.jsonl + unlink bodies. Memories keep their SourceRefs (shown as forgotten). */
  deleteSources(ids: string[]): string[] {
    return this.mutate((touch) => {
      const present = [...new Set(ids)].filter((id) => this.sources.has(id));
      if (present.length === 0) return [];
      const at = nowIso(this.now);
      for (const id of present) this.appendOp('sources', id, { op: 'del', id, at });
      this.compactJournals(['sources'], touch);
      for (const id of present) {
        try {
          unlinkSync(this.bodyPath(id));
        } catch {
          /* already gone */
        }
        this.bodies.delete(id);
      }
      return present;
    });
  }

  /** normalizeForQuote(quote) is a substring of normalizeForQuote(turn text | document text). false when the source or turn is missing. */
  verifyQuote(sourceId: string, quote: string, turn?: number): boolean {
    const content = this.getSourceContent(sourceId);
    if (!content) return false;
    const needle = normalizeForQuote(quote);
    if (needle === '') return false;
    if (content.kind === 'document') return normalizeForQuote(content.text).includes(needle);
    if (turn === undefined) return content.turns.some((t) => normalizeForQuote(t.text).includes(needle));
    const t = content.turns.find((x) => x.i === turn);
    if (!t) return false;
    return normalizeForQuote(t.text).includes(needle);
  }

  // ---------------------------------------------------------------------------
  // Grants
  // ---------------------------------------------------------------------------

  listGrants(): Grant[] {
    this.assertOpen();
    return [...this.grants.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.label.localeCompare(b.label));
  }

  getGrantByLabel(label: string): Grant | undefined {
    this.assertOpen();
    for (const g of this.grants.values()) if (g.label === label) return g;
    return undefined;
  }

  /** Constant-time comparison over all grants (no early exit on label). */
  getGrantByTokenHash(hash: string): Grant | undefined {
    this.assertOpen();
    let found: Grant | undefined;
    for (const g of this.grants.values()) {
      if (hashesEqual(g.tokenHash, hash)) found = g;
    }
    return found;
  }

  /** EXISTS when another grant already carries the label (rotate by re-putting the same id instead). */
  putGrant(g: Grant): Grant {
    const parsed = Grant.safeParse(g);
    if (!parsed.success) throw new VaultError('INVALID_ARGUMENT', `invalid grant: ${issuePath(parsed.error.issues)}`);
    return this.mutate(() => {
      for (const other of this.grants.values()) {
        if (other.label === parsed.data.label && other.id !== parsed.data.id) {
          throw new VaultError('EXISTS', `a grant labelled "${parsed.data.label}" already exists`, `run: opencontext-vault grant ${parsed.data.label} --rotate`);
        }
      }
      this.appendOp('grants', parsed.data.id, { op: 'put', record: parsed.data });
      return parsed.data;
    });
  }

  /** del + compact so the revoked hash leaves the live file. */
  deleteGrant(id: string): void {
    this.mutate((touch) => {
      if (!this.grants.has(id)) throw new VaultError('NOT_FOUND', `grant not found: ${id}`);
      this.appendOp('grants', id, { op: 'del', id, at: nowIso(this.now) });
      this.compactJournals(['grants'], touch);
    });
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  /** Assigns id and session, appends under the lock (prev chain computed there). On IO failure throws VaultError('IO') — the guard turns that into a tool error: the vault refuses to serve what it cannot log. */
  appendAudit(e: Omit<AuditEntry, 'id' | 'session'>): AuditEntry {
    const parsed = AuditEntry.safeParse({ ...e, id: newId('aud'), session: this.session });
    if (!parsed.success) throw new VaultError('INVALID_ARGUMENT', `invalid audit entry: ${issuePath(parsed.error.issues)}`);
    return this.mutate(() => {
      this.appendOp('audit', parsed.data.id, { op: 'put', record: parsed.data });
      return parsed.data;
    });
  }

  private auditEntryOf(line: JournalLine): AuditEntry | undefined {
    if (line.op.op !== 'put') return undefined;
    const parsed = AuditEntry.safeParse(line.op.record);
    if (!parsed.success) throw new VaultError('CORRUPT', `journal audit: seq ${line.seq} holds an invalid record`, VERIFY_HINT);
    return parsed.data;
  }

  /** oldest → newest within the window; limit keeps the newest. Reads the file fresh each time (the audit log is not held in memory). */
  readAudit(o?: { since?: string; limit?: number; label?: string; event?: AuditEntry['event']; outcome?: AuditEntry['outcome'] }): AuditEntry[] {
    this.assertOpen();
    const since = o?.since !== undefined ? parseTime(o.since, 'since') : undefined;
    const reader = new Journal(this.files.audit, 'audit', JOURNAL_KINDS.audit, this.sealer, this.onWarn);
    const entries: AuditEntry[] = [];
    for (const line of reader.loadAll().lines) {
      const entry = this.auditEntryOf(line);
      if (!entry) continue;
      if (since !== undefined && Date.parse(entry.at) < since) continue;
      if (o?.label !== undefined && entry.grant?.label !== o.label) continue;
      if (o?.event !== undefined && entry.event !== o.event) continue;
      if (o?.outcome !== undefined && entry.outcome !== o.outcome) continue;
      entries.push(entry);
    }
    if (o?.limit !== undefined && o.limit >= 0 && entries.length > o.limit) return entries.slice(entries.length - o.limit);
    return entries;
  }

  /** For `audit --follow`: entries after byte offset; returns the new offset. Lines are authenticated individually (not chained) so a follower can start mid-file; a rewritten file (rekey) restarts from the top. */
  tailAudit(fromByte: number): { entries: AuditEntry[]; byte: number } {
    this.assertOpen();
    let buf: Buffer;
    try {
      buf = readFileSync(this.files.audit);
    } catch (err) {
      throw new VaultError('IO', `cannot read audit journal: ${(err as Error).message}`);
    }
    const headerEnd = buf.indexOf(0x0a);
    if (headerEnd < 0) return { entries: [], byte: 0 };
    let gen: string;
    try {
      gen = (JSON.parse(buf.toString('utf8', 0, headerEnd)) as { gen: string }).gen;
    } catch {
      throw new VaultError('CORRUPT', 'journal audit: header is not valid JSON', VERIFY_HINT);
    }
    const decodeFrom = (start: number, strictFirst: boolean): { entries: AuditEntry[]; byte: number } | undefined => {
      const entries: AuditEntry[] = [];
      let pos = start;
      let first = true;
      for (;;) {
        const nl = buf.indexOf(0x0a, pos);
        if (nl < 0) break;
        try {
          const env = lineToEnvelope(buf.toString('utf8', pos, nl));
          const plaintext = this.sealer.open(env, { gen, seq: env.seq, id: env.id, prev: env.prev });
          const op = JSON.parse(plaintext.toString('utf8')) as { op: string; record?: unknown };
          const entry = op.op === 'put' ? AuditEntry.parse(op.record) : undefined;
          if (entry) entries.push(entry);
        } catch {
          if (first && strictFirst) return undefined;
          break;
        }
        first = false;
        pos = nl + 1;
      }
      return { entries, byte: pos };
    };
    const start = fromByte <= 0 || fromByte > buf.length ? headerEnd + 1 : fromByte;
    const result = (start === headerEnd + 1 ? undefined : decodeFrom(start, true)) ?? decodeFrom(headerEnd + 1, false);
    return result ?? { entries: [], byte: headerEnd + 1 };
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /** Compacts memories, sources, grants (never audit). Safe with other processes running (they full-reload on gen change). */
  compact(): void {
    this.mutate((touch) => this.compactJournals(COMPACTABLE, touch));
  }

  /** New data key: rewrites all journals (new gens) and every body under the lock (touching it per file), then the key file and the manifest (new keyId/keyCheck). Other processes reload the key on their next refresh(). */
  rekey(src: PassphraseSource): void {
    this.mutate((touch) => {
      // Everything that can refuse (no passphrase, unreadable key file) must fail BEFORE a single journal is re-sealed,
      // otherwise a KEY_LOCKED error would leave journals the current key file cannot open.
      const keySrc = this.keyFileWritePrecheck(src);
      const newKey = randomBytes(32);
      const sealer = new Sealer(newKey, this.vaultId);
      const auditLines = this.journals.audit.loadAll().lines.filter((l) => l.op.op === 'put');
      const journals = this.makeJournals(sealer);
      const gens = { ...this.manifestValue.gens };
      gens.memories = journals.memories.rewrite([...this.memories.values()].map((m) => ({ id: m.id, record: m })), newGen());
      touch();
      gens.sources = journals.sources.rewrite([...this.sources.values()].map((s) => ({ id: s.id, record: s })), newGen());
      touch();
      gens.grants = journals.grants.rewrite([...this.grants.values()].map((g) => ({ id: g.id, record: g })), newGen());
      touch();
      gens.audit = journals.audit.rewrite(
        auditLines.map((l) => ({ id: l.id, record: l.op.op === 'put' ? l.op.record : undefined })),
        newGen(),
      );
      touch();
      for (const meta of this.sources.values()) {
        const content = this.bodies.get(meta.id) ?? this.readBody(meta, this.sealer);
        this.writeBody(meta.id, content, sealer);
        touch();
      }
      try {
        rewriteKeyFile(this.keyFile, this.vaultId, newKey, keySrc);
      } finally {
        newKey.fill(0);
      }
      this.writeManifest({ ...this.manifestValue, keyId: sealer.keyId, keyCheck: sealer.seal('check', 'ok', STANDALONE), gens });
      this.sealer.destroy();
      this.sealer = sealer;
      this.journals = journals;
    });
  }

  /** Proves the key file can be rewritten (exists, belongs to this vault, passphrase available when scrypt) and pins the passphrase so no later prompt or lookup can fail mid-rekey. */
  private keyFileWritePrecheck(src: PassphraseSource): PassphraseSource {
    const current = loadKey(this.keyFile, this.vaultId, src, this.onWarn);
    const matches = keyIdOf(current) === this.sealer.keyId;
    current.fill(0);
    if (!matches) throw new VaultError('BAD_KEY', 'the key file on disk no longer matches the open vault', 'run: opencontext-vault status');
    let kdf: string;
    try {
      kdf = (JSON.parse(readFileSync(this.keyFile, 'utf8')) as { kdf?: string }).kdf ?? 'none';
    } catch (err) {
      throw new VaultError('IO', `cannot read key file: ${(err as Error).message}`);
    }
    if (kdf !== 'scrypt') return {};
    const passphrase = resolvePassphrase(src);
    if (passphrase === undefined) {
      throw new VaultError('KEY_LOCKED', 'rekey needs the passphrase to rewrite the key file', 'set OPENCONTEXT_VAULT_PASSPHRASE, OPENCONTEXT_VAULT_PASSPHRASE_CMD, or pass --passphrase-file <path>');
    }
    return { passphrase };
  }

  /** Key-less chain verification of all four journals + manifest gens match; with the key also checks every body hash. */
  verify(o?: { bodies?: boolean }): {
    ok: boolean;
    journals: Record<JournalName, ReturnType<typeof Journal.verifyChain>>;
    bodies?: { checked: number; bad: string[] };
  } {
    this.assertOpen();
    // Deliberately no sync: this is the diagnostic that the CORRUPT hint points at, so it must report a bad vault, not throw on it.
    return withLock(this.dir, () => {
      const { manifest } = readManifest(this.files.manifest);
      const journals = {} as Record<JournalName, ReturnType<typeof Journal.verifyChain>>;
      let ok = true;
      for (const name of JOURNAL_NAMES) {
        let r = Journal.verifyChain(this.files[name]);
        if (r.ok && r.gen !== manifest.gens[name]) {
          r = { ...r, ok: false, reason: 'generation does not match vault.json (rolled back or swapped)' };
        }
        journals[name] = r;
        ok &&= r.ok;
      }
      if (!o?.bodies) return { ok, journals };
      const bad: string[] = [];
      let checked = 0;
      for (const meta of this.sources.values()) {
        checked += 1;
        try {
          this.readBody(meta, this.sealer);
        } catch (err) {
          if (err instanceof VaultError) bad.push(meta.id);
          else throw err;
        }
      }
      return { ok: ok && bad.length === 0, journals, bodies: { checked, bad } };
    });
  }

  /** Recompute every memory's sources[].verified; returns changed memory ids (writes only when fix=true). Orphaned refs are "<memoryId>:<sourceId>". */
  verifyProvenance(o?: { fix?: boolean }): { checked: number; changed: string[]; orphaned: string[] } {
    const run = (): { checked: number; changed: string[]; orphaned: string[] } => {
      const changed: string[] = [];
      const orphaned: string[] = [];
      let checked = 0;
      for (const m of [...this.memories.values()]) {
        checked += 1;
        let differs = false;
        const sources = m.sources.map((ref) => {
          if (!this.sources.has(ref.sourceId)) orphaned.push(`${m.id}:${ref.sourceId}`);
          const verified = ref.quote !== undefined && this.verifyQuote(ref.sourceId, ref.quote, ref.turn);
          if (verified !== ref.verified) differs = true;
          return { ...ref, verified };
        });
        if (!differs) continue;
        changed.push(m.id);
        if (o?.fix) this.appendOp('memories', m.id, { op: 'put', record: { ...m, sources } });
      }
      return { checked, changed, orphaned };
    };
    if (o?.fix) return this.mutate(run);
    this.assertOpen();
    return run();
  }

  stats(): VaultStats {
    this.assertOpen();
    let active = 0;
    for (const m of this.memories.values()) if (m.status === 'active') active += 1;
    let unreviewed = 0;
    let sourceBytes = 0;
    for (const s of this.sources.values()) {
      if (s.review.status === 'unreviewed') unreviewed += 1;
      sourceBytes += s.bytes;
    }
    return {
      memories: this.memories.size,
      activeMemories: active,
      sources: this.sources.size,
      unreviewedSources: unreviewed,
      sourceBytes,
      grants: this.grants.size,
      auditEntries: this.journals.audit.lastSeq,
      diskBytes: diskBytes(this.dir),
    };
  }
}
