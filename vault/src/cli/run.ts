import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAuditSink } from '../access/audit.js';
import type { PassphraseSource } from '../crypto/keyfile.js';
import { VaultError } from '../errors.js';
import { resolvePaths } from '../store/paths.js';
import { VaultStore } from '../store/vault-store.js';
import { GLOBAL_FLAGS, UsageError, parseCommandLine, type Command, type CommandContext, type CommandSpec, type FlagSpec } from './args.js';
import { audit } from './commands/audit.js';
import { clients } from './commands/clients.js';
import { compact } from './commands/compact.js';
import { config } from './commands/config.js';
import { exportCommand } from './commands/export.js';
import { forget } from './commands/forget.js';
import { grant } from './commands/grant.js';
import { help } from './commands/help.js';
import { importCommand } from './commands/import.js';
import { init } from './commands/init.js';
import { list } from './commands/list.js';
import { rekey } from './commands/rekey.js';
import { remember } from './commands/remember.js';
import { revoke } from './commands/revoke.js';
import { search } from './commands/search.js';
import { serve } from './commands/serve.js';
import { show } from './commands/show.js';
import { sources } from './commands/sources.js';
import { status } from './commands/status.js';
import { verify } from './commands/verify.js';
import type { CliIo } from './io.js';

/** Every command in help order (the §6 table order). */
const ALL: readonly Command[] = [init, serve, grant, revoke, clients, config, importCommand, exportCommand, search, list, show, remember, forget, sources, audit, verify, status, rekey, compact, help];

const BIN = 'opencontext-vault';

const ENV_HELP: ReadonlyArray<readonly [string, string]> = [
  ['OPENCONTEXT_VAULT_DIR', 'vault directory (default ~/.opencontext/vault)'],
  ['OPENCONTEXT_VAULT_KEY_FILE', 'key file (default ~/.opencontext/vault.key, a sibling of the vault directory)'],
  ['OPENCONTEXT_VAULT_PASSPHRASE', 'passphrase for a passphrase-protected key file'],
  ['OPENCONTEXT_VAULT_PASSPHRASE_CMD', 'command printing the passphrase (split on whitespace, run without a shell, 5 s timeout)'],
  ['OPENCONTEXT_VAULT_TOKEN', 'client token, read by serve only'],
];

/** The package version from package.json (next to dist/ and src/ alike); "0.0.0" only if the file is unreadable. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The absolute path of the built CLI, what config snippets must point at; resolved relative to this module so src/ and dist/ agree. */
function cliPath(): string {
  return fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
}

function flagLabel(f: FlagSpec): string {
  return f.placeholder !== undefined ? `--${f.name} ${f.placeholder}` : `--${f.name}`;
}

function usageOf(spec: CommandSpec): string {
  const flags = spec.flags.length > 0 ? ' [flags]' : '';
  return `${spec.name}${spec.args !== '' ? ` ${spec.args}` : ''}${flags}`;
}

/**
 * Single source of truth for `help` AND the README CLI block (test/cli-help.test.ts diff-checks them): one entry per
 * command with its usage line, summary, details and flags, in help order.
 */
export const COMMANDS: ReadonlyArray<{ name: string; usage: string; summary: string; details: string; flags: ReadonlyArray<{ flag: string; help: string }> }> = ALL.map((c) => ({
  name: c.spec.name,
  usage: usageOf(c.spec),
  summary: c.spec.summary,
  details: c.spec.details,
  flags: c.spec.flags.map((f) => ({ flag: flagLabel(f), help: f.help })),
}));

const PAD = 26;

/** Wrap at 100 columns with a hanging indent; help text and README stay readable in a terminal and in a code block. */
function wrap(text: string, indent: string, width = 100): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur === '') cur = w;
    else if (indent.length + cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else cur += ` ${w}`;
  }
  if (cur !== '') lines.push(cur);
  return lines.map((l) => `${indent}${l}`).join('\n');
}

function flagLines(flags: ReadonlyArray<{ flag: string; help: string }>, indent: string): string {
  return flags
    .map((f) => {
      const label = `${indent}${f.flag}`;
      const gap = label.length < indent.length + PAD ? ' '.repeat(indent.length + PAD - label.length) : `\n${' '.repeat(indent.length + PAD)}`;
      return `${label}${gap}${wrap(f.help, ' '.repeat(indent.length + PAD)).trimStart()}`;
    })
    .join('\n');
}

function commandSection(c: (typeof COMMANDS)[number]): string {
  const flags = c.flags.length > 0 ? `\n${flagLines(c.flags, '  ')}` : '';
  return `${BIN} ${c.usage}\n${wrap(c.details, '  ')}${flags}\n`;
}

/** The full reference: synopsis, command table, global flags, environment, exit codes, then one section per command. */
export function renderHelp(): string {
  const commandTable = COMMANDS.map((c) => `  ${c.usage.padEnd(PAD)}${c.summary}`).join('\n');
  const globals = flagLines(GLOBAL_FLAGS.map((f) => ({ flag: flagLabel(f), help: f.help })), '  ');
  const env = ENV_HELP.map(([k, v]) => `  ${k.padEnd(34)}${v}`).join('\n');
  return [
    `${BIN} — a user-owned, encrypted, portable memory for your AI agents, as a local MCP server`,
    '',
    `Usage: ${BIN} <command> [flags]`,
    '',
    'Commands:',
    commandTable,
    '',
    'Global flags (before or after the command):',
    globals,
    '',
    'Environment:',
    env,
    '',
    'Exit codes: 0 ok · 1 usage · 2 vault error (printed as CODE: message, then a hint) · 3 unexpected',
    '',
    ...COMMANDS.map(commandSection),
  ].join('\n');
}

/** Help for one command (its section plus the global flags), or the whole reference. Unknown names are a usage error. */
function helpFor(command: string | undefined): string {
  if (command === undefined) return renderHelp();
  const c = COMMANDS.find((x) => x.name === command);
  if (c === undefined) throw new UsageError(`unknown command "${command}"`);
  return `${commandSection(c)}\nGlobal flags:\n${flagLines(GLOBAL_FLAGS.map((f) => ({ flag: flagLabel(f), help: f.help })), '  ')}\n`;
}

function usageLine(command: string | undefined): string {
  const c = command !== undefined ? COMMANDS.find((x) => x.name === command) : undefined;
  return c !== undefined ? `usage: ${BIN} ${c.usage}\n(run: ${BIN} help ${c.name})\n` : `usage: ${BIN} <command> [flags]\n(run: ${BIN} help)\n`;
}

/** --passphrase-file wins over OPENCONTEXT_VAULT_PASSPHRASE; the command and the prompt are added when available. */
function passphraseSource(io: CliIo, file: string | undefined, prompt: boolean): PassphraseSource {
  let passphrase: string | undefined;
  if (file !== undefined) {
    try {
      passphrase = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      throw new VaultError('IO', `cannot read --passphrase-file ${file}: ${(err as Error).message}`);
    }
  } else if (io.env.OPENCONTEXT_VAULT_PASSPHRASE !== undefined) {
    passphrase = io.env.OPENCONTEXT_VAULT_PASSPHRASE;
  }
  const cmd = io.env.OPENCONTEXT_VAULT_PASSPHRASE_CMD;
  const ask = prompt && io.isTTY && io.prompt !== undefined ? io.prompt : undefined;
  return {
    ...(passphrase !== undefined ? { passphrase } : {}),
    ...(cmd !== undefined && cmd.trim() !== '' ? { passphraseCmd: cmd } : {}),
    ...(ask !== undefined ? { prompt: (q: string): string => ask(q, true) } : {}),
  };
}

/**
 * The whole CLI as a function so tests run it in-process. Exit codes: 0 ok, 1 usage, 2 VaultError (printed to stderr
 * as "<CODE>: msg" and an indented hint), 3 unexpected. Human output goes to stdout except for `serve`, whose stdout
 * is the MCP protocol; errors and warnings always go to stderr.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const version = readVersion();
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(argv, ALL.map((c) => c.spec));
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`error: ${err.message}\n${usageLine(err.command)}`);
      return 1;
    }
    throw err;
  }
  const { command, positionals, flags } = parsed;
  if (flags.bool('version')) {
    io.stdout(`${version}\n`);
    return 0;
  }
  if (flags.bool('help')) {
    io.stdout(helpFor(command));
    return 0;
  }
  if (command === undefined) {
    io.stderr(renderHelp());
    return 1;
  }
  const cmd = ALL.find((c) => c.spec.name === command);
  if (cmd === undefined) {
    io.stderr(`error: unknown command "${command}"\n${usageLine(undefined)}`);
    return 1;
  }
  const isServe = command === 'serve';
  const json = flags.bool('json');
  const quiet = flags.bool('quiet');
  const now = (): Date => new Date();
  const started = Date.now();
  const out = (s: string): void => (isServe ? io.stderr(s) : io.stdout(s));
  const ctx: CommandContext = {
    io,
    flags,
    positionals,
    json,
    quiet,
    vaultDir: '',
    keyFile: '',
    version,
    cliPath: cliPath(),
    now,
    print: out,
    info: (s: string): void => {
      if (!quiet && !json) out(s);
    },
    warn: (s: string): void => io.stderr(s),
    passphrase: (o?: { prompt?: boolean }): PassphraseSource => passphraseSource(io, flags.str('passphrase-file'), (o?.prompt ?? true) && !isServe),
    openStore: (): VaultStore => VaultStore.open({ dir: ctx.vaultDir, keyFile: ctx.keyFile, passphrase: ctx.passphrase(), onWarn: (m: string) => io.stderr(`warning: ${m}\n`), now }),
    confirm: (question: string): boolean => {
      if (!io.isTTY || io.prompt === undefined) return false;
      const answer = io.prompt(question, false).trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    },
    audit: (store, name, args, o): void => {
      createAuditSink(store, { pid: process.pid, now, client: () => null }).record({
        grant: null,
        client: null,
        event: 'cli',
        name,
        args,
        outcome: o?.outcome ?? 'ok',
        ms: Math.max(0, Date.now() - started),
        ...(o?.error !== undefined ? { error: o.error } : {}),
        ...(o?.ids !== undefined || o?.count !== undefined ? { result: { ...(o.count !== undefined ? { count: o.count } : {}), ...(o.ids !== undefined ? { ids: o.ids } : {}) } } : {}),
      });
    },
    helpText: helpFor,
  };
  try {
    const paths = resolvePaths({ vaultDir: flags.str('vault-dir'), keyFile: flags.str('key-file'), env: io.env });
    ctx.vaultDir = paths.vaultDir;
    ctx.keyFile = paths.keyFile;
    return await cmd.run(ctx);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`error: ${err.message}\n${usageLine(err.command ?? command)}`);
      return 1;
    }
    if (err instanceof VaultError) {
      io.stderr(`${err.code}: ${err.message}\n${err.hint !== undefined ? `  ${err.hint}\n` : ''}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`error: ${message}\n`);
    return 3;
  }
}
