import { VaultError } from '../../errors.js';
import type { Command, CommandContext } from '../args.js';

/** `revoke`: delete a grant; the journal is compacted so the revoked hash leaves the live file. */
export const revoke: Command = {
  spec: {
    name: 'revoke',
    args: '<label>',
    summary: "Delete a client's grant; it is denied on its next call",
    details:
      'Removes the grant and compacts the grants journal. A server process started with that token keeps running but every further call is denied (grants are resolved on every call, never cached). Logged in the audit journal as a cli event.',
    flags: [],
  },
  run(ctx: CommandContext): number {
    const label = ctx.positionals[0];
    if (label === undefined || ctx.positionals.length !== 1) throw new VaultError('INVALID_ARGUMENT', 'revoke takes exactly one label', 'run: opencontext-vault clients');
    const store = ctx.openStore();
    try {
      const existing = store.getGrantByLabel(label);
      if (existing === undefined) throw new VaultError('NOT_FOUND', `no grant labelled "${label}"`, 'run: opencontext-vault clients');
      store.deleteGrant(existing.id);
      ctx.audit(store, 'revoke', { label }, { ids: [existing.id] });
      if (ctx.json) ctx.print(`${JSON.stringify({ label, id: existing.id, revoked: true })}\n`);
      else ctx.print(`revoked: ${label} (running clients are denied on their next call)\n`);
      return 0;
    } finally {
      store.close();
    }
  },
};
