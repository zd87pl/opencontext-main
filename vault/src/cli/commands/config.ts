import { looksLikeToken } from '../../crypto/token.js';
import { VaultError } from '../../errors.js';
import type { Command, CommandContext } from '../args.js';
import { CLIENT_KINDS, parseClientKind, renderAllSnippets, renderSnippet } from '../snippets.js';

/** `config`: reprint a client's config snippet. Tokens are not recoverable, so the placeholder is used unless --token is given. */
export const config: Command = {
  spec: {
    name: 'config',
    args: '<label>',
    summary: 'Print the MCP config snippet for an existing grant',
    details:
      'Prints the snippet(s) for the grant with the given label using absolute paths for node and dist/cli.js. Tokens are stored only as hashes, so the snippet shows <TOKEN> unless you pass --token; to get a new token run grant --rotate.',
    flags: [
      { name: 'client', type: 'string', placeholder: `${CLIENT_KINDS.join('|')}|all`, help: 'which host to print for (default all)' },
      { name: 'token', type: 'string', placeholder: '<token>', help: 'embed this token instead of the <TOKEN> placeholder' },
    ],
  },
  run(ctx: CommandContext): number {
    const label = ctx.positionals[0];
    if (label === undefined || ctx.positionals.length !== 1) throw new VaultError('INVALID_ARGUMENT', 'config takes exactly one label', 'run: opencontext-vault clients');
    const clientFlag = ctx.flags.str('client') ?? 'all';
    const kind = clientFlag === 'all' ? undefined : parseClientKind(clientFlag);
    const token = ctx.flags.str('token');
    if (token !== undefined && !looksLikeToken(token)) throw new VaultError('INVALID_ARGUMENT', 'the given token does not look like a vault token (ocv_ + 32 chars)');
    const store = ctx.openStore();
    try {
      const existing = store.getGrantByLabel(label);
      if (existing === undefined) throw new VaultError('NOT_FOUND', `no grant labelled "${label}"`, `run: opencontext-vault grant ${label} --scopes read,write --client <kind>`);
    } finally {
      store.close();
    }
    const value = token ?? '<TOKEN>';
    const text = kind === undefined ? renderAllSnippets(value, ctx.io.execPath, ctx.cliPath) : renderSnippet(kind, value, ctx.io.execPath, ctx.cliPath);
    if (ctx.json) {
      const snippets: Record<string, string> = {};
      for (const k of kind === undefined ? CLIENT_KINDS : [kind]) snippets[k] = renderSnippet(k, value, ctx.io.execPath, ctx.cliPath);
      ctx.print(`${JSON.stringify({ label, snippets })}\n`);
      return 0;
    }
    ctx.print(text);
    if (token === undefined) ctx.info(`(replace <TOKEN> with the token printed by grant; run: opencontext-vault grant ${label} --rotate for a new one)\n`);
    return 0;
  },
};
