/**
 * Request-boundary security helpers for the proxy: SSRF protection for upstream URLs, header
 * hygiene for forwarded requests, payload limits and response security headers.
 */

import { isIP } from 'node:net';

/** Maximum request body the gateway accepts (10 MB). */
export const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024;
/** Maximum upstream response the proxy buffers (50 MB); larger transfers use streaming sessions. */
export const MAX_UPSTREAM_RESPONSE_SIZE = 50 * 1024 * 1024;
export const MAX_URL_LENGTH = 2048;
/** Upstream request timeout in milliseconds. */
export const REQUEST_TIMEOUT = 30000;

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'];

function ipv4Octets(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split('.').map(Number);
}

/**
 * True for loopback, link-local (incl. cloud metadata services), private, carrier-grade NAT,
 * multicast and reserved IPv4/IPv6 addresses.
 */
export function isPrivateAddress(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  const v4 = ipv4Octets(host);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 0 || // 0.0.0.0/8 "this network"
      a === 10 || // 10/8
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
      (a === 169 && b === 254) || // link-local, AWS/GCP/Azure metadata
      (a === 172 && b >= 16 && b <= 31) || // 172.16/12
      (a === 192 && b === 168) || // 192.168/16
      a >= 224 // multicast and reserved
    );
  }

  if (isIP(host) === 6) {
    // IPv4-mapped addresses: dotted (::ffff:10.0.0.1) or, as the URL parser normalises them,
    // hex (::ffff:a00:1). Both are judged by the embedded IPv4 address.
    const mapped = host.match(/^::ffff:(.+)$/);
    if (mapped) {
      if (mapped[1].includes('.')) return isPrivateAddress(mapped[1]);
      const groups = mapped[1].split(':');
      if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
        const [high, low] = groups.map((g) => Number.parseInt(g, 16));
        return isPrivateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
      }
    }
    return (
      host === '::' ||
      host === '::1' ||
      host.startsWith('fe80:') || // link-local
      /^f[cd][0-9a-f]{2}:/.test(host) || // fc00::/7 unique local
      host.startsWith('ff') // multicast
    );
  }

  return false;
}

export interface ProxyUrlOptions {
  /**
   * When given, the resolved URL must stay inside this origin and base path. Prevents `..` path
   * segments from reaching other endpoints on the partner's host.
   */
  baseUrl?: string;
}

/** Validate a fully-resolved upstream URL before the proxy connects to it. */
export function validateProxyUrl(urlString: string, options: ProxyUrlOptions = {}): ValidationResult {
  if (urlString.length > MAX_URL_LENGTH) {
    return { valid: false, error: 'URL too long' };
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { valid: false, error: `Protocol ${url.protocol} not allowed` };
  }
  if (url.username || url.password) {
    return { valid: false, error: 'Credentials in URL not allowed' };
  }

  const hostname = url.hostname.toLowerCase();
  if (
    !hostname ||
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    isPrivateAddress(hostname)
  ) {
    return { valid: false, error: 'Access to internal resources blocked' };
  }

  if (/%00|%0d|%0a/i.test(url.href)) {
    return { valid: false, error: 'Suspicious URL pattern detected' };
  }

  if (options.baseUrl) {
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      return { valid: false, error: 'Invalid partner base URL' };
    }
    const basePath = base.pathname.replace(/\/+$/, '');
    const inside =
      url.origin === base.origin &&
      (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`));
    if (!inside) {
      return { valid: false, error: 'URL escapes the partner base path' };
    }
  }

  return { valid: true };
}

/** Headers that are meaningful only for a single hop (RFC 7230 §6.1) and must not be forwarded. */
export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Request headers the gateway never forwards to partners. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'cookie',
  'content-length', // recomputed for the forwarded body
  'expect',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-passport-id',
]);

export interface SanitizeHeadersOptions {
  /** Drop the client's `Authorization` header (used when the gateway injects its own credential). */
  stripAuthorization?: boolean;
}

/**
 * Build the header set to forward upstream: lower-cased names, hop-by-hop and gateway-internal
 * headers removed, multi-valued headers joined, and values that could inject CRLF rejected.
 */
export function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>,
  options: SanitizeHeadersOptions = {}
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [name, rawValue] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (
      rawValue === undefined ||
      HOP_BY_HOP_HEADERS.has(key) ||
      DROPPED_REQUEST_HEADERS.has(key) ||
      key.startsWith('x-opencontext-') ||
      (options.stripAuthorization && key === 'authorization')
    ) {
      continue;
    }

    const value = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;
    // Only printable ASCII (plus tab) is forwarded: CR/LF would allow header injection.
    if (value.length >= 8192 || /[^\t\x20-\x7e]/.test(value)) {
      continue;
    }
    sanitized[key] = value;
  }

  return sanitized;
}

/** Validate a `Content-Length` request header against the payload limit. */
export function validatePayloadSize(contentLength: string | undefined): ValidationResult {
  if (!contentLength) {
    return { valid: true };
  }
  if (!/^\d+$/.test(contentLength)) {
    return { valid: false, error: 'Invalid content-length header' };
  }
  if (Number(contentLength) > MAX_PAYLOAD_SIZE) {
    return { valid: false, error: `Payload too large. Maximum size: ${MAX_PAYLOAD_SIZE} bytes` };
  }
  return { valid: true };
}

/** Content Security Policy for a JSON API: nothing may load or execute. */
export function getCSPHeader(): string {
  return [
    "default-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export function getSecurityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': getCSPHeader(),
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Cache-Control': 'no-store',
  };
}
