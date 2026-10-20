import { porterStem } from './stem.js';

/**
 * ~50 English function words dropped from indexed text and from queries. Deliberately short: BM25's idf already
 * discounts frequent words, and dropping more risks eating meaningful tokens ("user", "project", tag names).
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'is', 'it',
  'its', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'she', 'so',
  'that', 'the', 'their', 'them', 'there', 'these', 'they', 'this', 'to', 'was',
  'we', 'were', 'what', 'when', 'which', 'who', 'will', 'with', 'you', 'your',
]);

/** One shared segmenter: constructing Intl.Segmenter is comparatively expensive, segmenting with it is cheap. */
const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
const ASCII_WORD = /^[a-z]+$/;
const DIGIT = /^[0-9]$/;

/**
 * Memoized Porter stemming. Real corpora repeat a small vocabulary millions of times, so caching the stem of
 * each distinct ASCII word makes indexing a multi-megabyte vault several times faster. Bounded so a hostile or
 * random-token source cannot grow it without limit.
 */
const STEM_CACHE_MAX = 50_000;
const stemCache = new Map<string, string>();
function stemCached(word: string): string {
  const hit = stemCache.get(word);
  if (hit !== undefined) return hit;
  const s = porterStem(word);
  if (stemCache.size >= STEM_CACHE_MAX) stemCache.clear();
  stemCache.set(word, s);
  return s;
}

/**
 * Text → index terms: NFKC → Intl.Segmenter('und', word) keeping isWordLike segments → lowercase → drop stopwords →
 * drop length-1 tokens that are not a digit → Porter-stem tokens matching /^[a-z]+$/ only. CJK runs, accented
 * words and identifiers ("foo_bar", "mem_3f9a…", "3.14") are kept verbatim so a search for them still matches;
 * Porter is defined for English letters only.
 */
export function tokenize(text: string): string[] {
  return run(text, true);
}

/**
 * Query-side tokenization: identical to tokenize(), but when every token is a stopword the stopwords are kept so a
 * query such as "what is it" still searches instead of silently matching nothing.
 */
export function tokenizeQuery(text: string): string[] {
  const tokens = run(text, true);
  return tokens.length > 0 ? tokens : run(text, false);
}

function run(text: string, dropStopwords: boolean): string[] {
  const out: string[] = [];
  for (const seg of segmenter.segment(text.normalize('NFKC'))) {
    if (!seg.isWordLike) continue;
    const t = seg.segment.toLowerCase();
    if (dropStopwords && STOPWORDS.has(t)) continue;
    if (t.length === 1 && !DIGIT.test(t)) continue;
    out.push(ASCII_WORD.test(t) ? stemCached(t) : t);
  }
  return out;
}

/**
 * The stem of one already-segmented word, with the same ASCII-only rule as tokenize(). Exported for the snippet
 * builder, which needs per-segment stems at original text offsets and must agree with the index exactly.
 */
export function stemToken(segment: string): string {
  const t = segment.normalize('NFKC').toLowerCase();
  return ASCII_WORD.test(t) ? stemCached(t) : t;
}
