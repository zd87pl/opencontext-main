/**
 * Horizontal scaling support with clustering and load balancing
 */

import cluster from 'cluster';
import { cpus } from 'os';
import { EventEmitter } from 'events';

export interface ClusterConfig {
  workers?: number;
  restartDelay?: number;
  maxMemory?: number;
  gracefulTimeout?: number;
  enableHotReload?: boolean;
}

export class ClusterManager extends EventEmitter {
  private config: ClusterConfig;
  private workers: Map<number, cluster.Worker> = new Map();
  private restarting: Set<number> = new Set();

  constructor(config: ClusterConfig = {}) {
    super();
    this.config = {
      workers: config.workers || cpus().length,
      restartDelay: config.restartDelay || 1000,
      maxMemory: config.maxMemory || 512 * 1024 * 1024, // 512MB
      gracefulTimeout: config.gracefulTimeout || 30000,
      enableHotReload: config.enableHotReload ?? true,
      ...config
    };
  }

  start(workerFile: string): void {
    if (!cluster.isPrimary) {
      throw new Error('ClusterManager can only be started from the primary process');
    }

    console.log(`Starting cluster with ${this.config.workers} workers`);

    // Set up cluster configuration
    cluster.setupPrimary({
      exec: workerFile,
      silent: false,
    });

    // Start workers
    for (let i = 0; i < this.config.workers!; i++) {
      this.spawnWorker();
    }

    // Handle worker events
    cluster.on('exit', (worker, code, signal) => {
      this.handleWorkerExit(worker, code, signal);
    });

    cluster.on('online', (worker) => {
      console.log(`Worker ${worker.process.pid} is online`);
      this.emit('workerOnline', worker);
    });

    cluster.on('disconnect', (worker) => {
      console.log(`Worker ${worker.process.pid} disconnected`);
      this.emit('workerDisconnect', worker);
    });

    // Monitor worker memory usage
    if (this.config.maxMemory) {
      setInterval(() => {
        this.monitorWorkerMemory();
      }, 30000); // Check every 30 seconds
    }

    // Graceful shutdown
    this.setupGracefulShutdown();

    this.emit('clusterStarted', {
      workers: this.config.workers,
      pid: process.pid,
    });
  }

  private spawnWorker(): cluster.Worker {
    const worker = cluster.fork();
    this.workers.set(worker.id, worker);

    // Set up worker monitoring
    this.setupWorkerMonitoring(worker);

    return worker;
  }

  private setupWorkerMonitoring(worker: cluster.Worker): void {
    // Health check
    worker.on('message', (message) => {
      if (message.type === 'health-check') {
        worker.send({ type: 'health-response', timestamp: Date.now() });
      }
    });

    // Memory monitoring
    setInterval(() => {
      if (worker.isDead()) return;

      worker.send({ type: 'memory-check' });
    }, 60000); // Check every minute
  }

  private handleWorkerExit(worker: cluster.Worker, code: number, signal: string): void {
    console.log(`Worker ${worker.process.pid} died with code ${code} and signal ${signal}`);
    
    this.workers.delete(worker.id);
    this.emit('workerExit', { worker, code, signal });

    // Don't restart if we're shutting down
    if (this.restarting.has(worker.id)) {
      this.restarting.delete(worker.id);
      return;
    }

    // Restart worker after delay
    setTimeout(() => {
      console.log(`Restarting worker ${worker.id}`);
      this.spawnWorker();
    }, this.config.restartDelay);
  }

  private monitorWorkerMemory(): void {
    for (const worker of this.workers.values()) {
      if (worker.isDead()) continue;

      worker.send({ 
        type: 'memory-usage-request',
        maxMemory: this.config.maxMemory 
      });
    }
  }

  async restartWorker(workerId: number): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }

    this.restarting.add(workerId);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.kill('SIGKILL');
        reject(new Error('Worker restart timeout'));
      }, this.config.gracefulTimeout);

      worker.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      // Try graceful shutdown first
      worker.disconnect();
    });
  }

  async restartAllWorkers(): Promise<void> {
    console.log('Performing rolling restart of all workers');

    const workerIds = Array.from(this.workers.keys());
    
    // Restart workers one by one to maintain service availability
    for (const workerId of workerIds) {
      try {
        await this.restartWorker(workerId);
        console.log(`Worker ${workerId} restarted successfully`);
        
        // Wait a bit before restarting the next worker
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`Failed to restart worker ${workerId}:`, error);
      }
    }

    console.log('Rolling restart completed');
    this.emit('allWorkersRestarted');
  }

  getWorkerStats(): {
    total: number;
    online: number;
    dead: number;
    workers: Array<{
      id: number;
      pid: number;
      state: string;
      isDead: boolean;
    }>;
  } {
    const workers = Array.from(this.workers.values());
    
    return {
      total: workers.length,
      online: workers.filter(w => !w.isDead()).length,
      dead: workers.filter(w => w.isDead()).length,
      workers: workers.map(w => ({
        id: w.id,
        pid: w.process.pid || 0,
        state: w.state,
        isDead: w.isDead(),
      })),
    };
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down cluster gracefully`);
      
      const workers = Array.from(this.workers.values());
      
      // Disconnect all workers
      for (const worker of workers) {
        if (!worker.isDead()) {
          worker.disconnect();
        }
      }

      // Wait for workers to exit gracefully
      const shutdownPromises = workers.map(worker => 
        new Promise<void>((resolve) => {
          if (worker.isDead()) {
            resolve();
            return;
          }

          const timeout = setTimeout(() => {
            console.log(`Force killing worker ${worker.process.pid}`);
            worker.kill('SIGKILL');
            resolve();
          }, this.config.gracefulTimeout);

          worker.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        })
      );

      await Promise.all(shutdownPromises);
      console.log('All workers shut down');
      
      this.emit('clusterShutdown');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGUSR2', () => {
      // Hot reload trigger
      if (this.config.enableHotReload) {
        this.restartAllWorkers();
      }
    });
  }
}

/**
 * Worker health monitoring utilities
 */
export class WorkerHealthMonitor {
  private memoryThreshold: number;
  private checkInterval: number;
  private lastHealthCheck: number = Date.now();

  constructor(memoryThreshold: number = 512 * 1024 * 1024, checkInterval: number = 60000) {
    this.memoryThreshold = memoryThreshold;
    this.checkInterval = checkInterval;
    this.setupHealthChecks();
  }

  private setupHealthChecks(): void {
    // Listen for messages from cluster manager
    process.on('message', (message: any) => {
      switch (message.type) {
        case 'health-check':
          this.respondToHealthCheck();
          break;
        case 'memory-check':
          this.checkMemoryUsage();
          break;
        case 'memory-usage-request':
          this.checkMemoryUsage(message.maxMemory);
          break;
      }
    });

    // Periodic self-health check
    setInterval(() => {
      this.performSelfCheck();
    }, this.checkInterval);
  }

  private respondToHealthCheck(): void {
    if (process.send) {
      process.send({
        type: 'health-response',
        pid: process.pid,
        timestamp: Date.now(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      });
    }
    this.lastHealthCheck = Date.now();
  }

  private checkMemoryUsage(threshold?: number): void {
    const memoryUsage = process.memoryUsage();
    const currentThreshold = threshold || this.memoryThreshold;

    if (memoryUsage.heapUsed > currentThreshold) {
      console.warn(`Worker ${process.pid} memory usage high: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`);
      
      if (process.send) {
        process.send({
          type: 'memory-warning',
          pid: process.pid,
          memory: memoryUsage,
          threshold: currentThreshold,
        });
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
    }
  }

  private performSelfCheck(): void {
    const now = Date.now();
    const timeSinceLastCheck = now - this.lastHealthCheck;

    // If we haven't received a health check in a while, something might be wrong
    if (timeSinceLastCheck > this.checkInterval * 2) {
      console.warn(`Worker ${process.pid} health check overdue by ${timeSinceLastCheck}ms`);
    }

    // Check memory usage
    this.checkMemoryUsage();
  }

  isHealthy(): boolean {
    const memoryUsage = process.memoryUsage();
    const timeSinceLastCheck = Date.now() - this.lastHealthCheck;

    return memoryUsage.heapUsed < this.memoryThreshold && 
           timeSinceLastCheck < this.checkInterval * 2;
  }
}

/**
 * Load balancer for distributing work across workers
 */
export class LoadBalancer {
  private workers: number[] = [];
  private currentIndex: number = 0;
  private strategy: 'round-robin' | 'least-connections' | 'weighted' = 'round-robin';
  private connections: Map<number, number> = new Map();
  private weights: Map<number, number> = new Map();

  constructor(strategy: 'round-robin' | 'least-connections' | 'weighted' = 'round-robin') {
    this.strategy = strategy;
  }

  addWorker(workerId: number, weight: number = 1): void {
    this.workers.push(workerId);
    this.connections.set(workerId, 0);
    this.weights.set(workerId, weight);
  }

  removeWorker(workerId: number): void {
    this.workers = this.workers.filter(id => id !== workerId);
    this.connections.delete(workerId);
    this.weights.delete(workerId);
  }

  selectWorker(): number | null {
    if (this.workers.length === 0) return null;

    switch (this.strategy) {
      case 'round-robin':
        return this.roundRobinSelect();
      case 'least-connections':
        return this.leastConnectionsSelect();
      case 'weighted':
        return this.weightedSelect();
      default:
        return this.roundRobinSelect();
    }
  }

  private roundRobinSelect(): number {
    const worker = this.workers[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.workers.length;
    return worker;
  }

  private leastConnectionsSelect(): number {
    let minConnections = Infinity;
    let selectedWorker = this.workers[0];

    for (const workerId of this.workers) {
      const connections = this.connections.get(workerId) || 0;
      if (connections < minConnections) {
        minConnections = connections;
        selectedWorker = workerId;
      }
    }

    return selectedWorker;
  }

  private weightedSelect(): number {
    // Simple weighted round-robin
    const totalWeight = Array.from(this.weights.values()).reduce((sum, weight) => sum + weight, 0);
    let random = Math.random() * totalWeight;

    for (const workerId of this.workers) {
      const weight = this.weights.get(workerId) || 1;
      random -= weight;
      if (random <= 0) {
        return workerId;
      }
    }

    return this.workers[0];
  }

  incrementConnections(workerId: number): void {
    const current = this.connections.get(workerId) || 0;
    this.connections.set(workerId, current + 1);
  }

  decrementConnections(workerId: number): void {
    const current = this.connections.get(workerId) || 0;
    this.connections.set(workerId, Math.max(0, current - 1));
  }

  getStats(): {
    strategy: string;
    workers: number;
    connections: Map<number, number>;
    weights: Map<number, number>;
  } {
    return {
      strategy: this.strategy,
      workers: this.workers.length,
      connections: new Map(this.connections),
      weights: new Map(this.weights),
    };
  }
}