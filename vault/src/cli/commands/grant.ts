import { hashToken, newToken } from '../../crypto/token.js';
import { VaultError } from '../../errors.js';
import { newId, nowIso } from '../../ids.js';
import { ALL_SCOPES, Label, type Grant, type Scope } from '../../types.js';
import { normalizeTags } from '../../util/text.js';
import type { Command, CommandContext } from '../args.js';
import { CLIENT_KINDS, parseClientKind, renderAllSnippets, renderSnippet } from '../snippets.js';

/** Validate a grant label against the shared Label shape so the CLI and the store agree. */
function parseLabel(value: string | undefined): string {
  if (value === undefined || value === '') throw new VaultError('INVALID_ARGUMENT', 'a label is required', 'example: opencontext-vault grant claude-desktop --scopes read,write');
  if (!Label.safeParse(value).success) {
    throw new VaultError('INVALID_ARGUMENT', `invalid label "${value}"`, 'labels are 1-40 chars of lowercase letters, digits and hyphens, starting with a letter or digit');
  }
  return value;
}

/** Scopes in canonical order (read, write, sources, forget, instruct), deduplicated; an unknown name is INVALID_ARGUMENT. */
function parseScopes(values: string[]): Scope[] {
  const wanted = new Set<string>();
  for (const v of values) {
    const s = v.trim().toLowerCase();
    if (!(ALL_SCOPES as readonly string[]).includes(s)) {
      throw new VaultError('INVALID_ARGUMENT', `unknown scope "${v}"`, `scopes are: ${ALL_SCOPES.join(', ')}`);
    }
    wanted.add(s);
  }
  return ALL_SCOPES.filter((s) => wanted.has(s));
}

/** `grant`: mint a token for one MCP client. The token is printed once and never stored (only its hash is). */
export const grant: Command = {
  spec: {
    name: 'grant',
    args: '<label>',
    summary: 'Mint a token for an MCP client and print its config snippet',
    details:
      'Creates a grant named <label> with the given scopes, mints an ocv_ token, stores only its hash and prints the token exactly once. With --client the token is embedded in a ready-to-paste config snippet (absolute node and dist/cli.js paths). --rotate replaces the token of an existing label; the old token is denied on its very next call. Scope read covers memories, write lets the client store memories, sources exposes raw conversations, forget allows deletion, instruct allows standing instructions. Logged in the audit journal as a cli event (label, scopes and tags only).',
    flags: [
      { name: 'scopes', type: 'string', placeholder: 'read,write[,sources,forget,instruct]', help: 'scopes to grant (default read,write)' },
      { name: 'tags', type: 'string', placeholder: '<a,b>', help: 'restrict what the client reads to records carrying one of these tags; its writes always carry them (it may add tags of its own)' },
      { name: 'note', type: 'string', placeholder: '<text>', help: 'free-text note stored with the grant (max 200 chars)' },
      { name: 'rotate', type: 'boolean', help: 'replace the token of an existing label (scopes/tags/note are kept unless given again)' },
      { name: 'client', type: 'string', placeholder: `${CLIENT_KINDS.join('|')}|all`, help: 'also print the config snippet for this MCP host (all: every host, with the token shown once above them)' },
    ],
  },
  run(ctx: CommandContext): number {
    const label = parseLabel(ctx.positionals[0]);
    if (ctx.positionals.length > 1) throw new VaultError('INVALID_ARGUMENT', 'grant takes exactly one label');
    const rotate = ctx.flags.bool('rotate');
    const clientFlag = ctx.flags.str('client');
    const clientKind = clientFlag === undefined || clientFlag === 'all' ? undefined : parseClientKind(clientFlag);
    const scopesGiven = ctx.flags.has('scopes') ? parseScopes(ctx.flags.list('scopes')) : undefined;
    const tagsGiven = ctx.flags.has('tags') ? normalizeTags(ctx.flags.list('tags')) : undefined;
    const noteGiven = ctx.flags.str('note');
    if (noteGiven !== undefined && noteGiven.length > 200) throw new VaultError('INVALID_ARGUMENT', 'note is longer than 200 chars');

    const store = ctx.openStore();
    try {
      const existing = store.getGrantByLabel(label);
      if (existing !== undefined && !rotate) {
        throw new VaultError('EXISTS', `a grant labelled "${label}" already exists`, `run: opencontext-vault grant ${label} --rotate (new token) or opencontext-vault revoke ${label}`);
      }
      if (existing === undefined && rotate) {
        throw new VaultError('NOT_FOUND', `no grant labelled "${label}" to rotate`, `run: opencontext-vault grant ${label} --scopes read,write`);
      }
      const scopes = scopesGiven ?? existing?.scopes ?? (['read', 'write'] as Scope[]);
      if (scopes.length === 0) throw new VaultError('INVALID_ARGUMENT', 'at least one scope is required');
      const tags = tagsGiven ?? existing?.tags;
      const note = noteGiven ?? existing?.note;
      const token = newToken();
      const record: Grant = {
        id: existing?.id ?? newId('grt'),
        label,
        tokenHash: hashToken(token),
        scopes,
        ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
        createdAt: existing?.createdAt ?? nowIso(ctx.now),
        ...(note !== undefined && note !== '' ? { note } : {}),
      };
      store.putGrant(record);
      ctx.audit(store, 'grant', { label, scopes, tags: tags ?? [], rotate }, { ids: [record.id] });

      const snippets: Record<string, string> = {};
      if (clientKind !== undefined) snippets[clientKind] = renderSnippet(clientKind, token, ctx.io.execPath, ctx.cliPath);
      else if (clientFlag === 'all') for (const k of CLIENT_KINDS) snippets[k] = renderSnippet(k, '<TOKEN>', ctx.io.execPath, ctx.cliPath);

      if (ctx.json) {
        ctx.print(`${JSON.stringify({ label, id: record.id, scopes, tags: tags ?? [], rotated: rotate, token, snippets })}\n`);
        return 0;
      }
      ctx.print(`granted: ${scopes.join(', ')}\n`);
      ctx.print(`label:   ${label}${rotate ? ' (token rotated; the old token is now denied)' : ''}\n`);
      if (tags !== undefined && tags.length > 0) ctx.print(`tags:    ${tags.join(', ')}\n`);
      if (clientKind !== undefined) {
        ctx.print(`token:   shown once, inside the snippet below; it is not stored and cannot be recovered\n\n`);
        ctx.print(snippets[clientKind] ?? '');
      } else {
        ctx.print(`token:   ${token}\n`);
        ctx.info(`         shown once; not stored; put it in the client's MCP config as OPENCONTEXT_VAULT_TOKEN\n`);
        if (clientFlag === 'all') {
          ctx.print(`\n`);
          ctx.print(renderAllSnippets('<TOKEN>', ctx.io.execPath, ctx.cliPath).replace(/\n$/, ''));
          ctx.info(`\n(replace <TOKEN> with the token above)\n`);
        }
      }
      return 0;
    } finally {
      store.close();
    }
  },
};
