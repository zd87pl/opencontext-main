import { VaultError } from '../errors.js';
import { Tag } from '../types.js';

/** NFKC → collapse all whitespace runs to one space → trim. Case is preserved: quotes are verbatim. The ONLY quote normalizer; store, importers and CLI verify all use it. */
export function normalizeForQuote(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** normalizeForQuote → lowercase → strip trailing . ! ? characters. Dedup key for memories (with subject lowercased). Exact match only — never token similarity. */
export function normalizeStatement(s: string): string {
  return normalizeForQuote(s).toLowerCase().replace(/[.!?]+$/u, '').trim();
}

/** Lowercase, trim, dedupe, validate each against Tag; throws VaultError('INVALID_ARGUMENT', `invalid tag "<value>"`). Centralized so grants, memories and sources agree on what a tag is. */
export function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (!Tag.safeParse(tag).success) {
      throw new VaultError('INVALID_ARGUMENT', `invalid tag "${raw}"`);
    }
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Truncate text to max chars, appending "…[truncated]" when cut; never splits a surrogate pair. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…[truncated]`;
}

/** Truncate a JSON serialization to max chars, appending "…[truncated]" when cut. Used for audit args so one huge call cannot bloat the log. */
export function truncateJson(value: unknown, max: number): string {
  return truncateText(JSON.stringify(value) ?? 'null', max);
}

/** C0 and C1 control characters (except tab and newline), DEL and the Unicode line/paragraph separators: what a terminal would interpret. */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Replace terminal-significant control characters with U+FFFD so a stored string can never erase a line, move the cursor or spoof a row when the CLI prints it. Newlines and tabs are kept (callers that need one-line cells collapse them). */
export function stripControl(s: string): string {
  return s.replace(CONTROL_RE, '\uFFFD');
}

/** True when the string carries no control character other than tab, newline and carriage return (what agent-supplied text fields must satisfy; one-line fields additionally refuse newlines). */
export function hasNoControl(s: string): boolean {
  return !/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/.test(s);
}
