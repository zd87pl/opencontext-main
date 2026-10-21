import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { VaultError } from '../errors.js';
import { EXPORT_FORMAT } from '../types.js';
import { isRecord } from './common.js';
import { iterateJsonArray } from './json-array-stream.js';

/** Every input shape the importer understands; also the vocabulary of the CLI's --format flag, so the two can never disagree. */
export type ImportFormat = 'chatgpt' | 'claude' | 'claude-projects' | 'gemini' | 'markdown' | 'text' | 'vault';

const PEEK_BYTES = 4096;

async function peek(path: string): Promise<string> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    throw new VaultError('IO', `cannot open ${path}: ${(err as Error).message}`);
  }
  try {
    const buf = Buffer.alloc(PEEK_BYTES);
    const { bytesRead } = await fh.read(buf, 0, PEEK_BYTES, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

function classifyFirstElement(first: unknown): ImportFormat | undefined {
  if (!isRecord(first)) return undefined;
  if (isRecord(first.mapping)) return 'chatgpt';
  if (Array.isArray(first.chat_messages)) return 'claude';
  if (Array.isArray(first.docs) || typeof first.prompt_template === 'string') return 'claude-projects';
  const products = Array.isArray(first.products) ? first.products : [];
  if (
    products.some((p) => typeof p === 'string' && /gemini|bard/i.test(p)) ||
    (typeof first.header === 'string' && /gemini|bard/i.test(first.header)) ||
    (typeof first.title === 'string' && first.title.startsWith('Prompted '))
  ) {
    return 'gemini';
  }
  return undefined;
}

/**
 * By filename + a bounded peek at the first element (iterateJsonArray) or the first 4 KB of text; the content
 * decides, the filename only hints, so a renamed export still imports. Returns undefined when unsure (the CLI then
 * requires --format). Throws UNSUPPORTED for Google Takeout's `MyActivity.html`, the one unsupported file with a known
 * fix (re-export as JSON), so the user is told what to do instead of "not supported".
 */
export async function detectFormat(path: string): Promise<ImportFormat | undefined> {
  const name = basename(path).toLowerCase();
  const ext = extname(name);
  if (name === 'myactivity.html') {
    throw new VaultError(
      'UNSUPPORTED',
      'MyActivity.html: the Google Takeout HTML format is not supported',
      're-export from Google Takeout with "JSON" selected as the format for My Activity, then import MyActivity.json',
    );
  }
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') return 'markdown';
  if (ext === '.txt' || ext === '.text') return 'text';
  if (ext !== '.json') return undefined;
  const head = (await peek(path)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('{')) {
    return new RegExp(`"format"\\s*:\\s*"${EXPORT_FORMAT}"`).test(head) ? 'vault' : undefined;
  }
  if (!head.startsWith('[')) return undefined;
  let first: unknown;
  let empty = true;
  try {
    for await (const element of iterateJsonArray(path)) {
      first = element;
      empty = false;
      break;
    }
  } catch (err) {
    if (err instanceof VaultError) return undefined;
    throw err;
  }
  if (empty) return undefined;
  return classifyFirstElement(first);
}
