/**
 * Basic patterns for things that must never become a memory: API keys, cloud credentials, private keys, bearer
 * tokens, our own vault tokens and "password: …" lines. Documented as a hint, not a control (false positives and
 * negatives are possible); the order matters because the first match names the pattern in the error message.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = Object.freeze([
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'vault token', re: /ocv_[A-Za-z0-9_-]{32}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'API key', re: /\b(?:sk|rk|pk)[-_](?:(?:live|test|proj|ant|or|api)[-_])?[A-Za-z0-9_-]{16,}/ },
  { name: 'password', re: /password\s*[:=]\s*\S{8,}/i },
]);

/** Returns the matched pattern name or null. Cheap enough to run on every statement and quote before a write. */
export function looksLikeSecret(text: string): string | null {
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(text)) return p.name;
  }
  return null;
}
