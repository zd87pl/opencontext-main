import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TOKEN_HASH_DOMAIN, TOKEN_PREFIX } from '../types.js';
import { sha256Hex } from '../util/canonical-json.js';

const TOKEN_RE = /^ocv_[A-Za-z0-9_-]{32}$/;

/** "ocv_" + base64url(randomBytes(24)) — 36 chars. Shown to the user exactly once; the fixed prefix lets the secret scanner recognize our own tokens. */
export function newToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
}

/** sha256Hex(TOKEN_HASH_DOMAIN + token). Tokens are 192-bit random, so an unkeyed hash is sufficient; the domain prefix keeps the hash distinct from any other sha256 of the same bytes. */
export function hashToken(token: string): string {
  return sha256Hex(TOKEN_HASH_DOMAIN + token);
}

/** Constant-time compare of two hex hashes so grant lookup leaks nothing through timing. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Still do a comparison of equal-length buffers so the mismatch path costs the same.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Shape check only (no lookup); used by the CLI to reject obviously wrong --token values and by the secret scanner. */
export function looksLikeToken(s: string): boolean {
  return TOKEN_RE.test(s);
}
