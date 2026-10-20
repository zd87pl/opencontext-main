/**
 * Normalise an unknown thrown value to a message string.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : String(error);
}

/**
 * Whether an error corresponds to a named custom Solidity error.
 *
 * ethers v6 decodes custom reverts into `revert.name` / `reason` when the
 * error fragment is part of the contract ABI. The message check covers
 * providers that only surface the revert as text, and plain `Error`s.
 */
export function isRevertError(error: unknown, name: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const e = error as { message?: unknown; reason?: unknown; revert?: { name?: unknown } | null };
  if (e.revert?.name === name || e.reason === name) {
    return true;
  }
  return typeof e.message === 'string' && e.message.includes(name);
}
