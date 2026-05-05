/**
 * Clustered gateway server entry point
 */

import cluster from 'cluster';
import { ClusterManager, WorkerHealthMonitor } from './cluster.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENABLE_CLUSTERING = process.env.ENABLE_CLUSTERING !== 'false';
const WORKER_COUNT = parseInt(process.env.WORKER_COUNT || '0') || undefined;

if (cluster.isPrimary && ENABLE_CLUSTERING) {
  // Master process - manage workers
  console.log(`Master process ${process.pid} is running`);

  const clusterManager = new ClusterManager({
    workers: WORKER_COUNT,
    restartDelay: 2000,
    maxMemory: 512 * 1024 * 1024, // 512MB
    gracefulTimeout: 30000,
    enableHotReload: true,
  });

  // Set up cluster event handlers
  clusterManager.on('clusterStarted', (info) => {
    console.log(`Cluster started with ${info.workers} workers (master PID: ${info.pid})`);
  });

  clusterManager.on('workerOnline', (worker) => {
    console.log(`Worker ${worker.process.pid} came online`);
  });

  clusterManager.on('workerExit', ({ worker, code, signal }) => {
    console.error(`Worker ${worker.process.pid} exited with code ${code} and signal ${signal}`);
  });

  clusterManager.on('allWorkersRestarted', () => {
    console.log('All workers have been restarted successfully');
  });

  // Start the cluster
  const workerFile = join(__dirname, 'worker.js');
  clusterManager.start(workerFile);

  // Expose cluster management API
  const express = require('express');
  const app = express();
  const port = parseInt(process.env.CLUSTER_MANAGEMENT_PORT || '3001');

  app.use(express.json());

  // Cluster management endpoints require a shared secret to prevent unauthenticated DoS.
  // Set CLUSTER_MGMT_SECRET to a strong random value in production.
  const clusterMgmtSecret = process.env.CLUSTER_MGMT_SECRET;
  if (!clusterMgmtSecret) {
    console.warn('[cluster] CLUSTER_MGMT_SECRET is not set. Management endpoints are DISABLED.');
  }

  function requireClusterAuth(req: any, res: any, next: any): void {
    if (!clusterMgmtSecret) {
      res.status(503).json({ error: 'Cluster management disabled: CLUSTER_MGMT_SECRET not configured' });
      return;
    }
    const provided = req.headers['x-cluster-secret'];
    if (provided !== clusterMgmtSecret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }

  app.get('/cluster/status', requireClusterAuth, (req: any, res: any) => {
    res.json({
      status: 'running',
      master: {
        pid: process.pid,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      },
      workers: clusterManager.getWorkerStats(),
    });
  });

  app.post('/cluster/restart', requireClusterAuth, async (req: any, res: any) => {
    try {
      await clusterManager.restartAllWorkers();
      res.json({ success: true, message: 'All workers restarted' });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.post('/cluster/restart/:workerId', requireClusterAuth, async (req: any, res: any) => {
    try {
      const workerId = parseInt(req.params.workerId);
      await clusterManager.restartWorker(workerId);
      res.json({ success: true, message: `Worker ${workerId} restarted` });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  app.listen(port, () => {
    console.log(`Cluster management API listening on port ${port}`);
  });

} else {
  // Worker process or single-process mode
  console.log(`Worker process ${process.pid} starting...`);

  // Set up worker health monitoring
  const healthMonitor = new WorkerHealthMonitor(
    512 * 1024 * 1024, // 512MB memory threshold
    60000 // 1 minute check interval
  );

  // Start the actual gateway application
  import('./proxy.js').then(() => {
    console.log(`Gateway worker ${process.pid} is ready`);
    
    if (process.send) {
      process.send({ type: 'worker-ready', pid: process.pid });
    }
  }).catch((error) => {
    console.error(`Failed to start gateway worker:`, error);
    process.exit(1);
  });

  // Handle graceful shutdown
  const gracefulShutdown = (signal: string) => {
    console.log(`Worker ${process.pid} received ${signal}, shutting down gracefully...`);
    
    // Give the application time to finish current requests
    setTimeout(() => {
      console.log(`Worker ${process.pid} shutting down`);
      process.exit(0);
    }, 5000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('disconnect', () => gracefulShutdown('disconnect'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    console.error(`Uncaught exception in worker ${process.pid}:`, error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error(`Unhandled rejection in worker ${process.pid}:`, reason);
    process.exit(1);
  });
}