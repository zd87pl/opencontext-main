import { describe, expect, it } from 'vitest';
import { SECRET_PATTERNS, looksLikeSecret } from '../src/access/secrets.js';
import { newToken } from '../src/crypto/token.js';

// The positive samples are assembled at runtime from fragments on purpose: a literal
// well-formed token in the source would trip GitHub's push protection (and any other
// secret scanner pointed at this repository) even though every sample is synthetic.
const join = (...parts: string[]): string => parts.join('');
const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'; // 36 chars, the GitHub token body length

describe('looksLikeSecret: positives', () => {
  it.each([
    ['OpenAI-style key', join('my key is sk-', 'proj-abcdefghijklmnopqrstuvwxyz0123456789'), 'API key'],
    ['Stripe live key', join('use rk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc'), 'API key'],
    ['Anthropic-style key', join('sk-', 'ant-api03-abcdefghijklmnopqrstuvwxyz'), 'API key'],
    ['publishable key', join('pk_', 'test_', '51H8abcdefghijklmnopqrstu'), 'API key'],
    ['AWS access key id', join('AKIA', 'IOSFODNN7EXAMPLE'), 'AWS access key'],
    ['PEM private key', join('-----BEGIN RSA ', 'PRIVATE KEY-----', '\nMIIEow…'), 'private key'],
    ['PEM generic private key', join('-----BEGIN ', 'PRIVATE KEY-----'), 'private key'],
    ['GitHub PAT', join('ghp', '_', alpha), 'GitHub token'],
    ['GitHub OAuth', join('gho', '_', alpha), 'GitHub token'],
    ['Slack bot token', join('xoxb', '-123456789012-1234567890123-', 'AbCdEfGhIjKlMnOpQrStUvWx'), 'Slack token'],
    ['Slack app token', join('xoxa', '-2-123456789012-abcdefghijkl'), 'Slack token'],
    ['JWT', join('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'), 'JWT'],
    ['our own vault token', `token ${newToken()} here`, 'vault token'],
    ['password line', 'password: hunter2hunter2', 'password'],
    ['Password with equals', 'PASSWORD = correct-horse-battery', 'password'],
  ])('%s', (_name, text, pattern) => {
    expect(looksLikeSecret(text)).toBe(pattern);
  });
});

describe('looksLikeSecret: negatives', () => {
  it.each([
    ['ordinary base64', 'The attachment was QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkw= long'],
    ['eyJ prose without the dotted structure', 'the string eyJhbGciOiJIUzI1NiJ9 is just base64 of a JSON header'],
    ['eyJ with one dot only', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
    ['the word password alone', 'User prefers a password manager over memorizing passwords.'],
    ['password with a short value', 'password: abc'],
    ['skills sentence', 'User is skilled in sk-learn and pk-pd modelling'],
    ['short sk- prefix', 'sk-12345 is a ticket id'],
    ['AKIA inside a word', 'The lake AKIAKIAKIAKIAKIAKIA is fictional'],
    ['gh_ without a tool letter', 'gh_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'],
    ['plain statement', 'User prefers tabs over spaces in Go.'],
    ['empty', ''],
    ['unicode text', 'Der Nutzer wohnt in Zürich und spricht 日本語.'],
    ['a memory id', 'See mem_3f9a1c77e02b4d10 and src_7d2e0b1a9c3f4e55.'],
    ['ocv_ with wrong length', 'ocv_tooshort'],
  ])('%s', (_name, text) => {
    expect(looksLikeSecret(text)).toBeNull();
  });
});

describe('SECRET_PATTERNS', () => {
  it('is a frozen list of named regexes covering the documented families', () => {
    expect(Object.isFrozen(SECRET_PATTERNS)).toBe(true);
    const names = SECRET_PATTERNS.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['API key', 'AWS access key', 'private key', 'GitHub token', 'Slack token', 'JWT', 'vault token', 'password']));
    for (const p of SECRET_PATTERNS) expect(p.re).toBeInstanceOf(RegExp);
  });

  it('no pattern uses the global flag (a stateful lastIndex would make test() flaky)', () => {
    for (const p of SECRET_PATTERNS) expect(p.re.global).toBe(false);
  });
});
