/**
 * Clustered entry point. The primary forks one worker per CPU (or `WORKER_COUNT`), restarts
 * workers that die, performs rolling restarts on SIGUSR2 and exposes a small management API on
 * `CLUSTER_MANAGEMENT_PORT` (loopback only). Workers run `worker.ts`.
 *
 * With `ENABLE_CLUSTERING=false` the process runs the gateway directly.
 */

import 'dotenv/config';
import cluster from 'node:cluster';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { ClusterManager, WorkerHealthMonitor } from './cluster.js';

const ENABLE_CLUSTERING = process.env.ENABLE_CLUSTERING !== 'false';
const WORKER_COUNT = Number.parseInt(process.env.WORKER_COUNT ?? '0', 10) || undefined;
const MANAGEMENT_PORT = Number.parseInt(process.env.CLUSTER_MANAGEMENT_PORT ?? '3002', 10);

if (cluster.isPrimary && ENABLE_CLUSTERING) {
  console.log(`Primary process ${process.pid} is running`);

  // Workers execute the same flavour of file as the primary: `worker.ts` under tsx (whose loader
  // the fork inherits through process.execArgv) or `worker.js` from the build output.
  const here = fileURLToPath(import.meta.url);
  const workerFile = join(dirname(here), `worker${extname(here)}`);

  const manager = new ClusterManager({
    workers: WORKER_COUNT,
    restartDelay: 2000,
    maxMemory: 512 * 1024 * 1024,
    gracefulTimeout: 30000,
    enableHotReload: true,
  });

  manager.on('clusterStarted', (info: { workers: number; pid: number }) => {
    console.log(`Cluster started with ${info.workers} workers (primary PID: ${info.pid})`);
  });
  manager.on('workerExit', ({ code, signal }: { code: number; signal: string }) => {
    console.error(`A worker exited with code ${code} and signal ${signal}`);
  });
  manager.on('allWorkersRestarted', () => {
    console.log('All workers have been restarted');
  });

  manager.start(workerFile);

  const api = Fastify({ logger: false });

  api.get('/cluster/status', async () => ({
    status: 'running',
    primary: { pid: process.pid, uptime: process.uptime(), memory: process.memoryUsage() },
    workers: manager.getWorkerStats(),
  }));

  api.post('/cluster/restart', async () => {
    await manager.restartAllWorkers();
    return { success: true, message: 'All workers restarted' };
  });

  api.post('/cluster/restart/:workerId', async (request, reply) => {
    const workerId = Number.parseInt((request.params as { workerId: string }).workerId, 10);
    try {
      await manager.restartWorker(workerId);
      return { success: true, message: `Worker ${workerId} restarted` };
    } catch (error) {
      return reply.code(404).send({ success: false, error: (error as Error).message });
    }
  });

  api
    .listen({ port: MANAGEMENT_PORT, host: '127.0.0.1' })
    .then(() => console.log(`Cluster management API listening on 127.0.0.1:${MANAGEMENT_PORT}`))
    .catch((error: unknown) => {
      console.error('Cluster management API failed to start:', error);
    });
} else {
  new WorkerHealthMonitor(512 * 1024 * 1024, 60000);
  const { startServer } = await import('./bootstrap.js');
  await startServer();
}
