import { VaultError } from '../../errors.js';
import type { Command, CommandContext } from '../args.js';

const MEM_RE = /^mem_[0-9a-f]{16}$/;
const SRC_RE = /^src_[0-9a-f]{16}$/;

/** `forget`: delete memories and/or sources; ciphertext leaves the live journals immediately (compaction). */
export const forget: Command = {
  spec: {
    name: 'forget',
    args: '[id…]',
    summary: 'Delete memories or sources by id, by author, or by cited source',
    details:
      'Deleting a memory also deletes the older versions it supersedes; deleting a source removes its body and record while memories keep their citation (shown as forgotten). --created-by removes every memory a client wrote (reverses poisoning); --source removes every memory citing that source and then the source itself. The memories, sources and grants journals are compacted in the same step so the ciphertext leaves those files; run `rekey` afterwards for a sensitive deletion. The audit journal is never compacted: the arguments of the MCP call that wrote a record (statement, filed text) stay in it, readable by the key holder with `audit`. Asks for confirmation on a terminal unless --yes; without a terminal --yes is required. Logged in the audit journal as a cli event.',
    flags: [
      { name: 'created-by', type: 'string', placeholder: '<label>', help: 'every memory written by this grant label (or "cli"/"import")' },
      { name: 'source', type: 'string', placeholder: '<src_id>', help: 'every memory citing this source, then the source itself' },
      { name: 'yes', type: 'boolean', help: 'do not ask for confirmation' },
    ],
  },
  run(ctx: CommandContext): number {
    const createdBy = ctx.flags.str('created-by');
    const sourceFlag = ctx.flags.str('source');
    const yes = ctx.flags.bool('yes');
    if (ctx.positionals.length === 0 && createdBy === undefined && sourceFlag === undefined) {
      throw new VaultError('INVALID_ARGUMENT', 'nothing to forget', 'pass ids, --created-by <label> or --source <src_id>');
    }
    const store = ctx.openStore();
    try {
      const memories = new Set<string>();
      const sources = new Set<string>();
      const notFound: string[] = [];
      for (const id of ctx.positionals) {
        if (MEM_RE.test(id)) {
          if (store.getMemory(id) !== undefined) memories.add(id);
          else notFound.push(id);
        } else if (SRC_RE.test(id)) {
          if (store.getSourceMeta(id) !== undefined) sources.add(id);
          else notFound.push(id);
        } else {
          throw new VaultError('INVALID_ARGUMENT', `"${id}" is not a memory (mem_…) or source (src_…) id`);
        }
      }
      if (createdBy !== undefined) for (const m of store.listMemories({ createdBy, status: 'all' })) memories.add(m.id);
      if (sourceFlag !== undefined) {
        if (!SRC_RE.test(sourceFlag)) throw new VaultError('INVALID_ARGUMENT', `--source expects a src_ id, got "${sourceFlag}"`);
        if (store.getSourceMeta(sourceFlag) === undefined) notFound.push(sourceFlag);
        else {
          sources.add(sourceFlag);
          for (const m of store.listMemories({ status: 'all' })) if (m.sources.some((s) => s.sourceId === sourceFlag)) memories.add(m.id);
        }
      }
      const total = memories.size + sources.size;
      if (total === 0) {
        if (ctx.json) ctx.print(`${JSON.stringify({ forgotten: [], notFound })}\n`);
        else ctx.print(`nothing to forget${notFound.length > 0 ? ` (not found: ${notFound.join(', ')})` : ''}\n`);
        return 0;
      }
      if (!yes) {
        if (!ctx.io.isTTY) {
          throw new VaultError('INVALID_ARGUMENT', `refusing to forget ${total} record${total === 1 ? '' : 's'} without confirmation (no terminal)`, 'pass --yes');
        }
        for (const id of memories) ctx.print(`  ${id}  "${store.getMemory(id)?.statement ?? ''}"\n`);
        for (const id of sources) ctx.print(`  ${id}  "${store.getSourceMeta(id)?.title ?? ''}"\n`);
        if (!ctx.confirm(`Forget ${total} record${total === 1 ? '' : 's'}? This cannot be undone. [y/N] `)) {
          ctx.print('aborted; nothing forgotten\n');
          return 0;
        }
      }
      const forgottenMemories = memories.size > 0 ? store.deleteMemories([...memories]) : [];
      const forgottenSources = sources.size > 0 ? store.deleteSources([...sources]) : [];
      const forgotten = [...forgottenMemories, ...forgottenSources];
      ctx.audit(store, 'forget', { ids: ctx.positionals, createdBy, source: sourceFlag, forgotten: forgotten.length, notFound }, { ids: forgotten.slice(0, 50), count: forgotten.length });
      if (ctx.json) {
        ctx.print(`${JSON.stringify({ forgotten, notFound })}\n`);
        return 0;
      }
      ctx.print(`forgotten: ${forgottenMemories.length} memor${forgottenMemories.length === 1 ? 'y' : 'ies'}, ${forgottenSources.length} source${forgottenSources.length === 1 ? '' : 's'}\n`);
      for (const id of forgotten) ctx.info(`  ${id}\n`);
      if (notFound.length > 0) ctx.print(`not found: ${notFound.join(', ')}\n`);
      ctx.info('tip: run `opencontext-vault rekey` after a sensitive deletion so the old ciphertext cannot be opened from backups\n');
      return 0;
    } finally {
      store.close();
    }
  },
};
