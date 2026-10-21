import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  DePINJobSchema,
  ExternalServiceError,
  FlowRateSchema,
  GatewayError,
  GitHubLinkSchema,
  NotFoundError,
  PassportIdSchema,
  RateLimitError,
  ServiceUnavailableError,
  StreamStartSchema,
  StreamingSessionSchema,
  UsageQuerySchema,
  ValidationError,
  formatErrorResponse,
  validateRequest,
} from '../src/validation.js';

describe('validateRequest', () => {
  it('returns parsed data on success', () => {
    const parse = validateRequest(StreamingSessionSchema);
    expect(parse({ passportId: 'p1', partnerId: 'satellite', totalSize: '2048', costPerByte: '5' })).toEqual({
      passportId: 'p1',
      partnerId: 'satellite',
      totalSize: 2048,
      costPerByte: '5',
    });
  });

  it('throws a ValidationError listing every failing field', () => {
    const parse = validateRequest(StreamStartSchema);
    let caught: unknown;
    try {
      parse({ passportId: '', partnerId: 'github', sender: 'x', receiver: 'y', flowRate: '0' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const fields = (caught as ValidationError).issues.map((issue) => issue.field).sort();
    expect(fields).toEqual(['flowRate', 'passportId', 'receiver', 'sender']);
    expect((caught as ValidationError).statusCode).toBe(400);
  });
});

describe('schemas', () => {
  it('constrains passport ids to a safe character set', () => {
    expect(PassportIdSchema.safeParse('github:12345:0xabc').success).toBe(true);
    expect(PassportIdSchema.safeParse('a b').success).toBe(false);
    expect(PassportIdSchema.safeParse('a/b').success).toBe(false);
    expect(PassportIdSchema.safeParse('x'.repeat(257)).success).toBe(false);
  });

  it('requires positive integer flow rates', () => {
    expect(FlowRateSchema.safeParse('1').success).toBe(true);
    expect(FlowRateSchema.safeParse('0').success).toBe(false);
    expect(FlowRateSchema.safeParse('-1').success).toBe(false);
    expect(FlowRateSchema.safeParse('1.5').success).toBe(false);
  });

  it('coerces usage query parameters', () => {
    expect(UsageQuerySchema.parse({ since: '1700000000000' })).toEqual({ since: 1700000000000 });
    expect(UsageQuerySchema.safeParse({ since: 'yesterday' }).success).toBe(false);
    expect(UsageQuerySchema.safeParse({ since: '-1' }).success).toBe(false);
  });

  it('defaults job priority and rejects empty input', () => {
    expect(DePINJobSchema.parse({ model: 'm', input: { prompt: 'x' } }).priority).toBe('cost');
    expect(DePINJobSchema.safeParse({ model: 'm', input: {} }).success).toBe(false);
    expect(DePINJobSchema.safeParse({ model: 'm', input: { p: 1 }, priority: 'cheap' }).success).toBe(false);
  });

  it('requires a 65-byte signature for wallet links', () => {
    const base = { walletAddress: `0x${'1'.repeat(40)}`, githubUserId: '42' };
    expect(GitHubLinkSchema.parse({ ...base, signature: `0x${'ab'.repeat(65)}` }).githubUserId).toBe(42);
    expect(GitHubLinkSchema.safeParse({ ...base, signature: '0x1234' }).success).toBe(false);
  });
});

describe('errors', () => {
  it('map to HTTP statuses and titles', () => {
    expect(new ValidationError('v').statusCode).toBe(400);
    expect(new AuthenticationError('a').statusCode).toBe(401);
    expect(new NotFoundError('n').statusCode).toBe(404);
    expect(new RateLimitError('r').statusCode).toBe(429);
    expect(new ServiceUnavailableError('s').statusCode).toBe(503);
    expect(new ExternalServiceError('e', 'github').statusCode).toBe(502);
    expect(new ExternalServiceError('e', 'github', 504).statusCode).toBe(504);
    expect(new NotFoundError('n').name).toBe('NotFoundError');
    expect(new NotFoundError('n')).toBeInstanceOf(GatewayError);
  });
});

describe('formatErrorResponse', () => {
  const previousEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = previousEnv;
  });

  it('serialises gateway errors with their extra fields', () => {
    const validation = formatErrorResponse(new ValidationError('bad', [{ field: 'x', message: 'm', code: 'c' }]), 400);
    expect(validation).toMatchObject({ error: 'Validation Failed', message: 'bad', statusCode: 400 });
    expect(validation.issues).toHaveLength(1);
    expect(validation.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const external = formatErrorResponse(new ExternalServiceError('down', 'github', 502), 502);
    expect(external.service).toBe('github');

    const reset = new Date('2030-01-01T00:00:00Z');
    const limited = formatErrorResponse(new RateLimitError('slow down', reset), 429);
    expect(limited.retryAfter).toBe(reset.toISOString());
  });

  it('exposes unexpected error messages outside production only', () => {
    process.env.NODE_ENV = 'test';
    expect(formatErrorResponse(new Error('boom'), 500).message).toBe('boom');
    process.env.NODE_ENV = 'production';
    expect(formatErrorResponse(new Error('boom'), 500)).toMatchObject({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
    });
    expect(formatErrorResponse('string failure', 500).error).toBe('Internal Server Error');
  });

  it('labels generic client errors', () => {
    expect(formatErrorResponse(new Error('nope'), 404).error).toBe('Not Found');
    expect(formatErrorResponse(new Error('nope'), 400).error).toBe('Bad Request');
  });
});
