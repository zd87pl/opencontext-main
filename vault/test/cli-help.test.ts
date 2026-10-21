import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLOBAL_FLAGS } from '../src/cli/args.js';
import { COMMANDS, renderHelp } from '../src/cli/run.js';

const README = join(import.meta.dirname, '..', 'README.md');
const BEGIN = '<!-- cli:begin -->\n';
const END = '<!-- cli:end -->';

/** The §6 command table: every command and every flag it lists must exist in the binary. */
const SPEC_TABLE: Readonly<Record<string, readonly string[]>> = {
  init: ['--passphrase'],
  serve: ['--token'],
  grant: ['--scopes', '--tags', '--note', '--rotate', '--client'],
  revoke: [],
  clients: ['--pending'],
  config: ['--client', '--token'],
  import: ['--format', '--tags', '--no-raw', '--dry-run', '--gemini-window'],
  export: ['--out', '--format', '--no-raw', '--full', '--include-superseded', '--force'],
  search: ['--sources', '--limit', '--kind', '--tag'],
  list: ['--kind', '--tag', '--created-by', '--status', '--since', '--limit'],
  show: [],
  remember: ['--kind', '--statement', '--subject', '--tag', '--confidence'],
  forget: ['--created-by', '--source', '--yes'],
  sources: ['--review', '--type', '--limit'],
  audit: ['--follow', '--since', '--client', '--event', '--denied', '--limit'],
  verify: ['--provenance', '--fix'],
  status: [],
  rekey: [],
  compact: [],
  help: [],
};

describe('cli help and README stay in sync', () => {
  it('README carries exactly renderHelp() between the cli markers', () => {
    const readme = readFileSync(README, 'utf8');
    const start = readme.indexOf(BEGIN);
    const end = readme.indexOf(END);
    expect(start, 'README has <!-- cli:begin -->').toBeGreaterThanOrEqual(0);
    expect(end, 'README has <!-- cli:end -->').toBeGreaterThan(start);
    const block = readme.slice(start + BEGIN.length, end);
    expect(block).toBe(`\`\`\`text\n${renderHelp()}\`\`\`\n`);
  });

  it('lists every §6 command in order with every §6 flag', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(Object.keys(SPEC_TABLE));
    for (const c of COMMANDS) {
      const flags = c.flags.map((f) => f.flag.split(' ')[0]);
      for (const wanted of SPEC_TABLE[c.name] ?? []) expect(flags, `${c.name} has ${wanted}`).toContain(wanted);
      expect(c.summary.length, `${c.name} summary`).toBeGreaterThan(10);
      expect(c.details.length, `${c.name} details`).toBeGreaterThan(20);
      for (const f of c.flags) expect(f.help.length, `${c.name} ${f.flag} help`).toBeGreaterThan(3);
    }
  });

  it('documents the global flags, the environment variables and the exit codes', () => {
    const help = renderHelp();
    for (const f of GLOBAL_FLAGS) expect(help).toContain(`--${f.name}`);
    for (const name of ['--vault-dir', '--key-file', '--passphrase-file', '--json', '--quiet', '--version', '--help']) expect(help).toContain(name);
    for (const env of ['OPENCONTEXT_VAULT_DIR', 'OPENCONTEXT_VAULT_KEY_FILE', 'OPENCONTEXT_VAULT_PASSPHRASE', 'OPENCONTEXT_VAULT_PASSPHRASE_CMD', 'OPENCONTEXT_VAULT_TOKEN']) {
      expect(help).toContain(env);
    }
    expect(help).toContain('0 ok · 1 usage · 2 vault error');
    expect(help.endsWith('\n')).toBe(true);
    // A usage line and a section per command.
    for (const c of COMMANDS) expect(help).toContain(`\nopencontext-vault ${c.usage}\n`);
    // Wording bans (§9) do not sneak into the reference.
    for (const banned of ['zero-knowledge', 'military-grade', 'unhackable', 'tamper-proof', 'blockchain', 'decentralized']) {
      expect(help.toLowerCase()).not.toContain(banned);
    }
  });
});
