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

/** Truncate a JSON serialization to max chars, appending "…[truncated]" when cut. Used for audit args so one huge call cannot bloat the log; never splits a surrogate pair. */
export function truncateJson(value: unknown, max: number): string {
  const json = JSON.stringify(value) ?? 'null';
  if (json.length <= max) return json;
  let cut = json.slice(0, Math.max(0, max));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…[truncated]`;
}
