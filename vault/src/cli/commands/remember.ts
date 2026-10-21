import { looksLikeSecret } from '../../access/secrets.js';
import { VaultError } from '../../errors.js';
import { newId, nowIso } from '../../ids.js';
import { Confidence, LIMITS, MemoryKind, type Memory } from '../../types.js';
import { normalizeTags } from '../../util/text.js';
import type { Command, CommandContext } from '../args.js';

/** `remember`: the owner writes a memory directly (createdBy "cli"); no scope check, same validation and dedup as vault_remember. */
export const remember: Command = {
  spec: {
    name: 'remember',
    args: '',
    summary: 'Store a memory yourself (createdBy "cli")',
    details:
      'One sentence in third person ("User prefers …"), no newlines, max 500 chars. Secret-looking statements (API keys, tokens, "password: …") are refused with SECRET_DETECTED. An active memory with the same normalized statement and subject is reported instead of duplicated. Logged in the audit journal as a cli event.',
    flags: [
      { name: 'kind', type: 'string', placeholder: MemoryKind.options.join('|'), help: 'what kind of memory (required)' },
      { name: 'statement', type: 'string', placeholder: '<sentence>', help: 'the memory (required)' },
      { name: 'subject', type: 'string', placeholder: '<who>', help: 'default "user"; a name or "project:<name>"' },
      { name: 'tag', type: 'string', multiple: true, placeholder: '<tag>', help: 'tag (repeatable)' },
      { name: 'confidence', type: 'string', placeholder: Confidence.options.join('|'), help: 'default stated' },
    ],
  },
  run(ctx: CommandContext): number {
    const kind = ctx.flags.choice('kind', MemoryKind.options);
    const statement = ctx.flags.str('statement')?.trim();
    if (kind === undefined) throw new VaultError('INVALID_ARGUMENT', '--kind is required', `one of: ${MemoryKind.options.join(', ')}`);
    if (statement === undefined || statement === '') throw new VaultError('INVALID_ARGUMENT', '--statement is required');
    if (/[\r\n]/.test(statement)) throw new VaultError('INVALID_ARGUMENT', 'the statement must be one line');
    if (statement.length > LIMITS.statement) throw new VaultError('INVALID_ARGUMENT', `the statement is longer than ${LIMITS.statement} chars`);
    const secret = looksLikeSecret(statement);
    if (secret !== null) throw new VaultError('SECRET_DETECTED', `the statement looks like a secret (${secret})`, 'the vault never stores passwords, keys or tokens');
    const subject = ctx.flags.str('subject')?.trim() || 'user';
    const tags = normalizeTags(ctx.flags.list('tag'));
    const confidence = ctx.flags.choice('confidence', Confidence.options) ?? 'stated';
    const store = ctx.openStore();
    try {
      const existing = store.findDuplicate(statement, subject);
      if (existing !== undefined) {
        if (ctx.json) ctx.print(`${JSON.stringify({ memory: existing, deduplicated: true })}\n`);
        else ctx.print(`${existing.id}  already stored (${existing.kind}, ${existing.confidence}, by ${existing.createdBy}); nothing written\n`);
        return 0;
      }
      const at = nowIso(ctx.now);
      const memory: Memory = {
        id: newId('mem'),
        kind,
        statement,
        subject,
        tags,
        confidence,
        sources: [],
        createdAt: at,
        updatedAt: at,
        createdBy: 'cli',
        status: 'active',
      };
      const stored = store.putMemory(memory);
      ctx.audit(store, 'remember', { id: stored.id, kind, subject, tags, confidence }, { ids: [stored.id], count: 1 });
      if (ctx.json) ctx.print(`${JSON.stringify({ memory: stored, deduplicated: false })}\n`);
      else ctx.print(`${stored.id}  ${kind} [${confidence}]  "${statement}"\n`);
      return 0;
    } finally {
      store.close();
    }
  },
};
