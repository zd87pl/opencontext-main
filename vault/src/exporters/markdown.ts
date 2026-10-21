import { nowIso } from '../ids.js';
import type { VaultStore } from '../store/vault-store.js';
import type { Memory, MemoryKind, SourceMeta, SourceType } from '../types.js';

/** Markdown switches: `full` disables the 2000-char cut per source; `includeSuperseded` adds old versions marked as such. */
export interface MarkdownOptions {
  full?: boolean;
  includeSuperseded?: boolean;
  now?: () => Date;
}

const KIND_ORDER: ReadonlyArray<{ kind: MemoryKind; heading: string }> = [
  { kind: 'instruction', heading: 'Instructions' },
  { kind: 'preference', heading: 'Preferences' },
  { kind: 'fact', heading: 'Facts' },
  { kind: 'goal', heading: 'Goals' },
  { kind: 'skill', heading: 'Skills' },
  { kind: 'relationship', heading: 'Relationships' },
  { kind: 'event', heading: 'Events' },
];

const VENDOR: Readonly<Record<SourceType, string>> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  markdown: 'Markdown',
  text: 'Text',
  agent: 'Agent',
  vault: 'Vault',
};

const TRUNCATE_AT = 2000;

function day(iso: string): string {
  return iso.slice(0, 10);
}

function provenance(m: Memory, store: VaultStore): string {
  if (m.sources.length === 0) return '';
  const parts = m.sources.map((ref) => {
    const meta = store.getSourceMeta(ref.sourceId);
    if (!meta) return '*forgotten source*';
    return `*${VENDOR[meta.type]}: "${meta.title}"* (${day(meta.createdAt)})`;
  });
  return ` — from ${parts.join(', ')}`;
}

function memoryLine(m: Memory, store: VaultStore): string {
  const superseded = m.status === 'superseded' ? ' _(superseded)_' : '';
  return `- [${m.confidence}] ${m.statement}${provenance(m, store)} \`${m.id}\`${superseded}\n`;
}

function quoted(text: string): string {
  return text.split(/\r?\n/).join('\n> ');
}

/** Blockquoted body of one source; conversations as role-tagged turns, documents verbatim. */
function sourceBody(store: VaultStore, meta: SourceMeta): string {
  const content = store.getSourceContent(meta.id);
  if (!content) return '> _(body unavailable)_\n';
  if (content.kind === 'document') return `> ${quoted(content.text)}\n`;
  let out = '';
  for (const turn of content.turns) {
    const omitted = turn.omitted && turn.omitted.length > 0 ? ` _[omitted: ${turn.omitted.join(', ')}]_` : '';
    out += `> **${turn.role}:** ${quoted(turn.text)}${omitted}\n`;
  }
  return out;
}

/**
 * Human-readable, NOT re-importable (§4.5): memories grouped by kind in the profile order, each with its provenance,
 * then every source as a blockquote cut at 2000 chars unless `full`. Written synchronously chunk by chunk; the
 * caller owns and ends the stream.
 */
export function writeMarkdown(store: VaultStore, out: NodeJS.WritableStream, o: MarkdownOptions): void {
  const today = day(nowIso(o.now));
  out.write(`# Memory export — ${today}\n`);
  const memories = store.listMemories({ status: o.includeSuperseded ? 'all' : 'active' });
  for (const { kind, heading } of KIND_ORDER) {
    const group = memories.filter((m) => m.kind === kind);
    if (group.length === 0) continue;
    let section = `\n## ${heading}\n`;
    for (const m of group) section += memoryLine(m, store);
    out.write(section);
  }
  const sources = store.listSources();
  if (sources.length === 0) return;
  out.write('\n## Sources\n');
  for (const meta of sources) {
    const size = meta.kind === 'conversation' ? `${meta.turnCount} turn${meta.turnCount === 1 ? '' : 's'}` : 'document';
    let body = sourceBody(store, meta);
    if (!o.full && body.length > TRUNCATE_AT) {
      body = `${body.slice(0, TRUNCATE_AT)}\n…(truncated at ${TRUNCATE_AT} chars; use --full)\n`;
    }
    out.write(`\n### ${meta.title} (${meta.type}, ${day(meta.createdAt)}, ${size}) \`${meta.id}\`\n${body}`);
  }
}
