import { VaultError } from '../errors.js';

/**
 * Strict standard-alphabet base64 with padding: anything else is rejected so a corrupt field is reported as such, not
 * silently decoded to garbage bytes. The check is linear and never recurses: a grouped quantifier such as
 * `(?:[A-Za-z0-9+/]{4})*` makes V8 push one backtrack frame per group and overflow the stack on a body of a few MB,
 * which turned every multi-megabyte source into an unreadable one. Length % 4 plus an end-anchored `={0,2}` accepts
 * exactly the same strings as the grouped form (padding can only sit in the final quad).
 */
const B64_CHARS_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Standard base64 with padding (what Buffer.toString('base64') emits). Used for every binary field in envelopes and key files so third-party decoders need only one alphabet. */
export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** True when `text` is canonical padded base64 (any length, including the empty string). */
export function isBase64(text: string): boolean {
  return text.length % 4 === 0 && B64_CHARS_RE.test(text);
}

/** Inverse of b64. Throws VaultError('CORRUPT') on invalid input because every caller is decoding an on-disk field that must be exactly what the writer emitted. */
export function unb64(text: string): Buffer {
  if (typeof text !== 'string' || !isBase64(text)) {
    throw new VaultError('CORRUPT', 'invalid base64 field');
  }
  return Buffer.from(text, 'base64');
}
