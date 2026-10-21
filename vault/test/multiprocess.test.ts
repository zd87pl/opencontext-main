import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashToken, newToken } from '../src/crypto/token.js';
import { newId } from '../src/ids.js';
import { Journal } from '../src/store/journal.js';
import { VaultStore } from '../src/store/vault-store.js';
import { canonicalJson } from '../src/util/canonical-json.js';
import { makeMemory, tmpVault } from './helpers/tmp-vault.js';

const ROOT = join(import.meta.dirname, '..');
/** Under `npm test` the pretest build provides dist/ (works on Node 20); otherwise the children load the TS sources (Node ≥ 22.7). */
const USE_DIST = existsSync(join(ROOT, 'dist', 'store', 'vault-store.js'));
const STORE_SRC = USE_DIST ? join(ROOT, 'dist', 'store', 'vault-store.js') : join(ROOT, 'src', 'store', 'vault-store.ts');
const IDS_SRC = USE_DIST ? join(ROOT, 'dist', 'ids.js') : join(ROOT, 'src', 'ids.ts');
const NODE_ARGS = (loader: string): string[] => (USE_DIST ? [] : ['--no-warnings', '--experimental-transform-types', '--import', loader]);

/** Lets a child `node` process import the TypeScript sources directly (resolve ./x.js → ./x.ts, strip/transform types). */
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

/** Shared prelude for every child: opens the vault named by argv and gives it a makeMemory() of its own. */
const PRELUDE = `
  import { existsSync, writeFileSync } from 'node:fs';
  import { VaultStore } from ${JSON.stringify(STORE_SRC)};
  import { newId, nowIso } from ${JSON.stringify(IDS_SRC)};
  const [dir, keyFile] = process.argv.slice(2);
  const passphrase = process.env.OPENCONTEXT_VAULT_PASSPHRASE;
  const store = VaultStore.open({ dir, keyFile, passphrase: passphrase === undefined ? undefined : { passphrase }, onWarn: (m) => process.stderr.write(m + '\\n') });
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const sleep = (ms) => Atomics.wait(sleeper, 0, 0, ms);
  const waitFor = (file, timeoutMs = 20_000) => { const until = Date.now() + timeoutMs; while (!existsSync(file)) { if (Date.now() > until) throw new Error('timeout waiting for ' + file); sleep(10); } };
  const mem = (statement) => { const now = nowIso(); return { id: newId('mem'), kind: 'fact', statement, subject: 'user', tags: [], confidence: 'stated', sources: [], createdAt: now, updatedAt: now, createdBy: 'child', status: 'active' }; };
`;

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe('multi-process', () => {
  let v: ReturnType<typeof tmpVault>;
  let root: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    v = tmpVault();
    root = join(v.dir, '..');
    writeFileSync(join(root, 'loader.mjs'), LOADER);
  });
  afterEach(() => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    children.length = 0;
    v.cleanup();
  });

  function child(name: string, body: string, env: Record<string, string> = {}): { proc: ChildProcess; done: Promise<Finished> } {
    const file = join(root, `${name}.mjs`);
    writeFileSync(file, `${PRELUDE}\n${body}\n`);
    const proc = spawn(process.execPath, [...NODE_ARGS(join(root, 'loader.mjs')), file, v.dir, v.keyFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    children.push(proc);
    const done = new Promise<Finished>((resolve) => {
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      proc.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    return { proc, done };
  }

  async function waitForFile(file: string, timeoutMs = 20_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!existsSync(file)) {
      if (Date.now() > until) throw new Error(`timeout waiting for ${file}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('(1) two VaultStore instances on one dir interleaving put/delete/compact converge', () => {
    const a = v.store;
    const b = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 40; i += 1) {
        const writer = i % 3 === 0 ? a : b;
        ids.push(writer.putMemory(makeMemory({ statement: `Fact ${i}.` })).id);
        if (i % 4 === 3) (i % 2 === 0 ? a : b).deleteMemories([ids[i - 1] ?? '', ids[i - 3] ?? '']);
        if (i % 9 === 8) (i % 2 === 0 ? b : a).compact();
        if (i % 10 === 5) a.refresh();
      }
      const ca = a.refresh();
      const cb = b.refresh();
      expect(ca.reloaded || cb.reloaded).toBe(true);
      expect(canonicalJson(a.listMemories({ status: 'all' }))).toBe(canonicalJson(b.listMemories({ status: 'all' })));
      expect(a.listMemories()).toHaveLength(20);
      expect(a.manifest.gens).toEqual(b.manifest.gens);
      expect(a.verify().ok).toBe(true);
      expect(b.verify().ok).toBe(true);
      const fresh = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
      expect(canonicalJson(fresh.listMemories({ status: 'all' }))).toBe(canonicalJson(a.listMemories({ status: 'all' })));
      fresh.close();
    } finally {
      b.close();
    }
  });

  it('(2) a child process appends 200 memories while the parent appends 200 → 400 after refresh, chains verify', async () => {
    const { done } = child(
      'writer',
      `
      for (let i = 0; i < 200; i += 1) store.putMemory(mem('Child fact ' + i + '.'));
      store.close();
      process.stdout.write('done');
    `,
    );
    const parent = v.store;
    for (let i = 0; i < 200; i += 1) parent.putMemory(makeMemory({ statement: `Parent fact ${i}.`, createdBy: 'parent' }));
    const r = await done;
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe('done');
    parent.refresh();
    const all = parent.listMemories();
    expect(all).toHaveLength(400);
    expect(all.filter((m) => m.createdBy === 'child')).toHaveLength(200);
    expect(all.filter((m) => m.createdBy === 'parent')).toHaveLength(200);
    expect(Journal.verifyChain(join(v.dir, 'memories.jsonl'))).toMatchObject({ ok: true, lines: 400 });
    expect(parent.verify().ok).toBe(true);
    expect(existsSync(join(v.dir, '.lock'))).toBe(false);
    expect(r.stderr).toBe('');
  });

  it('(3) a child holds the store open and tails while the parent compacts and rekeys → child refresh() sees everything', async () => {
    const ready = join(root, 'ready');
    const go = join(root, 'go');
    const { done } = child(
      'tailer',
      `
      const seen = new Set();
      writeFileSync(${JSON.stringify(ready)}, '1');
      let reloads = 0;
      while (!existsSync(${JSON.stringify(go)})) {
        const c = store.refresh();
        if (c.reloaded) reloads += 1;
        for (const m of c.memoriesPut) seen.add(m.id);
        sleep(5);
      }
      const c = store.refresh();
      if (c.reloaded) reloads += 1;
      const memories = store.listMemories();
      const out = { count: memories.length, keyId: store.keyId, gens: store.manifest.gens, reloads,
        verify: store.verify({ bodies: true }).ok, sample: memories.map((m) => m.statement).sort().slice(0, 3),
        canWrite: Boolean(store.putMemory(mem('Written by the child after the rekey.')).id) };
      store.close();
      process.stdout.write(JSON.stringify(out));
    `,
    );
    await waitForFile(ready);
    const parent = v.store;
    for (let i = 0; i < 50; i += 1) parent.putMemory(makeMemory({ statement: `Phase 1 fact ${i}.` }));
    await new Promise((r) => setTimeout(r, 50));
    parent.compact();
    for (let i = 0; i < 50; i += 1) parent.putMemory(makeMemory({ statement: `Phase 2 fact ${i}.` }));
    await new Promise((r) => setTimeout(r, 50));
    const keyIdBefore = parent.keyId;
    parent.rekey({});
    expect(parent.keyId).not.toBe(keyIdBefore);
    for (let i = 0; i < 50; i += 1) parent.putMemory(makeMemory({ statement: `Phase 3 fact ${i}.` }));
    await new Promise((r) => setTimeout(r, 50));
    parent.deleteMemories([parent.listMemories()[0]?.id ?? '']);
    writeFileSync(go, '1');
    const r = await done;
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { count: number; keyId: string; gens: Record<string, string>; reloads: number; verify: boolean; canWrite: boolean };
    expect(out.count).toBe(149);
    expect(out.keyId).toBe(parent.keyId);
    expect(out.gens).toEqual(parent.manifest.gens);
    expect(out.reloads).toBeGreaterThanOrEqual(1); // compact and rekey each force a reload; a loaded machine may fold them into one poll
    expect(out.verify).toBe(true);
    expect(out.canWrite).toBe(true);
    parent.refresh();
    expect(parent.listMemories()).toHaveLength(150);
    expect(parent.verify({ bodies: true }).ok).toBe(true);
  });

  it('(3b) the same with a passphrase-protected key: the child reloads the rekeyed key through its passphrase source', async () => {
    const p = tmpVault({ passphrase: 'multi-pass' });
    const pRoot = join(p.dir, '..');
    writeFileSync(join(pRoot, 'loader.mjs'), LOADER);
    try {
      const ready = join(pRoot, 'ready');
      const go = join(pRoot, 'go');
      const file = join(pRoot, 'tailer.mjs');
      writeFileSync(
        file,
        `${PRELUDE}
        writeFileSync(${JSON.stringify(ready)}, '1');
        waitFor(${JSON.stringify(go)});
        store.refresh();
        process.stdout.write(JSON.stringify({ count: store.listMemories().length, keyId: store.keyId }));
        store.close();
      `,
      );
      const proc = spawn(process.execPath, [...NODE_ARGS(join(pRoot, 'loader.mjs')), file, p.dir, p.keyFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OPENCONTEXT_VAULT_PASSPHRASE: 'multi-pass' },
      });
      children.push(proc);
      const done = new Promise<Finished>((resolve) => {
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d: Buffer) => {
          stdout += d.toString();
        });
        proc.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        proc.on('close', (code) => resolve({ code, stdout, stderr }));
      });
      await waitForFile(ready);
      p.store.putMemory(makeMemory());
      p.store.rekey({ passphrase: 'multi-pass' });
      p.store.putMemory(makeMemory());
      writeFileSync(go, '1');
      const r = await done;
      expect(r.code, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ count: 2, keyId: p.store.keyId });
    } finally {
      p.cleanup();
    }
  });

  it('(4) parent revokes a grant → child getGrantByTokenHash returns undefined after refresh()', async () => {
    const token = newToken();
    const hash = hashToken(token);
    const g = v.store.putGrant({ id: newId('grt'), label: 'cursor', tokenHash: hash, scopes: ['read'], createdAt: new Date().toISOString() });
    const ready = join(root, 'ready');
    const revoked = join(root, 'revoked');
    const { done } = child(
      'client',
      `
      const before = store.getGrantByTokenHash(${JSON.stringify(hash)});
      writeFileSync(${JSON.stringify(ready)}, '1');
      waitFor(${JSON.stringify(revoked)});
      const stale = store.getGrantByTokenHash(${JSON.stringify(hash)}); // without refresh: still cached
      const c = store.refresh();
      const after = store.getGrantByTokenHash(${JSON.stringify(hash)});
      process.stdout.write(JSON.stringify({ before: before?.label ?? null, stale: stale?.label ?? null, grantsChanged: c.grantsChanged || c.reloaded, after: after?.label ?? null, labels: store.listGrants().map((x) => x.label) }));
      store.close();
    `,
    );
    await waitForFile(ready);
    v.store.deleteGrant(g.id);
    writeFileSync(revoked, '1');
    const r = await done;
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ before: 'cursor', stale: 'cursor', grantsChanged: true, after: null, labels: [] });
    expect(readFileSync(join(v.dir, 'grants.jsonl'), 'utf8')).not.toContain(g.id);

    // rotate: the old token stops working, the new one works, in the other process
    const token2 = newToken();
    const g2 = v.store.putGrant({ id: newId('grt'), label: 'cursor', tokenHash: hashToken(token), scopes: ['read'], createdAt: new Date().toISOString() });
    const rotated = join(root, 'rotated');
    const ready2 = join(root, 'ready2');
    const second = child(
      'client2',
      `
      writeFileSync(${JSON.stringify(ready2)}, '1');
      waitFor(${JSON.stringify(rotated)});
      store.refresh();
      process.stdout.write(JSON.stringify({ old: store.getGrantByTokenHash(${JSON.stringify(hash)})?.label ?? null, fresh: store.getGrantByTokenHash(${JSON.stringify(hashToken(token2))})?.label ?? null }));
      store.close();
    `,
    );
    await waitForFile(ready2);
    v.store.putGrant({ ...g2, tokenHash: hashToken(token2) });
    writeFileSync(rotated, '1');
    const r2 = await second.done;
    expect(r2.code, r2.stderr).toBe(0);
    expect(JSON.parse(r2.stdout)).toEqual({ old: null, fresh: 'cursor' });
  });
});
