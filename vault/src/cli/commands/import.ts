import { resolve } from 'node:path';
import { VaultError } from '../../errors.js';
import type { ImportFormat } from '../../importers/detect.js';
import { runImport } from '../../importers/run.js';
import type { Command, CommandContext } from '../args.js';

const FORMATS: readonly ImportFormat[] = ['chatgpt', 'claude', 'claude-projects', 'gemini', 'markdown', 'text', 'vault'];

/** `import`: vendor exports, note folders and portable vault exports into sources (and, for vault files, memories). */
export const importCommand: Command = {
  spec: {
    name: 'import',
    args: '<path…>',
    summary: 'Import ChatGPT/Claude/Gemini exports, folders of notes, or a portable vault export',
    details:
      'Takes files or directories (recursive; dot-dirs and node_modules skipped) and auto-detects each file\'s format from its content. Re-importing is idempotent: an unchanged conversation is skipped, a changed one is updated in place (review state kept), and the vendor record is kept verbatim as `raw` unless --no-raw. A portable export (`export --format json`) restores memories and sources with their original ids. Files it cannot read are listed under "ignored"; the exit code is non-zero only for fatal errors. Logged in the audit journal as a cli event.',
    flags: [
      { name: 'format', type: 'string', placeholder: FORMATS.join('|'), help: 'force the format instead of auto-detecting' },
      { name: 'tags', type: 'string', placeholder: '<a,b>', help: 'tag every imported source' },
      { name: 'no-raw', type: 'boolean', help: 'do not keep the untouched vendor record (smaller, lossy)' },
      { name: 'dry-run', type: 'boolean', help: 'parse and count without writing' },
      { name: 'gemini-window', type: 'string', placeholder: '<minutes>', help: 'group Gemini activity records closer than this into one conversation (default 30; 0 = one source per record)' },
    ],
  },
  async run(ctx: CommandContext): Promise<number> {
    if (ctx.positionals.length === 0) throw new VaultError('INVALID_ARGUMENT', 'import needs at least one file or directory', 'example: opencontext-vault import ~/Downloads/chatgpt-export/');
    const format = ctx.flags.choice('format', FORMATS);
    const tags = ctx.flags.list('tags');
    const keepRaw = !ctx.flags.bool('no-raw');
    const dryRun = ctx.flags.bool('dry-run');
    const geminiWindow = ctx.flags.int('gemini-window');
    const paths = ctx.positionals.map((p) => resolve(ctx.io.cwd, p));
    const store = ctx.openStore();
    try {
      let lastShown = 0;
      const report = await runImport(store, paths, {
        ...(format !== undefined ? { format } : {}),
        tags,
        keepRaw,
        dryRun,
        ...(geminiWindow !== undefined ? { geminiWindowMinutes: geminiWindow } : {}),
        warn: (m) => ctx.warn(`${m}\n`),
        now: ctx.now,
        onProgress: (n) => {
          if (n - lastShown >= 100 && !ctx.quiet && !ctx.json) {
            lastShown = n;
            ctx.warn(`… ${n} sources\n`);
          }
        },
      });
      ctx.audit(store, 'import', { paths, format: format ?? 'auto', tags, keepRaw, dryRun, added: report.added, updated: report.updated, skipped: report.skipped, memoriesAdded: report.memoriesAdded }, {
        count: report.added + report.updated,
      });
      if (ctx.json) {
        ctx.print(`${JSON.stringify(report)}\n`);
        return 0;
      }
      const files = report.files.map((f) => `${f.path} (${f.format})`);
      ctx.print(`${dryRun ? 'dry run: ' : ''}imported ${report.files.length} file${report.files.length === 1 ? '' : 's'}${files.length > 0 && files.length <= 5 ? `: ${files.join(', ')}` : ''}\n`);
      const memories = report.memoriesAdded + report.memoriesSkipped > 0 ? ` · memories +${report.memoriesAdded} (${report.memoriesSkipped} already present)` : '';
      ctx.print(`added ${report.added} source${report.added === 1 ? '' : 's'} · ${report.updated} updated · ${report.skipped} skipped${memories} · raw vendor records ${keepRaw ? 'kept' : 'dropped'} · ${(report.ms / 1000).toFixed(1)} s\n`);
      for (const line of report.ignored) ctx.info(`ignored: ${line}\n`);
      for (const line of report.notes) ctx.info(`note: ${line}\n`);
      return 0;
    } finally {
      store.close();
    }
  },
};
