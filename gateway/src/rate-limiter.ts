/**
 * Passport-based rate limiting service
 */

import { FastifyRequest } from 'fastify';
import { LRUCache } from 'lru-cache';

export interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  max: number; // Max requests per window
  standardHeaders: boolean; // Return rate limit info in headers
  legacyHeaders: boolean; // Return rate limit info in legacy headers
  keyGenerator?: (req: FastifyRequest) => string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

export interface RateLimitInfo {
  limit: number;
  current: number;
  remaining: number;
  resetTime: Date;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export class PassportRateLimiter {
  private cache: LRUCache<string, RateLimitEntry>;
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
    this.cache = new LRUCache<string, RateLimitEntry>({
      max: 10000, // Store up to 10k passport entries
      ttl: config.windowMs,
      updateAgeOnGet: false,
    });
  }

  /**
   * Check if request should be rate limited
   */
  async checkLimit(request: FastifyRequest): Promise<RateLimitInfo> {
    const key = this.getKey(request);
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let entry = this.cache.get(key);

    // Reset if window expired
    if (!entry || entry.resetTime <= now) {
      entry = {
        count: 0,
        resetTime: now + this.config.windowMs,
      };
    }

    // Increment counter
    entry.count++;
    this.cache.set(key, entry);

    const remaining = Math.max(0, this.config.max - entry.count);
    const resetTime = new Date(entry.resetTime);

    return {
      limit: this.config.max,
      current: entry.count,
      remaining,
      resetTime,
    };
  }

  /**
   * Generate rate limit key from request
   */
  private getKey(request: FastifyRequest): string {
    if (this.config.keyGenerator) {
      return this.config.keyGenerator(request);
    }

    // Default: use passport ID if available, otherwise IP
    const passportId = request.headers['x-passport-id'] as string;
    if (passportId) {
      return `passport:${passportId}`;
    }

    // Fallback to IP-based limiting
    const forwarded = request.headers['x-forwarded-for'] as string;
    const ip = forwarded ? forwarded.split(',')[0].trim() : request.ip;
    return `ip:${ip}`;
  }

  /**
   * Reset rate limit for a specific key
   */
  reset(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Get current limit info for a key
   */
  getInfo(key: string): RateLimitInfo | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    return {
      limit: this.config.max,
      current: entry.count,
      remaining: Math.max(0, this.config.max - entry.count),
      resetTime: new Date(entry.resetTime),
    };
  }
}

/**
 * Create passport-based rate limiter
 */
export function createPassportRateLimiter(
  windowMs: number = 60000, // 1 minute
  max: number = 100 // 100 requests per minute
): PassportRateLimiter {
  return new PassportRateLimiter({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
  });
}

/**
 * Rate limit configurations for different tiers
 */
export const RateLimitTiers = {
  free: {
    windowMs: 60000, // 1 minute
    max: 100, // 100 requests per minute
  },
  basic: {
    windowMs: 60000,
    max: 1000, // 1000 requests per minute
  },
  premium: {
    windowMs: 60000,
    max: 10000, // 10000 requests per minute
  },
  unlimited: {
    windowMs: 60000,
    max: Number.MAX_SAFE_INTEGER,
  },
};