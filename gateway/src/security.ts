/**
 * Security utilities for input validation and sanitization
 */

import { URL } from 'url';
import validator from 'validator';
import DOMPurify from 'isomorphic-dompurify';

// Allowed protocols for proxy requests
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

// Blocked domains for security
const BLOCKED_DOMAINS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '169.254.169.254', // AWS metadata service
  '::1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16'
];

// Maximum allowed payload size (10MB)
export const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024;

// Maximum URL length
export const MAX_URL_LENGTH = 2048;

// Request timeout (30 seconds)
export const REQUEST_TIMEOUT = 30000;

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate URL for proxy requests
 */
export function validateProxyUrl(urlString: string): ValidationResult {
  try {
    // Check URL length
    if (urlString.length > MAX_URL_LENGTH) {
      return { valid: false, error: 'URL too long' };
    }

    // Validate URL format
    if (!validator.isURL(urlString, { 
      protocols: ['http', 'https'],
      require_protocol: true,
      require_valid_protocol: true 
    })) {
      return { valid: false, error: 'Invalid URL format' };
    }

    const url = new URL(urlString);

    // Check protocol
    if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
      return { valid: false, error: `Protocol ${url.protocol} not allowed` };
    }

    // Check for blocked domains and IPs
    const hostname = url.hostname.toLowerCase();
    
    // Check blocked domains
    for (const blocked of BLOCKED_DOMAINS) {
      if (hostname === blocked || hostname.includes(blocked)) {
        return { valid: false, error: 'Access to internal resources blocked' };
      }
    }

    // Check for private IPs
    if (validator.isIP(hostname, 4)) {
      const parts = hostname.split('.').map(Number);
      if (
        parts[0] === 10 || // 10.0.0.0/8
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || // 172.16.0.0/12
        (parts[0] === 192 && parts[1] === 168) || // 192.168.0.0/16
        parts[0] === 127 // 127.0.0.0/8
      ) {
        return { valid: false, error: 'Access to private IPs blocked' };
      }
    }

    // Check for suspicious patterns
    if (
      url.href.includes('..') ||
      url.href.includes('\\x') ||
      url.href.includes('%00') ||
      url.href.includes('%0d%0a')
    ) {
      return { valid: false, error: 'Suspicious URL pattern detected' };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'Invalid URL' };
  }
}

/**
 * Sanitize request headers
 */
export function sanitizeHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  
  // Blocked headers that should not be forwarded
  const blockedHeaders = [
    'host',
    'authorization',
    'cookie',
    'x-opencontext-passport',
    'x-forwarded-for',
    'x-real-ip'
  ];

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    
    // Skip blocked headers
    if (blockedHeaders.includes(lowerKey)) {
      continue;
    }

    // Ensure single string value
    const stringValue = Array.isArray(value) ? value[0] : value;
    
    // Validate header value
    if (stringValue && validator.isAscii(stringValue) && stringValue.length < 8192) {
      sanitized[key] = stringValue;
    }
  }

  return sanitized;
}

/**
 * Sanitize JSON payload
 */
export function sanitizeJson(obj: any, maxDepth: number = 10): any {
  if (maxDepth <= 0) {
    throw new Error('Maximum object depth exceeded');
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // Sanitize HTML content
    return DOMPurify.sanitize(obj, { 
      ALLOWED_TAGS: [],
      ALLOWED_ATTR: [],
      KEEP_CONTENT: true 
    });
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeJson(item, maxDepth - 1));
  }

  if (typeof obj === 'object') {
    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      // Skip prototype pollution attempts
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      sanitized[key] = sanitizeJson(value, maxDepth - 1);
    }
    return sanitized;
  }

  // Unknown type, don't include
  return undefined;
}

/**
 * Validate request payload size
 */
export function validatePayloadSize(contentLength: string | undefined): ValidationResult {
  if (!contentLength) {
    return { valid: true };
  }

  const size = parseInt(contentLength, 10);
  if (isNaN(size)) {
    return { valid: false, error: 'Invalid content-length header' };
  }

  if (size > MAX_PAYLOAD_SIZE) {
    return { valid: false, error: `Payload too large. Maximum size: ${MAX_PAYLOAD_SIZE} bytes` };
  }

  return { valid: true };
}

/**
 * Create Content Security Policy header
 */
export function getCSPHeader(): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ');
}

/**
 * Get security headers
 */
export function getSecurityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': getCSPHeader(),
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
  };
}