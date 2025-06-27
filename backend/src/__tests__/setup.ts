import { vi } from 'vitest';

// Mock environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_123456789';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123456789';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/opencontext_test';
process.env.REDIS_URL = 'redis://localhost:6379';

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

// Mock crypto.randomUUID for consistent testing
vi.stubGlobal('crypto', {
  ...crypto,
  randomUUID: () => 'test-uuid-123'
});

// Setup global test utilities
beforeEach(() => {
  // Clear all mocks before each test
  vi.clearAllMocks();
  
  // Reset global session keys
  global.sessionKeys = new Map();
});

afterEach(() => {
  // Cleanup after each test
  vi.resetAllMocks();
});