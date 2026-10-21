import { parseArgs } from 'node:util';
import type { PassphraseSource } from '../crypto/keyfile.js';
import { VaultError } from '../errors.js';
import type { VaultStore } from '../store/vault-store.js';
import type { CliIo } from './io.js';

/** One flag as both the parser needs it (type, multiple) and the help text shows it (placeholder, help). */
export interface FlagSpec {
  name: string;
  type: 'string' | 'boolean';
  /** Repeatable (`--tag a --tag b`); comma-separated values are also split by Flags.list(). */
  multiple?: boolean;
  /** Shown after the flag in help, e.g. "<dir>" or "read,write[,sources,forget,instruct]". */
  placeholder?: string;
  help: string;
}

/** One command as the help text and the parser see it; the handler lives next to it in src/cli/commands/<name>.ts. */
export interface CommandSpec {
  name: string;
  /** Positional part of the usage line, e.g. "<label>" or "<path…>"; empty for none. */
  args: string;
  summary: string;
  /** Longer explanation printed by `help <command>` and in the README; one or more sentences. */
  details: string;
  flags: readonly FlagSpec[];
}

/** Flags accepted before or after any command; the parser merges them with the command's own. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: 'vault-dir', type: 'string', placeholder: '<dir>', help: 'vault directory (env OPENCONTEXT_VAULT_DIR; default ~/.opencontext/vault)' },
  { name: 'key-file', type: 'string', placeholder: '<path>', help: 'key file (env OPENCONTEXT_VAULT_KEY_FILE; default ~/.opencontext/vault.key)' },
  { name: 'passphrase-file', type: 'string', placeholder: '<path>', help: 'read the key passphrase from this file (else OPENCONTEXT_VAULT_PASSPHRASE, OPENCONTEXT_VAULT_PASSPHRASE_CMD, or a prompt)' },
  { name: 'json', type: 'boolean', help: 'machine-readable JSON output' },
  { name: 'quiet', type: 'boolean', help: 'print only the essential result (ids, tokens, tables)' },
  { name: 'version', type: 'boolean', help: 'print the version and exit' },
  { name: 'help', type: 'boolean', help: 'print this help (or `help <command>`) and exit' },
];

/** A command-line mistake (unknown command/flag, missing argument): exit 1, with the usage line, never a stack trace. */
export class UsageError extends Error {
  constructor(message: string, public readonly command?: string) {
    super(message);
    this.name = 'UsageError';
  }
}

type RawValues = Record<string, string | boolean | Array<string | boolean> | undefined>;

/** Typed accessors over parseArgs values; every command reads its flags through this so conversions and errors are uniform. */
export class Flags {
  constructor(private readonly values: RawValues, private readonly command: string | undefined) {}

  /** Last value of a string flag, or undefined. */
  str(name: string): string | undefined {
    const v = this.values[name];
    if (Array.isArray(v)) {
      const last = v[v.length - 1];
      return typeof last === 'string' ? last : undefined;
    }
    return typeof v === 'string' ? v : undefined;
  }

  bool(name: string): boolean {
    const v = this.values[name];
    return v === true;
  }

  /** Every occurrence of a repeatable flag, each split on commas, trimmed, empties dropped. */
  list(name: string): string[] {
    const v = this.values[name];
    const raw = Array.isArray(v) ? v : v === undefined ? [] : [v];
    const out: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      for (const part of item.split(',')) {
        const t = part.trim();
        if (t !== '') out.push(t);
      }
    }
    return out;
  }

  /** Non-negative integer flag; a non-number is a usage error. */
  int(name: string): number | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v)) throw new UsageError(`--${name} expects a non-negative integer, got "${v}"`, this.command);
    return Number(v);
  }

  /** String flag restricted to a fixed vocabulary; anything else is a usage error naming the choices. */
  choice<T extends string>(name: string, choices: readonly T[]): T | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    if ((choices as readonly string[]).includes(v)) return v as T;
    throw new UsageError(`--${name} must be one of ${choices.join(', ')}, got "${v}"`, this.command);
  }

  has(name: string): boolean {
    return this.values[name] !== undefined;
  }
}

/** What parseCommandLine produces: the command (undefined for a bare `--help`/`--version`), its positionals and typed flags. */
export interface ParsedLine {
  command: string | undefined;
  positionals: string[];
  flags: Flags;
}

function toOptions(flags: readonly FlagSpec[]): Record<string, { type: 'string' | 'boolean'; multiple?: boolean }> {
  const out: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }> = {};
  for (const f of flags) out[f.name] = { type: f.type, ...(f.multiple ? { multiple: true } : {}) };
  return out;
}

/**
 * Two passes over node:util.parseArgs (no third-party parser, §6). Pass one is lenient and only knows the global
 * flags: its first positional is the command. Pass two is strict with the global flags plus that command's own,
 * so an unknown flag or a missing value is a UsageError that names the command. Flags may appear before or after
 * the command and in any order.
 */
export function parseCommandLine(argv: readonly string[], commands: ReadonlyArray<CommandSpec>): ParsedLine {
  const lenient = parseArgs({ args: [...argv], options: toOptions(GLOBAL_FLAGS), allowPositionals: true, strict: false });
  const command = lenient.positionals[0];
  if (command === undefined) {
    return { command: undefined, positionals: [], flags: new Flags(lenient.values as RawValues, undefined) };
  }
  const spec = commands.find((c) => c.name === command);
  if (spec === undefined) throw new UsageError(`unknown command "${command}"`);
  let strict: ReturnType<typeof parseArgs>;
  try {
    strict = parseArgs({ args: [...argv], options: toOptions([...GLOBAL_FLAGS, ...spec.flags]), allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message.split('.')[0] ?? 'invalid arguments', command);
  }
  const positionals = [...strict.positionals];
  const at = positionals.indexOf(command);
  if (at >= 0) positionals.splice(at, 1);
  return { command, positionals, flags: new Flags(strict.values as RawValues, command) };
}

/**
 * What every command handler receives. Store access goes through `openStore()` so each command opens the vault
 * exactly once, late (after argument validation), with the right passphrase source; `print` is stdout for every
 * command except `serve`, whose stdout is the MCP protocol. `info` is suppressed by --quiet.
 */
export interface CommandContext {
  io: CliIo;
  flags: Flags;
  positionals: string[];
  json: boolean;
  quiet: boolean;
  vaultDir: string;
  keyFile: string;
  version: string;
  /** Absolute path of dist/cli.js, for config snippets. */
  cliPath: string;
  now: () => Date;
  /** Human output (stdout; stderr for serve). */
  print(s: string): void;
  /** Secondary human output, dropped under --quiet. */
  info(s: string): void;
  /** Diagnostics; always stderr. */
  warn(s: string): void;
  /** Passphrase source: --passphrase-file → OPENCONTEXT_VAULT_PASSPHRASE → _CMD → masked prompt (CLI only; never for serve). */
  passphrase(o?: { prompt?: boolean }): PassphraseSource;
  /** VaultStore.open on the resolved paths; the caller closes it. */
  openStore(): VaultStore;
  /** Interactive yes/no; false when there is no TTY. */
  confirm(question: string): boolean;
  /** Record a `cli` audit entry (grant null, client null, args as the server does: JSON string, tokens redacted, truncated). */
  audit(store: VaultStore, name: string, args: unknown, o?: { outcome?: 'ok' | 'denied' | 'error'; error?: string; ids?: string[]; count?: number }): void;
  /** The generated help text, for one command or all. */
  helpText(command?: string): string;
}

/** A command module: its spec (for help, README and the parser) and its handler, which returns the exit code. */
export interface Command {
  spec: CommandSpec;
  run(ctx: CommandContext): Promise<number> | number;
}

/** "24h"/"7d"/"30m"/"90s" relative to now, or an ISO date; anything else is INVALID_ARGUMENT. Shared by `list --since` and `audit --since`. */
export function parseSince(value: string, now: () => Date): string {
  const m = /^(\d+)([smhd])$/.exec(value.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const ms = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return new Date(now().getTime() - n * ms).toISOString();
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new VaultError('INVALID_ARGUMENT', `invalid --since "${value}"`, 'use an ISO date or a duration like 24h, 7d, 30m');
  return new Date(t).toISOString();
}
