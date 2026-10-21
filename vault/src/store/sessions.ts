import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Contents of sessions/<pid>.json; plaintext on purpose (no secrets) so `status` can read it without the key. */
export interface SessionInfo {
  pid: number;
  session: string;
  startedAt: string;
  label: string | null;
}

function sessionsDir(vaultDir: string): string {
  return join(vaultDir, 'sessions');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** sessions/<pid>.json = { pid, session, startedAt, label | null }. Written by `serve` at start, removed at exit, so `status` can show which clients are connected. Stale when the pid is dead. Returns unregister. */
export function registerSession(vaultDir: string, info: { session: string; label: string | null }): () => void {
  const dir = sessionsDir(vaultDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${process.pid}.json`);
  const record: SessionInfo = { pid: process.pid, session: info.session, startedAt: new Date().toISOString(), label: info.label };
  writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return () => {
    try {
      unlinkSync(path);
    } catch {
      /* already removed */
    }
  };
}

/** Live server processes. Files whose pid is dead are removed on the way (best effort) so crashed servers do not accumulate. */
export function liveSessions(vaultDir: string): SessionInfo[] {
  const dir = sessionsDir(vaultDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    let info: SessionInfo | undefined;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SessionInfo>;
      if (typeof raw.pid === 'number' && typeof raw.session === 'string' && typeof raw.startedAt === 'string') {
        info = { pid: raw.pid, session: raw.session, startedAt: raw.startedAt, label: typeof raw.label === 'string' ? raw.label : null };
      }
    } catch {
      info = undefined;
    }
    if (info && pidAlive(info.pid)) {
      out.push(info);
      continue;
    }
    try {
      unlinkSync(path);
    } catch {
      /* best effort cleanup */
    }
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.pid - b.pid);
}
