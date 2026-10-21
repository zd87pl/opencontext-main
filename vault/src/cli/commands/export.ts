import { chmodSync, createWriteStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { VaultError } from '../../errors.js';
import { writeMarkdown } from '../../exporters/markdown.js';
import { writePortable } from '../../exporters/portable.js';
import type { Command, CommandContext } from '../args.js';

/** End a stream and wait for it to flush; errors become IO so the CLI prints a code, not a stack. */
function finish(out: NodeJS.WritableStream): Promise<void> {
  return new Promise<void>((resolveDone, reject) => {
    out.once('error', (err: Error) => reject(new VaultError('IO', `export write failed: ${err.message}`)));
    out.end(() => resolveDone());
  });
}

/** A Writable over io.stdout for in-process runs (tests); the real binary gets process.stdout through io.stdoutStream. */
function stdoutWritable(ctx: CommandContext): NodeJS.WritableStream {
  if (ctx.io.stdoutStream !== undefined) return ctx.io.stdoutStream;
  return new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      ctx.io.stdout(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
}

/** `export`: the portable JSON (streamed, re-importable) or a human-readable markdown file. */
export const exportCommand: Command = {
  spec: {
    name: 'export',
    args: '',
    summary: 'Write the portable JSON export (or markdown) to a file or stdout',
    details:
      'JSON (default) is the documented opencontext-vault-export v1 format (SPEC.md): every memory including superseded versions and every source with its full body and raw vendor record, streamed so a large vault never has to fit in RAM; `import` reads it back. Markdown (--format md) is for humans and is not re-importable. The export is plaintext: --out writes with mode 0600 and refuses to overwrite without --force. Never includes grants, tokens, keys or audit entries. Logged in the audit journal as a cli event.',
    flags: [
      { name: 'out', type: 'string', placeholder: '<file>', help: 'write here instead of stdout (mode 0600)' },
      { name: 'format', type: 'string', placeholder: 'json|md', help: 'output format (default json)' },
      { name: 'no-raw', type: 'boolean', help: 'omit raw vendor records (lossy)' },
      { name: 'full', type: 'boolean', help: 'markdown: do not truncate sources at 2000 chars' },
      { name: 'include-superseded', type: 'boolean', help: 'markdown: include superseded memory versions' },
      { name: 'force', type: 'boolean', help: 'overwrite an existing --out file' },
    ],
  },
  async run(ctx: CommandContext): Promise<number> {
    const format = ctx.flags.choice('format', ['json', 'md'] as const) ?? 'json';
    const outFlag = ctx.flags.str('out');
    const includeRaw = !ctx.flags.bool('no-raw');
    const full = ctx.flags.bool('full');
    const includeSuperseded = ctx.flags.bool('include-superseded');
    const force = ctx.flags.bool('force');
    const outPath = outFlag !== undefined ? resolve(ctx.io.cwd, outFlag) : undefined;
    if (outPath !== undefined && existsSync(outPath) && !force) {
      throw new VaultError('EXISTS', `${outPath} already exists`, 'pass --force to overwrite, or --out <another file>');
    }
    ctx.warn('export is plaintext: keep the file as safe as the vault key\n');
    const store = ctx.openStore();
    try {
      const target: NodeJS.WritableStream = outPath !== undefined ? createWriteStream(outPath, { mode: 0o600, flags: 'w' }) : stdoutWritable(ctx);
      let memories: number;
      let sources: number;
      if (format === 'json') {
        const counts = await writePortable(store, target, { generator: `@opencontext/vault ${ctx.version}`, now: ctx.now, includeRaw });
        memories = counts.memories;
        sources = counts.sources;
      } else {
        writeMarkdown(store, target, { full, includeSuperseded, now: ctx.now });
        memories = store.listMemories({ status: includeSuperseded ? 'all' : 'active' }).length;
        sources = store.listSources().length;
      }
      if (outPath !== undefined) {
        await finish(target);
        try {
          chmodSync(outPath, 0o600);
        } catch {
          /* Windows: permissions are not enforced */
        }
      } else if (target !== ctx.io.stdoutStream) {
        await finish(target);
      }
      ctx.audit(store, 'export', { format, out: outPath ?? 'stdout', includeRaw, full, includeSuperseded, memories, sources }, { count: memories + sources });
      ctx.warn(`exported ${memories} memor${memories === 1 ? 'y' : 'ies'} and ${sources} source${sources === 1 ? '' : 's'} (${format})${outPath !== undefined ? ` → ${outPath}` : ''}\n`);
      return 0;
    } finally {
      store.close();
    }
  },
};
