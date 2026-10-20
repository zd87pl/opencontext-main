import { afterAll, beforeAll, vi } from 'vitest';

// Set before any module under test is imported (imports are hoisted above hooks).
process.env.NODE_ENV = 'test';

beforeAll(() => {
  // Services log warnings on expected failure paths; keep the test output readable.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});
