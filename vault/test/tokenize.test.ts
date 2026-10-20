import { describe, expect, it } from 'vitest';
import { STOPWORDS, stemToken, tokenize, tokenizeQuery } from '../src/search/tokenize.js';

describe('tokenize', () => {
  it('segments with Intl.Segmenter and stems only ASCII words (the §0 probe sentence)', () => {
    expect(tokenize('Hello 世界 wörld, Go-lang 3.14')).toEqual(['hello', '世界', 'wörld', 'go', 'lang', '3.14']);
  });

  it('lowercases and Porter-stems English words', () => {
    expect(tokenize('TABS Tabs tabs')).toEqual(['tab', 'tab', 'tab']);
    expect(tokenize('running runs ran preferences')).toEqual(['run', 'run', 'ran', 'prefer']);
  });

  it('keeps accented words, CJK runs and identifiers verbatim', () => {
    expect(tokenize('naïve cafés 日本語')).toEqual(['naïve', 'cafés', '日本語']);
    expect(tokenize('mem_3f9a1c77e02b4d10 foo_bar example.com')).toEqual(['mem_3f9a1c77e02b4d10', 'foo_bar', 'example.com']);
  });

  it('drops stopwords', () => {
    expect(tokenize('the cat is on the mat')).toEqual(['cat', 'mat']);
    expect(tokenize('User prefers tabs over spaces in Go')).toEqual(['user', 'prefer', 'tab', 'over', 'space', 'go']);
    expect(STOPWORDS.has('the')).toBe(true);
    expect(STOPWORDS.has('user')).toBe(false);
    expect(STOPWORDS.size).toBeGreaterThanOrEqual(40);
    expect(STOPWORDS.size).toBeLessThanOrEqual(60);
  });

  it('drops length-1 tokens unless they are digits', () => {
    expect(tokenize('x y 7 a Z')).toEqual(['7']);
  });

  it('applies NFKC before segmenting (ligatures, fullwidth, circled digits)', () => {
    expect(tokenize('ﬁle ＡＢＣ ①')).toEqual(['file', 'abc', '1']);
  });

  it('ignores punctuation and whitespace runs', () => {
    expect(tokenize('  multiple   spaces\nand\tnewlines!!! ')).toEqual(['multipl', 'space', 'newlin']);
    expect(tokenize('')).toEqual([]);
    expect(tokenize('... --- !!!')).toEqual([]);
  });
});

describe('tokenizeQuery', () => {
  it('matches tokenize when any non-stopword survives', () => {
    expect(tokenizeQuery('the cat')).toEqual(['cat']);
    expect(tokenizeQuery('User prefers tabs')).toEqual(tokenize('User prefers tabs'));
  });

  it('falls back to keeping stopwords when the query is only stopwords', () => {
    expect(tokenize('what is it')).toEqual([]);
    expect(tokenizeQuery('what is it')).toEqual(['what', 'is', 'it']);
  });

  it('is empty for an empty or punctuation-only query', () => {
    expect(tokenizeQuery('')).toEqual([]);
    expect(tokenizeQuery('?!')).toEqual([]);
  });
});

describe('stemToken', () => {
  it('normalizes one segment exactly like tokenize does', () => {
    expect(stemToken('Preferences')).toBe('prefer');
    expect(stemToken('ﬁle')).toBe('file');
    expect(stemToken('Wörld')).toBe('wörld');
    expect(stemToken('3.14')).toBe('3.14');
  });
});
