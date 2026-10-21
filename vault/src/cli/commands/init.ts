import { resolvePassphrase } from '../../crypto/keyfile.js';
import { VaultError } from '../../errors.js';
import { VaultStore } from '../../store/vault-store.js';
import type { Command, CommandContext } from '../args.js';
import { renderPairs } from '../table.js';

/** Passphrase for a NEW key: file/env/command first (scriptable), else a double masked prompt so a typo cannot lock the vault forever. */
function newPassphrase(ctx: CommandContext): string {
  const fromSource = resolvePassphrase(ctx.passphrase({ prompt: false }));
  if (fromSource !== undefined) {
    if (fromSource === '') throw new VaultError('INVALID_ARGUMENT', 'the passphrase is empty');
    return fromSource;
  }
  const prompt = ctx.io.prompt;
  if (!ctx.io.isTTY || prompt === undefined) {
    throw new VaultError('INVALID_ARGUMENT', '--passphrase needs a passphrase and there is no terminal to ask on', 'set OPENCONTEXT_VAULT_PASSPHRASE or pass --passphrase-file <path>');
  }
  const first = prompt('New passphrase: ', true);
  if (first === '') throw new VaultError('INVALID_ARGUMENT', 'the passphrase is empty');
  const second = prompt('Repeat passphrase: ', true);
  if (first !== second) throw new VaultError('INVALID_ARGUMENT', 'the passphrases do not match');
  return first;
}

/** `init`: a new vault directory, manifest, four journals and the key file (a sibling of the directory by default). */
export const init: Command = {
  spec: {
    name: 'init',
    args: '',
    summary: 'Create a new vault and its key file',
    details:
      'Creates the vault directory (mode 0700), the plaintext manifest, four empty encrypted journals and the key file (mode 0600, a sibling of the vault directory so the directory can be backed up without the key). Fails with EXISTS if the directory already holds a vault. On Windows file permissions are not enforced.',
    flags: [
      {
        name: 'passphrase',
        type: 'boolean',
        help: 'wrap the key with a passphrase (scrypt N=2^17); asks twice on a terminal, else uses OPENCONTEXT_VAULT_PASSPHRASE, OPENCONTEXT_VAULT_PASSPHRASE_CMD or --passphrase-file',
      },
    ],
  },
  run(ctx: CommandContext): number {
    const passphrase = ctx.flags.bool('passphrase') ? newPassphrase(ctx) : undefined;
    const store = VaultStore.init({
      dir: ctx.vaultDir,
      keyFile: ctx.keyFile,
      ...(passphrase !== undefined ? { passphraseForNewKey: passphrase } : {}),
      onWarn: ctx.warn,
      now: ctx.now,
    });
    try {
      const kdf = passphrase !== undefined ? 'scrypt' : 'none';
      if (ctx.json) {
        ctx.print(`${JSON.stringify({ vaultDir: ctx.vaultDir, keyFile: ctx.keyFile, vaultId: store.vaultId, keyId: store.keyId, kdf })}\n`);
        return 0;
      }
      const win32 = process.platform === 'win32';
      ctx.print(
        renderPairs([
          ['vault', `${ctx.vaultDir}${win32 ? '' : ' (0700)'}`],
          ['key', `${ctx.keyFile}${win32 ? '' : ' (0600)'} — ${kdf === 'scrypt' ? 'passphrase-protected (scrypt)' : 'plain key file; enable full-disk encryption'}; never leaves your machine`],
        ]),
      );
      if (win32) ctx.warn('note: file permissions are not enforced on Windows\n');
      ctx.info(
        `next   opencontext-vault import <chatgpt or claude export folder, Google Takeout JSON, or a folder of .md>\n` +
          `       opencontext-vault grant claude-desktop --scopes read,write,sources --client claude-desktop\n`,
      );
      return 0;
    } finally {
      store.close();
    }
  },
};
