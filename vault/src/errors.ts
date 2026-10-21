export type VaultErrorCode =
  | 'DENIED'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'EXISTS'
  | 'SECRET_DETECTED'
  | 'TOO_LARGE'
  | 'LOCKED'
  | 'VAULT_NOT_FOUND'
  | 'KEY_NOT_FOUND'
  | 'KEY_LOCKED'
  | 'BAD_KEY'
  | 'CORRUPT'
  | 'UNSUPPORTED'
  | 'IO';

/**
 * The only error type that crosses module boundaries. `hint` is a one-line, copy-pasteable fix
 * (usually a CLI command) that tool results and CLI output show to the user. Never put key material,
 * tokens, passphrases, memory statements or source text into `message` or `hint`.
 */
export class VaultError extends Error {
  constructor(
    public readonly code: VaultErrorCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'VaultError';
  }
  /** Exit code for the CLI: 2 for VaultError, 3 for anything else. */
  static exitCode(err: unknown): number {
    return err instanceof VaultError ? 2 : 3;
  }
  static is(err: unknown, code?: VaultErrorCode): err is VaultError {
    return err instanceof VaultError && (code === undefined || err.code === code);
  }
}
