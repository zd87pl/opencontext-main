/**
 * Multi-process support: a primary that supervises workers (restart on exit, rolling restarts,
 * memory monitoring) and the worker-side health monitor that answers it.
 *
 * Connection distribution between workers is done by Node's cluster module itself.
 */

import cluster, { type Worker } from 'node:cluster';
import { EventEmitter } from 'node:events';
import { cpus } from 'node:os';

export interface ClusterConfig {
  workers?: number;
  /** Delay before replacing a dead worker, in milliseconds. */
  restartDelay?: number;
  /** Heap size (bytes) above which a worker is warned. */
  maxMemory?: number;
  /** How long a worker gets to drain before it is killed, in milliseconds. */
  gracefulTimeout?: number;
  /** Rolling-restart all workers on SIGUSR2. */
  enableHotReload?: boolean;
}

interface WorkerMessage {
  type?: string;
  [key: string]: unknown;
}

export class ClusterManager extends EventEmitter {
  private readonly config: Required<ClusterConfig>;
  private readonly workers = new Map<number, Worker>();
  private readonly monitors = new Map<number, NodeJS.Timeout>();
  private readonly retiring = new Set<number>();
  private shuttingDown = false;
  private memoryMonitor: NodeJS.Timeout | null = null;

  constructor(config: ClusterConfig = {}) {
    super();
    this.config = {
      workers: config.workers ?? cpus().length,
      restartDelay: config.restartDelay ?? 1000,
      maxMemory: config.maxMemory ?? 512 * 1024 * 1024,
      gracefulTimeout: config.gracefulTimeout ?? 30000,
      enableHotReload: config.enableHotReload ?? true,
    };
  }

  start(workerFile: string): void {
    if (!cluster.isPrimary) {
      throw new Error('ClusterManager can only be started from the primary process');
    }

    console.log(`Starting cluster with ${this.config.workers} workers`);
    cluster.setupPrimary({ exec: workerFile, silent: false });

    for (let i = 0; i < this.config.workers; i++) {
      this.spawnWorker();
    }

    cluster.on('exit', (worker, code, signal) => this.handleWorkerExit(worker, code, signal));
    cluster.on('online', (worker) => {
      console.log(`Worker ${worker.process.pid} is online`);
      this.emit('workerOnline', worker);
    });
    cluster.on('disconnect', (worker) => {
      console.log(`Worker ${worker.process.pid} disconnected`);
      this.emit('workerDisconnect', worker);
    });

    this.memoryMonitor = setInterval(() => this.monitorWorkerMemory(), 30000);
    this.memoryMonitor.unref();
    this.setupSignalHandlers();

    this.emit('clusterStarted', { workers: this.config.workers, pid: process.pid });
  }

  private spawnWorker(): Worker {
    const worker = cluster.fork();
    this.workers.set(worker.id, worker);

    worker.on('message', (message: WorkerMessage) => {
      if (message?.type === 'health-check') {
        worker.send({ type: 'health-response', timestamp: Date.now() });
      }
      if (message?.type === 'memory-warning') {
        this.emit('workerMemoryWarning', { worker, ...message });
      }
    });

    const monitor = setInterval(() => {
      if (!worker.isDead()) worker.send({ type: 'memory-check' });
    }, 60000);
    monitor.unref();
    this.monitors.set(worker.id, monitor);

    return worker;
  }

  private handleWorkerExit(worker: Worker, code: number, signal: string): void {
    console.log(`Worker ${worker.process.pid} exited with code ${code} and signal ${signal}`);

    this.workers.delete(worker.id);
    const monitor = this.monitors.get(worker.id);
    if (monitor) {
      clearInterval(monitor);
      this.monitors.delete(worker.id);
    }
    this.emit('workerExit', { worker, code, signal });

    if (this.shuttingDown) return;

    // Workers retired on purpose (rolling restart) are replaced immediately; crashes after a delay.
    const delay = this.retiring.delete(worker.id) ? 0 : this.config.restartDelay;
    const timer = setTimeout(() => {
      if (this.shuttingDown) return;
      console.log(`Replacing worker ${worker.id}`);
      this.spawnWorker();
    }, delay);
    timer.unref();
  }

  private monitorWorkerMemory(): void {
    for (const worker of this.workers.values()) {
      if (!worker.isDead()) {
        worker.send({ type: 'memory-usage-request', maxMemory: this.config.maxMemory });
      }
    }
  }

  /** Disconnect a worker and resolve once it has exited (it is replaced automatically). */
  async restartWorker(workerId: number): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }
    this.retiring.add(workerId);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.kill('SIGKILL');
        reject(new Error('Worker restart timeout'));
      }, this.config.gracefulTimeout);

      worker.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      worker.disconnect();
    });
  }

  /** Restart workers one at a time so capacity never drops to zero. */
  async restartAllWorkers(): Promise<void> {
    console.log('Performing rolling restart of all workers');
    for (const workerId of Array.from(this.workers.keys())) {
      try {
        await this.restartWorker(workerId);
        console.log(`Worker ${workerId} restarted`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
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
    workers: Array<{ id: number; pid: number; connected: boolean; isDead: boolean }>;
  } {
    const workers = Array.from(this.workers.values());
    return {
      total: workers.length,
      online: workers.filter((w) => !w.isDead()).length,
      dead: workers.filter((w) => w.isDead()).length,
      workers: workers.map((w) => ({
        id: w.id,
        pid: w.process.pid ?? 0,
        connected: w.isConnected(),
        isDead: w.isDead(),
      })),
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.memoryMonitor) clearInterval(this.memoryMonitor);

    const workers = Array.from(this.workers.values());
    await Promise.all(
      workers.map(
        (worker) =>
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
            worker.disconnect();
          })
      )
    );
    console.log('All workers shut down');
    this.emit('clusterShutdown');
  }

  private setupSignalHandlers(): void {
    const onSignal = (signal: string) => {
      console.log(`Received ${signal}, shutting down cluster gracefully`);
      this.shutdown().finally(() => process.exit(0));
    };
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGUSR2', () => {
      if (this.config.enableHotReload) void this.restartAllWorkers();
    });
  }
}

/** The IPC surface the health monitor uses: `process` in a real worker, an EventEmitter in tests. */
export interface WorkerChannel {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
  send?(message: unknown): unknown;
}

/**
 * Worker-side counterpart: answers the primary's health and memory probes and warns when the
 * heap grows past the threshold.
 */
export class WorkerHealthMonitor {
  private readonly memoryThreshold: number;
  private readonly checkInterval: number;
  private readonly channel: WorkerChannel;
  private readonly onMessage: (message: unknown) => void;
  private readonly timer: NodeJS.Timeout;
  private lastHealthCheck = Date.now();

  constructor(
    memoryThreshold = 512 * 1024 * 1024,
    checkInterval = 60000,
    channel: WorkerChannel = process
  ) {
    this.memoryThreshold = memoryThreshold;
    this.checkInterval = checkInterval;
    this.channel = channel;

    this.onMessage = (raw: unknown) => {
      const message = (raw ?? {}) as WorkerMessage;
      switch (message.type) {
        case 'health-check':
          this.respondToHealthCheck();
          break;
        case 'memory-check':
          this.checkMemoryUsage();
          break;
        case 'memory-usage-request':
          this.checkMemoryUsage(typeof message.maxMemory === 'number' ? message.maxMemory : undefined);
          break;
      }
    };
    channel.on('message', this.onMessage);

    this.timer = setInterval(() => this.performSelfCheck(), this.checkInterval);
    this.timer.unref();
  }

  /** Detach from the channel and stop the periodic self-check. */
  stop(): void {
    this.channel.off('message', this.onMessage);
    clearInterval(this.timer);
  }

  private send(message: unknown): void {
    this.channel.send?.(message);
  }

  private respondToHealthCheck(): void {
    this.send({
      type: 'health-response',
      pid: process.pid,
      timestamp: Date.now(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    });
    this.lastHealthCheck = Date.now();
  }

  private checkMemoryUsage(threshold = this.memoryThreshold): void {
    const memory = process.memoryUsage();
    if (memory.heapUsed <= threshold) return;

    console.warn(`Worker ${process.pid} memory usage high: ${Math.round(memory.heapUsed / 1024 / 1024)}MB`);
    this.send({ type: 'memory-warning', pid: process.pid, memory, threshold });
    global.gc?.();
  }

  private performSelfCheck(): void {
    const sinceLastCheck = Date.now() - this.lastHealthCheck;
    if (sinceLastCheck > this.checkInterval * 2) {
      console.warn(`Worker ${process.pid} health check overdue by ${sinceLastCheck}ms`);
    }
    this.checkMemoryUsage();
  }

  isHealthy(): boolean {
    return (
      process.memoryUsage().heapUsed < this.memoryThreshold &&
      Date.now() - this.lastHealthCheck < this.checkInterval * 2
    );
  }
}
