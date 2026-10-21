import { segmentWords, stemToken } from './tokenize.js';

interface Occurrence {
  start: number;
  end: number;
  term: string;
}

const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
/** Context re-segmented around a window edge to find a true word boundary without storing every boundary of a large text. */
const EDGE_MARGIN = 48;

/**
 * Picks the `width`-character window (default 180) of `text` that contains the most DISTINCT stemmed query terms
 * (ties: more occurrences, then earliest), centres it on those hits, trims both edges to word boundaries and wraps
 * every matching word in «». Whitespace runs in the returned text are collapsed to one space so a multi-line
 * conversation turn reads as one line. `start` is the offset of the window in the original text; `hits` is the
 * number of distinct query terms present in the window (0 → the leading `width` characters are returned).
 *
 * Matching uses the same per-word normalization as the index (NFKC → lowercase → Porter for ASCII words), so a
 * query for "preferences" highlights "preferred" — exactly the words that made the document a hit.
 */
export function bestSnippet(
  text: string,
  stemmedTerms: string[],
  width = 180,
): { text: string; start: number; hits: number } {
  const w = Math.max(1, Math.floor(width));
  const wanted = new Set(stemmedTerms);
  const occurrences: Occurrence[] = [];
  if (wanted.size > 0 && text.length > 0) {
    const memo = new Map<string, string>();
    // Whole bodies go through the chunked segmenter (Node 20 is super-linear on long strings); the window edges
    // below re-segment short slices and keep the plain one.
    for (const seg of segmentWords(text)) {
      if (!seg.isWordLike) continue;
      let stem = memo.get(seg.segment);
      if (stem === undefined) {
        stem = stemToken(seg.segment);
        memo.set(seg.segment, stem);
      }
      if (wanted.has(stem)) occurrences.push({ start: seg.index, end: seg.index + seg.segment.length, term: stem });
    }
  }

  if (occurrences.length === 0) {
    const end = trimEnd(text, Math.min(text.length, w), 0);
    return { text: collapse(text.slice(0, end)), start: 0, hits: 0 };
  }

  // Best window: for each occurrence as the leftmost hit, count what fits within `w` chars.
  let bestI = 0;
  let bestJ = 0; // index of the last occurrence inside the best window
  let bestDistinct = 0;
  let bestCount = 0;
  for (let i = 0; i < occurrences.length; i++) {
    const first = occurrences[i];
    const limit = first.start + w;
    const distinct = new Set<string>([first.term]);
    let count = 1;
    let j = i;
    while (j + 1 < occurrences.length && occurrences[j + 1].end <= limit) {
      j++;
      distinct.add(occurrences[j].term);
      count++;
    }
    if (distinct.size > bestDistinct || (distinct.size === bestDistinct && count > bestCount)) {
      bestDistinct = distinct.size;
      bestCount = count;
      bestI = i;
      bestJ = j;
    }
    // Every later window covers a subset of this one's occurrences, so nothing can beat it.
    if (j === occurrences.length - 1) break;
  }

  const first = occurrences[bestI];
  const last = occurrences[bestJ];
  // Centre the hits in the window, then clamp to the text.
  const span = Math.max(last.end, first.end) - first.start;
  let start = Math.max(0, first.start - Math.floor(Math.max(0, w - span) / 2));
  let end = Math.min(text.length, start + w);
  if (end === text.length) start = Math.max(0, end - w);
  start = trimStart(text, start, first.start);
  end = trimEnd(text, end, Math.max(last.end, first.end));

  // Wrap every occurrence that lies inside the window.
  const pieces: string[] = [];
  let cursor = start;
  const seen = new Set<string>();
  for (const occ of occurrences) {
    if (occ.start < start) continue;
    if (occ.end > end) break;
    pieces.push(text.slice(cursor, occ.start), '«', text.slice(occ.start, occ.end), '»');
    cursor = occ.end;
    seen.add(occ.term);
  }
  pieces.push(text.slice(cursor, end));
  return { text: collapse(pieces.join('')), start, hits: seen.size };
}

/** Move `pos` forward to the next word boundary and past any whitespace (never past `cap`, itself a boundary). */
function trimStart(text: string, pos: number, cap: number): number {
  let at = Math.min(pos, cap);
  if (pos > 0 && pos < cap) {
    at = cap;
    const lo = Math.max(0, pos - EDGE_MARGIN);
    const hi = Math.min(text.length, pos + EDGE_MARGIN);
    for (const seg of segmenter.segment(text.slice(lo, hi))) {
      const i = lo + seg.index;
      if (i >= pos) {
        at = Math.min(i, cap);
        break;
      }
    }
  }
  while (at < cap && WHITESPACE.test(text[at])) at++;
  return at;
}

/** Move `pos` backward to the previous word boundary and before any whitespace (never before `floor`, itself a boundary). */
function trimEnd(text: string, pos: number, floor: number): number {
  let at = Math.max(pos, floor);
  if (pos < text.length && pos > floor) {
    at = floor;
    const lo = Math.max(0, pos - EDGE_MARGIN);
    const hi = Math.min(text.length, pos + EDGE_MARGIN);
    for (const seg of segmenter.segment(text.slice(lo, hi))) {
      const i = lo + seg.index;
      if (i > pos) break;
      if (i >= floor) at = i;
    }
  }
  while (at > floor && WHITESPACE.test(text[at - 1])) at--;
  return at;
}

const WHITESPACE = /\s/;

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
