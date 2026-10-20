import { tokenize, tokenizeQuery } from './tokenize.js';

/** One ranked document: its id, BM25 score and the query terms it contains. */
export interface Hit {
  id: string;
  score: number;
  terms: string[];
}

interface Doc {
  /** Token count (document length for the BM25 length normalization). */
  len: number;
  /** Term frequencies, kept per document so a doc can be replaced or the postings rebuilt without re-tokenizing. */
  tf: Map<string, number>;
}

/**
 * In-memory inverted index with Okapi BM25 ranking (k1 = 1.2, b = 0.75, idf = ln(1 + (N − n + 0.5) / (n + 0.5))).
 * Postings are Map<term, Map<docId, tf>>. It is built and kept in memory only and never persisted: an on-disk
 * index would leak every term of every memory and conversation next to the encrypted journals.
 *
 * remove() leaves a tombstone instead of walking the postings (the common case is a handful of deletions between
 * server restarts); scoring skips tombstoned docs and counts document frequency over live docs only, so results are
 * identical to a freshly built index at all times. rebuild() purges tombstones and runs automatically once they
 * exceed 25% of the live documents.
 */
export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  /** Live and tombstoned docs alike; `tombstones` tells them apart. */
  private readonly docs = new Map<string, Doc>();
  private postings = new Map<string, Map<string, number>>();
  private readonly tombstones = new Set<string>();
  /** Sum of live document lengths. */
  private totalLen = 0;

  constructor(o: { k1?: number; b?: number } = {}) {
    this.k1 = o.k1 ?? 1.2;
    this.b = o.b ?? 0.75;
  }

  /** Index `text` under `docId`, replacing any previous (live or tombstoned) document with that id. */
  add(docId: string, text: string): void {
    if (this.docs.has(docId)) this.purge(docId);
    const tf = new Map<string, number>();
    const tokens = tokenize(text);
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.set(docId, { len: tokens.length, tf });
    this.totalLen += tokens.length;
    for (const [term, n] of tf) {
      let p = this.postings.get(term);
      if (p === undefined) {
        p = new Map<string, number>();
        this.postings.set(term, p);
      }
      p.set(docId, n);
    }
  }

  /** Tombstone `docId`; unknown ids are ignored. Triggers rebuild() when tombstones exceed 25% of live docs. */
  remove(docId: string): void {
    const doc = this.docs.get(docId);
    if (doc === undefined || this.tombstones.has(docId)) return;
    this.tombstones.add(docId);
    this.totalLen -= doc.len;
    if (this.tombstones.size > 0.25 * this.size) this.rebuild();
  }

  has(docId: string): boolean {
    return this.docs.has(docId) && !this.tombstones.has(docId);
  }

  /** Number of live (non-tombstoned) documents. */
  get size(): number {
    return this.docs.size - this.tombstones.size;
  }

  /**
   * Candidates are the union of the postings of the query terms; `filter` is applied while scoring (it never
   * affects idf, so a filtered result ranks exactly like the unfiltered one); top-k by score, ties broken by docId
   * ascending so results are deterministic. An empty term list or an empty index yields [].
   */
  search(query: string, o: { limit: number; filter?: (docId: string) => boolean }): Hit[] {
    const terms = this.terms(query);
    const N = this.size;
    if (terms.length === 0 || N === 0 || o.limit <= 0) return [];
    const avgdl = this.totalLen / N;
    const allowed = new Map<string, boolean>();
    const isAllowed = (id: string): boolean => {
      if (o.filter === undefined) return true;
      let v = allowed.get(id);
      if (v === undefined) {
        v = o.filter(id);
        allowed.set(id, v);
      }
      return v;
    };
    const scores = new Map<string, { score: number; terms: string[] }>();
    for (const term of terms) {
      const p = this.postings.get(term);
      if (p === undefined) continue;
      let n = 0;
      for (const id of p.keys()) if (!this.tombstones.has(id)) n++;
      if (n === 0) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      for (const [id, tf] of p) {
        if (this.tombstones.has(id) || !isAllowed(id)) continue;
        const doc = this.docs.get(id);
        if (doc === undefined) continue;
        const norm = this.k1 * (1 - this.b + (this.b * doc.len) / avgdl);
        const s = (idf * tf * (this.k1 + 1)) / (tf + norm);
        const acc = scores.get(id);
        if (acc === undefined) scores.set(id, { score: s, terms: [term] });
        else {
          acc.score += s;
          acc.terms.push(term);
        }
      }
    }
    const hits: Hit[] = [];
    for (const [id, { score, terms: matched }] of scores) hits.push({ id, score, terms: matched });
    hits.sort((x, y) => (y.score !== x.score ? y.score - x.score : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    return hits.length > o.limit ? hits.slice(0, o.limit) : hits;
  }

  /** Drop every tombstoned document and rebuild the postings from the live documents' term counts. */
  rebuild(): void {
    for (const id of this.tombstones) this.docs.delete(id);
    this.tombstones.clear();
    const postings = new Map<string, Map<string, number>>();
    for (const [id, doc] of this.docs) {
      for (const [term, n] of doc.tf) {
        let p = postings.get(term);
        if (p === undefined) {
          p = new Map<string, number>();
          postings.set(term, p);
        }
        p.set(id, n);
      }
    }
    this.postings = postings;
  }

  /** Distinct query terms after tokenizeQuery(), in first-seen order — what search() scores and snippets highlight. */
  terms(query: string): string[] {
    return [...new Set(tokenizeQuery(query))];
  }

  /** Remove a document and its postings outright (used when a doc id is re-added). */
  private purge(docId: string): void {
    const doc = this.docs.get(docId);
    if (doc === undefined) return;
    for (const term of doc.tf.keys()) {
      const p = this.postings.get(term);
      if (p === undefined) continue;
      p.delete(docId);
      if (p.size === 0) this.postings.delete(term);
    }
    if (this.tombstones.delete(docId) === false) this.totalLen -= doc.len;
    this.docs.delete(docId);
  }
}
