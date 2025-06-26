import { vi, beforeAll, afterAll } from 'vitest';

// Global test setup
beforeAll(() => {
  // Mock console methods to reduce test noise
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret-key';
  process.env.GITHUB_CLIENT_ID = 'test-github-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-github-client-secret';
});

afterAll(() => {
  // Restore console methods
  vi.restoreAllMocks();
});