import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'partners/**/*.ts'],
      exclude: [
        // Process entry points: they bind ports / fork workers and are exercised by `npm start`, not unit tests.
        'src/bootstrap.ts',
        'src/proxy.ts',
        'src/server.ts',
        'src/worker.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
