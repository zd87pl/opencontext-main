import { readFileSync } from 'node:fs';
import { VaultError } from '../../errors.js';
import { Journal } from '../../store/journal.js';
import { vaultFiles } from '../../store/paths.js';
import type { VaultStore } from '../../store/vault-store.js';
import { Manifest, type JournalName } from '../../types.js';
import { genIsCurrent } from '../../store/vault-store.js';
import type { Command, CommandContext } from '../args.js';
import { renderTable } from '../table.js';

const JOURNALS: readonly JournalName[] = ['memories', 'sources', 'grants', 'audit'];

type ChainReport = Record<JournalName, ReturnType<typeof Journal.verifyChain>>;

interface Report {
  ok: boolean;
  keyless: boolean;
  journals: ChainReport;
  bodies?: { checked: number; bad: string[] };
  provenance?: { checked: number; changed: string[]; orphaned: string[]; fixed: boolean };
}

/** Chain verification without the key: the manifest is plaintext and every journal line carries its seq and prev hash. */
function keylessVerify(vaultDir: string): { ok: boolean; journals: ChainReport } {
  const files = vaultFiles(vaultDir);
  let manifest: Manifest;
  try {
    manifest = Manifest.parse(JSON.parse(readFileSync(files.manifest, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new VaultError('VAULT_NOT_FOUND', `no vault at ${vaultDir}`, 'run: opencontext-vault init');
    throw new VaultError('CORRUPT', 'vault.json is not a valid manifest');
  }
  const journals = {} as ChainReport;
  let ok = true;
  for (const name of JOURNALS) {
    let r = Journal.verifyChain(files[name]);
    if (r.ok && !genIsCurrent(manifest, name, r.gen)) r = { ...r, ok: false, reason: 'generation does not match vault.json (rolled back or swapped)' };
    journals[name] = r;
    ok &&= r.ok;
  }
  return { ok, journals };
}

/** Every CORRUPT hint says "run verify", so verify must never refuse with the same CORRUPT: a vault that does not open is verified key-less and the report names what is wrong. */
function openOrKeyless(ctx: CommandContext): VaultStore | undefined {
  try {
    return ctx.openStore();
  } catch (err) {
    if (VaultError.is(err, 'KEY_NOT_FOUND') || VaultError.is(err, 'KEY_LOCKED') || VaultError.is(err, 'BAD_KEY')) {
      ctx.warn(`${err.code}: ${err.message}; verifying chains without the key (bodies and provenance need it)\n`);
      return undefined;
    }
    if (VaultError.is(err, 'CORRUPT')) {
      ctx.warn(`${err.code}: ${err.message}; the vault does not open, verifying chains without the key\n`);
      return undefined;
    }
    throw err;
  }
}

/** `verify`: tamper-evidence check of every journal (key-less), body hashes (with the key) and, on request, provenance flags. */
export const verify: Command = {
  spec: {
    name: 'verify',
    args: '',
    summary: 'Check journal chains, manifest generations, body hashes and (optionally) provenance',
    details:
      'Without the key: every journal\'s header, sequence contiguity and prev-hash chain, plus the generation recorded in vault.json (detects a journal swapped for an older copy; a compaction interrupted between its rename and its manifest write is finished, not reported). With the key: every source body is decrypted and its sha256 compared to its record. --provenance recomputes each memory citation\'s `verified` flag against the cited turn and lists citations whose source is gone; --fix writes the recomputed flags. Exit 2 with CORRUPT when anything fails; a vault that does not open is still checked key-less so the report names the problem. Tail truncation of a journal is not detectable without an external anchor (SECURITY.md).',
    flags: [
      { name: 'provenance', type: 'boolean', help: 'also recompute quote verification and list orphaned citations' },
      { name: 'fix', type: 'boolean', help: 'with --provenance: write the recomputed flags' },
    ],
  },
  run(ctx: CommandContext): number {
    const wantProvenance = ctx.flags.bool('provenance') || ctx.flags.bool('fix');
    const fix = ctx.flags.bool('fix');
    const store = openOrKeyless(ctx);
    let report: Report;
    try {
      if (store === undefined) {
        const r = keylessVerify(ctx.vaultDir);
        report = { ok: r.ok, keyless: true, journals: r.journals };
      } else {
        const r = store.verify({ bodies: true });
        report = { ok: r.ok, keyless: false, journals: r.journals, ...(r.bodies !== undefined ? { bodies: r.bodies } : {}) };
        if (wantProvenance) {
          const p = store.verifyProvenance({ fix });
          report.provenance = { ...p, fixed: fix };
          if (fix && p.changed.length > 0) ctx.audit(store, 'verify', { fix: true, changed: p.changed.length, orphaned: p.orphaned.length }, { ids: p.changed.slice(0, 50), count: p.changed.length });
        }
      }
    } finally {
      store?.close();
    }
    if (ctx.json) ctx.print(`${JSON.stringify(report)}\n`);
    else {
      ctx.print(
        renderTable(
          ['JOURNAL', 'OK', 'LINES', 'GEN', 'PROBLEM'],
          JOURNALS.map((name) => {
            const r = report.journals[name];
            return [name, r.ok ? 'yes' : 'NO', String(r.lines), r.gen || '-', r.ok ? '' : `${r.reason ?? 'broken'}${r.brokenAtLine !== undefined ? ` (line ${r.brokenAtLine})` : ''}`];
          }),
        ),
      );
      if (report.bodies !== undefined) ctx.print(`bodies      ${report.bodies.checked} checked, ${report.bodies.bad.length} bad${report.bodies.bad.length > 0 ? `: ${report.bodies.bad.join(', ')}` : ''}\n`);
      else ctx.print('bodies      not checked (no key)\n');
      if (report.provenance !== undefined) {
        const p = report.provenance;
        ctx.print(`provenance  ${p.checked} memories checked, ${p.changed.length} with stale verified flags${p.fixed ? ' (fixed)' : p.changed.length > 0 ? ' (run with --fix to write)' : ''}, ${p.orphaned.length} citation${p.orphaned.length === 1 ? '' : 's'} to forgotten sources\n`);
        for (const id of p.changed) ctx.info(`  changed  ${id}\n`);
        for (const ref of p.orphaned) ctx.info(`  orphaned ${ref}\n`);
      }
      ctx.print(`verify: ${report.ok ? 'ok' : 'FAILED'}${report.keyless ? ' (chains only; no key)' : ''}\n`);
    }
    if (!report.ok) {
      const broken = JOURNALS.filter((n) => !report.journals[n].ok).map((n) => `${n}: ${report.journals[n].reason ?? 'broken chain'}`);
      const badBodies = report.bodies !== undefined && report.bodies.bad.length > 0 ? [`${report.bodies.bad.length} source bodies failed their hash`] : [];
      throw new VaultError('CORRUPT', `verification failed: ${[...broken, ...badBodies].join('; ')}`, 'restore the vault directory from a backup made with the same key, or export what still opens and init a new vault');
    }
    return 0;
  },
};
