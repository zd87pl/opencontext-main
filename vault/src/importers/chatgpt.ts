import type { Turn, TurnRole } from '../types.js';
import { fallbackExternalId, isRecord, str, titleFrom, toIso, type ParseContext, type ParsedSource } from './common.js';

interface Node {
  id: string;
  parent: string | undefined;
  children: string[];
  message: Record<string, unknown> | undefined;
}

type PartialTurn = Omit<Turn, 'i'>;

function roleOf(message: Record<string, unknown>): TurnRole {
  const author = isRecord(message.author) ? str(message.author.role) : undefined;
  switch (author) {
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

/** Non-text parts of a multimodal message become `omitted` markers; the marker names the vendor content type so nothing is silently lost. */
function omittedNameOf(part: Record<string, unknown>): string {
  const type = str(part.content_type) ?? 'non-text';
  if (type === 'image_asset_pointer') return 'image';
  if (type === 'audio_asset_pointer' || type === 'real_time_user_audio_video_asset_pointer') return 'audio';
  if (type === 'video_container_asset_pointer') return 'video';
  return type;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * One mapping node's message → a turn, or undefined when there is nothing to carry (empty placeholders, hidden
 * system scaffolding). Custom instructions (`user_editable_context`) are kept as a system turn because they are the
 * user's own words about themselves — the most memory-relevant text in the whole export.
 */
function messageToTurn(message: Record<string, unknown>): PartialTurn | undefined {
  const role = roleOf(message);
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  const content = isRecord(message.content) ? message.content : undefined;
  const contentType = content ? str(content.content_type) : undefined;
  const at = toIso(message.create_time);
  const omitted: string[] = [];
  let text = '';

  if (content && contentType === 'user_editable_context') {
    const pieces: string[] = [];
    const profile = str(content.user_profile);
    const instructions = str(content.user_instructions);
    if (profile !== undefined && profile.trim() !== '') pieces.push(`User profile:\n${profile}`);
    if (instructions !== undefined && instructions.trim() !== '') pieces.push(`User instructions:\n${instructions}`);
    if (pieces.length === 0) return undefined;
    return { role: 'system', text: pieces.join('\n\n'), ...(at !== undefined ? { at } : {}) };
  }
  if (content && contentType === 'model_editable_context') {
    const ctx = str(content.model_set_context);
    if (ctx === undefined || ctx.trim() === '') return undefined;
    return { role: 'system', text: `Model context:\n${ctx}`, ...(at !== undefined ? { at } : {}) };
  }
  if (role === 'system' && metadata.is_visually_hidden_from_conversation === true) return undefined;

  if (content) {
    if (contentType === 'text' || contentType === 'multimodal_text' || Array.isArray(content.parts)) {
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const texts: string[] = [];
      for (const part of parts) {
        if (typeof part === 'string') {
          if (part !== '') texts.push(part);
        } else if (isRecord(part)) {
          const transcript = str(part.text);
          if (str(part.content_type) === 'audio_transcription' && transcript !== undefined && transcript !== '') texts.push(transcript);
          else pushUnique(omitted, omittedNameOf(part));
        }
      }
      text = texts.join('\n');
    } else if (contentType === 'tether_browsing_display') {
      text = str(content.result) ?? '';
      if (text === '') pushUnique(omitted, 'tether_browsing_display');
    } else if (contentType === 'tether_quote') {
      text = str(content.text) ?? str(content.title) ?? '';
      if (text === '') pushUnique(omitted, 'tether_quote');
    } else if (typeof content.text === 'string') {
      // code, execution_output, system_error and friends all carry their payload in `text`
      text = content.text;
      if (text === '' && contentType !== undefined) pushUnique(omitted, contentType);
    } else if (contentType !== undefined) {
      pushUnique(omitted, contentType);
    }
  }
  const recipient = str(message.recipient);
  if (recipient !== undefined && recipient !== 'all') pushUnique(omitted, `tool_use:${recipient}`);
  if (text === '' && omitted.length === 0) return undefined;
  return { role, text, ...(at !== undefined ? { at } : {}), ...(omitted.length > 0 ? { omitted } : {}) };
}

function readNodes(mapping: Record<string, unknown>): Map<string, Node> {
  const nodes = new Map<string, Node>();
  for (const [key, value] of Object.entries(mapping)) {
    if (!isRecord(value)) continue;
    const id = str(value.id) ?? key;
    const parent = str(value.parent);
    const children = Array.isArray(value.children) ? value.children.filter((c): c is string => typeof c === 'string') : [];
    nodes.set(key, { id, parent, children, message: isRecord(value.message) ? value.message : undefined });
  }
  return nodes;
}

/** The leaf of the newest branch when `current_node` is unusable: walk from a root following the last child, as the app does. */
function newestLeaf(nodes: Map<string, Node>): string | undefined {
  let root: string | undefined;
  for (const [key, node] of nodes) {
    if (node.parent === undefined || !nodes.has(node.parent)) {
      root = key;
      break;
    }
  }
  if (root === undefined) return undefined;
  let cur = root;
  const seen = new Set<string>();
  for (;;) {
    seen.add(cur);
    const children = nodes.get(cur)?.children ?? [];
    let next: string | undefined;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const c = children[i];
      if (c !== undefined && nodes.has(c) && !seen.has(c)) {
        next = c;
        break;
      }
    }
    if (next === undefined) return cur;
    cur = next;
  }
}

/**
 * ChatGPT `conversations.json` element → one conversation source. Only the branch ending at `current_node` becomes
 * turns (that is what the user last saw); messages on abandoned branches are counted in a note and survive only in
 * `raw`, which is why `--no-raw` is documented as lossy. Importer "chatgpt@1".
 */
export function parseChatGptConversation(item: unknown, ctx: ParseContext): ParsedSource | undefined {
  if (!isRecord(item) || !isRecord(item.mapping)) {
    ctx.warn(`${ctx.path}: skipped a record without a "mapping" tree`);
    return undefined;
  }
  const notes: string[] = [];
  const nodes = readNodes(item.mapping);
  let leaf = str(item.current_node);
  if (leaf === undefined || !nodes.has(leaf)) {
    leaf = newestLeaf(nodes);
    if (leaf !== undefined) notes.push('current_node missing; followed the newest branch');
  }
  const path: string[] = [];
  const onPath = new Set<string>();
  for (let cur = leaf; cur !== undefined && nodes.has(cur) && !onPath.has(cur); cur = nodes.get(cur)?.parent) {
    path.push(cur);
    onPath.add(cur);
  }
  path.reverse();

  const turns: Turn[] = [];
  for (const key of path) {
    const message = nodes.get(key)?.message;
    if (!message) continue;
    const turn = messageToTurn(message);
    if (turn) turns.push({ i: turns.length, ...turn });
  }
  let abandoned = 0;
  for (const [key, node] of nodes) {
    if (onPath.has(key) || !node.message) continue;
    if (messageToTurn(node.message)) abandoned += 1;
  }
  if (abandoned > 0) {
    notes.push(
      ctx.keepRaw
        ? `${abandoned} message${abandoned === 1 ? '' : 's'} on abandoned branches kept only in raw`
        : `${abandoned} message${abandoned === 1 ? '' : 's'} on abandoned branches dropped (raw not kept)`,
    );
  }

  let createdAt = toIso(item.create_time);
  if (createdAt === undefined) {
    const fromUpdate = toIso(item.update_time);
    const fromTurn = turns.map((t) => t.at).find((at): at is string => at !== undefined);
    createdAt = fromUpdate ?? fromTurn;
    if (createdAt !== undefined) notes.push(`create_time missing; used ${fromUpdate !== undefined ? 'update_time' : 'the first message time'}`);
  }
  let externalId = str(item.conversation_id) ?? str(item.id);
  if (externalId === undefined || externalId === '') {
    externalId = fallbackExternalId(item);
    notes.push('conversation id missing; id derived from the record hash');
  }
  const firstUser = turns.find((t) => t.role === 'user')?.text;
  const vendorTitle = str(item.title);
  const title = titleFrom(vendorTitle, firstUser);
  if ((vendorTitle === undefined || vendorTitle.trim() === '') && title !== 'Untitled conversation') notes.push('title missing; used the first user message');

  const updatedAt = toIso(item.update_time);
  return {
    type: 'chatgpt',
    kind: 'conversation',
    title,
    externalId,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    content: { kind: 'conversation', turns, ...(ctx.keepRaw ? { raw: item } : {}) },
    notes,
  };
}
