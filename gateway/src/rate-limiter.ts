/**
 * Fixed-window rate limiting keyed by passport (falling back to client IP).
 *
 * The @fastify/rate-limit plugin limits per IP; this limiter adds a per-passport budget so that
 * one agent cannot exhaust a shared egress IP's allowance.
 */

import type { FastifyRequest } from 'fastify';
import { LRUCache } from 'lru-cache';

/** The parts of a request the limiter looks at. */
export type RateLimitRequest = Pick<FastifyRequest, 'headers' | 'ip'>;

export interface RateLimitConfig {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests per window. */
  max: number;
  keyGenerator?: (request: RateLimitRequest) => string;
  /** Upper bound on tracked keys; least-recently-used keys are evicted first. */
  maxTrackedKeys?: number;
}

export interface RateLimitInfo {
  limit: number;
  current: number;
  remaining: number;
  resetTime: Date;
  /** True when this request exceeded the budget. */
  exceeded: boolean;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/** The key the limiter would use for a request: `passport:<id>` or `ip:<address>`. */
export function rateLimitKeyFor(request: RateLimitRequest): string {
  const passportId = request.headers['x-passport-id'];
  if (typeof passportId === 'string' && passportId.length > 0) {
    return `passport:${passportId}`;
  }
  return `ip:${request.ip}`;
}

export class PassportRateLimiter {
  private readonly cache: LRUCache<string, RateLimitEntry>;
  private readonly config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
    this.cache = new LRUCache<string, RateLimitEntry>({
      max: config.maxTrackedKeys ?? 10000,
      ttl: config.windowMs,
      updateAgeOnGet: false,
    });
  }

  /** Count a request against its key and report the remaining budget. */
  checkLimit(request: RateLimitRequest): RateLimitInfo {
    const key = this.config.keyGenerator?.(request) ?? rateLimitKeyFor(request);
    const now = Date.now();

    let entry = this.cache.get(key);
    if (!entry || entry.resetTime <= now) {
      entry = { count: 0, resetTime: now + this.config.windowMs };
    }
    entry.count++;
    this.cache.set(key, entry);

    return this.describe(entry);
  }

  private describe(entry: RateLimitEntry): RateLimitInfo {
    return {
      limit: this.config.max,
      current: entry.count,
      remaining: Math.max(0, this.config.max - entry.count),
      resetTime: new Date(entry.resetTime),
      exceeded: entry.count > this.config.max,
    };
  }

  reset(key: string): void {
    this.cache.delete(key);
  }

  getInfo(key: string): RateLimitInfo | null {
    const entry = this.cache.get(key);
    if (!entry || entry.resetTime <= Date.now()) return null;
    return this.describe(entry);
  }

  get trackedKeys(): number {
    return this.cache.size;
  }
}

export function createPassportRateLimiter(windowMs = 60000, max = 100): PassportRateLimiter {
  return new PassportRateLimiter({ windowMs, max });
}

export const RateLimitTiers = {
  free: { windowMs: 60000, max: 100 },
  basic: { windowMs: 60000, max: 1000 },
  premium: { windowMs: 60000, max: 10000 },
  unlimited: { windowMs: 60000, max: Number.MAX_SAFE_INTEGER },
} as const;
