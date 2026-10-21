import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PassportRateLimiter,
  RateLimitTiers,
  createPassportRateLimiter,
  rateLimitKeyFor,
  type RateLimitRequest,
} from '../src/rate-limiter.js';

const byPassport = (id: string): RateLimitRequest => ({ headers: { 'x-passport-id': id }, ip: '9.9.9.9' });
const byIp = (ip: string): RateLimitRequest => ({ headers: {}, ip });

describe('rateLimitKeyFor', () => {
  it('prefers the passport header and falls back to the client IP', () => {
    expect(rateLimitKeyFor(byPassport('p1'))).toBe('passport:p1');
    expect(rateLimitKeyFor(byIp('1.2.3.4'))).toBe('ip:1.2.3.4');
    expect(rateLimitKeyFor({ headers: { 'x-passport-id': '' }, ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
  });
});

describe('PassportRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts requests per key within a window', () => {
    const limiter = new PassportRateLimiter({ windowMs: 60000, max: 2 });

    const first = limiter.checkLimit(byPassport('p1'));
    expect(first).toMatchObject({ limit: 2, current: 1, remaining: 1, exceeded: false });

    const second = limiter.checkLimit(byPassport('p1'));
    expect(second).toMatchObject({ current: 2, remaining: 0, exceeded: false });

    const third = limiter.checkLimit(byPassport('p1'));
    expect(third).toMatchObject({ current: 3, remaining: 0, exceeded: true });
    expect(third.resetTime.getTime()).toBe(first.resetTime.getTime());

    // Other keys are unaffected.
    expect(limiter.checkLimit(byPassport('p2')).exceeded).toBe(false);
    expect(limiter.checkLimit(byIp('1.1.1.1')).exceeded).toBe(false);
    expect(limiter.trackedKeys).toBe(3);
  });

  it('starts a fresh window once the previous one expires', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const limiter = new PassportRateLimiter({ windowMs: 1000, max: 1 });

    limiter.checkLimit(byPassport('p1'));
    expect(limiter.checkLimit(byPassport('p1')).exceeded).toBe(true);

    vi.setSystemTime(Date.now() + 1001);
    const info = limiter.checkLimit(byPassport('p1'));
    expect(info.exceeded).toBe(false);
    expect(info.current).toBe(1);
    expect(limiter.getInfo('passport:p1')?.current).toBe(1);
  });

  it('reports and resets tracked keys', () => {
    const limiter = new PassportRateLimiter({ windowMs: 60000, max: 5 });
    expect(limiter.getInfo('passport:p1')).toBeNull();
    limiter.checkLimit(byPassport('p1'));
    expect(limiter.getInfo('passport:p1')?.remaining).toBe(4);
    limiter.reset('passport:p1');
    expect(limiter.getInfo('passport:p1')).toBeNull();
  });

  it('expires info once the window is over', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const limiter = new PassportRateLimiter({ windowMs: 1000, max: 5 });
    limiter.checkLimit(byPassport('p1'));
    vi.setSystemTime(Date.now() + 1500);
    expect(limiter.getInfo('passport:p1')).toBeNull();
  });

  it('supports a custom key generator', () => {
    const limiter = new PassportRateLimiter({
      windowMs: 60000,
      max: 1,
      keyGenerator: (request) => `tenant:${request.headers['x-tenant']}`,
    });
    limiter.checkLimit({ headers: { 'x-tenant': 'a', 'x-passport-id': 'p1' }, ip: '1.1.1.1' });
    const second = limiter.checkLimit({ headers: { 'x-tenant': 'a', 'x-passport-id': 'p2' }, ip: '2.2.2.2' });
    expect(second.exceeded).toBe(true);
    expect(limiter.getInfo('tenant:a')?.current).toBe(2);
  });

  it('evicts the least recently used keys beyond the tracking bound', () => {
    const limiter = new PassportRateLimiter({ windowMs: 60000, max: 1, maxTrackedKeys: 2 });
    limiter.checkLimit(byPassport('a'));
    limiter.checkLimit(byPassport('b'));
    limiter.checkLimit(byPassport('c'));
    expect(limiter.trackedKeys).toBe(2);
    expect(limiter.getInfo('passport:a')).toBeNull();
  });

  it('exposes factory defaults and tiers', () => {
    const limiter = createPassportRateLimiter();
    expect(limiter.checkLimit(byPassport('p')).limit).toBe(100);
    expect(RateLimitTiers.basic.max).toBe(1000);
    expect(RateLimitTiers.unlimited.max).toBe(Number.MAX_SAFE_INTEGER);
  });
});
