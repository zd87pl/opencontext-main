import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['env.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  dts: true,
  external: ['zod', 'dotenv']
});