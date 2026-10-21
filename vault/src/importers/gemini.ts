import type { Turn } from '../types.js';
import { sha256Hex } from '../util/canonical-json.js';
import { clampTitle, isRecord, str, toIso, type ParseContext, type ParsedSource } from './common.js';
import { htmlToText } from './html-to-text.js';

const PROMPT_PREFIX = 'Prompted ';

interface Activity {
  prompt: string;
  time: string;
  ms: number;
  responses: string[];
  files: string[];
  raw: unknown;
}

function readActivity(item: unknown): Activity | undefined | 'not-a-prompt' | 'no-time' {
  if (!isRecord(item)) return undefined;
  const title = str(item.title);
  if (title === undefined || !title.startsWith(PROMPT_PREFIX)) return 'not-a-prompt';
  const time = toIso(item.time);
  if (time === undefined) return 'no-time';
  const responses: string[] = [];
  if (Array.isArray(item.safeHtmlItem)) {
    for (const entry of item.safeHtmlItem) {
      if (!isRecord(entry)) continue;
      const html = str(entry.html);
      if (html === undefined) continue;
      const text = htmlToText(html);
      if (text !== '') responses.push(text);
    }
  }
  const files: string[] = [];
  if (Array.isArray(item.attachedFiles)) {
    for (const file of item.attachedFiles) {
      if (isRecord(file)) files.push(str(file.name) ?? 'file');
    }
  }
  return { prompt: title.slice(PROMPT_PREFIX.length), time, ms: Date.parse(time), responses, files, raw: item };
}

/**
 * Google Takeout `MyActivity.json` (Gemini Apps) → conversation sources. Takeout has no conversation ids, only one
 * record per prompt (newest first), so records are sorted by time and consecutive prompts closer than `windowMinutes`
 * are grouped into one source — a heuristic, documented as such; `windowMinutes: 0` keeps one source per record.
 * Response HTML is flattened with htmlToText. Importer "gemini@1".
 */
export function parseGeminiActivity(items: unknown[], ctx: ParseContext & { windowMinutes: number }): ParsedSource[] {
  const activities: Activity[] = [];
  let notPrompts = 0;
  let noTime = 0;
  for (const item of items) {
    const read = readActivity(item);
    if (read === undefined || read === 'not-a-prompt') {
      notPrompts += 1;
      continue;
    }
    if (read === 'no-time') {
      noTime += 1;
      continue;
    }
    activities.push(read);
  }
  if (notPrompts > 0) ctx.warn(`${ctx.path}: skipped ${notPrompts} activity record${notPrompts === 1 ? ' that is not a prompt' : 's that are not prompts'}`);
  if (noTime > 0) ctx.warn(`${ctx.path}: skipped ${noTime} prompt${noTime === 1 ? '' : 's'} without a readable time`);
  activities.sort((a, b) => a.ms - b.ms);

  const windowMs = Math.max(0, ctx.windowMinutes) * 60_000;
  const groups: Activity[][] = [];
  for (const activity of activities) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev && windowMs > 0 && activity.ms - prev.ms <= windowMs) last.push(activity);
    else groups.push([activity]);
  }

  const usedIds = new Map<string, number>();
  const out: ParsedSource[] = [];
  for (const group of groups) {
    const first = group[0];
    if (!first) continue;
    const turns: Turn[] = [];
    let promptsOnly = 0;
    for (const activity of group) {
      const omitted = activity.files.map((f) => `file:${f}`);
      turns.push({ i: turns.length, role: 'user', text: activity.prompt, at: activity.time, ...(omitted.length > 0 ? { omitted } : {}) });
      if (activity.responses.length === 0) promptsOnly += 1;
      for (const response of activity.responses) turns.push({ i: turns.length, role: 'assistant', text: response, at: activity.time });
    }
    const notes: string[] = [];
    if (group.length > 1) notes.push(`${group.length} activity records grouped within ${ctx.windowMinutes} min (Takeout has no conversation ids)`);
    if (promptsOnly > 0) notes.push(`${promptsOnly} prompt${promptsOnly === 1 ? '' : 's'} had no recorded response`);
    let externalId = `${first.time}#${sha256Hex(first.prompt).slice(0, 16)}`;
    const seen = usedIds.get(externalId) ?? 0;
    usedIds.set(externalId, seen + 1);
    if (seen > 0) externalId += `~${seen + 1}`;
    out.push({
      type: 'gemini',
      kind: 'conversation',
      title: clampTitle(first.prompt, 120) || 'Untitled conversation',
      externalId,
      createdAt: first.time,
      content: { kind: 'conversation', turns, ...(ctx.keepRaw ? { raw: group.map((a) => a.raw) } : {}) },
      notes,
    });
  }
  return out;
}
