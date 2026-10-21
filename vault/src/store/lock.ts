import { closeSync, ftruncateSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { writeFully } from '../util/fs.js';
import { join, resolve } from 'node:path';
import { VaultError } from '../errors.js';

/** Tunables exposed so tests can shrink the wait and stale windows; production callers use the defaults. */
export interface LockOptions {
  waitMs?: number /* default 10_000 */;
  staleMs?: number /* default 60_000 */;
}

const SLEEP_MS = 5;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Locks held by this process, by absolute dir. Re-entry from the same process is safe because the store is synchronous: nothing can interleave inside fn. */
const held = new Map<string, number>();

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

type LockState = { kind: 'gone' } | { kind: 'live' } | { kind: 'stale'; content: string };

/**
 * A lock is stale when its holder is dead or has not touched it within staleMs. "gone" means it was released between
 * our EEXIST and this read: that is not stale, and unlinking would delete whatever lock the next process just created.
 * The content ends with "\n" only when the holder's write completed; a partial read is judged by mtime, never parsed.
 */
function inspect(lockPath: string, staleMs: number): LockState {
  let content = '';
  try {
    content = readFileSync(lockPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'gone' };
    return { kind: 'live' };
  }
  const m = /^(\d+) (\d+)\n$/.exec(content);
  if (!m) {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > staleMs ? { kind: 'stale', content } : { kind: 'live' };
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'gone' } : { kind: 'live' };
    }
  }
  const pid = Number(m[1]);
  const ms = Number(m[2]);
  if (!pidAlive(pid) || Date.now() - ms > staleMs) return { kind: 'stale', content };
  return { kind: 'live' };
}

/** Removes a stale lock only if it still holds the exact bytes we judged stale, so a lock a live process acquired meanwhile is never deleted. */
function reclaim(lockPath: string, content: string): void {
  try {
    if (readFileSync(lockPath, 'utf8') !== content) return;
    unlinkSync(lockPath);
  } catch {
    /* already gone or replaced: the retry will find out */
  }
}

/**
 * Exclusive directory lock via openSync(dir/.lock, 'wx', 0o600) holding "<pid> <ms>\n".
 * On EEXIST the lock is stale only if (a) its pid is not alive (process.kill(pid, 0) → ESRCH) OR (b) its timestamp
 * is older than staleMs; stale → unlink and retry. Otherwise sleep 5 ms (Atomics.wait) and retry until waitMs,
 * then throw VaultError('LOCKED', …, 'another opencontext-vault process is busy; retry, or delete <lock> if no process holds it').
 * `touch()` rewrites the timestamp; long operations (compact, rekey) call it at least every 5 s so a live lock is never stolen.
 * Release and touch act only on a lock that still names this pid: once a lock has been judged stale and taken over,
 * the original holder can neither delete nor overwrite the new holder's lock.
 * Synchronous on purpose: the store is synchronous and holds the lock for milliseconds.
 */
export function withLock<T>(dir: string, fn: (touch: () => void) => T, o?: LockOptions): T {
  const waitMs = o?.waitMs ?? 10_000;
  const staleMs = o?.staleMs ?? 60_000;
  const key = resolve(dir);
  const lockPath = join(key, '.lock');

  const depth = held.get(key);
  if (depth !== undefined) {
    held.set(key, depth + 1);
    try {
      return fn(() => touchLock(lockPath));
    } finally {
      const d = held.get(key) ?? 1;
      if (d <= 1) held.delete(key);
      else held.set(key, d - 1);
    }
  }

  const started = Date.now();
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw new VaultError('IO', `cannot create lock ${lockPath}: ${(err as Error).message}`);
      const state = inspect(lockPath, staleMs);
      if (state.kind === 'gone') continue;
      if (state.kind === 'stale') {
        sleepSync(SLEEP_MS); // a holder caught mid-write finishes within this; a truly dead one never changes
        reclaim(lockPath, state.content);
        continue;
      }
      if (Date.now() - started >= waitMs) {
        throw new VaultError(
          'LOCKED',
          `vault is locked by another process (${lockPath})`,
          `another opencontext-vault process is busy; retry, or delete ${lockPath} if no process holds it`,
        );
      }
      sleepSync(SLEEP_MS);
      continue;
    }
    try {
      writeFully(fd, Buffer.from(`${process.pid} ${Date.now()}\n`, 'utf8'));
    } catch (err) {
      // We created the file a moment ago, so it is ours to remove: an empty lock left behind would make every
      // process wait the full stale window (ENOSPC on the pid write is the realistic case).
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        /* best effort */
      }
      throw new VaultError('IO', `cannot write lock ${lockPath}: ${(err as Error).message}`);
    }
    closeSync(fd);
    break;
  }

  held.set(key, 1);
  try {
    return fn(() => touchLock(lockPath));
  } finally {
    held.delete(key);
    releaseLock(lockPath);
  }
}

/** True when the lock file still names this process: after a stale-lock steal it names the new holder and is not ours to touch or remove. */
function ownsLock(lockPath: string): boolean {
  try {
    return readFileSync(lockPath, 'utf8').startsWith(`${process.pid} `);
  } catch {
    return false;
  }
}

/** Unlink only our own lock. If another process judged us stale and took over, its lock must survive our release, otherwise a third process could enter while it is still inside its critical section. */
function releaseLock(lockPath: string): void {
  if (!ownsLock(lockPath)) return;
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone: nothing to release */
  }
}

/** Refresh the timestamp in place ('r+', never create): a touch after a steal must not recreate or overwrite the new holder's lock. */
function touchLock(lockPath: string): void {
  if (!ownsLock(lockPath)) return;
  let fd: number;
  try {
    fd = openSync(lockPath, 'r+');
  } catch {
    return; // gone or unreadable: a failed touch only shortens the stale window
  }
  try {
    const line = Buffer.from(`${process.pid} ${Date.now()}\n`, 'utf8');
    writeFully(fd, line);
    ftruncateSync(fd, line.length);
  } catch {
    /* same: the lock itself is still held */
  } finally {
    closeSync(fd);
  }
}
