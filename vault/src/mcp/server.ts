import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAuditSink } from '../access/audit.js';
import { resolveCaller } from '../access/policy.js';
import type { PassphraseSource } from '../crypto/keyfile.js';
import { VaultSearch } from '../search/vault-search.js';
import { registerSession } from '../store/sessions.js';
import { VaultStore } from '../store/vault-store.js';
import { LIMITS, type ClientInfo } from '../types.js';
import { truncateText } from '../util/text.js';
import { SERVER_INSTRUCTIONS, registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools, type ToolDeps } from './tools.js';

/** The transport type as McpServer.connect declares it, derived so src/mcp imports nothing from the SDK beyond server/mcp.js and server/stdio.js. */
export type Transport = Parameters<McpServer['connect']>[0];

/** What createVaultServer needs; `now` and `onWarn` are injectable so tests get deterministic time and capture diagnostics. */
export interface ServerDeps {
  store: VaultStore;
  search: VaultSearch;
  token: string | undefined;
  version: string;
  now?: () => Date;
  onWarn?: (m: string) => void;
}

/** A configured server plus its lifecycle; `closed` resolves once the transport has closed (after session_end is logged). */
export interface VaultServer {
  server: McpServer;
  connect(t: Transport): Promise<void>;
  close(): Promise<void>;
  closed: Promise<void>;
}

/** Read buffer for one JSON-RPC frame: above the largest vault_source_add the schema admits (2,000,000 chars, up to 6 bytes each once JSON-escaped), so a legitimately sized call is never dropped by the transport. */
export const STDIO_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Narrow the SDK's Implementation to the strict ClientInfo stored in audit entries (hosts may send extra fields such as icons), clipped so an unauthenticated client cannot grow the never-compacted audit journal by megabytes per call. */
export function clientInfoOf(impl: { name: string; version: string; title?: string | undefined } | undefined): ClientInfo | null {
  if (impl === undefined) return null;
  const clip = (s: string): string => truncateText(s, LIMITS.clientField);
  return { name: clip(impl.name), version: clip(impl.version), ...(impl.title !== undefined ? { title: clip(impl.title) } : {}) };
}

/**
 * Registers 9 tools, 2 resources, 2 prompts; audits session_start (with clientInfo) in oninitialized and
 * session_end on transport close; kicks off search.buildSourceIndex() after connect. Session events are
 * best-effort (a failure is reported through onWarn): refusing to start would not help the user, and every
 * actual call is still gated by guarded(), which does refuse to serve what it cannot log.
 */
export function createVaultServer(deps: ServerDeps): VaultServer {
  const now = deps.now ?? (() => new Date());
  const warn = deps.onWarn ?? ((m: string) => void process.stderr.write(`${m}\n`));
  const server = new McpServer({ name: 'opencontext-vault', version: deps.version }, { instructions: SERVER_INSTRUCTIONS });
  const client = (): ClientInfo | null => clientInfoOf(server.server.getClientVersion());
  const baseAudit = createAuditSink(deps.store, { pid: process.pid, now, client });
  let started = false;
  const sessionEvent = (event: 'session_start' | 'session_end', at?: string): void => {
    if (event === 'session_start') {
      if (started) return;
      started = true;
    }
    const t0 = Date.now();
    try {
      deps.search.applyChanges(deps.store.refresh());
      const caller = resolveCaller(deps.store, deps.token);
      baseAudit.record({
        ...(at !== undefined ? { at } : {}),
        grant: caller.kind === 'granted' ? { id: caller.grant.id, label: caller.grant.label } : null,
        event,
        name: event,
        args: { client: client() },
        outcome: 'ok',
        ms: Math.max(0, Date.now() - t0),
      });
    } catch (err) {
      warn(`audit ${event} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // A client that calls tools without ever sending notifications/initialized still gets a session_start, written just
  // before its first logged call, so `clients --pending` sees every client that knocked.
  const audit: typeof baseAudit = {
    record(e): void {
      if (!started) sessionEvent('session_start', e.at);
      baseAudit.record(e);
    },
  };
  const toolDeps: ToolDeps = { store: deps.store, search: deps.search, audit, token: deps.token, now, version: deps.version, client };
  registerTools(server, toolDeps);
  registerResources(server, toolDeps);
  registerPrompts(server, toolDeps);

  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let ended = false;
  server.server.oninitialized = () => sessionEvent('session_start');
  // Transport failures (a frame over the read buffer, a malformed line) were silently dropped before: the host only
  // saw "server disconnected". Only the error's name and a clipped message go to stderr, with every quoted fragment
  // removed, because the SDK and JSON.parse embed the offending frame in their messages and hosts keep our stderr in
  // log files.
  server.server.onerror = (err: Error) => {
    const first = (err.message.split('\n')[0] ?? '').replace(/"[^"]*"/g, '"…"').replace(/'[^']*'/g, "'…'");
    warn(`mcp transport error: ${err.name}: ${truncateText(first, 200)}`);
  };
  server.server.onclose = () => {
    if (ended) return;
    ended = true;
    if (started) sessionEvent('session_end');
    resolveClosed();
  };

  return {
    server,
    closed,
    async connect(t: Transport): Promise<void> {
      await server.connect(t);
      void deps.search.buildSourceIndex().catch((err: unknown) => {
        warn(`source index build failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    async close(): Promise<void> {
      await server.close();
    },
  };
}

/** stdout is the protocol: anything a dependency prints with console.log/info/debug must go to stderr instead. */
function rebindConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    console.error(...args);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

/**
 * Used by `serve`: opens the store, builds the memory index, registers the session file, rebinds console.log/info/debug
 * to stderr, connects StdioServerTransport, resolves when the transport closes (the client closed the pipe). The source
 * index is built in the background after connect so a large vault does not delay the handshake.
 */
export async function runStdioServer(o: { dir: string; keyFile: string; token: string | undefined; passphrase: PassphraseSource; version: string; onStdoutGone?: (stop: () => void) => () => void }): Promise<void> {
  rebindConsoleToStderr();
  const warn = (m: string): void => void process.stderr.write(`${m}\n`);
  const store = VaultStore.open({ dir: o.dir, keyFile: o.keyFile, passphrase: o.passphrase, onWarn: warn });
  let unregister: () => void = () => undefined;
  try {
    const search = new VaultSearch(store);
    const caller = resolveCaller(store, o.token);
    unregister = registerSession(o.dir, { session: store.session, label: caller.kind === 'granted' ? caller.grant.label : null });
    const vault = createVaultServer({ store, search, token: o.token, version: o.version, onWarn: warn });
    const stop = (): void => void vault.close().catch(() => undefined);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop); // a closing terminal, or a host that hangs its children up on quit
    // The SDK's StdioServerTransport only listens for stdin 'data'/'error', never 'end', so without this the client
    // closing the pipe would leave the server waiting forever (exit code 13, no session_end, a stale session file).
    process.stdin.once('end', stop);
    // A host that closed our stdout but not stdin (crash, pipe teardown order) surfaces as EPIPE on the next write;
    // the CLI's default EPIPE handling is process.exit(0), which would skip session_end and the session-file cleanup.
    const releaseStdout = o.onStdoutGone?.(stop) ?? ((): void => undefined);
    try {
      await vault.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: STDIO_MAX_FRAME_BYTES }));
      await vault.closed;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      process.off('SIGHUP', stop);
      process.stdin.off('end', stop);
      releaseStdout();
    }
  } finally {
    unregister();
    store.close();
  }
}
