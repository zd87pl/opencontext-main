import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClusterManager, WorkerHealthMonitor } from '../src/cluster.js';

describe('WorkerHealthMonitor', () => {
  let send: ReturnType<typeof vi.fn>;
  const originalSend = process.send;

  beforeEach(() => {
    send = vi.fn();
    process.send = send as unknown as typeof process.send;
  });

  afterEach(() => {
    process.send = originalSend;
    process.removeAllListeners('message');
    vi.useRealTimers();
  });

  it('answers health checks from the primary', () => {
    const monitor = new WorkerHealthMonitor(1024 * 1024 * 1024, 60000);
    process.emit('message', { type: 'health-check' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ type: 'health-response', pid: process.pid });
    expect(monitor.isHealthy()).toBe(true);
  });

  it('warns the primary when the heap exceeds the threshold', () => {
    new WorkerHealthMonitor(1, 60000); // 1 byte: any heap is "too large"
    process.emit('message', { type: 'memory-check' });
    expect(send.mock.calls[0][0]).toMatchObject({ type: 'memory-warning', threshold: 1 });

    process.emit('message', { type: 'memory-usage-request', maxMemory: 2 });
    expect(send.mock.calls[1][0]).toMatchObject({ type: 'memory-warning', threshold: 2 });

    process.emit('message', { type: 'unknown' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reports unhealthy when health checks stop arriving or memory is high', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const monitor = new WorkerHealthMonitor(1024 * 1024 * 1024, 1000);
    expect(monitor.isHealthy()).toBe(true);
    vi.setSystemTime(Date.now() + 2001);
    expect(monitor.isHealthy()).toBe(false);

    const tight = new WorkerHealthMonitor(1, 60000);
    expect(tight.isHealthy()).toBe(false);
  });
});

describe('ClusterManager', () => {
  it('starts with no workers and rejects restarting unknown ones', async () => {
    const manager = new ClusterManager({ workers: 2 });
    expect(manager.getWorkerStats()).toEqual({ total: 0, online: 0, dead: 0, workers: [] });
    await expect(manager.restartWorker(42)).rejects.toThrow('Worker 42 not found');
  });

  it('completes a rolling restart and shutdown with nothing to do', async () => {
    const manager = new ClusterManager();
    const restarted = vi.fn();
    const shutdown = vi.fn();
    manager.on('allWorkersRestarted', restarted);
    manager.on('clusterShutdown', shutdown);

    await manager.restartAllWorkers();
    await manager.shutdown();
    expect(restarted).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
