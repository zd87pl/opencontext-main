import { describe, expect, it } from 'vitest';
import { VaultError } from '../src/errors.js';
import { b64, unb64 } from '../src/util/b64.js';
import { canonicalJson, sha256Hex } from '../src/util/canonical-json.js';
import { Lru } from '../src/util/lru.js';
import { hasNoControl, normalizeForQuote, normalizeStatement, normalizeTags, stripControl, truncateJson, truncateText } from '../src/util/text.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBase64 } from '../src/util/b64.js';

describe('b64', () => {
  it('round-trips bytes with standard padded base64', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const text = b64(bytes);
    expect(text).toBe(bytes.toString('base64'));
    expect(text).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(unb64(text).equals(bytes)).toBe(true);
    expect(b64(new Uint8Array(0))).toBe('');
  });

  it('encodes a Uint8Array view without copying the whole backing buffer', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    expect(b64(backing.subarray(2, 5))).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('rejects base64url, whitespace, bad padding and non-strings with CORRUPT', () => {
    for (const bad of ['AQI-', 'AQ ID', 'AQIDB', 'A===', '====', 'AQI=D', 'abc']) {
      expect(() => unb64(bad)).toThrow(VaultError);
      try {
        unb64(bad);
      } catch (err) {
        expect(VaultError.is(err, 'CORRUPT')).toBe(true);
      }
    }
    expect(() => unb64(42 as unknown as string)).toThrow(VaultError);
  });

  it('validates linearly: the base64 of a 16 MiB buffer decodes instead of overflowing the regex stack', () => {
    const bytes = Buffer.alloc(16 * 1024 * 1024, 7);
    const text = bytes.toString('base64');
    expect(text.length).toBeGreaterThan(20_000_000);
    expect(unb64(text).equals(bytes)).toBe(true);
    expect(() => unb64(`${text} `)).toThrow(VaultError);
    expect(() => unb64(`${text.slice(0, 1000)}-${text.slice(1001)}`)).toThrow(VaultError);
  });

  it('isBase64 accepts exactly what the grouped-quad regex accepted', () => {
    const grouped = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    const alphabet = ['A', 'z', '0', '+', '/', '=', '-', ' ', '\n'];
    let checked = 0;
    const walk = (prefix: string, depth: number): void => {
      expect(isBase64(prefix), JSON.stringify(prefix)).toBe(grouped.test(prefix));
      checked += 1;
      if (depth === 0) return;
      for (const c of alphabet) walk(prefix + c, depth - 1);
    };
    walk('', 5);
    expect(checked).toBeGreaterThan(50_000);
  });
});

describe('canonicalJson test vector (test/vectors/canonical-json-vectors.json)', () => {
  it('every case hashes to the committed sha256', () => {
    const doc = JSON.parse(readFileSync(join(import.meta.dirname, 'vectors', 'canonical-json-vectors.json'), 'utf8')) as { cases: Array<{ name: string; value: unknown; canonical: string; sha256: string }> };
    expect(doc.cases.length).toBeGreaterThanOrEqual(3);
    for (const c of doc.cases) {
      expect(canonicalJson(c.value), c.name).toBe(c.canonical);
      expect(sha256Hex(c.canonical), c.name).toBe(c.sha256);
    }
    const spec = readFileSync(join(import.meta.dirname, '..', 'SPEC.md'), 'utf8');
    for (const c of doc.cases) expect(spec, c.name).toContain(c.sha256);
  });
});

describe('canonicalJson', () => {
  it('sorts keys, drops undefined, keeps array order and nulls', () => {
    const value = { b: 1, a: [3, undefined, { z: null, y: 'x' }], c: undefined, d: 'é\n"' };
    expect(canonicalJson(value)).toBe('{"a":[3,null,{"y":"x","z":null}],"b":1,"d":"é\\n\\""}');
  });

  it('is independent of key insertion order and whitespace', () => {
    expect(canonicalJson({ x: 1, y: { q: 2, p: 3 } })).toBe(canonicalJson(JSON.parse('{ "y": {"p":3, "q":2}, "x": 1 }')));
  });

  it('sorts keys by code point, not UTF-16 code unit', () => {
    // U+FF21 (FULLWIDTH A) is a single code unit 0xFF21; U+1F600 is a surrogate pair starting 0xD83D.
    // Code-unit order would put the emoji first; code-point order puts U+FF21 first.
    expect(canonicalJson({ '😀': 1, 'Ａ': 2 })).toBe('{"Ａ":2,"😀":1}');
  });

  it('handles toJSON, non-finite numbers and nested empties like JSON.stringify', () => {
    expect(canonicalJson({ d: new Date(0), n: Number.NaN, i: Number.POSITIVE_INFINITY, e: {}, l: [] })).toBe(
      '{"d":"1970-01-01T00:00:00.000Z","e":{},"i":null,"l":[],"n":null}',
    );
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson('s')).toBe('"s"');
  });

  it('sha256Hex hashes strings as UTF-8 and bytes as-is', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'));
    expect(sha256Hex('世界')).toBe(sha256Hex(Buffer.from('世界', 'utf8')));
  });
});

describe('text', () => {
  it('normalizeForQuote applies NFKC, collapses whitespace, trims, keeps case', () => {
    expect(normalizeForQuote('  Hello \t\n  World  ')).toBe('Hello World');
    expect(normalizeForQuote('ﬁle')).toBe('file'); // U+FB01 ligature → "fi"
    expect(normalizeForQuote('é')).toBe('é'); // combining acute → precomposed
    expect(normalizeForQuote('Ａ')).toBe('A'); // fullwidth
    expect(normalizeForQuote('Keep CASE')).toBe('Keep CASE');
  });

  it('normalizeStatement lowercases and strips trailing punctuation only', () => {
    expect(normalizeStatement('User prefers Tabs over spaces.')).toBe('user prefers tabs over spaces');
    expect(normalizeStatement('Really?!')).toBe('really');
    expect(normalizeStatement('Mr. Smith lives in Lisbon.')).toBe('mr. smith lives in lisbon');
    expect(normalizeStatement('prefers tabs over spaces')).not.toBe(normalizeStatement('prefers spaces over tabs'));
  });

  it('normalizeTags lowercases, trims, dedupes and validates', () => {
    expect(normalizeTags([' Coding', 'go', 'coding', 'Go ', 'a.b:c-d_e'])).toEqual(['coding', 'go', 'a.b:c-d_e']);
    expect(normalizeTags([])).toEqual([]);
    expect(() => normalizeTags(['ok', 'has space'])).toThrow('invalid tag "has space"');
    expect(() => normalizeTags(['-leading'])).toThrow(VaultError);
    expect(() => normalizeTags(['x'.repeat(41)])).toThrow(VaultError);
    try {
      normalizeTags(['']);
    } catch (err) {
      expect(VaultError.is(err, 'INVALID_ARGUMENT')).toBe(true);
    }
  });

  it('truncateJson cuts long serializations and marks them', () => {
    expect(truncateJson({ a: 1 }, 100)).toBe('{"a":1}');
    const long = truncateJson({ text: 'x'.repeat(100) }, 20);
    expect(long.startsWith('{"text":"xxxx')).toBe(true);
    expect(long.endsWith('…[truncated]')).toBe(true);
    expect(long.length).toBe(20 + '…[truncated]'.length);
    expect(truncateJson(undefined, 10)).toBe('null');
  });

  it('truncateJson never splits a surrogate pair', () => {
    const s = truncateJson('ab😀cd', 4); // JSON is "ab😀cd" with quotes → cutting at 4 lands inside the pair
    expect(s).toBe('"ab…[truncated]');
  });
});

describe('Lru', () => {
  it('evicts least recently used beyond capacity and refreshes on get', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1); // a is now most recent
    lru.set('c', 3); // evicts b
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);
    expect(lru.size).toBe(2);
  });

  it('replaces values, deletes and clears', () => {
    const lru = new Lru<string, string>(3);
    lru.set('k', 'v1');
    lru.set('k', 'v2');
    expect(lru.size).toBe(1);
    expect(lru.get('k')).toBe('v2');
    lru.delete('k');
    expect(lru.get('k')).toBeUndefined();
    lru.set('x', '1');
    lru.clear();
    expect(lru.size).toBe(0);
    expect(lru.capacity).toBe(3);
  });

  it('capacity 0 stores nothing and invalid capacity throws', () => {
    const none = new Lru<string, string>(0);
    none.set('a', 'b');
    expect(none.size).toBe(0);
    expect(() => new Lru(-1)).toThrow(RangeError);
    expect(() => new Lru(1.5)).toThrow(RangeError);
  });
});

describe('truncateText and control characters', () => {
  it('truncateText cuts at max with the marker and never splits a surrogate pair; truncateJson delegates to it', () => {
    expect(truncateText('abc', 3)).toBe('abc');
    expect(truncateText('abcd', 3)).toBe('abc…[truncated]');
    expect(truncateText('ab😀cd', 3)).toBe('ab…[truncated]');
    expect(truncateJson({ a: 'x'.repeat(10) }, 6)).toBe(truncateText('{"a":"xxxxxxxxxx"}', 6));
  });

  it('stripControl replaces terminal-significant characters and keeps newlines, tabs and ordinary Unicode', () => {
    expect(stripControl('a\u001b[2K\u001b[1Gb\u0007c\u0000d\u009be\u2028f')).toBe('a\uFFFD[2K\uFFFD[1Gb\uFFFDc\uFFFDd\uFFFDe\uFFFDf');
    expect(stripControl('line\nnext\ttab 世界 é')).toBe('line\nnext\ttab 世界 é');
    expect(hasNoControl('User likes tea.\twith milk')).toBe(true);
    expect(hasNoControl('two\nlines\r\n')).toBe(true); // newlines are a one-line rule, not a control-character rule
    for (const bad of ['\u001b[31m', 'a\u0000b', 'a\u000bb', '\u009b', '\u2028', '\u007f']) expect(hasNoControl(bad), JSON.stringify(bad)).toBe(false);
  });
});
