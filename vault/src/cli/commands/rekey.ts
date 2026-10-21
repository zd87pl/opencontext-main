import { liveSessions } from '../../store/sessions.js';
import type { Command, CommandContext } from '../args.js';

/** `rekey`: a fresh data key; everything is re-sealed under the lock and other processes pick the key up on their next call. */
export const rekey: Command = {
  spec: {
    name: 'rekey',
    args: '',
    summary: 'Generate a new data key and re-encrypt every journal and body',
    details:
      'Runs entirely under the vault lock: journals are rewritten with new generations, every source body is re-sealed, then the key file and manifest are replaced. Running servers reload the key automatically (they read the passphrase from the same environment they started with). In passphrase mode the passphrase is asked for (or taken from the usual sources). Logged in the audit journal as a cli event.',
    flags: [],
  },
  run(ctx: CommandContext): number {
    const store = ctx.openStore();
    try {
      const sessions = liveSessions(ctx.vaultDir);
      if (sessions.length > 0) {
        ctx.warn(`${sessions.length} live server process${sessions.length === 1 ? '' : 'es'} (pid ${sessions.map((s) => s.pid).join(', ')}) will reload the key on their next call\n`);
      }
      const oldKeyId = store.keyId;
      store.rekey(ctx.passphrase());
      ctx.audit(store, 'rekey', { oldKeyId, keyId: store.keyId, liveSessions: sessions.length });
      if (ctx.json) ctx.print(`${JSON.stringify({ oldKeyId, keyId: store.keyId, liveSessions: sessions.length })}\n`);
      else ctx.print(`rekeyed: key ${oldKeyId} → ${store.keyId}; key file and manifest rewritten\n`);
      return 0;
    } finally {
      store.close();
    }
  },
};
