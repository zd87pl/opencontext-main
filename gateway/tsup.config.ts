import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/proxy.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  clean: true,
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  dts: true,
  external: [
    'fastify',
    '@fastify/cors',
    '@fastify/rate-limit',
    'http-proxy-middleware',
    'ethers',
    '@superfluid-finance/sdk-core'
  ]
});