import { describe, expect, it } from 'vitest';
import { bestSnippet } from '../src/search/snippet.js';

const strip = (s: string): string => s.replace(/[«»]/g, '');
const FILLER_WORDS = ['lorem', 'ipsum', 'dolor', 'sit', 'amet'];
const filler = (words: number): string => Array.from({ length: words }, (_, i) => FILLER_WORDS[i % FILLER_WORDS.length]).join(' ');

describe('bestSnippet', () => {
  it('returns a short text whole with every hit wrapped in «»', () => {
    expect(bestSnippet('I always use tabs in Go, fight me', ['tab'])).toEqual({
      text: 'I always use «tabs» in Go, fight me',
      start: 0,
      hits: 1,
    });
  });

  it('matches by stem, case-insensitively, and counts distinct terms', () => {
    const r = bestSnippet('Her Preferences changed; she preferred tabs.', ['prefer', 'tab']);
    expect(r.text).toBe('Her «Preferences» changed; she «preferred» «tabs».');
    expect(r.hits).toBe(2);
  });

  it('matches CJK runs, accented words and NFKC-equivalent forms without altering the original text', () => {
    expect(bestSnippet('Hello 世界 wörld', ['世界']).text).toBe('Hello «世界» wörld');
    expect(bestSnippet('Hello 世界 wörld', ['wörld']).text).toBe('Hello 世界 «wörld»');
    expect(bestSnippet('the ﬁle is here', ['file']).text).toBe('the «ﬁle» is here');
  });

  it('returns the leading window with hits 0 when nothing matches, trimmed to a word boundary', () => {
    const text = filler(100);
    const r = bestSnippet(text, ['zebra'], 50);
    expect(r.start).toBe(0);
    expect(r.hits).toBe(0);
    expect(r.text.length).toBeLessThanOrEqual(50);
    expect(r.text.length).toBeGreaterThan(40);
    for (const w of r.text.split(' ')) expect(FILLER_WORDS).toContain(w);
    expect(bestSnippet(text, [], 50).hits).toBe(0);
    expect(bestSnippet('', ['zebra'])).toEqual({ text: '', start: 0, hits: 0 });
  });

  it('centres a window of at most `width` characters on the hits deep inside a long text', () => {
    const text = `${filler(200)} the vault encrypts memories at rest ${filler(200)}`;
    const r = bestSnippet(text, ['vault', 'encrypt', 'memori'], 60);
    expect(r.hits).toBe(3);
    expect(r.text).toContain('«vault» «encrypts» «memories»');
    expect(strip(r.text).length).toBeLessThanOrEqual(60);
    expect(r.start).toBeGreaterThan(900);
    expect(text.slice(r.start)).toMatch(/^\S/); // starts at a word boundary
    const words = strip(r.text).split(' ');
    expect([...FILLER_WORDS, 'the', 'vault', 'encrypts', 'memories', 'at', 'rest']).toContain(words[0]);
    expect([...FILLER_WORDS, 'the', 'vault', 'encrypts', 'memories', 'at', 'rest']).toContain(words[words.length - 1]);
  });

  it('prefers the window with more distinct terms over one with more repeats', () => {
    const text = `alpha alpha alpha alpha ${filler(80)} alpha beta ${filler(80)}`;
    const r = bestSnippet(text, ['alpha', 'beta'], 40);
    expect(r.hits).toBe(2);
    expect(r.text).toContain('«alpha» «beta»');
    expect(r.start).toBeGreaterThan(20);
  });

  it('prefers the earliest window among equals', () => {
    const text = `${filler(40)} apple ${filler(40)} apple ${filler(40)}`;
    const r = bestSnippet(text, ['appl'], 40);
    expect(r.hits).toBe(1);
    expect(r.start).toBeLessThan(text.indexOf('apple'));
    expect(r.text).toContain('«apple»');
  });

  it('uses the default width of 180', () => {
    const text = `${filler(100)} needle ${filler(100)}`;
    const r = bestSnippet(text, ['needl']);
    expect(strip(r.text).length).toBeLessThanOrEqual(180);
    expect(strip(r.text).length).toBeGreaterThan(150);
    expect(r.text).toContain('«needle»');
  });

  it('collapses whitespace runs so a multi-line turn reads as one line', () => {
    expect(bestSnippet('line one\n\n  tabs\there  ', ['tab']).text).toBe('line one «tabs» here');
  });

  it('wraps an oversized single token even when it exceeds the width', () => {
    const long = 'a'.repeat(300);
    const r = bestSnippet(`${long} end`, [long], 50);
    expect(r.hits).toBe(1);
    expect(r.text).toBe(`«${long}»`);
  });
});
