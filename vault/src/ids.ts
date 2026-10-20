import { createHash, randomBytes } from 'node:crypto';

export type IdPrefix = 'mem' | 'src' | 'grt' | 'aud' | 'ses';

/** Random id: prefix + 16 lowercase hex from 8 random bytes. Not time-ordered on purpose (ids are plaintext on disk). */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** Deterministic id: prefix + first 16 hex of sha256(parts joined by NUL). Used for imported sources so re-import is idempotent. */
export function deterministicId(prefix: IdPrefix, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)}`;
}

/** 16 lowercase hex chars; used for journal gens. */
export function newGen(): string {
  return randomBytes(8).toString('hex');
}

/** 32 lowercase hex chars; the vault id. */
export function newVaultId(): string {
  return randomBytes(16).toString('hex');
}

/** Current time as the canonical IsoDate form (ms precision, Z). */
export function nowIso(now: () => Date = () => new Date()): string {
  return now().toISOString();
}
