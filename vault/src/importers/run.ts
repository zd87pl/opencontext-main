import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { VaultError } from '../errors.js';
import { deterministicId, nowIso } from '../ids.js';
import type { VaultStore } from '../store/vault-store.js';
import { LIMITS, type Source, type SourceContent } from '../types.js';
import { canonicalJson, sha256Hex } from '../util/canonical-json.js';
import { normalizeTags } from '../util/text.js';
import { parseChatGptConversation } from './chatgpt.js';
import { parseClaudeConversation, parseClaudeProject } from './claude.js';
import { IMPORTERS, type ParseContext, type ParsedSource } from './common.js';
import { detectFormat, type ImportFormat } from './detect.js';
import { parseDocument } from './document.js';
import { parseGeminiActivity } from './gemini.js';
import { iterateJsonArray } from './json-array-stream.js';
import { parsePortable } from './portable.js';

/** Switches for one import run; `now` is injectable so tests get deterministic importedAt stamps. */
export interface ImportOptions {
  format?: ImportFormat;
  tags?: string[];
  keepRaw?: boolean; // default true
  dryRun?: boolean;
  geminiWindowMinutes?: number; // default 30; 0 = one source per record
  onProgress?: (done: number) => void;
  warn?: (msg: string) => void;
  now?: () => Date;
}

/** What the CLI prints after `import`: per-file formats, counts, and every file it saw but did not import (with the reason). */
export interface ImportReport {
  files: Array<{ path: string; format: ImportFormat }>;
  added: number;
  updated: number;
  skipped: number;
  memoriesAdded: number;
  memoriesSkipped: number;
  ignored: string[];
  notes: string[];
  ms: number;
}

const MAX_REPORT_NOTES = 20;
const SKIP_DIRS = new Set(['node_modules']);

interface Entry {
  file: string;
  rel: string;
}

/** An input file this run could not read (permissions, a file over the string limit): listed under `ignored`, never fatal, unlike an IO error from the store. */
class UnreadableInput extends VaultError {
  constructor(rel: string, reason: string) {
    super('IO', `cannot read ${rel}: ${reason}`);
  }
}

/**
 * Recursive walk in sorted order (deterministic ids do not need it, but deterministic reports do); dot-dirs, dot-files
 * and node_modules are skipped. Symbolic links are not followed (`lstat`): a link to `.` or to an ancestor would be
 * descended until the kernel gives up some 40 levels down, importing every note that many times under distinct ids,
 * and a link out of the tree would import directories the user never pointed at. Skipped links are reported.
 */
function walk(dir: string, root: string, out: Entry[], ignored: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    throw new VaultError('IO', `cannot read directory ${dir}: ${(err as Error).message}`);
  }
  names.sort();
  for (const name of names) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join('/');
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      ignored.push(`${rel}: symbolic link not followed (pass its target explicitly to import it)`);
      continue;
    }
    if (st.isDirectory()) walk(full, root, out, ignored);
    else if (st.isFile()) out.push({ file: full, rel });
  }
}

function stripRaw(content: SourceContent): SourceContent {
  if (content.raw === undefined) return content;
  const { raw: _raw, ...rest } = content;
  return rest as SourceContent;
}

function errorText(err: VaultError): string {
  return err.hint !== undefined ? `${err.message} (${err.hint})` : err.message;
}

/** Front-matter tags are advisory: an invalid one is warned about and dropped, never fatal to the import. */
function safeTags(tags: string[], warn: (m: string) => void, where: string): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    try {
      out.push(...normalizeTags([tag]));
    } catch {
      warn(`${where}: ignoring invalid tag "${tag}"`);
    }
  }
  return out;
}

/**
 * Files or directories (recursive; skips dot-dirs, node_modules and symbolic links). Source id = deterministicId('src',
 * importer, externalId). Same id + same sha256 → skipped; same id + new sha256 → body replaced, meta updated (review
 * state preserved), unless the vendor's update time says the stored version is newer (then skipped and reported);
 * portable import keeps memory/source ids and skips existing ids. Vendor files stream element by element through the
 * store's LRU, so an export far larger than RAM imports in bounded memory. A file this run cannot read is listed under
 * `ignored` and the run continues.
 */
export async function runImport(store: VaultStore, paths: string[], o: ImportOptions): Promise<ImportReport> {
  const started = Date.now();
  const now = o.now ?? (() => new Date());
  const warn = o.warn ?? ((): void => undefined);
  const keepRaw = o.keepRaw ?? true;
  const runTags = normalizeTags(o.tags ?? []);
  const report: ImportReport = { files: [], added: 0, updated: 0, skipped: 0, memoriesAdded: 0, memoriesSkipped: 0, ignored: [], notes: [], ms: 0 };
  const notes: string[] = [];
  let done = 0;
  const progress = (): void => {
    done += 1;
    o.onProgress?.(done);
  };

  const entries: Entry[] = [];
  for (const given of paths) {
    const abs = resolve(given);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      throw new VaultError('NOT_FOUND', `no such file or directory: ${given}`);
    }
    if (st.isDirectory()) walk(abs, abs, entries, report.ignored);
    else entries.push({ file: abs, rel: relative(dirname(abs), abs) });
  }

  const upsert = (parsed: ParsedSource, importer: string, entry: Entry): void => {
    const id = deterministicId('src', importer, parsed.externalId);
    const content = keepRaw ? parsed.content : stripRaw(parsed.content);
    const sha256 = sha256Hex(canonicalJson(content));
    const existing = store.getSourceMeta(id);
    if (existing && existing.sha256 === sha256) {
      report.skipped += 1;
      progress();
      return;
    }
    if (existing?.updatedAt !== undefined && parsed.updatedAt !== undefined && Date.parse(parsed.updatedAt) < Date.parse(existing.updatedAt)) {
      // An older export of a conversation the vault already holds in a newer version: replacing it would silently roll
      // the stored turns back (and the citations into them). Keep the newer one and say so.
      const msg = `${entry.rel}: kept the stored version of "${existing.title}" (${existing.updatedAt}); this export is older (${parsed.updatedAt})`;
      warn(msg);
      report.ignored.push(msg);
      report.skipped += 1;
      progress();
      return;
    }
    const stamp = nowIso(now);
    const docTags = parsed.tags ? safeTags(parsed.tags, warn, entry.rel) : [];
    const tags = [...new Set([...(existing?.tags ?? []), ...runTags, ...docTags])].slice(0, LIMITS.tags);
    const title = parsed.title.trim() === '' ? 'Untitled' : parsed.title;
    const source: Source = {
      id,
      type: parsed.type,
      kind: parsed.kind,
      title,
      origin: { importer, path: entry.file, externalId: parsed.externalId, trust: 'imported' },
      tags,
      createdAt: parsed.createdAt ?? existing?.createdAt ?? stamp,
      ...(parsed.updatedAt !== undefined ? { updatedAt: parsed.updatedAt } : {}),
      importedAt: stamp,
      sha256,
      bytes: Buffer.byteLength(JSON.stringify(content), 'utf8'),
      turnCount: content.kind === 'conversation' ? content.turns.length : 1,
      hasRaw: content.raw !== undefined,
      notes: parsed.notes,
      review: existing?.review ?? { status: 'unreviewed' },
      content,
    };
    try {
      if (!o.dryRun) store.putSource(source);
    } catch (err) {
      if (VaultError.is(err, 'INVALID_ARGUMENT')) {
        const msg = `${entry.rel}: skipped "${title}": ${err.message}`;
        warn(msg);
        report.ignored.push(msg);
        progress();
        return;
      }
      throw err;
    }
    if (existing) report.updated += 1;
    else report.added += 1;
    for (const note of parsed.notes) notes.push(`${entry.rel}: ${title}: ${note}`);
    progress();
  };

  const importVault = (entry: Entry): void => {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(entry.file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== undefined) throw new VaultError('IO', `cannot read ${entry.file}: ${(err as Error).message}`);
      throw new VaultError('INVALID_ARGUMENT', `${entry.rel}: not valid JSON`);
    }
    const data = parsePortable(json);
    for (const source of data.sources) {
      if (store.getSourceMeta(source.id)) {
        report.skipped += 1;
        progress();
        continue;
      }
      const content = keepRaw ? source.content : stripRaw(source.content);
      const record: Source = {
        ...source,
        tags: [...new Set([...source.tags, ...runTags])].slice(0, LIMITS.tags),
        content,
        sha256: sha256Hex(canonicalJson(content)),
        bytes: Buffer.byteLength(JSON.stringify(content), 'utf8'),
        hasRaw: content.raw !== undefined,
      };
      if (!o.dryRun) store.putSource(record);
      report.added += 1;
      progress();
    }
    for (const memory of data.memories) {
      if (store.getMemory(memory.id)) {
        report.memoriesSkipped += 1;
        continue;
      }
      if (!o.dryRun) store.putMemory(memory);
      report.memoriesAdded += 1;
    }
  };

  const importFile = async (entry: Entry, format: ImportFormat): Promise<void> => {
    const ctx: ParseContext = { path: entry.file, now: nowIso(now), keepRaw, warn };
    switch (format) {
      case 'chatgpt':
        for await (const element of iterateJsonArray(entry.file)) {
          const parsed = parseChatGptConversation(element, ctx);
          if (parsed) upsert(parsed, IMPORTERS.chatgpt, entry);
        }
        return;
      case 'claude':
        for await (const element of iterateJsonArray(entry.file)) {
          const parsed = parseClaudeConversation(element, ctx);
          if (parsed) upsert(parsed, IMPORTERS.claude, entry);
        }
        return;
      case 'claude-projects':
        for await (const element of iterateJsonArray(entry.file)) {
          for (const parsed of parseClaudeProject(element, ctx)) upsert(parsed, IMPORTERS.claudeProjects, entry);
        }
        return;
      case 'gemini': {
        const items: unknown[] = [];
        for await (const element of iterateJsonArray(entry.file)) items.push(element);
        const parsedAll = parseGeminiActivity(items, { ...ctx, windowMinutes: o.geminiWindowMinutes ?? 30 });
        if (items.length > 0 && parsedAll.length === 0) {
          // Takeout localizes activity titles to the account language; the parser knows only the English "Prompted "
          // prefix. "imported 1 file, added 0 sources" would read as an empty export, so say what is going on.
          throw new VaultError(
            'UNSUPPORTED',
            `${entry.rel}: recognized as a Gemini activity export but none of its ${items.length} records has an English "Prompted …" title`,
            'only English-language Takeout exports are supported: set the Google account language to English and export My Activity (JSON) again',
          );
        }
        for (const parsed of parsedAll) upsert(parsed, IMPORTERS.gemini, entry);
        return;
      }
      case 'markdown':
      case 'text': {
        let text: string;
        let mtime: string;
        try {
          text = readFileSync(entry.file, 'utf8');
          mtime = statSync(entry.file).mtime.toISOString();
        } catch (err) {
          throw new UnreadableInput(entry.rel, (err as Error).message);
        }
        const parsed = parseDocument(text, { ...ctx, relPath: entry.rel, mediaType: format === 'markdown' ? 'text/markdown' : 'text/plain', mtime });
        upsert(parsed, IMPORTERS.document, entry);
        return;
      }
      case 'vault':
        importVault(entry);
        return;
    }
  };

  for (const entry of entries) {
    let format = o.format;
    if (format === undefined) {
      try {
        format = await detectFormat(entry.file);
      } catch (err) {
        if (!(err instanceof VaultError)) throw err;
        report.ignored.push(`${entry.rel}: ${errorText(err)}`);
        continue;
      }
    }
    if (format === undefined) {
      report.ignored.push(`${entry.rel}: not supported`);
      continue;
    }
    try {
      await importFile(entry, format);
    } catch (err) {
      if (err instanceof UnreadableInput) {
        report.ignored.push(errorText(err));
        continue;
      }
      if (VaultError.is(err, 'INVALID_ARGUMENT') || VaultError.is(err, 'UNSUPPORTED')) {
        report.ignored.push(`${entry.rel}: ${errorText(err)}`);
        continue;
      }
      throw err;
    }
    report.files.push({ path: entry.file, format });
  }

  report.notes = notes.length > MAX_REPORT_NOTES ? [...notes.slice(0, MAX_REPORT_NOTES), `… ${notes.length - MAX_REPORT_NOTES} more notes (see each source's notes)`] : notes;
  report.ms = Date.now() - started;
  return report;
}
