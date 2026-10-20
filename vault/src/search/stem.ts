/**
 * Porter (1980) stemmer — "An algorithm for suffix stripping", Program 14(3):130–137 — implemented from the
 * published rule set rather than pulled in as a dependency, so the search index adds no runtime package and its
 * behaviour is fixed by the 40 vectors in test/stem.test.ts. Input is expected to be a lowercase ASCII word (the
 * tokenizer only hands over tokens matching /^[a-z]+$/); anything else is stemmed on a best-effort basis with
 * non-letters treated as consonants. Words of one or two letters are returned unchanged, as in Porter's own
 * reference implementation, because the rules were never meant to shorten them further ("is" → "i" helps nobody).
 */
export function porterStem(word: string): string {
  if (word.length <= 2) return word;
  let w = word;

  // ---- Step 1a ----
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (w.endsWith('ss')) {
    /* keep */
  } else if (w.endsWith('s')) w = w.slice(0, -1);

  // ---- Step 1b ----
  if (w.endsWith('eed')) {
    // Longest matching suffix wins even when its condition fails: "feed" stays "feed", ED/ING are not tried.
    if (measure(w, w.length - 3) > 0) w = w.slice(0, -1);
  } else {
    let stem: string | undefined;
    if (w.endsWith('ed')) stem = w.slice(0, -2);
    else if (w.endsWith('ing')) stem = w.slice(0, -3);
    if (stem !== undefined && containsVowel(stem)) {
      w = stem;
      if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) w += 'e';
      else if (endsDoubleConsonant(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1);
      else if (measure(w, w.length) === 1 && endsCvc(w)) w += 'e';
    }
  }

  // ---- Step 1c ----
  if (w.endsWith('y') && containsVowel(w.slice(0, -1))) w = `${w.slice(0, -1)}i`;

  // ---- Step 2 ----
  w = replaceSuffix(w, STEP2, 0);

  // ---- Step 3 ----
  w = replaceSuffix(w, STEP3, 0);

  // ---- Step 4 ----
  w = replaceSuffix(w, STEP4, 1);

  // ---- Step 5a ----
  if (w.endsWith('e')) {
    const m = measure(w, w.length - 1);
    if (m > 1 || (m === 1 && !endsCvc(w.slice(0, -1)))) w = w.slice(0, -1);
  }

  // ---- Step 5b ----
  if (w.endsWith('l') && endsDoubleConsonant(w) && measure(w, w.length) > 1) w = w.slice(0, -1);

  return w;
}

/** [suffix, replacement, extra condition on the stem]; ordered so the longest matching suffix is found first. */
type Rule = readonly [string, string, ((stem: string) => boolean)?];

const STEP2: readonly Rule[] = [
  ['ational', 'ate'],
  ['tional', 'tion'],
  ['enci', 'ence'],
  ['anci', 'ance'],
  ['izer', 'ize'],
  ['abli', 'able'],
  ['alli', 'al'],
  ['entli', 'ent'],
  ['eli', 'e'],
  ['ousli', 'ous'],
  ['ization', 'ize'],
  ['ation', 'ate'],
  ['ator', 'ate'],
  ['alism', 'al'],
  ['iveness', 'ive'],
  ['fulness', 'ful'],
  ['ousness', 'ous'],
  ['aliti', 'al'],
  ['iviti', 'ive'],
  ['biliti', 'ble'],
];

const STEP3: readonly Rule[] = [
  ['icate', 'ic'],
  ['ative', ''],
  ['alize', 'al'],
  ['iciti', 'ic'],
  ['ical', 'ic'],
  ['ful', ''],
  ['ness', ''],
];

const STEP4: readonly Rule[] = [
  ['ement', ''],
  ['ance', ''],
  ['ence', ''],
  ['able', ''],
  ['ible', ''],
  ['ment', ''],
  ['ant', ''],
  ['ent', ''],
  ['ion', '', (stem) => stem.endsWith('s') || stem.endsWith('t')],
  ['ism', ''],
  ['ate', ''],
  ['iti', ''],
  ['ous', ''],
  ['ive', ''],
  ['ize', ''],
  ['al', ''],
  ['er', ''],
  ['ic', ''],
  ['ou', ''],
];

/**
 * Porter's rule-set semantics: only the rule with the longest matching suffix is considered; if its measure
 * condition (m > minMeasure) or extra condition fails, the word is left alone — no shorter suffix is tried.
 */
function replaceSuffix(w: string, rules: readonly Rule[], minMeasure: number): string {
  for (const [suffix, replacement, extra] of rules) {
    if (!w.endsWith(suffix)) continue;
    const stem = w.slice(0, w.length - suffix.length);
    if (measure(stem, stem.length) > minMeasure && (extra === undefined || extra(stem))) return stem + replacement;
    return w;
  }
  return w;
}

/** A consonant is any letter but a, e, i, o, u — and y when it is not preceded by a consonant (so "toy" ends in C). */
function isConsonant(w: string, i: number): boolean {
  switch (w[i]) {
    case 'a':
    case 'e':
    case 'i':
    case 'o':
    case 'u':
      return false;
    case 'y':
      return i === 0 ? true : !isConsonant(w, i - 1);
    default:
      return true;
  }
}

/** m in [C](VC){m}[V] for the prefix w[0, end). */
function measure(w: string, end: number): number {
  let m = 0;
  let i = 0;
  while (i < end && isConsonant(w, i)) i++;
  for (;;) {
    while (i < end && !isConsonant(w, i)) i++;
    if (i >= end) return m;
    while (i < end && isConsonant(w, i)) i++;
    m++;
    if (i >= end) return m;
  }
}

function containsVowel(stem: string): boolean {
  for (let i = 0; i < stem.length; i++) if (!isConsonant(stem, i)) return true;
  return false;
}

/** *d — ends with a double consonant (-tt, -ss, …). */
function endsDoubleConsonant(w: string): boolean {
  const n = w.length;
  return n >= 2 && w[n - 1] === w[n - 2] && isConsonant(w, n - 1);
}

/** *o — ends consonant-vowel-consonant where the final consonant is not w, x or y (-wil, -hop). */
function endsCvc(w: string): boolean {
  const n = w.length;
  if (n < 3) return false;
  if (!isConsonant(w, n - 1) || isConsonant(w, n - 2) || !isConsonant(w, n - 3)) return false;
  const last = w[n - 1];
  return last !== 'w' && last !== 'x' && last !== 'y';
}
