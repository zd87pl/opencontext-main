import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/index.ts', 'src/types.ts'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
      reporter: ['text', 'lcov'],
    },
  },
});
