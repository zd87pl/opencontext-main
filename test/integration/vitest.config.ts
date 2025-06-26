import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000, // Longer timeout for integration tests
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['../../gateway/src/**/*', '../../sdk/js/src/**/*'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.*',
        '**/*.config.*',
      ],
    },
  },
});