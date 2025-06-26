/**
 * Gateway worker process
 */

import { WorkerHealthMonitor } from './cluster.js';
import './proxy.js'; // Start the actual gateway

// Set up worker health monitoring
const healthMonitor = new WorkerHealthMonitor(
  parseInt(process.env.MAX_WORKER_MEMORY || '536870912'), // 512MB
  parseInt(process.env.HEALTH_CHECK_INTERVAL || '60000') // 1 minute
);

console.log(`Gateway worker ${process.pid} started`);

// Notify master that worker is ready
if (process.send) {
  process.send({ 
    type: 'worker-ready', 
    pid: process.pid,
    timestamp: Date.now()
  });
}

// Export health monitor for testing
export { healthMonitor };