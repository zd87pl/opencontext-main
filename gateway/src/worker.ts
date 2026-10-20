/**
 * Cluster worker: runs the gateway and reports health to the primary (see `server.ts`).
 */

import { WorkerHealthMonitor } from './cluster.js';
import { startServer } from './bootstrap.js';

const healthMonitor = new WorkerHealthMonitor(
  Number.parseInt(process.env.MAX_WORKER_MEMORY ?? '536870912', 10), // 512 MB
  Number.parseInt(process.env.HEALTH_CHECK_INTERVAL ?? '60000', 10)
);

const app = await startServer();

// The primary disconnects a worker to retire it gracefully: stop accepting requests, then exit.
process.once('disconnect', () => {
  app.close().finally(() => process.exit(0));
});

if (process.send) {
  process.send({ type: 'worker-ready', pid: process.pid, timestamp: Date.now() });
}

export { healthMonitor };
