import { defineConfig } from 'tsup';

export default defineConfig({
  // Three process entry points: single-process server, cluster primary, cluster worker.
  entry: ['src/proxy.ts', 'src/server.ts', 'src/worker.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // The gateway is an application, not a library: no type declarations are needed.
  dts: false,
  minify: process.env.NODE_ENV === 'production',
});
