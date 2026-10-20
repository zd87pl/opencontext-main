import { describe, expect, it } from 'vitest';
import { porterStem } from '../src/search/stem.js';

/**
 * 40 vectors from the standard Porter sample (the paper's step examples and the tartarus voc/output lists),
 * chosen so every step and cleanup rule is exercised and so the published 1980 rules and Porter's later reference
 * implementation agree on each.
 */
const VECTORS: ReadonlyArray<readonly [string, string]> = [
  // step 1a
  ['caresses', 'caress'],
  ['ponies', 'poni'],
  ['caress', 'caress'],
  ['cats', 'cat'],
  // step 1b
  ['feed', 'feed'],
  ['agreed', 'agre'],
  ['plastered', 'plaster'],
  ['bled', 'bled'],
  ['motoring', 'motor'],
  ['sing', 'sing'],
  ['conflated', 'conflat'],
  ['troubled', 'troubl'],
  // step 1b cleanup (at/bl/iz, double consonant, cvc)
  ['sized', 'size'],
  ['hopping', 'hop'],
  ['falling', 'fall'],
  ['failing', 'fail'],
  ['filing', 'file'],
  // step 1c
  ['happy', 'happi'],
  ['sky', 'sky'],
  // step 2
  ['relational', 'relat'],
  ['conditional', 'condit'],
  ['rational', 'ration'],
  ['hesitanci', 'hesit'],
  ['digitizer', 'digit'],
  ['vietnamization', 'vietnam'],
  ['operator', 'oper'],
  ['hopefulness', 'hope'],
  // step 3
  ['triplicate', 'triplic'],
  ['formative', 'form'],
  ['electriciti', 'electr'],
  ['goodness', 'good'],
  // step 4
  ['revival', 'reviv'],
  ['allowance', 'allow'],
  ['adjustable', 'adjust'],
  ['replacement', 'replac'],
  ['adoption', 'adopt'],
  ['effective', 'effect'],
  // step 5
  ['probate', 'probat'],
  ['controll', 'control'],
  ['roll', 'roll'],
];

describe('porterStem', () => {
  it('ships exactly 40 reference vectors', () => {
    expect(VECTORS).toHaveLength(40);
  });

  it.each(VECTORS)('%s → %s', (word, stem) => {
    expect(porterStem(word)).toBe(stem);
  });

  it("reproduces the paper's full-pipeline examples", () => {
    expect(porterStem('generalizations')).toBe('gener');
    expect(porterStem('oscillators')).toBe('oscil');
  });

  it('handles everyday vocabulary the way the standard sample does', () => {
    expect(porterStem('abilities')).toBe('abil');
    expect(porterStem('running')).toBe('run');
    expect(porterStem('preferences')).toBe('prefer');
    expect(porterStem('knowledge')).toBe('knowledg');
    expect(porterStem('carefully')).toBe('carefulli');
    expect(porterStem('memories')).toBe('memori');
  });

  it('leaves words of one or two letters alone', () => {
    expect(porterStem('is')).toBe('is');
    expect(porterStem('as')).toBe('as');
    expect(porterStem('a')).toBe('a');
    expect(porterStem('')).toBe('');
  });

  it('treats y as a vowel only after a consonant', () => {
    expect(porterStem('toys')).toBe('toi'); // step 1c: the stem "to" has a vowel, so the final y becomes i
    expect(porterStem('syzygy')).toBe('syzygi'); // every y after a consonant is a vowel, so the stem "syzyg" qualifies
  });
});
