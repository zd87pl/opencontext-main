import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultError } from '../src/errors.js';
import { deterministicId } from '../src/ids.js';
import { parseChatGptConversation } from '../src/importers/chatgpt.js';
import { parseClaudeConversation, parseClaudeProject } from '../src/importers/claude.js';
import { type ParseContext, type ParsedSource } from '../src/importers/common.js';
import { detectFormat } from '../src/importers/detect.js';
import { parseDocument } from '../src/importers/document.js';
import { parseGeminiActivity } from '../src/importers/gemini.js';
import { htmlToText } from '../src/importers/html-to-text.js';
import { runImport } from '../src/importers/run.js';
import { tmpVault } from './helpers/tmp-vault.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const NOW = '2026-10-20T10:00:00.000Z';
const MTIME = '2026-03-15T12:00:00.000Z';
const T0 = 1709370764.123456;
const iso = (seconds: number): string => new Date(Math.round(seconds * 1000)).toISOString();

function fixture(rel: string): string {
  return join(FIXTURES, rel);
}

function readJson(rel: string): unknown[] {
  return JSON.parse(readFileSync(fixture(rel), 'utf8')) as unknown[];
}

function ctxFor(rel: string, warnings: string[] = [], keepRaw = false): ParseContext {
  return { path: `test/fixtures/${rel}`, now: NOW, keepRaw, warn: (m) => warnings.push(m) };
}

/** Snapshots live next to the fixture; set UPDATE_SNAPSHOTS=1 to rewrite them after an intentional parser change. */
function expectSnapshot(rel: string, value: unknown): void {
  const path = fixture(rel);
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env.UPDATE_SNAPSHOTS === '1' || !existsSync(path)) writeFileSync(path, json);
  expect(existsSync(path)).toBe(true);
  expect(JSON.parse(json)).toEqual(JSON.parse(readFileSync(path, 'utf8')));
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function tmpCopy(rel: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ocv-imp-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dst = join(root, rel.split('/').pop() ?? 'copy');
  cpSync(fixture(rel), dst, { recursive: true });
  return dst;
}

function vault(): ReturnType<typeof tmpVault> {
  const v = tmpVault();
  cleanups.push(v.cleanup);
  return v;
}

/** The committed parser snapshots sit next to the fixtures and are (correctly) "not supported" by a directory import; keep them out of the assertions. */
function withoutSnapshots(ignored: string[]): string[] {
  return ignored.filter((entry) => !entry.includes('.snapshot.json'));
}

describe('htmlToText', () => {
  it('turns block ends and <br> into newlines, <li> into bullets, strips other tags and decodes entities', () => {
    const html = '<p>A &amp; B<br>line two</p><p>para <b>bold</b> &lt;tag&gt; &quot;q&quot; &#39;s&#39; &apos;a&apos;</p><ul><li>one</li><li>two &#8212; dash &#x1F680;</li></ul><h2>Head</h2><div>d</div><table><tr><td>x</td><td>y</td></tr></table>';
    expect(htmlToText(html)).toBe('A & B\nline two\npara bold <tag> "q" \'s\' \'a\'\n- one\n- two — dash 🚀\nHead\nd\nx y');
    // only closing block tags break lines (an opening <p> after text does not), exactly as specified
    expect(htmlToText('one<p>two</p>three')).toBe('onetwo\nthree');
  });
  it('collapses 3+ newlines to 2, drops comments/scripts and keeps unknown entities verbatim', () => {
    expect(htmlToText('a<br><br><br><br>b<!-- hidden --><script>alert(1)</script> &unknown; &nbsp;c')).toBe('a\n\nb &unknown;  c');
    expect(htmlToText('')).toBe('');
    expect(htmlToText('no markup at all')).toBe('no markup at all');
  });
});

describe('ChatGPT importer', () => {
  const items = readJson('chatgpt/conversations.json');
  const parseAll = (keepRaw: boolean, warnings: string[] = []): ParsedSource[] =>
    items.map((item) => parseChatGptConversation(item, ctxFor('chatgpt/conversations.json', warnings, keepRaw))).filter((p): p is ParsedSource => p !== undefined);

  it('matches the committed snapshot', () => {
    expectSnapshot('chatgpt/conversations.snapshot.json', parseAll(false));
  });

  it('follows the current branch, skips hidden system messages and keeps custom instructions as a system turn', () => {
    const [go] = parseAll(true);
    expect(go?.type).toBe('chatgpt');
    expect(go?.title).toBe('Go formatting');
    expect(go?.createdAt).toBe(iso(T0));
    expect(go?.content.kind).toBe('conversation');
    if (go?.content.kind !== 'conversation') throw new Error('expected a conversation');
    const turns = go.content.turns;
    expect(turns.map((t) => t.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(turns[0]?.text).toBe('User profile:\nI am Zed, a backend engineer in Lisbon. I write Go and Rust.\n\nUser instructions:\nBe terse. Use code blocks. Never apologise.');
    expect(turns[0]?.at).toBeUndefined();
    expect(turns[1]).toEqual({ i: 1, role: 'user', text: 'how should I format Go?', at: iso(T0) });
    expect(turns[5]?.text).toBe('I always use tabs in Go, fight me');
    expect(turns.map((t) => t.i)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(go.notes).toEqual([]);
  });

  it('marks multimodal parts as omitted and keeps the text part', () => {
    const [go] = parseAll(true);
    if (go?.content.kind !== 'conversation') throw new Error('expected a conversation');
    const last = go.content.turns[6];
    expect(last?.omitted).toEqual(['image']);
    expect(last?.text).toBe('No fight here — tabs are the gofmt default. The screenshot shows a gofmt-clean file.');
  });

  it('selects the edited branch and notes the abandoned one', () => {
    const [, porto] = parseAll(true);
    if (porto?.content.kind !== 'conversation') throw new Error('expected a conversation');
    const texts = porto.content.turns.map((t) => t.text);
    expect(texts).toHaveLength(6);
    expect(texts[2]).toBe('we prefer table wine over port; any vinho verde spots?');
    expect(texts.some((t) => t.includes('we do not drink port'))).toBe(false);
    expect(porto.notes).toEqual(['2 messages on abandoned branches kept only in raw']);
    const [, portoNoRaw] = parseAll(false);
    expect(portoNoRaw?.notes).toEqual(['2 messages on abandoned branches dropped (raw not kept)']);
    // the abandoned branch survives verbatim in raw
    expect(JSON.stringify(porto.content.raw)).toContain('we do not drink port though');
    expect(porto.content.raw).toBe(items[1]);
    expect(portoNoRaw?.content.raw).toBeUndefined();
  });

  it('falls back for a null title and a null create_time', () => {
    const [, , dog] = parseAll(true);
    expect(dog?.title).toBe('remind me what my dog is called? I told you last week');
    expect(dog?.createdAt).toBe(iso(T0 + 400500));
    expect(dog?.notes).toEqual(['create_time missing; used update_time', 'title missing; used the first user message']);
  });

  it('keeps tool calls, tool outputs and generated images as turns with omitted markers', () => {
    const [, , , logo] = parseAll(true);
    if (logo?.content.kind !== 'conversation') throw new Error('expected a conversation');
    const turns = logo.content.turns;
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant']);
    expect(turns[1]?.omitted).toEqual(['tool_use:dalle.text2im']);
    expect(turns[1]?.text).toContain('"prompt"');
    expect(turns[2]).toMatchObject({ role: 'tool', text: '', omitted: ['image'] });
    expect(turns[5]?.text).toContain('import matplotlib.pyplot as plt');
    expect(turns[5]?.omitted).toEqual(['tool_use:python']);
    expect(turns[6]?.text).toBe('\n<<ImageDisplayed>>');
  });

  it('uses the vendor conversation id as externalId and warns on records without a mapping', () => {
    const warnings: string[] = [];
    const parsed = parseAll(false, warnings);
    expect(parsed.map((p) => p.externalId)).toEqual(items.map((i) => (i as { conversation_id: string }).conversation_id));
    expect(parseChatGptConversation({ title: 'x' }, ctxFor('chatgpt/conversations.json', warnings))).toBeUndefined();
    expect(parseChatGptConversation('nope', ctxFor('chatgpt/conversations.json', warnings))).toBeUndefined();
    expect(warnings).toHaveLength(2);
  });

  it('derives a stable id and follows the newest branch when ids are missing', () => {
    const base = items[0] as Record<string, unknown>;
    const { conversation_id: _c, id: _i, current_node: _n, ...rest } = base;
    const a = parseChatGptConversation(rest, ctxFor('x'));
    const b = parseChatGptConversation(rest, ctxFor('x'));
    expect(a?.externalId).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(a?.externalId).toBe(b?.externalId);
    expect(a?.notes).toContain('current_node missing; followed the newest branch');
    expect(a?.content.kind === 'conversation' ? a.content.turns.length : 0).toBe(7);
  });
});

describe('Claude importer', () => {
  const items = readJson('claude/conversations.json');
  const projects = readJson('claude/projects.json');
  const parseAll = (keepRaw: boolean): ParsedSource[] =>
    items.map((item) => parseClaudeConversation(item, ctxFor('claude/conversations.json', [], keepRaw))).filter((p): p is ParsedSource => p !== undefined);

  it('matches the committed snapshots', () => {
    expectSnapshot('claude/conversations.snapshot.json', parseAll(false));
    expectSnapshot('claude/projects.snapshot.json', projects.flatMap((p) => parseClaudeProject(p, ctxFor('claude/projects.json'))));
  });

  it('reads content blocks with microsecond timestamps normalized to milliseconds', () => {
    const [style] = parseAll(true);
    expect(style?.title).toBe('Style chat');
    expect(style?.createdAt).toBe('2026-01-12T09:58:11.402Z');
    expect(style?.externalId).toBe((items[0] as { uuid: string }).uuid);
    if (style?.content.kind !== 'conversation') throw new Error('expected a conversation');
    expect(style.content.turns).toHaveLength(4);
    expect(style.content.turns[0]).toEqual({ i: 0, role: 'user', text: 'Always answer in British English please, and keep answers short.', at: '2026-01-12T09:58:11.410Z' });
    expect(style.content.turns[1]?.role).toBe('assistant');
    expect(style.content.raw).toBe(items[0]);
  });

  it('appends attachments inline, lists files and tool blocks as omitted, joins text blocks', () => {
    const [, review] = parseAll(false);
    if (review?.content.kind !== 'conversation') throw new Error('expected a conversation');
    const [first, second] = review.content.turns;
    expect(first?.text).toBe(
      'Here are my notes on the vault design. Can you check the journal layout for holes?\n\n[attachment: vault-notes.txt]\nJournal = header line + encrypted JSONL.\nAAD binds vaultId, kind, gen, seq, id, prev.\nCompaction rewrites with a new gen; manifest records the gen.\nOpen question: tail truncation is undetectable without an external anchor.',
    );
    expect(first?.omitted).toEqual(['file:journal-diagram.png']);
    expect(second?.role).toBe('assistant');
    expect(second?.text).toBe(
      'Two observations. First, binding seq and prev in the AAD closes replay and reordering. Second, your open question is right: keep an external anchor (even a line count in a note) if you care about tail truncation.\n\nI put the layout in an artifact on the right.',
    );
    expect(second?.omitted).toEqual(['thinking', 'tool_use:artifacts', 'tool_result:artifacts']);
    expect(review.notes).toEqual(['2 tool blocks recorded only as "omitted" markers']);
    expect(review.content.raw).toBeUndefined();
  });

  it('falls back to the first user message for an empty name and reads the older text-only shape', () => {
    const [, , puppy] = parseAll(false);
    expect(puppy?.title).toBe('what is a good name for a border collie puppy?');
    expect(puppy?.createdAt).toBe('2025-11-03T08:15:00.000Z');
    if (puppy?.content.kind !== 'conversation') throw new Error('expected a conversation');
    expect(puppy.content.turns.map((t) => t.text)).toEqual(['what is a good name for a border collie puppy?', 'Pixel, if she is quick and precise. Juniper if she is calm.']);
  });

  it('turns projects.json into one document per knowledge file plus the prompt_template', () => {
    const warnings: string[] = [];
    const docs = projects.flatMap((p) => parseClaudeProject(p, ctxFor('claude/projects.json', warnings, true)));
    const projectId = (projects[0] as { uuid: string }).uuid;
    expect(docs).toHaveLength(3);
    expect(docs.map((d) => d.title)).toEqual(['OpenContext Vault — project instructions', 'OpenContext Vault / README.md', 'OpenContext Vault / threats.txt']);
    expect(docs.map((d) => d.externalId)[0]).toBe(`${projectId}/prompt_template`);
    expect(docs.every((d) => d.type === 'claude' && d.kind === 'document')).toBe(true);
    expect(docs.map((d) => (d.content.kind === 'document' ? d.content.mediaType : ''))).toEqual(['text/markdown', 'text/markdown', 'text/plain']);
    expect(docs[0]?.content.kind === 'document' ? docs[0].content.text : '').toContain('Answer in British English.');
    expect(docs[0]?.createdAt).toBe('2026-02-01T12:00:00.000Z');
    expect(docs[1]?.createdAt).toBe('2026-02-01T12:05:00.000Z');
    expect(JSON.stringify(docs[0]?.content.raw)).not.toContain('"docs"');
    expect(docs[1]?.content.raw).toBe((projects[0] as { docs: unknown[] }).docs[0]);
    expect(parseClaudeProject(42, ctxFor('claude/projects.json', warnings))).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('warns on records without chat_messages', () => {
    const warnings: string[] = [];
    expect(parseClaudeConversation({ uuid: 'x', name: 'y' }, ctxFor('claude/conversations.json', warnings))).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});

describe('Gemini importer', () => {
  const items = readJson('gemini/MyActivity.json');
  const parse = (windowMinutes: number, warnings: string[] = [], keepRaw = false): ParsedSource[] =>
    parseGeminiActivity(items, { ...ctxFor('gemini/MyActivity.json', warnings, keepRaw), windowMinutes });

  it('matches the committed snapshots for the default window and for one source per record', () => {
    expectSnapshot('gemini/MyActivity.window30.snapshot.json', parse(30));
    expectSnapshot('gemini/MyActivity.window0.snapshot.json', parse(0));
  });

  it('strips the "Prompted " prefix, flattens HTML and groups records within 30 minutes', () => {
    const warnings: string[] = [];
    const sources = parse(30, warnings, true);
    expect(sources).toHaveLength(3);
    const [rust, translate, scrypt] = sources;
    expect(rust?.title).toBe('What is the best way to learn Rust?');
    expect(rust?.createdAt).toBe('2026-02-03T18:04:12.731Z');
    if (rust?.content.kind !== 'conversation') throw new Error('expected a conversation');
    expect(rust.content.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(rust.content.turns[0]?.text).toBe('What is the best way to learn Rust?');
    expect(rust.content.turns[1]?.text).toBe(
      'There are several good ways to learn Rust:\n- Read The Rust Programming Language (the "book")\n- Do the rustlings exercises\n- Port a small tool you already wrote in Go\nSince you mentioned Go & Solidity, ownership will be the new idea; traits will feel familiar.',
    );
    expect(rust.content.turns[3]?.text).toBe(
      'from cryptography.hazmat.primitives.ciphers.aead import AESGCM\naesgcm = AESGCM(key)\nct = aesgcm.encrypt(nonce, data, aad)\nThe tag is appended to the ciphertext — the last 16 bytes.',
    );
    expect(rust.notes).toEqual(['3 activity records grouped within 30 min (Takeout has no conversation ids)']);
    expect(Array.isArray(rust.content.raw) ? rust.content.raw.length : 0).toBe(3);
    expect(translate?.title).toBe('translate "your memory, your file" into Portuguese');
    expect(translate?.content.kind === 'conversation' ? translate.content.turns.length : 0).toBe(1);
    expect(translate?.notes).toEqual(['1 prompt had no recorded response']);
    expect(scrypt?.createdAt).toBe('2026-02-10T09:00:41.003Z');
    if (scrypt?.content.kind !== 'conversation') throw new Error('expected a conversation');
    expect(scrypt.content.turns[1]?.text).toBe('scrypt: built into Node, memory-hard, well understood.\nargon2: newer & tunable, but needs a native module.\n- For a personal vault scrypt N=2^17 is fine\n- Use a 16-byte random salt');
    expect(scrypt.content.turns[2]?.omitted).toEqual(['file:journal-diagram.png']);
    expect(warnings).toEqual(['test/fixtures/gemini/MyActivity.json: skipped 1 activity record that is not a prompt']);
  });

  it('splits at the window boundary and makes one source per record with window 0', () => {
    // the third prompt is 29 min 15 s after the second: inside a 30-minute window, outside a 29-minute one
    expect(parse(30)).toHaveLength(3);
    expect(parse(29)).toHaveLength(4);
    expect(parse(29)[1]?.title).toBe('and in Go?');
    const single = parse(0);
    expect(single).toHaveLength(6);
    expect(single.every((s) => s.content.kind === 'conversation' && s.content.turns.length <= 2)).toBe(true);
    expect(new Set(single.map((s) => s.externalId)).size).toBe(6);
    expect(single.map((s) => s.notes).flat()).toEqual(['1 prompt had no recorded response']);
  });

  it('gives stable externalIds and raw is the untouched record group', () => {
    const a = parse(30, [], true);
    const b = parse(30, [], true);
    expect(a.map((s) => s.externalId)).toEqual(b.map((s) => s.externalId));
    expect(a.every((s) => /^2026-\d\d-\d\dT[^#]+#[0-9a-f]{16}$/.test(s.externalId))).toBe(true);
    expect(a[1]?.content.raw).toEqual([items.find((i) => (i as { title: string }).title.includes('translate'))]);
    expect(parse(30, [], false).every((s) => s.content.raw === undefined)).toBe(true);
  });

  it('rejects the Takeout HTML with UNSUPPORTED and a re-export hint', async () => {
    const err = await detectFormat(fixture('gemini/MyActivity.html')).catch((e: unknown) => e);
    expect(VaultError.is(err, 'UNSUPPORTED')).toBe(true);
    expect((err as VaultError).hint).toContain('JSON');
  });
});

describe('document importer', () => {
  const doc = (rel: string, mediaType: 'text/markdown' | 'text/plain' = 'text/markdown'): ParsedSource =>
    parseDocument(readFileSync(fixture(`notes/${rel}`), 'utf8'), { ...ctxFor(`notes/${rel}`), relPath: rel, mediaType, mtime: MTIME });

  it('matches the committed snapshot', () => {
    expectSnapshot('notes/notes.snapshot.json', [doc('README.md'), doc('ideas.md'), doc('journal/2026-03-01.md'), doc('todo.txt', 'text/plain')]);
  });

  it('takes the title from the heading, the front matter or the file name, in that order of availability', () => {
    expect(doc('README.md')).toMatchObject({ type: 'markdown', kind: 'document', title: 'Project notes', externalId: 'README.md', createdAt: MTIME, notes: [] });
    expect(doc('README.md').tags).toBeUndefined();
    const journal = doc('journal/2026-03-01.md');
    expect(journal.title).toBe('Moving day');
    expect(journal.createdAt).toBe('2026-03-01T00:00:00.000Z');
    expect(journal.tags).toEqual(['personal', 'lisbon']);
    expect(journal.externalId).toBe('journal/2026-03-01.md');
    expect(journal.content.kind === 'document' ? journal.content.text.startsWith('---\n') : false).toBe(true);
    const ideas = doc('ideas.md');
    expect(ideas.title).toBe('Ideas backlog');
    expect(ideas.tags).toEqual(['vault', 'ideas']);
    expect(ideas.createdAt).toBe('2026-01-05T08:00:00.000Z');
    const todo = doc('todo.txt', 'text/plain');
    expect(todo).toMatchObject({ type: 'text', title: 'todo', createdAt: MTIME, notes: ['title taken from the file name'] });
    expect(todo.content).toEqual({ kind: 'document', mediaType: 'text/plain', text: readFileSync(fixture('notes/todo.txt'), 'utf8') });
  });

  it('normalizes Windows separators in the relative path and tolerates odd front matter', () => {
    const p = parseDocument('---\ntitle: \'Quoted\'\ndate: not-a-date\ntags: a, B , \n---\nbody', { ...ctxFor('x'), relPath: 'a\\b\\c.md', mediaType: 'text/markdown', mtime: MTIME });
    expect(p.externalId).toBe('a/b/c.md');
    expect(p.title).toBe('Quoted');
    expect(p.tags).toEqual(['a', 'b']);
    expect(p.createdAt).toBe(MTIME);
    expect(p.notes).toEqual(['front-matter date "not-a-date" is not a date; used the file time']);
    const empty = parseDocument('', { ...ctxFor('x'), relPath: 'empty.txt', mediaType: 'text/plain', mtime: 'garbage' });
    expect(empty.title).toBe('empty');
    expect(empty.createdAt).toBe(NOW);
  });
});

describe('detectFormat', () => {
  it('classifies every fixture by content, not by name', async () => {
    const cases: Array<[string, string | undefined]> = [
      ['chatgpt/conversations.json', 'chatgpt'],
      ['chatgpt/chat.html', undefined],
      ['chatgpt/user.json', undefined],
      ['claude/conversations.json', 'claude'],
      ['claude/projects.json', 'claude-projects'],
      ['claude/users.json', undefined],
      ['gemini/MyActivity.json', 'gemini'],
      ['notes/README.md', 'markdown'],
      ['notes/journal/2026-03-01.md', 'markdown'],
      ['notes/todo.txt', 'text'],
      ['notes/data.csv', undefined],
      ['portable/export.json', 'vault'],
      ['portable/export-v2.json', 'vault'],
      ['portable/not-an-export.json', undefined],
    ];
    for (const [rel, expected] of cases) {
      expect(await detectFormat(fixture(rel)), rel).toBe(expected);
    }
  });

  it('returns undefined for junk, empty arrays and renamed files it cannot place', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ocv-detect-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const junk = join(root, 'junk.json');
    writeFileSync(junk, 'this is not json at all');
    expect(await detectFormat(junk)).toBeUndefined();
    const empty = join(root, 'conversations.json');
    writeFileSync(empty, '[]');
    expect(await detectFormat(empty)).toBeUndefined();
    const numbers = join(root, 'numbers.json');
    writeFileSync(numbers, '[1, 2, 3]');
    expect(await detectFormat(numbers)).toBeUndefined();
    const renamed = join(root, 'whatever.json');
    cpSync(fixture('chatgpt/conversations.json'), renamed);
    expect(await detectFormat(renamed)).toBe('chatgpt');
    const bin = join(root, 'photo.jpg');
    writeFileSync(bin, Buffer.from([0xff, 0xd8, 0xff]));
    expect(await detectFormat(bin)).toBeUndefined();
  });
});

describe('runImport', () => {
  it('imports a ChatGPT export folder, ignores the viewer files and is idempotent', async () => {
    const { store } = vault();
    const progress: number[] = [];
    const report = await runImport(store, [fixture('chatgpt')], { onProgress: (n) => progress.push(n) });
    expect(report).toMatchObject({ added: 4, updated: 0, skipped: 0, memoriesAdded: 0, memoriesSkipped: 0 });
    expect(report.files).toEqual([{ path: fixture('chatgpt/conversations.json'), format: 'chatgpt' }]);
    expect(withoutSnapshots(report.ignored)).toEqual(['chat.html: not supported', 'user.json: not supported']);
    expect(report.ignored).toContain('conversations.snapshot.json: not supported');
    expect(report.notes).toContain('conversations.json: Trip to Porto: 2 messages on abandoned branches kept only in raw');
    expect(progress).toEqual([1, 2, 3, 4]);
    expect(report.ms).toBeGreaterThanOrEqual(0);
    const sources = store.listSources();
    expect(sources).toHaveLength(4);
    const items = readJson('chatgpt/conversations.json') as Array<{ conversation_id: string; title: string | null }>;
    for (const item of items) {
      const meta = store.getSourceMeta(deterministicId('src', 'chatgpt@1', item.conversation_id));
      expect(meta?.origin).toEqual({ importer: 'chatgpt@1', path: fixture('chatgpt/conversations.json'), externalId: item.conversation_id, trust: 'imported' });
      expect(meta?.hasRaw).toBe(true);
      expect(meta?.review).toEqual({ status: 'unreviewed' });
      expect(meta?.type).toBe('chatgpt');
    }
    const again = await runImport(store, [fixture('chatgpt')], {});
    expect(again).toMatchObject({ added: 0, updated: 0, skipped: 4 });
    expect(store.listSources()).toHaveLength(4);
  });

  it('updates a changed conversation under the same id and preserves its review state', async () => {
    const { store } = vault();
    const copy = tmpCopy('chatgpt');
    await runImport(store, [copy], {});
    const text = readFileSync(join(copy, 'conversations.json'), 'utf8');
    const [goMeta] = store.listSources({ type: 'chatgpt' }).filter((s) => s.title === 'Go formatting');
    if (!goMeta) throw new Error('missing source');
    store.updateSourceMeta({ ...goMeta, review: { status: 'reviewed', at: NOW, by: 'cli', memoriesCreated: 2 } });
    writeFileSync(join(copy, 'conversations.json'), text.replace('I always use tabs in Go, fight me', 'I always use tabs in Go, do not fight me'));
    const report = await runImport(store, [copy], { now: () => new Date('2026-10-21T00:00:00.000Z') });
    expect(report).toMatchObject({ added: 0, updated: 1, skipped: 3 });
    const updated = store.getSourceMeta(goMeta.id);
    expect(updated?.sha256).not.toBe(goMeta.sha256);
    expect(updated?.review).toEqual({ status: 'reviewed', at: NOW, by: 'cli', memoriesCreated: 2 });
    expect(updated?.importedAt).toBe('2026-10-21T00:00:00.000Z');
    expect(updated?.createdAt).toBe(goMeta.createdAt);
    const content = store.getSourceContent(goMeta.id);
    expect(content?.kind === 'conversation' ? content.turns[5]?.text : '').toBe('I always use tabs in Go, do not fight me');
  });

  it('honours keepRaw:false, dryRun and explicit tags', async () => {
    const { store } = vault();
    const dry = await runImport(store, [fixture('claude')], { dryRun: true, tags: ['Archive'] });
    expect(dry).toMatchObject({ added: 6 });
    expect(withoutSnapshots(dry.ignored)).toEqual(['users.json: not supported']);
    expect(store.listSources()).toHaveLength(0);
    const report = await runImport(store, [fixture('claude')], { keepRaw: false, tags: ['Archive', 'claude'] });
    expect(report).toMatchObject({ added: 6, updated: 0, skipped: 0 });
    expect(report.files.map((f) => f.format).sort()).toEqual(['claude', 'claude-projects']);
    for (const meta of store.listSources()) {
      expect(meta.hasRaw).toBe(false);
      expect(meta.tags).toEqual(['archive', 'claude']);
      expect(store.getSourceContent(meta.id)?.raw).toBeUndefined();
    }
    // the same data with raw is a different body → update, tags kept
    const withRaw = await runImport(store, [fixture('claude/conversations.json')], {});
    expect(withRaw).toMatchObject({ added: 0, updated: 3, skipped: 0 });
    expect(store.listSources({ type: 'claude' }).filter((s) => s.kind === 'conversation').every((s) => s.hasRaw && s.tags.join() === 'archive,claude')).toBe(true);
    await expect(runImport(store, [fixture('claude')], { tags: ['bad tag!'] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('walks directories, skipping dot-dirs and node_modules, and applies front-matter tags', async () => {
    const { store } = vault();
    const copy = tmpCopy('notes');
    mkdirSync(join(copy, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(copy, 'node_modules', 'left-pad', 'README.md'), '# left-pad\n\nmust not be imported\n');
    mkdirSync(join(copy, '.hidden'), { recursive: true });
    writeFileSync(join(copy, '.hidden', 'secret.md'), '# secret\n');
    writeFileSync(join(copy, '.DS_Store'), 'junk');
    const report = await runImport(store, [copy], { tags: ['notes'] });
    expect(report).toMatchObject({ added: 4 });
    expect(withoutSnapshots(report.ignored)).toEqual(['data.csv: not supported']);
    const sources = store.listSources();
    expect(sources.map((s) => s.origin.externalId).sort()).toEqual(['README.md', 'ideas.md', 'journal/2026-03-01.md', 'todo.txt']);
    const journal = sources.find((s) => s.origin.externalId === 'journal/2026-03-01.md');
    expect(journal?.tags).toEqual(['notes', 'personal', 'lisbon']);
    expect(journal?.title).toBe('Moving day');
    expect(journal?.id).toBe(deterministicId('src', 'document@1', 'journal/2026-03-01.md'));
    expect(sources.find((s) => s.origin.externalId === 'todo.txt')?.type).toBe('text');
    expect(sources.every((s) => s.kind === 'document' && s.turnCount === 1 && !s.hasRaw)).toBe(true);
    // moving the folder does not change ids: same relative paths → skipped
    const moved = tmpCopy('notes');
    const again = await runImport(store, [moved], {});
    expect(again).toMatchObject({ added: 0, skipped: 4 });
  });

  it('imports Gemini activity with the window option and reports the HTML export as unsupported', async () => {
    const { store } = vault();
    const report = await runImport(store, [fixture('gemini')], {});
    expect(report).toMatchObject({ added: 3 });
    const ignored = withoutSnapshots(report.ignored);
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatch(/^MyActivity\.html: .*not supported.*JSON/);
    const other = vault();
    expect((await runImport(other.store, [fixture('gemini/MyActivity.json')], { geminiWindowMinutes: 0 })).added).toBe(6);
  });

  it('imports a portable export keeping ids, and skips existing ids on re-import', async () => {
    const { store } = vault();
    const report = await runImport(store, [fixture('portable')], {});
    expect(report).toMatchObject({ added: 1, updated: 0, skipped: 0, memoriesAdded: 1, memoriesSkipped: 0 });
    expect(report.files.map((f) => f.format)).toEqual(['vault']);
    expect(report.ignored.find((i) => i.startsWith('export-v2.json:'))).toContain('version 2');
    expect(report.ignored).toContain('not-an-export.json: not supported');
    const memory = store.getMemory('mem_3f9a1c77e02b4d10');
    expect(memory).toMatchObject({ statement: 'User prefers tabs over spaces in Go.', createdBy: 'claude-desktop', createdAt: '2026-10-20T11:00:00.000Z' });
    expect(memory?.sources[0]?.verified).toBe(true);
    const source = store.getSourceMeta('src_7d2e0b1a9c3f4e55');
    expect(source).toMatchObject({ title: 'Go formatting', importedAt: '2026-10-20T10:30:00.000Z', review: { status: 'reviewed', memoriesCreated: 1 } });
    const again = await runImport(store, [fixture('portable/export.json')], {});
    expect(again).toMatchObject({ added: 0, skipped: 1, memoriesAdded: 0, memoriesSkipped: 1 });
  });

  it('accepts an explicit format, rejects missing paths and keeps going after a bad file', async () => {
    const { store } = vault();
    const asMarkdown = await runImport(store, [fixture('notes/todo.txt')], { format: 'markdown' });
    expect(asMarkdown.added).toBe(1);
    expect(store.listSources()[0]?.type).toBe('markdown');
    await expect(runImport(store, [join(FIXTURES, 'missing')], {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const forced = await runImport(store, [fixture('chatgpt/chat.html')], { format: 'chatgpt' });
    expect(forced.added).toBe(0);
    expect(forced.ignored[0]).toMatch(/^chat\.html: .*not a top-level JSON array/);
  });
});
