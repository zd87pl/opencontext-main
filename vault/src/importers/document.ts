import { basename, extname } from 'node:path';
import { clampTitle, toIso, type ParseContext, type ParsedSource } from './common.js';

interface FrontMatter {
  title?: string;
  date?: string;
  tags: string[];
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

function splitTags(value: string): string[] {
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((t) => unquote(t))
    .filter((t) => t !== '');
}

/** The tiny YAML subset note-taking apps actually write: `key: value` lines plus an inline or dashed list for tags. Anything else is left in the text untouched. */
function readFrontMatter(text: string): FrontMatter {
  const out: FrontMatter = { tags: [] };
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return out;
  const lines = (m[1] ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] ?? '').toLowerCase();
    const value = kv[2] ?? '';
    if (key === 'title') out.title = unquote(value);
    else if (key === 'date' || key === 'created') out.date ??= unquote(value);
    else if (key === 'tags' || key === 'tag') {
      if (value.trim() !== '') out.tags.push(...splitTags(value));
      else {
        for (let j = i + 1; j < lines.length; j += 1) {
          const item = /^\s*-\s*(.+)$/.exec(lines[j] ?? '');
          if (!item) break;
          out.tags.push(unquote(item[1] ?? ''));
          i = j;
        }
      }
    }
  }
  return out;
}

function firstHeading(text: string): string | undefined {
  const body = text.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  const m = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(body);
  return m?.[1]?.trim();
}

/**
 * A Markdown or plain-text file → one document source, text kept verbatim (front matter included: the file is the
 * record, so there is no separate `raw`). Title: front-matter `title:` → first `# heading` → file name; date: front
 * matter `date:` → file mtime. externalId is the path relative to the import root, so moving the folder re-imports
 * nothing. Importer "document@1".
 */
export function parseDocument(
  text: string,
  ctx: ParseContext & { relPath: string; mediaType: 'text/markdown' | 'text/plain'; mtime: string },
): ParsedSource {
  const fm = readFrontMatter(text);
  const rel = ctx.relPath.split(/[\\/]+/).join('/');
  const notes: string[] = [];
  let title = fm.title !== undefined ? clampTitle(fm.title) : '';
  if (title === '') {
    const heading = firstHeading(text);
    if (heading !== undefined) title = clampTitle(heading);
  }
  if (title === '') {
    const name = basename(rel);
    title = clampTitle(name.slice(0, name.length - extname(name).length)) || clampTitle(name) || 'Untitled document';
    notes.push('title taken from the file name');
  }
  let createdAt = fm.date !== undefined ? toIso(fm.date) : undefined;
  if (createdAt === undefined) {
    createdAt = toIso(ctx.mtime) ?? ctx.now;
    if (fm.date !== undefined) notes.push(`front-matter date "${fm.date}" is not a date; used the file time`);
  }
  const tags = fm.tags.map((t) => t.trim().toLowerCase()).filter((t) => t !== '');
  return {
    type: ctx.mediaType === 'text/markdown' ? 'markdown' : 'text',
    kind: 'document',
    title,
    externalId: rel,
    createdAt,
    content: { kind: 'document', mediaType: ctx.mediaType, text },
    notes,
    ...(tags.length > 0 ? { tags } : {}),
  };
}
