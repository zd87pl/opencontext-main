import { describe, expect, it } from 'vitest';
import { Bm25Index } from '../src/search/bm25.js';

/**
 * Hand-computed corpus (k1 = 1.2, b = 0.75, idf = ln(1 + (N − n + 0.5) / (n + 0.5))):
 *   d1 "apple banana cherry"          len 3   terms appl, banana, cherri
 *   d2 "apple apple durian"           len 3   terms appl×2, durian
 *   d3 "banana banana banana durian"  len 4   terms banana×3, durian
 * N = 3, avgdl = 10/3.
 *   idf(n=2) = ln(1 + 1.5/2.5) = ln 1.6          idf(n=1) = ln(1 + 2.5/1.5) = ln(8/3)
 *   norm(len 3) = 1.2·(0.25 + 0.75·(3/(10/3))) = 1.2·0.925 = 1.11
 *   norm(len 4) = 1.2·(0.25 + 0.75·(4/(10/3))) = 1.2·1.15  = 1.38
 *   score = idf · tf·2.2 / (tf + norm)
 */
const IDF2 = Math.log(1.6);
const IDF1 = Math.log(8 / 3);
const APPLE_D1 = (IDF2 * 2.2) / 2.11; // ≈ 0.49005
const APPLE_D2 = (IDF2 * 4.4) / 3.11; // ≈ 0.66496
const CHERRY_D1 = (IDF1 * 2.2) / 2.11; // ≈ 1.02266
const BANANA_D3 = (IDF2 * 6.6) / 4.38; // ≈ 0.70822
const DURIAN_D2 = (IDF2 * 2.2) / 2.11;
const DURIAN_D3 = (IDF2 * 2.2) / 2.38; // ≈ 0.43446

function corpus(): Bm25Index {
  const ix = new Bm25Index();
  ix.add('d1', 'apple banana cherry');
  ix.add('d2', 'apple apple durian');
  ix.add('d3', 'banana banana banana durian');
  return ix;
}

describe('Bm25Index scoring', () => {
  it('matches hand-computed idf and term-frequency scores', () => {
    const ix = corpus();
    const apple = ix.search('apple', { limit: 10 });
    expect(apple.map((h) => h.id)).toEqual(['d2', 'd1']);
    expect(apple[1]?.score).toBeCloseTo(APPLE_D1, 10);
    expect(apple[0]?.score).toBeCloseTo(APPLE_D2, 10);
    expect(apple[1]?.score).toBeCloseTo(0.49005, 4);
    expect(apple[0]?.score).toBeCloseTo(0.66496, 4);

    const banana = ix.search('banana', { limit: 10 });
    expect(banana.map((h) => h.id)).toEqual(['d3', 'd1']);
    expect(banana[0]?.score).toBeCloseTo(BANANA_D3, 10);
    expect(banana[1]?.score).toBeCloseTo(APPLE_D1, 10); // same tf, len and df as apple in d1
  });

  it('sums per-term scores for multi-term queries', () => {
    const ix = corpus();
    const hits = ix.search('apple durian', { limit: 10 });
    expect(hits.map((h) => h.id)).toEqual(['d2', 'd1', 'd3']);
    expect(hits[0]?.score).toBeCloseTo(APPLE_D2 + DURIAN_D2, 10);
    expect(hits[1]?.score).toBeCloseTo(APPLE_D1, 10);
    expect(hits[2]?.score).toBeCloseTo(DURIAN_D3, 10);
    expect(hits[0]?.terms).toEqual(['appl', 'durian']);
    expect(hits[1]?.terms).toEqual(['appl']);
    expect(hits[2]?.terms).toEqual(['durian']);
  });

  it('ranks the document containing the exact query terms above partial matches', () => {
    const ix = corpus();
    const [top] = ix.search('apple durian', { limit: 1 });
    expect(top?.id).toBe('d2');
    expect(ix.search('cherry', { limit: 10 }).map((h) => h.id)).toEqual(['d1']);
    expect(ix.search('cherry', { limit: 10 }).map((h) => h.id)).not.toContain('d2');
  });

  it('scores a rarer term higher than a common one at equal tf and length', () => {
    const ix = corpus();
    const cherry = ix.search('cherry', { limit: 10 })[0];
    const apple = ix.search('apple', { limit: 10 }).find((h) => h.id === 'd1');
    expect(cherry?.score).toBeCloseTo(CHERRY_D1, 10);
    expect(cherry?.score ?? 0).toBeGreaterThan(apple?.score ?? Infinity);
  });

  it('stems and lowercases both sides and ignores stopwords', () => {
    const ix = corpus();
    expect(ix.search('Apples', { limit: 10 }).map((h) => h.id)).toEqual(['d2', 'd1']);
    expect(ix.search('the apples', { limit: 10 }).map((h) => h.id)).toEqual(['d2', 'd1']);
    expect(ix.terms('apples apple the')).toEqual(['appl']);
  });

  it('returns [] for an empty term list, an unknown term, an empty index or limit 0', () => {
    const ix = corpus();
    expect(ix.search('', { limit: 10 })).toEqual([]);
    expect(ix.search('the', { limit: 10 })).toEqual([]);
    expect(ix.search('zebra', { limit: 10 })).toEqual([]);
    expect(ix.search('apple', { limit: 0 })).toEqual([]);
    expect(new Bm25Index().search('apple', { limit: 10 })).toEqual([]);
  });

  it('breaks score ties by docId ascending and respects limit', () => {
    const ix = new Bm25Index();
    ix.add('b', 'same text here');
    ix.add('c', 'same text here');
    ix.add('a', 'same text here');
    expect(ix.search('same', { limit: 10 }).map((h) => h.id)).toEqual(['a', 'b', 'c']);
    expect(ix.search('same', { limit: 2 }).map((h) => h.id)).toEqual(['a', 'b']);
  });

  it('a filtered search is numerically identical to a fresh index of the visible documents (N, avgdl and df exclude hidden ones)', () => {
    const ix = corpus();
    const hits = ix.search('apple', { limit: 10, filter: (id) => id !== 'd2' });
    expect(hits.map((h) => h.id)).toEqual(['d1']);
    // Visible corpus d1 + d3: N = 2, avgdl = 3.5, n(apple) = 1 → idf = ln(1 + 1.5/1.5) = ln 2; norm = 1.2·(0.25 + 0.75·3/3.5)
    const visibleOnly = (Math.log(2) * 2.2) / (1 + 1.2 * (0.25 + (0.75 * 3) / 3.5));
    expect(hits[0]?.score).toBeCloseTo(visibleOnly, 10);
    expect(hits[0]?.score).not.toBeCloseTo(APPLE_D1, 2); // the hidden d2 no longer leaks into the score
    const fresh = new Bm25Index();
    fresh.add('d1', 'apple banana cherry');
    fresh.add('d3', 'banana banana banana durian');
    expect(fresh.search('apple', { limit: 10 })[0]?.score).toBeCloseTo(hits[0]?.score ?? -1, 12);
    // the term-existence oracle is closed: two visible probe docs differing in one word score the same whether or not hidden docs mention it
    const probe = new Bm25Index();
    for (let i = 0; i < 5; i += 1) probe.add(`hidden${i}`, 'okafor okafor private note');
    probe.add('probeA', 'user mentioned okafor today');
    probe.add('probeB', 'user mentioned zzqx today');
    const visible = (id: string): boolean => id.startsWith('probe');
    const a = probe.search('okafor', { limit: 10, filter: visible })[0]?.score;
    const b = probe.search('zzqx', { limit: 10, filter: visible })[0]?.score;
    expect(a).toBeCloseTo(b ?? -1, 12);
    expect(probe.search('okafor zzqx', { limit: 10, filter: visible }).map((h) => h.id)).toEqual(['probeA', 'probeB']); // ties broken by id, not by hidden df
    // a filter that admits nothing yields [] rather than dividing by zero
    expect(ix.search('apple', { limit: 10, filter: () => false })).toEqual([]);
  });

  it('accepts custom k1 and b', () => {
    const ix = new Bm25Index({ k1: 2, b: 0 });
    ix.add('d1', 'apple banana cherry');
    ix.add('d2', 'apple apple durian');
    ix.add('d3', 'banana banana banana durian');
    // b = 0 → no length normalization: score = idf · tf·3 / (tf + 2)
    const hits = ix.search('apple', { limit: 10 });
    expect(hits.find((h) => h.id === 'd1')?.score).toBeCloseTo((IDF2 * 3) / 3, 10);
    expect(hits.find((h) => h.id === 'd2')?.score).toBeCloseTo((IDF2 * 6) / 4, 10);
  });
});

describe('Bm25Index maintenance', () => {
  const docs: Array<[string, string]> = [
    ['d1', 'apple banana cherry'],
    ['d2', 'apple apple durian'],
    ['d3', 'banana banana banana durian'],
    ['d4', 'elderberry fig apple'],
    ['d5', 'fig fig grape'],
    ['d6', 'grape apple cherry'],
    ['d7', 'honeydew durian'],
    ['d8', 'kiwi apple apple apple'],
    ['d9', 'lemon lime'],
    ['d10', 'mango banana'],
  ];
  const queries = ['apple', 'banana durian', 'fig', 'cherry grape', 'kiwi lemon mango'];
  const results = (ix: Bm25Index): unknown[] =>
    queries.map((q) => ix.search(q, { limit: 100 }).map((h) => ({ id: h.id, score: h.score.toFixed(12), terms: h.terms })));

  it('has/size track live documents and add replaces an existing id', () => {
    const ix = new Bm25Index();
    ix.add('d1', 'apple');
    expect(ix.has('d1')).toBe(true);
    expect(ix.size).toBe(1);
    ix.add('d1', 'zebra');
    expect(ix.size).toBe(1);
    expect(ix.search('apple', { limit: 10 })).toEqual([]);
    expect(ix.search('zebra', { limit: 10 }).map((h) => h.id)).toEqual(['d1']);
    ix.remove('d1');
    expect(ix.has('d1')).toBe(false);
    expect(ix.size).toBe(0);
    expect(ix.search('zebra', { limit: 10 })).toEqual([]);
    ix.remove('never-added');
    expect(ix.size).toBe(0);
  });

  it('matches a fresh index after remove (tombstoned), explicit rebuild and re-add', () => {
    const ix = new Bm25Index();
    for (const [id, text] of docs) ix.add(id, text);
    ix.remove('d2'); // 1 tombstone of 9 live docs: stays a tombstone (≤ 25%)
    expect(ix.has('d2')).toBe(false);
    expect(ix.size).toBe(9);

    const fresh = new Bm25Index();
    for (const [id, text] of docs) if (id !== 'd2') fresh.add(id, text);
    expect(results(ix)).toEqual(results(fresh));

    ix.rebuild();
    expect(ix.size).toBe(9);
    expect(results(ix)).toEqual(results(fresh));

    ix.add('d2', 'apple durian durian'); // re-adding a removed id
    ix.add('d4', 'fig only'); // replacing a live id
    const fresh2 = new Bm25Index();
    for (const [id, text] of docs) fresh2.add(id, id === 'd2' ? 'apple durian durian' : id === 'd4' ? 'fig only' : text);
    expect(ix.size).toBe(10);
    expect(results(ix)).toEqual(results(fresh2));
  });

  it('rebuilds automatically once tombstones exceed 25% of live docs', () => {
    const ix = new Bm25Index();
    for (const [id, text] of docs) ix.add(id, text);
    ix.remove('d1');
    ix.remove('d3');
    ix.remove('d5'); // 3 tombstones vs 7 live → > 25% → automatic rebuild
    const fresh = new Bm25Index();
    for (const [id, text] of docs) if (!['d1', 'd3', 'd5'].includes(id)) fresh.add(id, text);
    expect(ix.size).toBe(7);
    expect(results(ix)).toEqual(results(fresh));
    ix.add('d1', 'apple banana cherry');
    expect(ix.size).toBe(8);
    expect(ix.search('cherry', { limit: 10 }).map((h) => h.id)).toEqual(['d1', 'd6']);
  });

  it('removing every document leaves an empty, searchable index', () => {
    const ix = new Bm25Index();
    for (const [id, text] of docs) ix.add(id, text);
    for (const [id] of docs) ix.remove(id);
    expect(ix.size).toBe(0);
    expect(ix.search('apple', { limit: 10 })).toEqual([]);
    ix.add('x', 'apple');
    expect(ix.search('apple', { limit: 10 }).map((h) => h.id)).toEqual(['x']);
  });
});
