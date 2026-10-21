import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ClusterManager, WorkerHealthMonitor } from '../src/cluster.js';

/** A private IPC channel so the tests never touch the real process channel vitest itself uses. */
function channel() {
  return Object.assign(new EventEmitter(), { send: vi.fn() });
}

describe('WorkerHealthMonitor', () => {
  const monitors: WorkerHealthMonitor[] = [];
  const monitor = (...args: ConstructorParameters<typeof WorkerHealthMonitor>) => {
    const created = new WorkerHealthMonitor(...args);
    monitors.push(created);
    return created;
  };

  afterEach(() => {
    for (const created of monitors.splice(0)) created.stop();
    vi.useRealTimers();
  });

  it('answers health checks from the primary', () => {
    const ipc = channel();
    const health = monitor(1024 * 1024 * 1024, 60000, ipc);
    ipc.emit('message', { type: 'health-check' });

    expect(ipc.send).toHaveBeenCalledTimes(1);
    expect(ipc.send.mock.calls[0][0]).toMatchObject({ type: 'health-response', pid: process.pid });
    expect(health.isHealthy()).toBe(true);
  });

  it('warns the primary when the heap exceeds the threshold', () => {
    const ipc = channel();
    monitor(1, 60000, ipc); // 1 byte: any heap is "too large"
    ipc.emit('message', { type: 'memory-check' });
    expect(ipc.send.mock.calls[0][0]).toMatchObject({ type: 'memory-warning', threshold: 1 });

    ipc.emit('message', { type: 'memory-usage-request', maxMemory: 2 });
    expect(ipc.send.mock.calls[1][0]).toMatchObject({ type: 'memory-warning', threshold: 2 });

    ipc.emit('message', { type: 'unknown' });
    ipc.emit('message', null);
    expect(ipc.send).toHaveBeenCalledTimes(2);
  });

  it('reports unhealthy when health checks stop arriving or memory is high', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const health = monitor(1024 * 1024 * 1024, 1000, channel());
    expect(health.isHealthy()).toBe(true);
    vi.setSystemTime(Date.now() + 2001);
    expect(health.isHealthy()).toBe(false);

    expect(monitor(1, 60000, channel()).isHealthy()).toBe(false);
  });

  it('stops listening once stopped', () => {
    const ipc = channel();
    const health = monitor(1024 * 1024 * 1024, 60000, ipc);
    health.stop();
    ipc.emit('message', { type: 'health-check' });
    expect(ipc.send).not.toHaveBeenCalled();
    expect(ipc.listenerCount('message')).toBe(0);
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
