import { looksLikeToken } from '../../crypto/token.js';
import { runStdioServer } from '../../mcp/server.js';
import type { Command, CommandContext } from '../args.js';

/** `serve`: the MCP server over stdio. stdout is the protocol, so every diagnostic of this command goes to stderr. */
export const serve: Command = {
  spec: {
    name: 'serve',
    args: '',
    summary: 'Run the MCP server on stdio (what the client config launches)',
    details:
      'Loads the key, opens the vault, builds the memory index, answers MCP over stdin/stdout and builds the source index in the background. The client token comes from OPENCONTEXT_VAULT_TOKEN (preferred) or --token; without a valid token only vault_status answers. In passphrase mode set OPENCONTEXT_VAULT_PASSPHRASE_CMD (or OPENCONTEXT_VAULT_PASSPHRASE) in the client config: serve never prompts. Exits 0 when the client closes the pipe.',
    flags: [{ name: 'token', type: 'string', placeholder: '<token>', help: 'client token (visible in the process list; prefer the OPENCONTEXT_VAULT_TOKEN environment variable)' }],
  },
  async run(ctx: CommandContext): Promise<number> {
    const flagToken = ctx.flags.str('token');
    const raw = flagToken ?? ctx.io.env.OPENCONTEXT_VAULT_TOKEN;
    const token = raw !== undefined && raw.trim() !== '' ? raw.trim() : undefined;
    if (flagToken !== undefined) ctx.warn('warning: --token is visible to other processes on this machine; prefer OPENCONTEXT_VAULT_TOKEN\n');
    if (token !== undefined && !looksLikeToken(token)) {
      ctx.warn('warning: the token does not look like a vault token (ocv_ + 32 chars); serving without a grant\n');
    }
    // runStdioServer resolves when the client closes the pipe (it watches stdin 'end' itself) or on SIGINT/SIGTERM;
    // either way session_end is logged, the session file is removed and the process exits 0.
    await runStdioServer({
      dir: ctx.vaultDir,
      keyFile: ctx.keyFile,
      token,
      passphrase: ctx.passphrase({ prompt: false }),
      version: ctx.version,
    });
    return 0;
  },
};
