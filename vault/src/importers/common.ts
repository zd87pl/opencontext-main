import { sha256Hex } from '../util/canonical-json.js';
import { LIMITS, type SourceContent, type SourceType } from '../types.js';

/**
 * What a vendor parser hands to runImport: everything a SourceMeta needs except the fields the store
 * derives from the body (sha256, bytes, turnCount, hasRaw) and the fields only the import run knows
 * (id, origin.path, importedAt, tags from flags). Pure data so parsers stay free of fs and store code.
 */
export interface ParsedSource {
  type: SourceType;
  kind: 'conversation' | 'document';
  title: string;
  /** Vendor conversation id / relative file path; drives the deterministic SourceId together with the importer name. */
  externalId: string;
  createdAt?: string;
  /** The vendor's last-update time when the export carries one; an older export never overwrites a newer stored version. */
  updatedAt?: string;
  content: SourceContent;
  notes: string[];
  /** Tags the document itself declared (front matter); merged with the import run's --tags. */
  tags?: string[];
}

/** Inputs every parser gets: where the record came from (informational), the import clock, the raw-retention switch and a warning sink (stderr in the CLI). */
export interface ParseContext {
  path: string;
  now: string;
  keepRaw: boolean;
  warn: (msg: string) => void;
}

/** Importer name@version strings; the version is part of every deterministic source id, so bumping one re-imports under new ids on purpose. */
export const IMPORTERS = {
  chatgpt: 'chatgpt@1',
  claude: 'claude@1',
  claudeProjects: 'claude-projects@1',
  gemini: 'gemini@1',
  document: 'document@1',
  vault: 'vault@1',
} as const;

/** Narrow unknown JSON to a plain object without a cast at every call site. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** String field or undefined (vendor exports mix null, missing and empty freely). */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Any vendor timestamp → the canonical IsoDate form, or undefined when it cannot be read. Seconds-since-epoch
 * (ChatGPT, floats), milliseconds, and RFC 3339 strings with any fractional precision (Claude uses microseconds) all
 * normalize to millisecond precision with a trailing Z because the schema requires writers to emit that form.
 */
export function toIso(value: unknown): string | undefined {
  let ms: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // ChatGPT uses seconds (10 digits before the point); anything past 1e12 can only be milliseconds.
    ms = Math.abs(value) < 1e11 ? Math.round(value * 1000) : Math.round(value);
  } else if (typeof value === 'string' && value.trim() !== '') {
    ms = Date.parse(value.trim());
  } else {
    return undefined;
  }
  if (!Number.isFinite(ms)) return undefined;
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

/** Collapse whitespace and cut to `max` chars (default LIMITS.title) with an ellipsis so any vendor title fits the schema. */
export function clampTitle(text: string, max: number = LIMITS.title): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Title fallback chain used by every conversation importer: vendor title → first user line → "Untitled conversation". */
export function titleFrom(vendorTitle: string | undefined, firstUserText: string | undefined): string {
  const t = vendorTitle !== undefined ? clampTitle(vendorTitle) : '';
  if (t !== '') return t;
  const u = firstUserText !== undefined ? clampTitle(firstUserText, 80) : '';
  if (u !== '') return u;
  return 'Untitled conversation';
}

/** Stable stand-in for a missing vendor id: hash of the record itself, so a re-import of the same file is still idempotent. */
export function fallbackExternalId(record: unknown): string {
  return `sha256:${sha256Hex(JSON.stringify(record) ?? 'null').slice(0, 32)}`;
}
