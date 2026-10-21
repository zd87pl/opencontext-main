import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run.js';
import { TOOL_NAMES } from '../src/mcp/tools.js';
import { VaultStore } from '../src/store/vault-store.js';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const TOKEN_RE = /ocv_[A-Za-z0-9_-]{32}/;

/**
 * A client transport over a child process we spawn ourselves (the SDK's StdioClientTransport hides the exit code),
 * so the test can assert the server exits 0 when the client closes the pipe and can read everything it wrote to stderr.
 */
class ChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly stderr: string[] = [];
  readonly exited: Promise<number | null>;
  private readonly proc: ChildProcess;
  private readonly buffer = new ReadBuffer();

  constructor(args: string[], env: Record<string, string>) {
    this.proc = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      this.stderr.push(chunk.toString('utf8'));
    });
    this.exited = new Promise((resolve) => {
      this.proc.on('close', (code) => {
        this.onclose?.();
        resolve(code);
      });
    });
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  async start(): Promise<void> {
    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.buffer.readMessage();
        } catch (err) {
          this.onerror?.(err as Error);
          break;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc.stdin?.write(serializeMessage(message), (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Bytes straight into the server's stdin, bypassing serialization (malformed frames, raw requests). */
  sendRaw(bytes: string, cb: (err?: Error | null) => void): void {
    this.proc.stdin?.write(bytes, cb);
  }

  /** Stop reading the server's stdout: its next write gets EPIPE, as when a host dies with a request in flight. */
  closeStdout(): void {
    this.proc.stdout?.destroy();
  }

  async close(): Promise<void> {
    this.proc.stdin?.end();
    const timer = setTimeout(() => this.proc.kill('SIGKILL'), 15_000);
    await this.exited;
    clearTimeout(timer);
  }
}

interface Result {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** The child's environment: the parent's (PATH etc.) minus every OPENCONTEXT_* variable, plus what the test sets. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('OPENCONTEXT_')) env[k] = v;
  return { ...env, ...extra };
}

async function vault(o?: { passphrase?: string }): Promise<{ root: string; dir: string; keyFile: string; env: Record<string, string> }> {
  const root = mkdtempSync(join(tmpdir(), 'ocv-stdio-'));
  roots.push(root);
  const dir = join(root, 'vault');
  const keyFile = join(root, 'vault.key');
  const env: Record<string, string> = { OPENCONTEXT_VAULT_DIR: dir, OPENCONTEXT_VAULT_KEY_FILE: keyFile };
  if (o?.passphrase !== undefined) env.OPENCONTEXT_VAULT_PASSPHRASE = o.passphrase;
  const code = await runCli(o?.passphrase !== undefined ? ['init', '--passphrase'] : ['init'], fakeIo(env));
  expect(code).toBe(0);
  return { root, dir, keyFile, env };
}

function fakeIo(env: Record<string, string>): Parameters<typeof runCli>[1] {
  return { stdout: () => undefined, stderr: () => undefined, env: { PATH: process.env.PATH ?? '', ...env }, isTTY: false, cwd: ROOT, execPath: process.execPath, argv0: 'node' };
}

async function grantToken(env: Record<string, string>, scopes: string): Promise<string> {
  let out = '';
  const io = fakeIo(env);
  io.stdout = (s: string): void => {
    out += s;
  };
  expect(await runCli(['grant', 'desktop', '--scopes', scopes, '--json'], io)).toBe(0);
  return (JSON.parse(out) as { token: string }).token;
}

async function connect(env: Record<string, string>): Promise<{ client: Client; transport: ChildTransport; call(name: string, args?: Record<string, unknown>): Promise<Result> }> {
  const transport = new ChildTransport([CLI, 'serve'], childEnv(env));
  const client = new Client({ name: 'stdio-test', version: '0.0.1' });
  await client.connect(transport);
  return {
    client,
    transport,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as unknown as Result,
  };
}

describe.skipIf(!existsSync(CLI))('spawned binary: node dist/cli.js serve', () => {
  it('serves a granted client over stdio, keeps the token off stderr and exits 0 when the client closes', async () => {
    const v = await vault();
    const token = await grantToken(v.env, 'read,write,sources');
    const { client, transport, call } = await connect({ ...v.env, OPENCONTEXT_VAULT_TOKEN: token });
    const pid = transport.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    expect(existsSync(join(v.dir, 'sessions', `${pid}.json`))).toBe(true);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools.tools).toHaveLength(9);
    const status = await call('vault_status');
    expect(status.isError).toBeUndefined();
    expect(status.structuredContent).toMatchObject({ authorized: true, grant: { label: 'desktop', scopes: ['read', 'write', 'sources'] }, client: { name: 'stdio-test', version: '0.0.1' } });
    const remembered = await call('vault_remember', { statement: 'User runs the vault over stdio.', kind: 'fact', confidence: 'stated' });
    expect(remembered.isError, remembered.content[0]?.text).toBeUndefined();
    const memory = remembered.structuredContent?.memory as { id: string; createdBy: string };
    expect(memory.createdBy).toBe('desktop');
    const found = await call('vault_search', { query: 'stdio' });
    expect(found.isError).toBeUndefined();
    expect((found.structuredContent?.memories as Array<{ id: string }>).map((m) => m.id)).toContain(memory.id);
    expect(client.getInstructions()).toContain('private memory vault');

    await client.close();
    expect(await transport.exited).toBe(0);
    expect(transport.stderr.join('')).not.toMatch(TOKEN_RE);
    expect(existsSync(join(v.dir, 'sessions', `${pid}.json`))).toBe(false);
    expect(readdirSync(join(v.dir, 'sessions'))).toEqual([]);

    const store = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
    try {
      const audit = store.readAudit();
      const events = audit.map((e) => `${e.event}:${e.name}:${e.outcome}`);
      expect(events).toContain('session_start:session_start:ok');
      expect(events).toContain('session_end:session_end:ok');
      expect(events).toContain('tool:vault_remember:ok');
      expect(events).toContain('tool:vault_search:ok');
      expect(audit.find((e) => e.event === 'session_start')?.client).toEqual({ name: 'stdio-test', version: '0.0.1' });
      expect(audit.filter((e) => e.event !== 'cli').every((e) => e.pid === pid)).toBe(true);
      expect(JSON.stringify(audit)).not.toContain(token);
      expect(store.verify().ok).toBe(true);
    } finally {
      store.close();
    }
  }, 60_000);

  it('serves with a passphrase-protected key when OPENCONTEXT_VAULT_PASSPHRASE is set', async () => {
    const v = await vault({ passphrase: 'stdio-pass' });
    const token = await grantToken(v.env, 'read');
    const { client, transport, call } = await connect({ ...v.env, OPENCONTEXT_VAULT_TOKEN: token });
    const status = await call('vault_status');
    expect(status.structuredContent).toMatchObject({ authorized: true, grant: { label: 'desktop', scopes: ['read'] } });
    const denied = await call('vault_remember', { statement: 'User is denied.', kind: 'fact', confidence: 'stated' });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain('lacks scope "write"');
    await client.close();
    expect(await transport.exited).toBe(0);
    const stderr = transport.stderr.join('');
    expect(stderr).not.toMatch(TOKEN_RE);
    expect(stderr).not.toContain('stdio-pass');
  }, 60_000);

  it('serves unauthenticated when no token is set: vault_status says so and everything else is denied', async () => {
    const v = await vault();
    const { client, transport, call } = await connect(v.env);
    const status = await call('vault_status');
    expect(status.isError).toBeUndefined();
    expect(status.structuredContent).toMatchObject({ authorized: false });
    expect(status.structuredContent).not.toHaveProperty('counts');
    expect(JSON.stringify(status.structuredContent)).not.toContain(v.dir);
    const search = await call('vault_search', { query: 'anything' });
    expect(search.isError).toBe(true);
    expect(search.content[0]?.text).toContain('DENIED: this client has no access to the vault (no token)');
    await client.close();
    expect(await transport.exited).toBe(0);
  }, 60_000);

  it('exits 2 with KEY_LOCKED on stderr and nothing on stdout when the passphrase is missing', async () => {
    const v = await vault({ passphrase: 'stdio-pass' });
    const env = { ...v.env };
    delete env.OPENCONTEXT_VAULT_PASSPHRASE;
    const transport = new ChildTransport([CLI, 'serve'], childEnv(env));
    let stdout = '';
    transport.onmessage = (m) => {
      stdout += JSON.stringify(m);
    };
    await transport.start();
    expect(await transport.exited).toBe(2);
    expect(stdout).toBe('');
    expect(transport.stderr.join('')).toMatch(/^KEY_LOCKED: /);
  }, 60_000);
});

describe.skipIf(!existsSync(CLI))('spawned binary: transport errors and shutdown paths', () => {
  it('answers a 12 MB frame (TOO_LARGE, not a silent disconnect) and reports a malformed line on stderr', async () => {
    const v = await vault();
    const token = await grantToken(v.env, 'read,write,sources');
    const { client, transport, call } = await connect({ ...v.env, OPENCONTEXT_VAULT_TOKEN: token });
    const turns = Array.from({ length: 6 }, () => ({ role: 'user', text: 'x'.repeat(2_000_000) }));
    const big = await call('vault_source_add', { title: 'huge', turns });
    expect(big.isError).toBe(true);
    expect(big.content[0]?.text).toContain('TOO_LARGE');
    await new Promise<void>((resolve, reject) => transport.sendRaw('this is not json\n', (err) => (err ? reject(err) : resolve())));
    const status = await call('vault_status');
    expect(status.isError).toBeUndefined();
    await client.close();
    expect(await transport.exited).toBe(0);
    const stderr = transport.stderr.join('');
    expect(stderr).toContain('mcp transport error');
    expect(stderr).not.toContain('this is not json'); // never the frame itself
  }, 60_000);

  it('SIGHUP ends the session cleanly: session_end logged, session file removed, exit 0', async () => {
    const v = await vault();
    const { client, transport } = await connect(v.env);
    const pid = transport.pid ?? 0;
    expect(existsSync(join(v.dir, 'sessions', `${pid}.json`))).toBe(true);
    process.kill(pid, 'SIGHUP');
    expect(await transport.exited).toBe(0);
    expect(existsSync(join(v.dir, 'sessions', `${pid}.json`))).toBe(false);
    const store = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
    try {
      const events = store.readAudit().filter((e) => e.pid === pid).map((e) => e.event);
      expect(events).toEqual(['session_start', 'session_end']);
    } finally {
      store.close();
    }
    await client.close().catch(() => undefined);
  }, 60_000);

  it('a host that closed our stdout but not stdin: the next write ends the session cleanly instead of exit(0) without session_end', async () => {
    const v = await vault();
    const { transport } = await connect(v.env);
    const pid = transport.pid ?? 0;
    transport.closeStdout();
    await new Promise<void>((resolve, reject) => transport.sendRaw(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' })}\n`, (err) => (err ? reject(err) : resolve())));
    expect(await transport.exited).toBe(0);
    expect(existsSync(join(v.dir, 'sessions', `${pid}.json`))).toBe(false);
    const store = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
    try {
      const events = store.readAudit().filter((e) => e.pid === pid).map((e) => e.event);
      expect(events[0]).toBe('session_start');
      expect(events[events.length - 1]).toBe('session_end');
    } finally {
      store.close();
    }
  }, 60_000);
});
