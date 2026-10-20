import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CircuitOpenError,
  ConnectionPool,
  UpstreamResponseTooLargeError,
  UpstreamTimeoutError,
} from '../src/connection-pool.js';

/** A tiny upstream with endpoints for every failure mode the pool handles. */
function handler(hits: string[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    hits.push(url.pathname);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      switch (url.pathname) {
        case '/echo':
          res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
          res.end(JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }));
          return;
        case '/slow':
          setTimeout(() => {
            res.writeHead(200);
            res.end('late');
          }, 300);
          return;
        case '/big':
          res.writeHead(200);
          res.end(Buffer.alloc(4096, 'x'));
          return;
        case '/fail':
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('upstream exploded');
          return;
        default:
          res.writeHead(200);
          res.end('ok');
      }
    });
  };
}

describe('ConnectionPool', () => {
  let server: Server;
  let baseUrl: string;
  const hits: string[] = [];
  const pools: ConnectionPool[] = [];

  function pool(config: ConstructorParameters<typeof ConnectionPool>[0] = {}): ConnectionPool {
    const created = new ConnectionPool({ timeout: 2000, ...config });
    pools.push(created);
    return created;
  }

  beforeAll(async () => {
    server = createServer(handler(hits));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    hits.length = 0;
    vi.useRealTimers();
    for (const created of pools.splice(0)) created.destroy();
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('performs requests through keep-alive agents and tracks stats', async () => {
    const client = pool();
    const response = await client.request({
      method: 'POST',
      url: `${baseUrl}/echo`,
      headers: { 'content-type': 'text/plain', 'x-test': '1' },
      body: 'hello',
    });

    expect(response.status).toBe(200);
    expect(response.statusText).toBe('OK');
    expect(response.headers['x-upstream']).toBe('yes');
    expect(response.responseTime).toBeGreaterThanOrEqual(0);
    const echoed = JSON.parse(response.body.toString()) as { method: string; headers: Record<string, string>; body: string };
    expect(echoed.method).toBe('POST');
    expect(echoed.body).toBe('hello');
    expect(echoed.headers['x-test']).toBe('1');
    expect(echoed.headers['content-length']).toBe('5');

    await client.request({ method: 'GET', url: `${baseUrl}/echo` });
    const stats = client.getStats();
    expect(stats.totalRequests).toBe(2);
    expect(stats.errors).toBe(0);
    expect(stats.activeConnections).toBe(0);
    expect(stats.poolHits + stats.poolMisses).toBe(2);
    expect(stats.averageResponseTime).toBeGreaterThanOrEqual(0);

    const detailed = client.getDetailedStats();
    expect(detailed.byHost['127.0.0.1'].responseCount).toBe(2);
    expect(detailed.connections.http.totalSockets + detailed.connections.http.freeSockets).toBeGreaterThanOrEqual(0);
  });

  it('returns 5xx responses instead of throwing', async () => {
    const response = await pool().request({ method: 'GET', url: `${baseUrl}/fail` });
    expect(response.status).toBe(500);
    expect(response.body.toString()).toBe('upstream exploded');
  });

  it('times out slow upstreams', async () => {
    const client = pool();
    await expect(
      client.request({ method: 'GET', url: `${baseUrl}/slow`, timeout: 50 })
    ).rejects.toBeInstanceOf(UpstreamTimeoutError);
    expect(client.getStats().timeouts).toBe(1);
    expect(client.getStats().errors).toBe(1);
  });

  it('refuses responses larger than the configured bound', async () => {
    const client = pool({ maxResponseBytes: 1024 });
    await expect(client.request({ method: 'GET', url: `${baseUrl}/big` })).rejects.toBeInstanceOf(
      UpstreamResponseTooLargeError
    );
  });

  it('surfaces connection errors', async () => {
    const client = pool();
    await expect(client.request({ method: 'GET', url: 'http://127.0.0.1:1/' })).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  describe('retry', () => {
    it('retries transient failures with backoff and reports attempts', async () => {
      const client = pool();
      await expect(
        client.requestWithRetry({ method: 'GET', url: `${baseUrl}/slow`, timeout: 30, retries: 2, retryDelay: 1 })
      ).rejects.toBeInstanceOf(UpstreamTimeoutError);
      expect(client.getStats().totalRequests).toBe(2);

      const ok = await client.requestWithRetry({ method: 'GET', url: `${baseUrl}/ok`, retries: 3, retryDelay: 1 });
      expect(ok.attempts).toBe(1);
      expect(ok.body.toString()).toBe('ok');
    });

    it('does not retry connection refusals', async () => {
      const client = pool();
      await expect(
        client.requestWithRetry({ method: 'GET', url: 'http://127.0.0.1:1/', retries: 3, retryDelay: 1 })
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(client.getStats().totalRequests).toBe(1);
    });
  });

  describe('circuit breaker', () => {
    it('opens after consecutive failures and recovers through a half-open trial', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const client = pool({ circuitFailureThreshold: 2, circuitResetMs: 60000 });
      const fail = () => client.requestWithCircuitBreaker({ method: 'GET', url: `${baseUrl}/fail` });

      expect((await fail()).status).toBe(500);
      expect(client.getCircuitState(`${baseUrl}/fail`)?.state).toBe('closed');
      expect((await fail()).status).toBe(500);
      expect(client.getCircuitState(`${baseUrl}/fail`)?.state).toBe('open');

      await expect(fail()).rejects.toBeInstanceOf(CircuitOpenError);
      expect(hits.filter((path) => path === '/fail')).toHaveLength(2);

      // After the reset window one trial request is allowed; success closes the circuit.
      vi.setSystemTime(Date.now() + 60001);
      const ok = await client.requestWithCircuitBreaker({ method: 'GET', url: `${baseUrl}/ok` });
      expect(ok.status).toBe(200);
      expect(client.getCircuitState(`${baseUrl}/ok`)?.state).toBe('closed');
      expect(client.getCircuitState(`${baseUrl}/ok`)?.failures).toBe(0);
    });

    it('re-opens immediately when the half-open trial fails', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const client = pool({ circuitFailureThreshold: 1, circuitResetMs: 1000 });
      await client.requestWithCircuitBreaker({ method: 'GET', url: `${baseUrl}/fail` });
      expect(client.getCircuitState(`${baseUrl}/fail`)?.state).toBe('open');

      vi.setSystemTime(Date.now() + 1001);
      await client.requestWithCircuitBreaker({ method: 'GET', url: `${baseUrl}/fail` });
      expect(client.getCircuitState(`${baseUrl}/fail`)?.state).toBe('open');
      await expect(
        client.requestWithCircuitBreaker({ method: 'GET', url: `${baseUrl}/ok` })
      ).rejects.toBeInstanceOf(CircuitOpenError);
    });

    it('counts transport errors as failures', async () => {
      const client = pool({ circuitFailureThreshold: 1 });
      await expect(
        client.requestWithCircuitBreaker({ method: 'GET', url: 'http://127.0.0.1:1/x' })
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(client.getCircuitState('http://127.0.0.1:1/')?.state).toBe('open');
      expect(client.getCircuitState('http://unknown.example/')).toBeUndefined();
    });
  });

  it('warms up connections without throwing', async () => {
    const client = pool();
    await client.warmupConnections([`${baseUrl}/ok`, 'http://127.0.0.1:1/'], 2);
    expect(hits).toContain('/ok');
  });
});
