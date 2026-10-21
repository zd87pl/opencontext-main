import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VaultError } from '../src/errors.js';
import { withLock } from '../src/store/lock.js';

const ROOT = join(import.meta.dirname, '..');
/** Under `npm test` the pretest build provides dist/ (works on Node 20); otherwise the children load the TS sources (Node ≥ 22.7). */
const USE_DIST = existsSync(join(ROOT, 'dist', 'store', 'lock.js'));
const LOCK_SRC = USE_DIST ? join(ROOT, 'dist', 'store', 'lock.js') : join(ROOT, 'src', 'store', 'lock.ts');

/** Lets a child `node` process import the TypeScript sources directly (resolve ./x.js → ./x.ts). */
const LOADER = `
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(\`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    const ts = url.href.replace(/\\\\.js$/, '.ts');
    if (existsSync(fileURLToPath(ts))) return next(ts, context);
  }
  return next(specifier, context);
}
\`));
`;

function runChild(root: string, script: string, args: string[] = []): ReturnType<typeof spawn> {
  const loader = join(root, 'loader.mjs');
  if (!existsSync(loader)) writeFileSync(loader, LOADER);
  const file = join(root, `child-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(file, script);
  const nodeArgs = USE_DIST ? [] : ['--no-warnings', '--experimental-transform-types', '--import', loader];
  return spawn(process.execPath, [...nodeArgs, file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

function wait(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid ?? 999_999;
}

describe('withLock', () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ocv-lock-'));
    dir = join(root, 'vault');
    spawnSync('mkdir', ['-p', dir]);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates "<pid> <ms>" while held, removes it after, returns fn result, is re-entrant in-process', () => {
    const lock = join(dir, '.lock');
    const result = withLock(dir, (touch) => {
      const content = readFileSync(lock, 'utf8');
      expect(content).toMatch(new RegExp(`^${process.pid} \\d+\\n$`));
      const before = content;
      touch();
      expect(readFileSync(lock, 'utf8')).toMatch(new RegExp(`^${process.pid} \\d+\\n$`));
      expect(Number(readFileSync(lock, 'utf8').split(' ')[1])).toBeGreaterThanOrEqual(Number(before.split(' ')[1]));
      // nested call from the same process must not deadlock
      return withLock(dir, () => 42);
    });
    expect(result).toBe(42);
    expect(existsSync(lock)).toBe(false);
  });

  it('releases the lock when fn throws', () => {
    expect(() =>
      withLock(dir, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(join(dir, '.lock'))).toBe(false);
    expect(withLock(dir, () => 'ok')).toBe('ok');
  });

  it('contention across real processes serializes a read-modify-write counter', async () => {
    const counter = join(dir, 'counter.txt');
    writeFileSync(counter, '0');
    const script = `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { withLock } from ${JSON.stringify(LOCK_SRC)};
      const [dir, counter, n] = process.argv.slice(2);
      const sleep = new Int32Array(new SharedArrayBuffer(4));
      for (let i = 0; i < Number(n); i += 1) {
        withLock(dir, () => {
          const v = Number(readFileSync(counter, 'utf8'));
          Atomics.wait(sleep, 0, 0, 2); // widen the race window
          writeFileSync(counter, String(v + 1));
        }, { waitMs: 20_000 });
      }
    `;
    const kids = Array.from({ length: 4 }, () => runChild(root, script, [dir, counter, '25']));
    const results = await Promise.all(kids.map(wait));
    for (const r of results) expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(counter, 'utf8')).toBe('100');
    expect(existsSync(join(dir, '.lock'))).toBe(false);
  });

  it('a stale lock from a dead pid is reclaimed immediately', () => {
    writeFileSync(join(dir, '.lock'), `${deadPid()} ${Date.now()}\n`);
    // waitMs 0: no waiting allowed, so success proves the dead-pid lock was reclaimed, not waited out
    expect(withLock(dir, () => 'got it', { waitMs: 0 })).toBe('got it');
  });

  it('a live lock older than staleMs is reclaimed, but a live lock that keeps touching is NOT stolen', async () => {
    const script = `
      import { writeFileSync } from 'node:fs';
      import { withLock } from ${JSON.stringify(LOCK_SRC)};
      const [dir, marker, mode] = process.argv.slice(2);
      const sleep = new Int32Array(new SharedArrayBuffer(4));
      withLock(dir, (touch) => {
        const until = Date.now() + 1200;
        while (Date.now() < until) {
          Atomics.wait(sleep, 0, 0, 50);
          if (mode === 'touch') touch();
        }
        writeFileSync(marker, 'done');
      });
    `;
    // (a) holder never touches, parent treats > 300 ms as stale → parent steals before the holder finishes.
    const marker1 = join(root, 'marker-silent');
    const silent = runChild(root, script, [dir, marker1, 'silent']);
    await new Promise((r) => setTimeout(r, 500));
    withLock(dir, () => undefined, { staleMs: 300, waitMs: 5_000 });
    expect(existsSync(marker1)).toBe(false); // the holder was still running: its lock was (correctly, by rule) judged stale
    await wait(silent);

    // (b) holder touches every 50 ms → the lock is never older than staleMs → parent waits for the real release.
    const marker2 = join(root, 'marker-touch');
    const touching = runChild(root, script, [dir, marker2, 'touch']);
    await new Promise((r) => setTimeout(r, 500));
    withLock(dir, () => undefined, { staleMs: 300, waitMs: 5_000 });
    expect(existsSync(marker2)).toBe(true); // we only got in after the holder wrote its marker and released
    const r = await wait(touching);
    expect(r.code, r.stderr).toBe(0);
  });

  it('throws LOCKED with a hint after waitMs when a live, fresh lock is held', () => {
    const lock = join(dir, '.lock');
    writeFileSync(lock, `${process.pid} ${Date.now()}\n`); // our own pid is alive; not in the in-process table → foreign
    const t0 = Date.now();
    let err: unknown;
    try {
      withLock(dir, () => 'never', { waitMs: 150 });
    } catch (e) {
      err = e;
    }
    expect(VaultError.is(err, 'LOCKED')).toBe(true);
    expect((err as VaultError).hint).toContain(lock);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(existsSync(lock)).toBe(true); // not ours: untouched
    rmSync(lock);
  });

  it('an unparsable or partially written lock file is stale only by mtime', () => {
    const lock = join(dir, '.lock');
    writeFileSync(lock, '');
    expect(() => withLock(dir, () => 1, { waitMs: 100, staleMs: 60_000 })).toThrow(VaultError);
    expect(withLock(dir, () => 1, { waitMs: 100, staleMs: 0 })).toBe(1);
    // a truncated timestamp without the terminating newline must not be parsed as "ancient"
    writeFileSync(lock, `${process.pid} 1792`);
    expect(() => withLock(dir, () => 1, { waitMs: 100, staleMs: 60_000 })).toThrow(VaultError);
    rmSync(lock);
  });

  it('a lock released between EEXIST and the stale check is retried, never unlinked from under the next holder', async () => {
    // Many processes cycling fast on one lock: the release/acquire race is exercised thousands of times.
    const counter = join(dir, 'counter.txt');
    writeFileSync(counter, '0');
    const script = `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { withLock } from ${JSON.stringify(LOCK_SRC)};
      const [dir, counter, n] = process.argv.slice(2);
      for (let i = 0; i < Number(n); i += 1) {
        withLock(dir, () => { writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1)); }, { waitMs: 30_000 });
      }
    `;
    const kids = Array.from({ length: 6 }, () => runChild(root, script, [dir, counter, '150']));
    const results = await Promise.all(kids.map(wait));
    for (const r of results) expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(counter, 'utf8')).toBe('900');
  });
});

describe('withLock after a stale-lock steal', () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ocv-lock-'));
    dir = join(root, 'vault');
    spawnSync('mkdir', ['-p', dir]);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('the original holder neither removes nor overwrites the new holder\'s lock, so a third process is refused', async () => {
    const script = `
      import { withLock } from ${JSON.stringify(LOCK_SRC)};
      const [dir, mode] = process.argv.slice(2);
      const sleep = new Int32Array(new SharedArrayBuffer(4));
      withLock(dir, (touch) => {
        // silent long enough to be judged stale, then (in touch mode) touching while someone else holds the lock
        Atomics.wait(sleep, 0, 0, 700);
        if (mode === 'touch') for (let i = 0; i < 10; i += 1) { touch(); Atomics.wait(sleep, 0, 0, 50); }
      });
      process.stdout.write('released');
    `;
    const lock = join(dir, '.lock');
    const holder = runChild(root, script, [dir, 'touch']);
    await new Promise((r) => setTimeout(r, 400));
    const thirdScript = join(root, 'third.mjs');
    writeFileSync(thirdScript, `import { withLock } from ${JSON.stringify(LOCK_SRC)}; try { withLock(process.argv[2], () => {}, { waitMs: 0 }); process.stdout.write('ACQUIRED'); } catch (e) { process.stdout.write(e.code ?? 'ERR'); }`);
    const nodeArgs = USE_DIST ? [] : ['--no-warnings', '--experimental-transform-types', '--import', join(root, 'loader.mjs')];
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    // withLock is synchronous, so the critical section below must be too: the holder touches, finishes and "releases" meanwhile.
    const seen = withLock(
      dir,
      () => {
        expect(readFileSync(lock, 'utf8').startsWith(`${process.pid} `)).toBe(true); // stolen: the lock is ours now
        Atomics.wait(sleeper, 0, 0, 1400);
        const afterHolder = existsSync(lock) ? readFileSync(lock, 'utf8') : 'gone';
        // a third process must not get in while we are inside the critical section
        const third = spawnSync(process.execPath, [...nodeArgs, thirdScript, dir], { encoding: 'utf8' });
        return { afterHolder, third: third.stdout };
      },
      { staleMs: 300, waitMs: 5_000 },
    );
    const r = await wait(holder);
    expect(r.stdout).toBe('released');
    expect(seen.afterHolder.startsWith(`${process.pid} `)).toBe(true); // still our lock after the holder's touches and release
    expect(seen.third).toBe('LOCKED');
    expect(existsSync(lock)).toBe(false); // released by its real owner
  });
});
