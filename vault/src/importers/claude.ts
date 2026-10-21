import type { Turn, TurnRole } from '../types.js';
import { clampTitle, fallbackExternalId, isRecord, str, titleFrom, toIso, type ParseContext, type ParsedSource } from './common.js';

function roleOf(sender: string | undefined): TurnRole {
  switch (sender) {
    case 'human':
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    default:
      return 'tool';
  }
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * One chat message → a turn. Text content blocks are joined; attachments with extracted text are appended inline
 * (they are what the model actually read); tool use/result, thinking and binary files become `omitted` markers.
 */
function messageToTurn(message: Record<string, unknown>): { turn: Omit<Turn, 'i'>; toolBlocks: number } | undefined {
  const role = roleOf(str(message.sender));
  const omitted: string[] = [];
  const texts: string[] = [];
  let toolBlocks = 0;
  const blocks = Array.isArray(message.content) ? message.content : undefined;
  if (blocks && blocks.length > 0) {
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      const type = str(block.type);
      if (type === 'text') {
        const text = str(block.text);
        if (text !== undefined && text !== '') texts.push(text);
      } else if (type === 'tool_use') {
        toolBlocks += 1;
        pushUnique(omitted, `tool_use:${str(block.name) ?? 'unknown'}`);
      } else if (type === 'tool_result') {
        toolBlocks += 1;
        pushUnique(omitted, `tool_result:${str(block.name) ?? 'unknown'}`);
      } else if (type === 'thinking' || type === 'redacted_thinking') {
        pushUnique(omitted, 'thinking');
      } else if (type === 'image') {
        pushUnique(omitted, 'image');
      } else {
        pushUnique(omitted, type ?? 'non-text');
      }
    }
  } else {
    const text = str(message.text);
    if (text !== undefined && text !== '') texts.push(text);
  }
  let text = texts.join('\n\n');
  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      if (!isRecord(attachment)) continue;
      const name = str(attachment.file_name) ?? 'attachment';
      const extracted = str(attachment.extracted_content);
      if (extracted !== undefined && extracted !== '') text += `\n\n[attachment: ${name}]\n${extracted}`;
      else pushUnique(omitted, `attachment:${name}`);
    }
  }
  if (Array.isArray(message.files)) {
    for (const file of message.files) {
      if (!isRecord(file)) continue;
      pushUnique(omitted, `file:${str(file.file_name) ?? 'file'}`);
    }
  }
  if (text === '' && omitted.length === 0) return undefined;
  const at = toIso(message.created_at);
  return { turn: { role, text, ...(at !== undefined ? { at } : {}), ...(omitted.length > 0 ? { omitted } : {}) }, toolBlocks };
}

/**
 * Claude.ai `conversations.json` element → one conversation source. Messages are already linear (no branches), so
 * the only lossy parts are tool blocks and binary files, which are named in `omitted`. Importer "claude@1".
 */
export function parseClaudeConversation(item: unknown, ctx: ParseContext): ParsedSource | undefined {
  if (!isRecord(item) || !Array.isArray(item.chat_messages)) {
    ctx.warn(`${ctx.path}: skipped a record without "chat_messages"`);
    return undefined;
  }
  const notes: string[] = [];
  const turns: Turn[] = [];
  let toolBlocks = 0;
  for (const message of item.chat_messages) {
    if (!isRecord(message)) continue;
    const converted = messageToTurn(message);
    if (!converted) continue;
    toolBlocks += converted.toolBlocks;
    turns.push({ i: turns.length, ...converted.turn });
  }
  if (toolBlocks > 0) notes.push(`${toolBlocks} tool block${toolBlocks === 1 ? '' : 's'} recorded only as "omitted" markers`);
  let externalId = str(item.uuid);
  if (externalId === undefined || externalId === '') {
    externalId = fallbackExternalId(item);
    notes.push('conversation uuid missing; id derived from the record hash');
  }
  const createdAt = toIso(item.created_at) ?? turns.map((t) => t.at).find((at): at is string => at !== undefined);
  const firstUser = turns.find((t) => t.role === 'user')?.text;
  const updatedAt = toIso(item.updated_at);
  return {
    type: 'claude',
    kind: 'conversation',
    title: titleFrom(str(item.name), firstUser),
    externalId,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    content: { kind: 'conversation', turns, ...(ctx.keepRaw ? { raw: item } : {}) },
    notes,
  };
}

function mediaTypeOf(filename: string): 'text/markdown' | 'text/plain' {
  return /\.(md|markdown|mdx)$/i.test(filename) ? 'text/markdown' : 'text/plain';
}

/**
 * Claude.ai `projects.json` element → one document source per project knowledge file plus one for the project's
 * `prompt_template` (its custom instructions). Each is its own source so memories can cite a specific document.
 * Importer "claude-projects@1".
 */
export function parseClaudeProject(item: unknown, ctx: ParseContext): ParsedSource[] {
  if (!isRecord(item)) {
    ctx.warn(`${ctx.path}: skipped a record that is not a project`);
    return [];
  }
  const projectId = str(item.uuid) ?? fallbackExternalId(item);
  const name = clampTitle(str(item.name) ?? '', 200) || 'Untitled project';
  const projectCreated = toIso(item.created_at);
  const out: ParsedSource[] = [];
  const prompt = str(item.prompt_template);
  if (prompt !== undefined && prompt.trim() !== '') {
    const { docs: _docs, ...projectWithoutDocs } = item;
    out.push({
      type: 'claude',
      kind: 'document',
      title: clampTitle(`${name} — project instructions`),
      externalId: `${projectId}/prompt_template`,
      ...(projectCreated !== undefined ? { createdAt: projectCreated } : {}),
      content: { kind: 'document', mediaType: 'text/markdown', text: prompt, ...(ctx.keepRaw ? { raw: projectWithoutDocs } : {}) },
      notes: [],
    });
  }
  const docs = Array.isArray(item.docs) ? item.docs : [];
  let n = 0;
  for (const doc of docs) {
    if (!isRecord(doc)) continue;
    n += 1;
    const filename = str(doc.filename) ?? `document-${n}`;
    const docId = str(doc.uuid) ?? filename;
    const createdAt = toIso(doc.created_at) ?? projectCreated;
    out.push({
      type: 'claude',
      kind: 'document',
      title: clampTitle(`${name} / ${filename}`),
      externalId: `${projectId}/${docId}`,
      ...(createdAt !== undefined ? { createdAt } : {}),
      content: { kind: 'document', mediaType: mediaTypeOf(filename), text: str(doc.content) ?? '', ...(ctx.keepRaw ? { raw: doc } : {}) },
      notes: [],
    });
  }
  return out;
}
