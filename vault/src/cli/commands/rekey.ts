import { readFileSync } from 'node:fs';
import { VaultError } from '../../errors.js';
import { liveSessions } from '../../store/sessions.js';
import type { Command, CommandContext } from '../args.js';

/** The new passphrase for --new-passphrase: a file (scriptable), else a double masked prompt so a typo cannot lock the vault forever. */
function newPassphraseOf(ctx: CommandContext): string | undefined {
  const file = ctx.flags.str('new-passphrase-file');
  if (file !== undefined) {
    let value: string;
    try {
      value = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      throw new VaultError('IO', `cannot read --new-passphrase-file ${file}: ${(err as Error).message}`);
    }
    if (value === '') throw new VaultError('INVALID_ARGUMENT', 'the new passphrase is empty');
    return value;
  }
  if (!ctx.flags.bool('new-passphrase')) return undefined;
  const prompt = ctx.io.prompt;
  if (!ctx.io.isTTY || prompt === undefined) {
    throw new VaultError('INVALID_ARGUMENT', '--new-passphrase needs a terminal to ask on', 'pass --new-passphrase-file <path> instead');
  }
  const first = prompt('New passphrase: ', true);
  if (first === '') throw new VaultError('INVALID_ARGUMENT', 'the new passphrase is empty');
  const second = prompt('Repeat new passphrase: ', true);
  if (first !== second) throw new VaultError('INVALID_ARGUMENT', 'the passphrases do not match');
  return first;
}

/** `rekey`: a fresh data key; everything is re-sealed under the lock and other processes pick the key up on their next call. */
export const rekey: Command = {
  spec: {
    name: 'rekey',
    args: '',
    summary: 'Generate a new data key and re-encrypt every journal and body',
    details:
      'Runs entirely under the vault lock: every source body is checked to be readable, the new key is staged next to the key file (<key file>.next), journals are rewritten with new generations, every source body is re-sealed, then the manifest and the key file are replaced. An interrupted rekey is finished by the next command that opens the vault, because both keys stay on disk until the switch is complete. Running servers reload the key automatically (they read the passphrase from the same environment they started with). In passphrase mode the current passphrase is asked for once (or taken from the usual sources) and proven against the key file before anything is re-sealed; --new-passphrase changes it (asked twice on a terminal, or read from --new-passphrase-file). Logged in the audit journal as a cli event.',
    flags: [
      { name: 'new-passphrase', type: 'boolean', help: 'wrap the new key under a different passphrase: asked twice on a terminal, else read from --new-passphrase-file (also turns a plain key file into a passphrase-protected one)' },
      { name: 'new-passphrase-file', type: 'string', placeholder: '<path>', help: 'read the new passphrase from this file (one line)' },
    ],
  },
  run(ctx: CommandContext): number {
    const store = ctx.openStore();
    try {
      const newPassphrase = newPassphraseOf(ctx);
      const sessions = liveSessions(ctx.vaultDir);
      if (sessions.length > 0) {
        ctx.warn(`${sessions.length} live server process${sessions.length === 1 ? '' : 'es'} (pid ${sessions.map((s) => s.pid).join(', ')}) will reload the key on their next call\n`);
      }
      const oldKeyId = store.keyId;
      store.rekey(ctx.passphrase(), newPassphrase !== undefined ? { newPassphrase } : undefined);
      ctx.audit(store, 'rekey', { oldKeyId, keyId: store.keyId, liveSessions: sessions.length, passphraseChanged: newPassphrase !== undefined });
      if (ctx.json) ctx.print(`${JSON.stringify({ oldKeyId, keyId: store.keyId, liveSessions: sessions.length, passphraseChanged: newPassphrase !== undefined })}\n`);
      else ctx.print(`rekeyed: key ${oldKeyId} → ${store.keyId}; key file and manifest rewritten${newPassphrase !== undefined ? '; passphrase changed' : ''}\n`);
      return 0;
    } finally {
      store.close();
    }
  },
};
