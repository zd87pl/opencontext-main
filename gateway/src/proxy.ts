/**
 * Single-process entry point (`npm start`, `node dist/proxy.js`). Everything it does lives in
 * `bootstrap.ts` so that cluster workers can start the same server without re-running this file.
 */

import { startServer } from './bootstrap.js';

startServer().catch((error: unknown) => {
  console.error('Failed to start gateway:', error instanceof Error ? error.message : error);
  process.exit(1);
});
