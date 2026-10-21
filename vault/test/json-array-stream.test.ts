import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VaultError } from '../src/errors.js';
import { iterateJsonArray } from '../src/importers/json-array-stream.js';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ocv-jas-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, content: string | Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

async function collect(path: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const element of iterateJsonArray(path)) out.push(element);
  return out;
}

async function codeOf(path: string): Promise<string | undefined> {
  try {
    await collect(path);
    return undefined;
  } catch (err) {
    return err instanceof VaultError ? err.code : 'not-a-vault-error';
  }
}

describe('iterateJsonArray', () => {
  it('yields every element, including strings holding ], ", \\" and braces, and scalars', async () => {
    const elements: unknown[] = [
      { a: ']' },
      { b: '"quoted" text', c: 'back\\slash and \\" escaped' },
      { d: 'brace } and bracket ] inside', nested: { arr: [1, [2, [3, { e: '[' }]]] } },
      'plain ] string with "quotes"',
      42,
      -3.5e2,
      true,
      null,
      [1, 'two', { three: 3 }],
      { unicode: 'Zoë 日本語 🚀 é  ' },
      {},
      [],
    ];
    const p = file('elements.json', JSON.stringify(elements, null, 2));
    expect(await collect(p)).toEqual(elements);
    const compact = file('compact.json', JSON.stringify(elements));
    expect(await collect(compact)).toEqual(elements);
  });

  it('handles a UTF-8 BOM and leading whitespace, and an empty array', async () => {
    const p = file('bom.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('\n \t [ {"x": 1} , 2 ]\n')]));
    expect(await collect(p)).toEqual([{ x: 1 }, 2]);
    expect(await collect(file('empty-array.json', '[]'))).toEqual([]);
    expect(await collect(file('empty-array-ws.json', ' [ \n ] \n'))).toEqual([]);
  });

  it('carries multi-byte characters and large elements intact across chunk boundaries', async () => {
    // Three elements of ~1.1 MB each: every one straddles the 1 MiB read chunk, and the text is 2-byte UTF-8 throughout.
    const big = 'é'.repeat(550_000);
    const elements = [{ i: 0, text: big }, { i: 1, text: `${big}🚀` }, { i: 2, text: `日${big}` }];
    const p = file('big.json', JSON.stringify(elements));
    const got = await collect(p);
    expect(got).toEqual(elements);
  });

  it('rejects anything that is not a top-level array with INVALID_ARGUMENT', async () => {
    expect(await codeOf(file('object.json', '{"a": [1, 2]}'))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(file('empty.json', ''))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(file('ws.json', '   \n'))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(file('scalar.json', '"just a string"'))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(file('unterminated.json', '[1, 2'))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(file('unterminated-obj.json', '[{"a": 1}, {"b": '))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(file('bad-element.json', '[{"a": 1}, {bad}]'))).toBe('INVALID_ARGUMENT');
  });

  it('reports a missing file as IO', async () => {
    expect(await codeOf(join(dir, 'does-not-exist.json'))).toBe('IO');
  });

  it('stops reading and closes the file when the consumer breaks early', async () => {
    const p = file('early.json', JSON.stringify([1, 2, 3, 4]));
    let seen = 0;
    for await (const _element of iterateJsonArray(p)) {
      seen += 1;
      if (seen === 2) break;
    }
    expect(seen).toBe(2);
    // The file is not held open: it can be removed on every platform.
    rmSync(p);
  });

  it('streams a generated 50 MB file with heap growth under 100 MB', async () => {
    const p = join(dir, 'fifty.json');
    const fd = openSync(p, 'w');
    const filler = 'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore '.repeat(9);
    let bytes = 0;
    let count = 0;
    try {
      writeSync(fd, '[\n');
      bytes = 2;
      const target = 50 * 1024 * 1024;
      let batch: string[] = [];
      while (bytes < target) {
        const element = JSON.stringify({ id: count, title: `Conversation ${count}`, body: filler, tags: ['a', 'b'] });
        batch.push(element);
        bytes += element.length + 2;
        count += 1;
        if (batch.length === 1000) {
          writeSync(fd, `${batch.join(',\n')},\n`);
          batch = [];
        }
      }
      writeSync(fd, `${batch.join(',\n')}\n]\n`);
    } finally {
      closeSync(fd);
    }
    expect(bytes).toBeGreaterThan(50 * 1024 * 1024);

    const before = process.memoryUsage().heapUsed;
    let maxGrowth = 0;
    let seen = 0;
    let lastId = -1;
    for await (const element of iterateJsonArray(p)) {
      seen += 1;
      lastId = (element as { id: number }).id;
      if (seen % 2000 === 0) maxGrowth = Math.max(maxGrowth, process.memoryUsage().heapUsed - before);
    }
    maxGrowth = Math.max(maxGrowth, process.memoryUsage().heapUsed - before);
    expect(seen).toBe(count);
    expect(lastId).toBe(count - 1);
    expect(maxGrowth).toBeLessThan(100 * 1024 * 1024);
    rmSync(p);
  }, 120_000);
});
