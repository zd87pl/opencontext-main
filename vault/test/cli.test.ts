import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliIo } from '../src/cli/io.js';
import { COMMANDS, renderHelp, runCli } from '../src/cli/run.js';
import { renderAllSnippets, renderSnippet } from '../src/cli/snippets.js';
import { looksLikeToken } from '../src/crypto/token.js';
import { createVaultServer } from '../src/mcp/server.js';
import { VaultSearch } from '../src/search/vault-search.js';
import { VaultStore } from '../src/store/vault-store.js';
import type { AuditEntry, Memory, PortableExportV1, SourceMeta } from '../src/types.js';

const ROOT = join(import.meta.dirname, '..');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'chatgpt');
const PASSPHRASE_CMD_FIXTURE = join(ROOT, 'test', 'fixtures', 'core', 'passphrase-cmd.mjs');
const TOKEN_RE = /ocv_[A-Za-z0-9_-]{32}/g;
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

interface IoOptions {
  isTTY?: boolean;
  prompt?: (q: string, masked: boolean) => string;
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A fresh scratch directory with the env a CLI run needs to find its vault and key; nothing touches ~/.opencontext. */
function scratch(): { root: string; env: Record<string, string>; dir: string; keyFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'ocv-cli-'));
  roots.push(root);
  const dir = join(root, 'vault');
  const keyFile = join(root, 'vault.key');
  return { root, env: { OPENCONTEXT_VAULT_DIR: dir, OPENCONTEXT_VAULT_KEY_FILE: keyFile }, dir, keyFile };
}

/** In-process CliIo that captures everything; PATH is kept so a passphrase command can run. */
function makeIo(env: Record<string, string>, o: IoOptions = {}): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (s) => {
      out.push(s);
    },
    stderr: (s) => {
      err.push(s);
    },
    env: { PATH: process.env.PATH ?? '', ...env },
    isTTY: o.isTTY ?? false,
    ...(o.prompt !== undefined ? { prompt: o.prompt } : {}),
    cwd: ROOT,
    execPath: process.execPath,
    argv0: 'node',
  };
  return { io, out, err };
}

async function cli(args: string[], env: Record<string, string>, o: IoOptions = {}): Promise<Run> {
  const { io, out, err } = makeIo(env, o);
  const code = await runCli(args, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

/** The JSON object a snippet carries, with its leading `#` comment lines removed. */
function snippetJson(snippet: string): Record<string, unknown> {
  const body = snippet
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n');
  return JSON.parse(body) as Record<string, unknown>;
}

function tokensIn(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

describe('cli: end to end on a temp vault', () => {
  it('init → grant → import → memories → export/import round trip → verify → audit → revoke → pending clients', async () => {
    const v = scratch();

    // init: paths printed, permissions set, idempotency refused.
    const init = await cli(['init'], v.env);
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toContain(v.dir);
    expect(init.stdout).toContain(v.keyFile);
    expect(statSync(v.keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(v.dir).mode & 0o777).toBe(0o700);
    const again = await cli(['init'], v.env);
    expect(again.code).toBe(2);
    expect(again.stderr).toMatch(/^EXISTS: /);

    // grant --client: the token appears exactly once, inside a valid JSON snippet with absolute paths.
    const grant = await cli(['grant', 'claude-desktop', '--scopes', 'read,write,sources', '--client', 'claude-desktop'], v.env);
    expect(grant.code, grant.stderr).toBe(0);
    expect(grant.stdout).toContain('granted: read, write, sources');
    const tokens = tokensIn(grant.stdout + grant.stderr);
    expect(tokens).toHaveLength(1);
    const token = tokens[0] ?? '';
    expect(looksLikeToken(token)).toBe(true);
    const snippetStart = grant.stdout.indexOf('# Claude Desktop');
    expect(snippetStart).toBeGreaterThan(0);
    const snippet = snippetJson(grant.stdout.slice(snippetStart));
    const servers = snippet.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    const entry = servers['opencontext-vault'];
    expect(entry?.command).toBe(process.execPath);
    expect(entry?.args[0]).toBe(join(ROOT, 'dist', 'cli.js'));
    expect(isAbsolute(entry?.args[0] ?? '')).toBe(true);
    expect(entry?.args[1]).toBe('serve');
    expect(entry?.env.OPENCONTEXT_VAULT_TOKEN).toBe(token);

    // a second grant with the same label needs --rotate; rotation prints a new token once.
    const dup = await cli(['grant', 'claude-desktop'], v.env);
    expect(dup.code).toBe(2);
    expect(dup.stderr).toContain('EXISTS');
    expect(dup.stderr).toContain('--rotate');
    const rotated = await cli(['grant', 'claude-desktop', '--rotate'], v.env);
    expect(rotated.code, rotated.stderr).toBe(0);
    const rotatedTokens = tokensIn(rotated.stdout + rotated.stderr);
    expect(rotatedTokens).toHaveLength(1);
    expect(rotatedTokens[0]).not.toBe(token);
    expect(rotated.stdout).toContain('granted: read, write, sources'); // scopes kept
    const jsonGrant = await cli(['grant', 'cursor', '--scopes', 'read', '--tags', 'coding', '--json'], v.env);
    expect(jsonGrant.code).toBe(0);
    const parsedGrant = JSON.parse(jsonGrant.stdout) as { label: string; scopes: string[]; tags: string[]; token: string };
    expect(parsedGrant).toMatchObject({ label: 'cursor', scopes: ['read'], tags: ['coding'] });
    expect(tokensIn(jsonGrant.stdout + jsonGrant.stderr)).toEqual([parsedGrant.token]);
    const badScope = await cli(['grant', 'x', '--scopes', 'admin'], v.env);
    expect(badScope.code).toBe(2);
    expect(badScope.stderr).toContain('INVALID_ARGUMENT');
    const badLabel = await cli(['grant', 'Not A Label'], v.env);
    expect(badLabel.code).toBe(2);

    // clients
    const clients = await cli(['clients'], v.env);
    expect(clients.code).toBe(0);
    expect(clients.stdout).toContain('claude-desktop');
    expect(clients.stdout).toContain('read,write,sources');
    expect(clients.stdout).toContain('never');
    const clientsJson = JSON.parse((await cli(['clients', '--json'], v.env)).stdout) as Array<{ label: string }>;
    expect(clientsJson.map((c) => c.label).sort()).toEqual(['claude-desktop', 'cursor']);

    // import the ChatGPT fixture: counts as the importer reports them.
    const imp = await cli(['import', FIXTURE], v.env);
    expect(imp.code, imp.stderr).toBe(0);
    expect(imp.stdout).toContain('added 4 sources · 0 updated · 0 skipped');
    expect(imp.stdout).toContain('ignored: chat.html: not supported');
    const reimport = JSON.parse((await cli(['import', FIXTURE, '--json'], v.env)).stdout) as { added: number; skipped: number; files: Array<{ format: string }> };
    expect(reimport).toMatchObject({ added: 0, skipped: 4 });
    expect(reimport.files).toEqual([{ path: join(FIXTURE, 'conversations.json'), format: 'chatgpt' }]);
    const missing = await cli(['import', join(v.root, 'nope')], v.env);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('NOT_FOUND');

    // sources table
    const sources = await cli(['sources'], v.env);
    expect(sources.code).toBe(0);
    expect(sources.stdout).toContain('Trip to Porto');
    expect(sources.stdout.match(/imported/g)).toHaveLength(4);
    const sourceList = JSON.parse((await cli(['sources', '--json'], v.env)).stdout) as { total: number; sources: SourceMeta[] };
    expect(sourceList.total).toBe(4);
    const goSource = sourceList.sources.find((s) => s.title === 'Go formatting');
    expect(goSource).toBeDefined();

    // list is empty, remember twice, list shows both, dedup is exact.
    expect((await cli(['list'], v.env)).stdout).toContain('no memories');
    const rem1 = await cli(['remember', '--kind', 'preference', '--statement', 'User prefers tabs over spaces in Go.', '--tag', 'coding', '--tag', 'go'], v.env);
    expect(rem1.code, rem1.stderr).toBe(0);
    const mem1 = rem1.stdout.match(/mem_[0-9a-f]{16}/)?.[0] ?? '';
    expect(mem1).not.toBe('');
    const rem2 = JSON.parse((await cli(['remember', '--kind', 'fact', '--statement', 'User lives in Lisbon.', '--json'], v.env)).stdout) as { memory: Memory; deduplicated: boolean };
    expect(rem2.deduplicated).toBe(false);
    expect(rem2.memory.createdBy).toBe('cli');
    const dupMem = JSON.parse((await cli(['remember', '--kind', 'fact', '--statement', 'user lives in lisbon', '--json'], v.env)).stdout) as { memory: Memory; deduplicated: boolean };
    expect(dupMem.deduplicated).toBe(true);
    expect(dupMem.memory.id).toBe(rem2.memory.id);
    const secret = await cli(['remember', '--kind', 'fact', '--statement', `User token is ${token}`], v.env);
    expect(secret.code).toBe(2);
    expect(secret.stderr).toContain('SECRET_DETECTED');
    expect(secret.stderr).not.toContain(token);
    const noKind = await cli(['remember', '--statement', 'x'], v.env);
    expect(noKind.code).toBe(2);
    const listed = await cli(['list'], v.env);
    expect(listed.stdout).toContain(mem1);
    expect(listed.stdout).toContain(rem2.memory.id);
    expect((JSON.parse((await cli(['list', '--json', '--kind', 'preference'], v.env)).stdout) as { total: number }).total).toBe(1);
    expect((JSON.parse((await cli(['list', '--json', '--since', '24h'], v.env)).stdout) as { total: number }).total).toBe(2);
    expect((JSON.parse((await cli(['list', '--json', '--created-by', 'nobody'], v.env)).stdout) as { total: number }).total).toBe(0);

    // show
    const showMem = await cli(['show', mem1], v.env);
    expect(showMem.code).toBe(0);
    expect(showMem.stdout).toContain('User prefers tabs over spaces in Go.');
    expect(showMem.stdout).toContain('coding, go');
    const showSrc = await cli(['show', goSource?.id ?? ''], v.env);
    expect(showSrc.code).toBe(0);
    expect(showSrc.stdout).toContain('Go formatting');
    expect(showSrc.stdout).toContain('how should I format Go?');
    expect((await cli(['show', 'mem_0000000000000000'], v.env)).code).toBe(2);
    expect((await cli(['show', 'bogus'], v.env)).code).toBe(2);

    // search memories and sources
    const found = await cli(['search', 'tabs'], v.env);
    expect(found.code).toBe(0);
    expect(found.stdout).toContain(mem1);
    expect((await cli(['search', 'zzzqqq'], v.env)).stdout).toContain('no memories match');
    const foundSrc = await cli(['search', '--sources', 'porto'], v.env);
    expect(foundSrc.code).toBe(0);
    expect(foundSrc.stdout).toContain('Trip to Porto');
    expect(foundSrc.stdout).toContain('«Porto»');
    expect((await cli(['search'], v.env)).code).toBe(2);

    // forget: refuses without a terminal and --yes; honours --yes.
    const noYes = await cli(['forget', mem1], v.env);
    expect(noYes.code).toBe(2);
    expect(noYes.stderr).toContain('--yes');
    expect((await cli(['show', mem1], v.env)).code).toBe(0);
    const forgot = await cli(['forget', mem1, '--yes'], v.env);
    expect(forgot.code, forgot.stderr).toBe(0);
    expect(forgot.stdout).toContain('forgotten: 1 memory, 0 sources');
    expect((await cli(['show', mem1], v.env)).code).toBe(2);
    const forgotMissing = JSON.parse((await cli(['forget', 'mem_0000000000000000', '--yes', '--json'], v.env)).stdout) as { forgotten: string[]; notFound: string[] };
    expect(forgotMissing).toEqual({ forgotten: [], notFound: ['mem_0000000000000000'] });

    // export --out: 0600, refuses to overwrite, warns that it is plaintext.
    const outFile = join(v.root, 'export.json');
    const exp = await cli(['export', '--out', outFile], v.env);
    expect(exp.code, exp.stderr).toBe(0);
    expect(exp.stderr).toContain('export is plaintext');
    expect(statSync(outFile).mode & 0o777).toBe(0o600);
    const exported = JSON.parse(readFileSync(outFile, 'utf8')) as PortableExportV1;
    expect(exported.format).toBe('opencontext-vault-export');
    expect(exported.generator).toBe(`@opencontext/vault ${VERSION}`);
    expect(exported.memories).toHaveLength(1);
    expect(exported.sources).toHaveLength(4);
    expect(readFileSync(outFile, 'utf8')).not.toContain('ocv_');
    const refuse = await cli(['export', '--out', outFile], v.env);
    expect(refuse.code).toBe(2);
    expect(refuse.stderr).toContain('EXISTS');
    expect(refuse.stderr).toContain('--force');
    expect((await cli(['export', '--out', outFile, '--force'], v.env)).code).toBe(0);
    const toStdout = await cli(['export'], v.env);
    expect(toStdout.code).toBe(0);
    expect((JSON.parse(toStdout.stdout) as PortableExportV1).sources).toHaveLength(4);
    const md = await cli(['export', '--format', 'md', '--out', join(v.root, 'export.md')], v.env);
    expect(md.code).toBe(0);
    expect(readFileSync(join(v.root, 'export.md'), 'utf8')).toContain('# Memory export');

    // import the export into a second vault, export again: memories and sources are identical.
    const w = scratch();
    expect((await cli(['init'], w.env)).code).toBe(0);
    const imp2 = await cli(['import', outFile, '--json'], w.env);
    expect(imp2.code, imp2.stderr).toBe(0);
    expect(JSON.parse(imp2.stdout)).toMatchObject({ added: 4, memoriesAdded: 1, files: [{ format: 'vault' }] });
    const out2 = join(w.root, 'export2.json');
    expect((await cli(['export', '--out', out2], w.env)).code).toBe(0);
    const exported2 = JSON.parse(readFileSync(out2, 'utf8')) as PortableExportV1;
    expect(exported2.memories).toEqual(exported.memories);
    expect(exported2.sources).toEqual(exported.sources);
    expect(exported2.vaultId).not.toBe(exported.vaultId);

    // verify, status, compact, rekey
    const verify = await cli(['verify', '--provenance'], v.env);
    expect(verify.code, verify.stderr).toBe(0);
    expect(verify.stdout).toContain('verify: ok');
    expect(verify.stdout).toContain('4 checked, 0 bad');
    const status = await cli(['status'], v.env);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(v.dir);
    expect(status.stdout).toContain('kdf none');
    expect(status.stdout).toContain('claude-desktop: read,write,sources');
    expect((await cli(['compact'], v.env)).code).toBe(0);
    const rekey = await cli(['rekey'], v.env);
    expect(rekey.code, rekey.stderr).toBe(0);
    expect(rekey.stdout).toContain('rekeyed');
    expect((await cli(['verify'], v.env)).code).toBe(0);
    expect((await cli(['show', rem2.memory.id], v.env)).code).toBe(0);

    // audit --json lists the cli entries, one JSON object per line, none carrying a token.
    const audit = await cli(['audit', '--json', '--limit', '0'], v.env);
    expect(audit.code).toBe(0);
    const entries = audit.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as AuditEntry);
    expect(entries.every((e) => e.event === 'cli' && e.grant === null)).toBe(true);
    const names = entries.map((e) => e.name);
    for (const n of ['grant', 'import', 'remember', 'forget', 'export', 'compact', 'rekey']) expect(names, `logged ${n}`).toContain(n);
    expect(audit.stdout).not.toContain('ocv_');
    const human = await cli(['audit', '--event', 'cli', '--limit', '3'], v.env);
    expect(human.stdout.trim().split('\n')).toHaveLength(4); // header + 3
    expect(human.stdout).toContain('TIME');
    expect((await cli(['audit', '--denied'], v.env)).stdout.trim().split('\n')).toHaveLength(1);

    // config reprints snippets with a placeholder; revoke makes the grant disappear.
    const cfg = await cli(['config', 'cursor', '--client', 'vscode'], v.env);
    expect(cfg.code).toBe(0);
    expect(cfg.stdout).toContain('<TOKEN>');
    const cfgJson = snippetJson(cfg.stdout.split('\n(replace')[0] ?? '');
    expect((cfgJson.servers as Record<string, { type: string }>)['opencontext-vault']?.type).toBe('stdio');
    expect((await cli(['config', 'cursor', '--client', 'bogus'], v.env)).code).toBe(2);
    expect((await cli(['config', 'nobody'], v.env)).code).toBe(2);
    const cfgAll = await cli(['config', 'cursor'], v.env);
    expect(cfgAll.stdout).toContain('claude mcp add opencontext-vault');
    const revoke = await cli(['revoke', 'claude-desktop'], v.env);
    expect(revoke.code).toBe(0);
    expect(revoke.stdout).toContain('revoked: claude-desktop');
    expect((await cli(['clients'], v.env)).stdout).not.toContain('claude-desktop');
    expect((await cli(['revoke', 'claude-desktop'], v.env)).code).toBe(2);

    // an unauthenticated MCP session (no token) shows up in clients --pending with its self-asserted name.
    const store = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
    try {
      const server = createVaultServer({ store, search: new VaultSearch(store), token: undefined, version: VERSION, onWarn: () => undefined });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '1.2.3' });
      await server.connect(st);
      await client.connect(ct);
      await client.callTool({ name: 'vault_status', arguments: {} });
      await client.close();
      await server.closed;
    } finally {
      store.close();
    }
    const pending = await cli(['clients', '--pending'], v.env);
    expect(pending.code, pending.stderr).toBe(0);
    expect(pending.stdout).toContain('test-client 1.2.3');
    expect(pending.stdout).toContain('opencontext-vault grant test-client --scopes read,write');
    const pendingJson = JSON.parse((await cli(['clients', '--pending', '--json'], v.env)).stdout) as Array<{ client: { name: string }; sessions: number; suggestedLabel: string }>;
    expect(pendingJson).toHaveLength(1);
    expect(pendingJson[0]).toMatchObject({ client: { name: 'test-client' }, sessions: 1, suggestedLabel: 'test-client' });
    const denied = await cli(['audit', '--denied', '--json'], v.env);
    expect(denied.stdout.trim()).toBe(''); // vault_status needs no scope
    expect((await cli(['audit', '--event', 'session_start', '--json'], v.env)).stdout).toContain('"test-client"');
  }, 60_000);

  it('forget asks on a terminal, deletes by author and by source', async () => {
    const v = scratch();
    expect((await cli(['init'], v.env)).code).toBe(0);
    expect((await cli(['import', join(FIXTURE, 'conversations.json')], v.env)).code).toBe(0);
    const [src] = (JSON.parse((await cli(['sources', '--json'], v.env)).stdout) as { sources: SourceMeta[] }).sources;
    const a = JSON.parse((await cli(['remember', '--kind', 'fact', '--statement', 'User has a dog.', '--json'], v.env)).stdout) as { memory: Memory };
    // A memory citing the source, written through the store as an agent would.
    const store = VaultStore.open({ dir: v.dir, keyFile: v.keyFile });
    const cited = store.putMemory({ ...a.memory, id: 'mem_00000000000000aa', statement: 'User went to Porto.', createdBy: 'agent-x', sources: [{ sourceId: src?.id ?? '', turn: 0, verified: false }] });
    store.putMemory({ ...cited, id: 'mem_00000000000000ab', statement: 'User likes wine.', sources: [] });
    store.close();

    // 'n' on the prompt aborts; 'y' deletes.
    const abort = await cli(['forget', a.memory.id], v.env, { isTTY: true, prompt: () => 'n' });
    expect(abort.code).toBe(0);
    expect(abort.stdout).toContain('aborted');
    expect((await cli(['show', a.memory.id], v.env)).code).toBe(0);
    const yes = await cli(['forget', a.memory.id], v.env, { isTTY: true, prompt: () => 'y' });
    expect(yes.code).toBe(0);
    expect((await cli(['show', a.memory.id], v.env)).code).toBe(2);

    // --source removes the citing memory and the source; --created-by removes the rest of agent-x's writes.
    const bySource = JSON.parse((await cli(['forget', '--source', src?.id ?? '', '--yes', '--json'], v.env)).stdout) as { forgotten: string[] };
    expect(bySource.forgotten.sort()).toEqual(['mem_00000000000000aa', src?.id ?? ''].sort());
    expect((await cli(['show', src?.id ?? ''], v.env)).code).toBe(2);
    const byAuthor = JSON.parse((await cli(['forget', '--created-by', 'agent-x', '--yes', '--json'], v.env)).stdout) as { forgotten: string[] };
    expect(byAuthor.forgotten).toEqual(['mem_00000000000000ab']);
    expect((await cli(['forget', '--yes'], v.env)).code).toBe(2);
    expect((await cli(['forget', 'what', '--yes'], v.env)).code).toBe(2);
    expect((await cli(['verify'], v.env)).code).toBe(0);
  });
});

describe('cli: exit codes, help and version', () => {
  it('returns 1 for usage mistakes with a usage line', async () => {
    const v = scratch();
    const unknown = await cli(['bogus'], v.env);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('unknown command "bogus"');
    const badFlag = await cli(['list', '--bogus'], v.env);
    expect(badFlag.code).toBe(1);
    expect(badFlag.stderr).toContain("Unknown option '--bogus'");
    expect(badFlag.stderr).toContain('usage: opencontext-vault list');
    const badInt = await cli(['list', '--limit', 'ten'], v.env);
    expect(badInt.code).toBe(1);
    const badChoice = await cli(['list', '--kind', 'wish'], v.env);
    expect(badChoice.code).toBe(1);
    expect(badChoice.stderr).toContain('--kind must be one of');
    const none = await cli([], v.env);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('Usage: opencontext-vault <command>');
    expect((await cli(['help', 'bogus'], v.env)).code).toBe(1);
  });

  it('returns 2 for vault errors, printed as CODE: message and a hint', async () => {
    const v = scratch();
    const status = await cli(['status'], v.env);
    expect(status.code).toBe(2);
    expect(status.stderr).toMatch(/^VAULT_NOT_FOUND: /);
    expect(status.stderr).toContain('  run: opencontext-vault init');
    expect((await cli(['list'], v.env)).code).toBe(2);
    // The same with explicit flags instead of env.
    const flagged = await cli(['--vault-dir', v.dir, '--key-file', v.keyFile, 'status'], {});
    expect(flagged.code).toBe(2);
    expect(flagged.stderr).toContain(v.dir);
  });

  it('returns 3 for unexpected errors', async () => {
    const v = scratch();
    const boom = await cli(['init', '--passphrase'], v.env, {
      isTTY: true,
      prompt: () => {
        throw new Error('boom');
      },
    });
    expect(boom.code).toBe(3);
    expect(boom.stderr).toContain('error: boom');
    expect(existsSync(v.keyFile)).toBe(false);
  });

  it('prints the version and the generated help', async () => {
    const v = scratch();
    const version = await cli(['--version'], v.env);
    expect(version).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' });
    expect(VERSION).toBe('0.1.0');
    const help = await cli(['--help'], v.env);
    expect(help.code).toBe(0);
    expect(help.stdout).toBe(renderHelp());
    const helpCmd = await cli(['help'], v.env);
    expect(helpCmd.stdout).toBe(renderHelp());
    const one = await cli(['help', 'grant'], v.env);
    expect(one.code).toBe(0);
    expect(one.stdout).toContain('opencontext-vault grant <label> [flags]');
    expect(one.stdout).toContain('--rotate');
    expect(one.stdout).toContain('Global flags');
    const flagHelp = await cli(['grant', '--help'], v.env);
    expect(flagHelp.stdout).toBe(one.stdout);
    expect(COMMANDS.map((c) => c.name)).toContain('serve');
  });
});

describe('cli: serve and passphrase mode', () => {
  it('serve without a key file exits 2 with the init/--key-file hint, nothing on stdout', async () => {
    const v = scratch();
    expect((await cli(['init'], v.env)).code).toBe(0);
    rmSync(v.keyFile);
    const run = await cli(['serve'], v.env);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/^KEY_NOT_FOUND: /);
    expect(run.stderr).toContain('--key-file');
    const noVault = await cli(['serve'], scratch().env);
    expect(noVault.code).toBe(2);
    expect(noVault.stderr).toMatch(/^VAULT_NOT_FOUND: /);
  });

  it('serve on a passphrase-protected key without a passphrase names the env variables', async () => {
    const v = scratch();
    expect((await cli(['init', '--passphrase'], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE: 'fixture-pass-phrase' })).code).toBe(0);
    const run = await cli(['serve'], v.env);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/^KEY_LOCKED: /);
    expect(run.stderr).toContain('OPENCONTEXT_VAULT_PASSPHRASE_CMD');
    expect(run.stderr).toContain('OPENCONTEXT_VAULT_PASSPHRASE');
  });

  it('passphrase mode works through OPENCONTEXT_VAULT_PASSPHRASE_CMD, --passphrase-file and a prompt', async () => {
    const v = scratch();
    // init refuses without a passphrase source and no terminal, accepts the env, and the key file says scrypt.
    const noSource = await cli(['init', '--passphrase'], v.env);
    expect(noSource.code).toBe(2);
    expect(noSource.stderr).toContain('INVALID_ARGUMENT');
    const init = await cli(['init', '--passphrase'], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE: 'fixture-pass-phrase' });
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toContain('passphrase-protected');
    expect((JSON.parse(readFileSync(v.keyFile, 'utf8')) as { kdf: string }).kdf).toBe('scrypt');

    // Locked without any source; unlocked by the command fixture (run without a shell: the injection suffix is just arguments).
    const locked = await cli(['status'], v.env);
    expect(locked.code).toBe(2);
    expect(locked.stderr).toMatch(/^KEY_LOCKED: /);
    const cmd = `${process.execPath} ${PASSPHRASE_CMD_FIXTURE} ; echo pwned`;
    const viaCmd = await cli(['status'], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE_CMD: cmd });
    expect(viaCmd.code, viaCmd.stderr).toBe(0);
    expect(viaCmd.stdout).toContain('kdf scrypt');
    const wrong = await cli(['status'], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE: 'nope' });
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toMatch(/^BAD_KEY: /);

    // --passphrase-file, then a masked prompt on a terminal.
    const file = join(v.root, 'pass.txt');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, 'fixture-pass-phrase\n');
    expect((await cli(['status', '--passphrase-file', file], v.env)).code).toBe(0);
    const asked: Array<[string, boolean]> = [];
    const prompted = await cli(['status'], v.env, {
      isTTY: true,
      prompt: (q, masked) => {
        asked.push([q, masked]);
        return 'fixture-pass-phrase';
      },
    });
    expect(prompted.code, prompted.stderr).toBe(0);
    expect(asked).toEqual([['Passphrase: ', true]]);

    // A full write path under the passphrase: grant, remember, rekey (keeps scrypt mode), verify.
    const env = { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE_CMD: `${process.execPath} ${PASSPHRASE_CMD_FIXTURE}` };
    expect((await cli(['grant', 'c', '--scopes', 'read'], env)).code).toBe(0);
    expect((await cli(['remember', '--kind', 'fact', '--statement', 'User tests things.'], env)).code).toBe(0);
    expect((await cli(['rekey'], env)).code).toBe(0);
    expect((JSON.parse(readFileSync(v.keyFile, 'utf8')) as { kdf: string }).kdf).toBe('scrypt');
    expect((await cli(['verify'], env)).code).toBe(0);
    expect((await cli(['list'], env)).stdout).toContain('User tests things.');
    // init --passphrase on a terminal asks twice and refuses a mismatch.
    const w = scratch();
    const answers = ['one', 'two'];
    const mismatch = await cli(['init', '--passphrase'], w.env, { isTTY: true, prompt: () => answers.shift() ?? '' });
    expect(mismatch.code).toBe(2);
    expect(mismatch.stderr).toContain('do not match');
    expect(existsSync(w.keyFile)).toBe(false);
    const ok = await cli(['init', '--passphrase'], w.env, { isTTY: true, prompt: () => 'same' });
    expect(ok.code).toBe(0);
    expect((await cli(['status'], { ...w.env, OPENCONTEXT_VAULT_PASSPHRASE: 'same' })).code).toBe(0);
  }, 60_000);
});

describe('cli: snippets', () => {
  it('renders every client kind with absolute paths and the token exactly once', () => {
    const token = 'ocv_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
    const all = renderAllSnippets(token, '/usr/local/bin/node', '/opt/vault/dist/cli.js');
    expect(all.match(TOKEN_RE)).toHaveLength(5);
    for (const kind of ['claude-desktop', 'cursor', 'windsurf'] as const) {
      const json = snippetJson(renderSnippet(kind, token, '/usr/local/bin/node', '/opt/vault/dist/cli.js'));
      const entry = (json.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>)['opencontext-vault'];
      expect(entry).toEqual({ command: '/usr/local/bin/node', args: ['/opt/vault/dist/cli.js', 'serve'], env: { OPENCONTEXT_VAULT_TOKEN: token } });
    }
    const vscode = snippetJson(renderSnippet('vscode', token, '/usr/local/bin/node', '/opt/vault/dist/cli.js'));
    expect((vscode.servers as Record<string, { type: string }>)['opencontext-vault']?.type).toBe('stdio');
    const code = renderSnippet('claude-code', token, '/usr/local/bin/node', '/opt/vault/dist/cli.js');
    expect(code).toContain(`claude mcp add opencontext-vault -s user -e OPENCONTEXT_VAULT_TOKEN=${token} -- /usr/local/bin/node /opt/vault/dist/cli.js serve`);
    // Windows-style paths survive JSON escaping.
    const win = snippetJson(renderSnippet('cursor', '<TOKEN>', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\vault\\dist\\cli.js'));
    expect((win.mcpServers as Record<string, { command: string }>)['opencontext-vault']?.command).toBe('C:\\Program Files\\nodejs\\node.exe');
  });
});

describe('cli: review fixes', () => {
  it('terminal control characters in stored strings never reach a human-readable line; --json keeps them escaped', async () => {
    const v = scratch();
    expect((await cli(['init'], v.env)).code).toBe(0);
    const statement = 'User likes tea.\u001b[2K\u001b[1Gmem_0000000000000000  fact  stated  User likes coffee.\u0007';
    const r = await cli(['remember', '--kind', 'fact', '--statement', statement], v.env);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('\u001b');
    for (const args of [['list'], ['search', 'tea'], ['list', '--created-by', 'cli']]) {
      const out = await cli(args, v.env);
      expect(out.code).toBe(0);
      expect(out.stdout, args.join(' ')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      expect(out.stdout).toContain('�[2K');
    }
    const id = (JSON.parse((await cli(['list', '--json'], v.env)).stdout) as { memories: Array<{ id: string; statement: string }> }).memories[0];
    expect(id?.statement).toBe(statement); // the data itself is untouched
    const show = await cli(['show', id?.id ?? ''], v.env);
    expect(show.stdout).not.toContain('\u001b');
    expect((await cli(['show', id?.id ?? '', '--json'], v.env)).stdout).toContain('\\u001b');
  });

  it('rekey --new-passphrase-file changes the passphrase, and an interactive rekey asks once for the current one and refuses a typo', async () => {
    const v = scratch();
    expect((await cli(['init', '--passphrase'], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE: 'old-pass' })).code).toBe(0);
    expect((await cli(['remember', '--kind', 'fact', '--statement', 'User keeps data.'], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE: 'old-pass' })).code).toBe(0);
    // the documented old way (rekey under a NEW env passphrase) cannot work and fails before anything is re-sealed
    const wrong = await cli(['rekey'], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE: 'new-pass' });
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toMatch(/^BAD_KEY: /);
    expect((await cli(['status'], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE: 'old-pass' })).code).toBe(0);
    const file = join(v.root, 'new.txt');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, 'new-pass\n');
    const changed = await cli(['rekey', '--new-passphrase-file', file], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE: 'old-pass' });
    expect(changed.code, changed.stderr).toBe(0);
    expect(changed.stdout).toContain('passphrase changed');
    expect((await cli(['status'], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE: 'old-pass' })).code).toBe(2);
    const ok = await cli(['list'], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE: 'new-pass' });
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('User keeps data.');
    expect(existsSync(`${v.keyFile}.next`)).toBe(false);
    // interactive: the passphrase that opens the vault and the one that re-wraps the key are each asked once, and a typo at the second is proven wrong, not adopted
    const asked: string[] = [];
    const answers = ['new-pass', 'typo-pass'];
    const typo = await cli(['rekey'], v.env, {
      isTTY: true,
      prompt: (q) => {
        asked.push(q);
        return answers.shift() ?? '';
      },
    });
    expect(typo.code).toBe(2);
    expect(typo.stderr).toMatch(/^BAD_KEY: /);
    expect(asked).toEqual(['Passphrase: ', 'Passphrase: ']);
    expect((await cli(['list'], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE: 'new-pass' })).code).toBe(0);
    expect((await cli(['list'], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE: 'typo-pass' })).code).toBe(2);
    // --new-passphrase on a terminal: current passphrase, then the new one twice (a mismatch is refused), then the current one is proven again before the re-seal
    const mismatch = ['new-pass', 'a', 'b'];
    const mm = await cli(['rekey', '--new-passphrase'], v.env, { isTTY: true, prompt: () => mismatch.shift() ?? '' });
    expect(mm.code).toBe(2);
    expect(mm.stderr).toContain('do not match');
    const good = ['new-pass', 'third', 'third', 'new-pass'];
    const askedNew: string[] = [];
    const okNew = await cli(['rekey', '--new-passphrase'], v.env, {
      isTTY: true,
      prompt: (q) => {
        askedNew.push(q);
        return good.shift() ?? '';
      },
    });
    expect(okNew.code, okNew.stderr).toBe(0);
    expect(askedNew).toEqual(['Passphrase: ', 'New passphrase: ', 'Repeat new passphrase: ', 'Passphrase: ']);
    expect((await cli(['list'], { ...v.env, OPENCONTEXT_VAULT_PASSPHRASE: 'third' })).code).toBe(0);
    // a plain key file becomes passphrase-protected
    const w = scratch();
    expect((await cli(['init'], w.env)).code).toBe(0);
    expect((await cli(['rekey', '--new-passphrase-file', file], w.env)).code).toBe(0);
    expect((JSON.parse(readFileSync(w.keyFile, 'utf8')) as { kdf: string }).kdf).toBe('scrypt');
    expect((await cli(['status'], w.env)).code).toBe(2);
    expect((await cli(['status'], { ...w.env, OPENCONTEXT_VAULT_PASSPHRASE: 'new-pass' })).code).toBe(0);
  }, 90_000);

  it('verify on a vault that does not open still prints its report and names the problem', async () => {
    const v = scratch();
    expect((await cli(['init'], v.env)).code).toBe(0);
    expect((await cli(['remember', '--kind', 'fact', '--statement', 'User keeps data.'], v.env)).code).toBe(0);
    const manifestPath = join(v.dir, 'vault.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { gens: Record<string, string> };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, gens: { ...manifest.gens, memories: 'ffffffffffffffff' } }, null, 2)}\n`);
    const list = await cli(['list'], v.env);
    expect(list.code).toBe(2);
    expect(list.stderr).toMatch(/^CORRUPT: /);
    const verify = await cli(['verify'], v.env);
    expect(verify.code).toBe(2);
    expect(verify.stdout).toContain('memories');
    expect(verify.stdout).toContain('generation does not match');
    expect(verify.stdout).toContain('verify: FAILED (chains only; no key)');
    expect(verify.stderr).toContain('does not open');
    const json = await cli(['verify', '--json'], v.env);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, keyless: true });
  });

  it('init reports the real directory mode, warns about a key file inside the directory, and can be retried after a failure', async () => {
    const v = scratch();
    const { chmodSync, mkdirSync, writeFileSync, rmSync: rm } = await import('node:fs');
    mkdirSync(v.dir, { recursive: true });
    if (process.platform !== 'win32') chmodSync(v.dir, 0o755);
    const inside = await cli(['init', '--key-file', join(v.dir, 'vault.key')], v.env);
    expect(inside.code, inside.stderr).toBe(0);
    if (process.platform !== 'win32') {
      expect(inside.stdout).toContain('(0755)');
      expect(inside.stdout).not.toContain('(0700)');
      expect(inside.stderr).toContain('0755');
    }
    expect(inside.stderr).toContain('inside the vault directory');
    // a failed init leaves nothing behind
    const w = scratch();
    mkdirSync(w.dir, { recursive: true });
    writeFileSync(join(w.dir, 'sources.jsonl'), 'crash leftover');
    const failed = await cli(['init'], w.env);
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain('EXISTS: journal already exists');
    expect(existsSync(w.keyFile)).toBe(false);
    rm(join(w.dir, 'sources.jsonl'));
    expect((await cli(['init'], w.env)).code).toBe(0);
    // an orphan key file without a vault names the retry
    const x = scratch();
    writeFileSync(x.keyFile, '{}');
    const orphan = await cli(['init'], x.env);
    expect(orphan.code).toBe(2);
    expect(orphan.stderr).toContain('previous init');
  });
});
