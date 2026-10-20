import { afterEach, beforeEach, vi } from 'vitest';

// Test environment. Every external dependency (Prisma, Stripe, Redis, RPC) is
// either mocked at the module boundary or disabled, so the suite runs offline.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_123456789';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123456789';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/opencontext_test';
// Without REDIS_URL the session-key store keeps keys in process memory.
delete process.env.REDIS_URL;

beforeEach(() => {
  vi.clearAllMocks();
  // In-memory session-key store (see session-key-store.ts); start every test empty.
  globalThis.sessionKeys = new Map();
});

afterEach(() => {
  vi.resetAllMocks();
});
