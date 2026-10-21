import { VaultError } from '../../errors.js';
import type { VaultStore } from '../../store/vault-store.js';
import type { Memory, Source, SourceMeta } from '../../types.js';
import type { Command, CommandContext } from '../args.js';
import { renderPairs, truncate } from '../table.js';

const TURNS_SHOWN = 20;
const TURN_CHARS = 400;
const DOC_CHARS = 2000;

/** Older versions first (through `supersedes`), then this one, then newer ones (through `supersededBy`); cycles are cut by the seen set. */
function versionChain(store: VaultStore, m: Memory): Memory[] {
  const older: Memory[] = [];
  const seen = new Set<string>([m.id]);
  for (let cur = m.supersedes; cur !== undefined && !seen.has(cur); ) {
    const prev = store.getMemory(cur);
    if (prev === undefined) break;
    seen.add(cur);
    older.unshift(prev);
    cur = prev.supersedes;
  }
  const newer: Memory[] = [];
  for (let cur = m.supersededBy; cur !== undefined && !seen.has(cur); ) {
    const next = store.getMemory(cur);
    if (next === undefined) break;
    seen.add(cur);
    newer.push(next);
    cur = next.supersededBy;
  }
  return [...older, m, ...newer];
}

/** Provenance rows resolved the way vault_search reports them (title null when forgotten; self-attested when the author supplied the source). */
function provenance(store: VaultStore, m: Memory): Array<{ sourceId: string; title: string | null; type: string | null; trust: string | null; turn?: number; quote?: string; verified: boolean; selfAttested: boolean }> {
  return m.sources.map((ref) => {
    const meta = store.getSourceMeta(ref.sourceId);
    return {
      sourceId: ref.sourceId,
      title: meta?.title ?? null,
      type: meta?.type ?? null,
      trust: meta?.origin.trust ?? null,
      ...(ref.turn !== undefined ? { turn: ref.turn } : {}),
      ...(ref.quote !== undefined ? { quote: ref.quote } : {}),
      verified: ref.verified,
      selfAttested: meta !== undefined && meta.origin.trust === 'agent-supplied' && meta.origin.path === m.createdBy,
    };
  });
}

function showMemory(ctx: CommandContext, store: VaultStore, m: Memory): void {
  const prov = provenance(store, m);
  const versions = versionChain(store, m);
  if (ctx.json) {
    ctx.print(`${JSON.stringify({ ...m, provenance: prov, versions: versions.map((v) => ({ id: v.id, status: v.status, updatedAt: v.updatedAt })) })}\n`);
    return;
  }
  ctx.print(`${m.id}  ${m.kind} [${m.confidence}]  ${m.status}\n  "${m.statement}"\n`);
  const pairs: Array<[string, string]> = [
    ['  subject', m.subject],
    ['  tags', m.tags.length > 0 ? m.tags.join(', ') : '-'],
    ['  created', `${m.createdAt} by ${m.createdBy}`],
    ['  updated', m.updatedAt],
  ];
  if (m.validFrom !== undefined || m.validUntil !== undefined) pairs.push(['  valid', `${m.validFrom ?? '…'} → ${m.validUntil ?? '…'}`]);
  ctx.print(renderPairs(pairs));
  if (prov.length === 0) ctx.print('  sources   none (told to the agent directly)\n');
  else {
    ctx.print('  sources\n');
    for (const p of prov) {
      const title = p.title === null ? '(forgotten)' : `"${truncate(p.title, 60)}" (${p.type}, ${p.trust})`;
      const flags = [p.verified ? 'verified ✓' : 'unverified', ...(p.selfAttested ? ['self-attested ⚠'] : [])].join(', ');
      ctx.print(`    ${p.sourceId}  ${title}${p.turn !== undefined ? `  turn ${p.turn}` : ''}  ${flags}\n`);
      if (p.quote !== undefined) ctx.print(`      quote: "${p.quote}"\n`);
    }
  }
  if (versions.length > 1) {
    ctx.print('  versions\n');
    for (const v of versions) ctx.print(`    ${v.id}  ${v.status}  ${v.updatedAt}${v.id === m.id ? '  ← shown' : ''}\n`);
  }
}

function showSource(ctx: CommandContext, store: VaultStore, meta: SourceMeta): void {
  const source: Source | undefined = store.getSource(meta.id);
  if (source === undefined) throw new VaultError('CORRUPT', `source body missing: ${meta.id}`, 'run: opencontext-vault verify');
  const content = source.content;
  if (ctx.json) {
    const body = content.kind === 'conversation' ? { kind: content.kind, turns: content.turns.slice(0, TURNS_SHOWN), totalTurns: content.turns.length } : { kind: content.kind, mediaType: content.mediaType, text: content.text.slice(0, DOC_CHARS), totalChars: content.text.length };
    ctx.print(`${JSON.stringify({ ...meta, content: body })}\n`);
    return;
  }
  ctx.print(`${meta.id}  ${meta.type} ${meta.kind}  "${meta.title}"\n`);
  const review = `${meta.review.status}${meta.review.at !== undefined ? ` at ${meta.review.at}` : ''}${meta.review.by !== undefined ? ` by ${meta.review.by}` : ''}${meta.review.memoriesCreated !== undefined ? `, ${meta.review.memoriesCreated} memories` : ''}${meta.review.note !== undefined ? ` — ${meta.review.note}` : ''}`;
  ctx.print(
    renderPairs([
      ['  origin', `${meta.origin.importer}  ${meta.origin.path}  external ${meta.origin.externalId}  trust ${meta.origin.trust}`],
      ['  tags', meta.tags.length > 0 ? meta.tags.join(', ') : '-'],
      ['  created', meta.createdAt],
      ['  imported', meta.importedAt],
      ['  size', `${meta.turnCount} turn${meta.turnCount === 1 ? '' : 's'}, ${meta.bytes} bytes, raw ${meta.hasRaw ? 'kept' : 'absent'}`],
      ['  review', review],
      ...(meta.notes.length > 0 ? ([['  notes', meta.notes.join('; ')]] as Array<[string, string]>) : []),
    ]),
  );
  if (content.kind === 'document') {
    ctx.print(`  text (${content.mediaType}${content.text.length > DOC_CHARS ? `, first ${DOC_CHARS} of ${content.text.length} chars` : ''})\n`);
    ctx.print(`${content.text.slice(0, DOC_CHARS).replace(/^/gm, '    ')}\n`);
    return;
  }
  const shown = content.turns.slice(0, TURNS_SHOWN);
  ctx.print(`  turns${content.turns.length > shown.length ? ` (first ${shown.length} of ${content.turns.length})` : ''}\n`);
  for (const t of shown) {
    const omitted = t.omitted !== undefined && t.omitted.length > 0 ? ` [omitted: ${t.omitted.join(', ')}]` : '';
    ctx.print(`    ${t.i} ${t.role}: ${truncate(t.text, TURN_CHARS)}${omitted}\n`);
  }
}

/** `show`: one memory with full provenance and its version chain, or one source with its metadata and first turns. */
export const show: Command = {
  spec: {
    name: 'show',
    args: '<id>',
    summary: 'Show a memory with provenance and versions, or a source with its first turns',
    details:
      'For a mem_ id: statement, subject, tags, author, every cited source with title, turn, verbatim quote, whether the quote was found in the cited turn, and whether the source was supplied by the same client that wrote the memory (self-attested); then the supersede chain. For a src_ id: metadata (origin, trust, review state, notes) and the first 20 turns (or the first 2000 chars of a document).',
    flags: [],
  },
  run(ctx: CommandContext): number {
    const id = ctx.positionals[0];
    if (id === undefined || ctx.positionals.length !== 1) throw new VaultError('INVALID_ARGUMENT', 'show takes exactly one id (mem_… or src_…)');
    const store = ctx.openStore();
    try {
      if (id.startsWith('mem_')) {
        const m = store.getMemory(id);
        if (m === undefined) throw new VaultError('NOT_FOUND', `no memory ${id}`, 'run: opencontext-vault list --status all');
        showMemory(ctx, store, m);
        return 0;
      }
      if (id.startsWith('src_')) {
        const meta = store.getSourceMeta(id);
        if (meta === undefined) throw new VaultError('NOT_FOUND', `no source ${id}`, 'run: opencontext-vault sources');
        showSource(ctx, store, meta);
        return 0;
      }
      throw new VaultError('INVALID_ARGUMENT', `"${id}" is not a memory (mem_…) or source (src_…) id`);
    } finally {
      store.close();
    }
  },
};
