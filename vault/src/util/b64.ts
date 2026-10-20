import { VaultError } from '../errors.js';

/** Strict standard-alphabet base64 with padding: anything else is rejected so a corrupt field is reported as such, not silently decoded to garbage bytes. */
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Standard base64 with padding (what Buffer.toString('base64') emits). Used for every binary field in envelopes and key files so third-party decoders need only one alphabet. */
export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** Inverse of b64. Throws VaultError('CORRUPT') on invalid input because every caller is decoding an on-disk field that must be exactly what the writer emitted. */
export function unb64(text: string): Buffer {
  if (typeof text !== 'string' || !B64_RE.test(text)) {
    throw new VaultError('CORRUPT', 'invalid base64 field');
  }
  return Buffer.from(text, 'base64');
}
