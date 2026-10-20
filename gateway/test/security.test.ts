import { describe, expect, it } from 'vitest';
import {
  MAX_PAYLOAD_SIZE,
  MAX_URL_LENGTH,
  getSecurityHeaders,
  isPrivateAddress,
  sanitizeHeaders,
  validatePayloadSize,
  validateProxyUrl,
} from '../src/security.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.255',
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.5',
    '[::1]',
  ])('treats %s as private', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111', 'example.com', 'newsapi.org'])(
    'treats %s as public',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    }
  );
});

describe('validateProxyUrl', () => {
  it('accepts public http(s) URLs', () => {
    expect(validateProxyUrl('https://newsapi.org/v2/top-headlines?country=us')).toEqual({ valid: true });
    expect(validateProxyUrl('http://example.com/')).toEqual({ valid: true });
  });

  it.each([
    ['http://localhost/admin', 'internal resources'],
    ['http://LOCALHOST:8080/', 'internal resources'],
    ['http://app.localhost/', 'internal resources'],
    ['http://127.0.0.1/', 'internal resources'],
    ['http://10.1.2.3/', 'internal resources'],
    ['http://169.254.169.254/latest/meta-data/', 'internal resources'],
    ['http://[::1]/', 'internal resources'],
    ['http://[::ffff:192.168.0.1]/', 'internal resources'],
    ['http://metadata.google.internal/', 'internal resources'],
    ['http://db.service.internal/', 'internal resources'],
    ['http://printer.local/', 'internal resources'],
    ['ftp://example.com/file', 'Protocol ftp: not allowed'],
    ['file:///etc/passwd', 'Protocol file: not allowed'],
    ['https://user:pass@example.com/', 'Credentials in URL not allowed'],
    ['https://example.com/%0d%0aInjected: yes', 'Suspicious URL pattern'],
    ['https://example.com/a%00b', 'Suspicious URL pattern'],
    ['not a url', 'Invalid URL format'],
    [`https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`, 'URL too long'],
  ])('rejects %s', (url, reason) => {
    const result = validateProxyUrl(url);
    expect(result.valid).toBe(false);
    expect(result.error).toContain(reason);
  });

  it('keeps proxied paths inside the partner base path', () => {
    const baseUrl = 'https://newsapi.org/v2';
    expect(validateProxyUrl('https://newsapi.org/v2/everything', { baseUrl }).valid).toBe(true);
    expect(validateProxyUrl('https://newsapi.org/v2', { baseUrl }).valid).toBe(true);
    expect(validateProxyUrl('https://newsapi.org/v2/x/../../v1/other', { baseUrl })).toEqual({
      valid: false,
      error: 'URL escapes the partner base path',
    });
    expect(validateProxyUrl('https://newsapi.org/v20/other', { baseUrl }).valid).toBe(false);
    expect(validateProxyUrl('https://evil.example/v2/x', { baseUrl }).valid).toBe(false);
    expect(validateProxyUrl('https://newsapi.org/v2/x', { baseUrl: 'nonsense' }).error).toBe(
      'Invalid partner base URL'
    );
  });
});

describe('sanitizeHeaders', () => {
  const incoming = {
    Host: 'gateway.example',
    Cookie: 'session=1',
    Connection: 'keep-alive',
    'Keep-Alive': 'timeout=5',
    'Transfer-Encoding': 'chunked',
    'Content-Length': '12',
    'X-Forwarded-For': '1.2.3.4',
    'X-Real-IP': '1.2.3.4',
    'X-Passport-ID': 'p1',
    'X-OpenContext-Internal': 'x',
    Authorization: 'Bearer token',
    'Content-Type': 'application/json',
    Accept: ['application/json', 'text/plain'],
    'X-Api-Key': 'abc',
    'X-Injected': 'ok\r\nX-Evil: yes',
    'X-Unicode': 'café',
    'X-Huge': 'x'.repeat(9000),
    'X-Empty': undefined,
  };

  it('drops hop-by-hop, connection-specific and gateway headers', () => {
    const headers = sanitizeHeaders(incoming);
    for (const dropped of [
      'host',
      'cookie',
      'connection',
      'keep-alive',
      'transfer-encoding',
      'content-length',
      'x-forwarded-for',
      'x-real-ip',
      'x-passport-id',
      'x-opencontext-internal',
      'x-injected',
      'x-unicode',
      'x-huge',
      'x-empty',
    ]) {
      expect(headers).not.toHaveProperty(dropped);
    }
  });

  it('keeps and normalises the rest', () => {
    const headers = sanitizeHeaders(incoming);
    expect(headers).toEqual({
      authorization: 'Bearer token',
      'content-type': 'application/json',
      accept: 'application/json, text/plain',
      'x-api-key': 'abc',
    });
  });

  it('strips Authorization only when asked', () => {
    expect(sanitizeHeaders(incoming, { stripAuthorization: true })).not.toHaveProperty('authorization');
    expect(sanitizeHeaders(incoming, { stripAuthorization: false })).toHaveProperty('authorization');
  });
});

describe('validatePayloadSize', () => {
  it('accepts missing or small content lengths', () => {
    expect(validatePayloadSize(undefined)).toEqual({ valid: true });
    expect(validatePayloadSize('')).toEqual({ valid: true });
    expect(validatePayloadSize('1024')).toEqual({ valid: true });
    expect(validatePayloadSize(String(MAX_PAYLOAD_SIZE))).toEqual({ valid: true });
  });

  it('rejects oversized or malformed content lengths', () => {
    expect(validatePayloadSize(String(MAX_PAYLOAD_SIZE + 1)).error).toContain('Payload too large');
    expect(validatePayloadSize('abc').error).toBe('Invalid content-length header');
    expect(validatePayloadSize('-1').error).toBe('Invalid content-length header');
  });
});

describe('getSecurityHeaders', () => {
  it('locks the API down for browsers', () => {
    const headers = getSecurityHeaders();
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers['Cache-Control']).toBe('no-store');
  });
});
