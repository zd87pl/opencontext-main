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
const WHITESPACE = /\s/;

/** Longest run handed to Intl.Segmenter in one call; see segmentWords. */
export const SEGMENT_CHUNK = 4096;

export interface WordSegment {
  segment: string;
  /** Offset of the segment in the whole text, not in the chunk it was produced from. */
  index: number;
  isWordLike: boolean | undefined;
}

/**
 * Word segmentation that stays linear on Node 20. The ICU build in Node 20 makes Intl.Segmenter super-linear in
 * the input length (a 200 KB string took 20 s there against 33 ms on Node 22 in the perf check), so the text is
 * segmented in runs of at most SEGMENT_CHUNK characters, each cut at a whitespace character: whitespace is always a
 * segment boundary, so the segments are identical to a whole-text pass. A run with no whitespace in its second
 * half is cut at the limit (never inside a surrogate pair), which can split one very long token; that is the
 * price of bounded time and only affects a 2 KB+ word.
 */
export function* segmentWords(text: string): Generator<WordSegment> {
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + SEGMENT_CHUNK);
    if (end < text.length) {
      let cut = end;
      const floor = start + SEGMENT_CHUNK / 2;
      while (cut > floor && !WHITESPACE.test(text[cut] ?? '')) cut -= 1;
      if (cut > floor) end = cut;
      else {
        const before = text.charCodeAt(end - 1);
        if (before >= 0xd800 && before <= 0xdbff) end -= 1;
      }
    }
    for (const seg of segmenter.segment(text.slice(start, end))) {
      yield { segment: seg.segment, index: start + seg.index, isWordLike: seg.isWordLike };
    }
    start = end;
  }
}

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
  for (const seg of segmentWords(text.normalize('NFKC'))) {
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
