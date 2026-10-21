/**
 * Outbound HTTP client for partner APIs: keep-alive connection pooling via `http(s).Agent`, a
 * per-host circuit breaker, bounded response buffering, timeouts and retry with backoff.
 *
 * Node's global `fetch` (undici) ignores `http.Agent` options, so this client uses
 * `http.request`/`https.request` directly; that is what makes the pool statistics real.
 */

import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { LRUCache } from 'lru-cache';
import { MAX_UPSTREAM_RESPONSE_SIZE, REQUEST_TIMEOUT } from './security.js';

export interface ConnectionPoolConfig {
  maxSockets?: number;
  maxFreeSockets?: number;
  /** Socket inactivity timeout in milliseconds. */
  timeout?: number;
  keepAlive?: boolean;
  keepAliveMsecs?: number;
  maxCachedSessions?: number;
  scheduling?: 'lifo' | 'fifo';
  /** Largest response body that will be buffered. */
  maxResponseBytes?: number;
  /** Consecutive failures per host before the circuit opens. */
  circuitFailureThreshold?: number;
  /** How long an open circuit stays open before a trial request is allowed. */
  circuitResetMs?: number;
}

export interface PooledRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** Per-request timeout in milliseconds. */
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

export interface PooledResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  responseTime: number;
}

export interface RequestStats {
  totalRequests: number;
  activeConnections: number;
  poolHits: number;
  poolMisses: number;
  timeouts: number;
  errors: number;
  averageResponseTime: number;
}

export interface HostStats {
  responseCount: number;
  averageResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
}

export interface AgentStats {
  totalSockets: number;
  freeSockets: number;
  pendingRequests: number;
}

export interface CircuitState {
  failures: number;
  lastFailureTime: number;
  state: 'closed' | 'open' | 'half-open';
}

export class UpstreamTimeoutError extends Error {
  readonly code = 'UPSTREAM_TIMEOUT';
  constructor(url: string, timeoutMs: number) {
    super(`Upstream request to ${new URL(url).host} timed out after ${timeoutMs}ms`);
    this.name = 'UpstreamTimeoutError';
  }
}

export class UpstreamResponseTooLargeError extends Error {
  readonly code = 'UPSTREAM_RESPONSE_TOO_LARGE';
  constructor(limit: number) {
    super(`Upstream response exceeded ${limit} bytes`);
    this.name = 'UpstreamResponseTooLargeError';
  }
}

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';
  constructor(host: string) {
    super(`Circuit breaker is open for ${host}`);
    this.name = 'CircuitOpenError';
  }
}

/** The subset of the pool the app depends on; tests substitute a fake upstream. */
export interface UpstreamClient {
  request(options: PooledRequestOptions): Promise<PooledResponse>;
  requestWithCircuitBreaker(options: PooledRequestOptions): Promise<PooledResponse>;
  getStats(): RequestStats;
}

function countSockets(record: NodeJS.ReadOnlyDict<unknown[]> | undefined): number {
  return Object.values(record ?? {}).reduce((sum, list) => sum + (list?.length ?? 0), 0);
}

export class ConnectionPool implements UpstreamClient {
  private readonly httpAgent: HttpAgent;
  private readonly httpsAgent: HttpsAgent;
  private readonly stats: RequestStats;
  private readonly responseTimes: LRUCache<string, number[]>;
  private readonly circuits = new Map<string, CircuitState>();
  private readonly maxResponseBytes: number;
  private readonly failureThreshold: number;
  private readonly circuitResetMs: number;
  private readonly defaultTimeout: number;

  constructor(config: ConnectionPoolConfig = {}) {
    const agentConfig = {
      keepAlive: config.keepAlive ?? true,
      keepAliveMsecs: config.keepAliveMsecs ?? 1000,
      maxSockets: config.maxSockets ?? 50,
      maxFreeSockets: config.maxFreeSockets ?? 10,
      timeout: config.timeout ?? REQUEST_TIMEOUT,
      scheduling: config.scheduling ?? ('lifo' as const),
    };

    this.httpAgent = new HttpAgent(agentConfig);
    this.httpsAgent = new HttpsAgent({
      ...agentConfig,
      maxCachedSessions: config.maxCachedSessions ?? 100,
    });
    this.maxResponseBytes = config.maxResponseBytes ?? MAX_UPSTREAM_RESPONSE_SIZE;
    this.failureThreshold = config.circuitFailureThreshold ?? 5;
    this.circuitResetMs = config.circuitResetMs ?? 60000;
    this.defaultTimeout = config.timeout ?? REQUEST_TIMEOUT;

    this.stats = {
      totalRequests: 0,
      activeConnections: 0,
      poolHits: 0,
      poolMisses: 0,
      timeouts: 0,
      errors: 0,
      averageResponseTime: 0,
    };
    this.responseTimes = new LRUCache<string, number[]>({ max: 1000, ttl: 300000 });
  }

  async request(options: PooledRequestOptions): Promise<PooledResponse> {
    const startTime = Date.now();
    this.stats.totalRequests++;
    this.stats.activeConnections++;

    try {
      const url = new URL(options.url);
      const isHttps = url.protocol === 'https:';
      const agent = isHttps ? this.httpsAgent : this.httpAgent;
      const poolName = agent.getName({
        host: url.hostname,
        port: Number(url.port) || (isHttps ? 443 : 80),
      });
      if ((agent.freeSockets[poolName]?.length ?? 0) > 0) {
        this.stats.poolHits++;
      } else {
        this.stats.poolMisses++;
      }

      const response = await this.send(url, agent, options);
      const responseTime = Date.now() - startTime;
      this.recordResponseTime(url.hostname, responseTime);
      return { ...response, responseTime };
    } catch (error) {
      this.stats.errors++;
      if (error instanceof UpstreamTimeoutError) this.stats.timeouts++;
      throw error;
    } finally {
      this.stats.activeConnections--;
    }
  }

  private send(
    url: URL,
    agent: HttpAgent | HttpsAgent,
    options: PooledRequestOptions
  ): Promise<Omit<PooledResponse, 'responseTime'>> {
    const timeoutMs = options.timeout ?? this.defaultTimeout;
    const body =
      options.body === undefined
        ? undefined
        : Buffer.isBuffer(options.body)
          ? options.body
          : Buffer.from(options.body);
    const headers: Record<string, string> = { ...options.headers };
    if (body) headers['content-length'] = body.length.toString();

    return new Promise((resolve, reject) => {
      // The promise settles exactly once; later socket-level errors from tearing down an aborted
      // request are expected and must not surface as unhandled exceptions.
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const succeed = (value: Omit<PooledResponse, 'responseTime'>) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = requestFn(url, { method: options.method, headers, agent }, (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > this.maxResponseBytes) {
            fail(new UpstreamResponseTooLargeError(this.maxResponseBytes));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const responseHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            responseHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
          }
          succeed({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', fail);
      });

      req.setTimeout(timeoutMs, () => {
        fail(new UpstreamTimeoutError(url.href, timeoutMs));
        req.destroy();
      });
      req.on('error', fail);
      req.end(body);
    });
  }

  async requestWithRetry(
    options: PooledRequestOptions
  ): Promise<PooledResponse & { attempts: number }> {
    const maxAttempts = Math.max(1, options.retries ?? 3);
    const baseDelay = options.retryDelay ?? 1000;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.request(options);
        return { ...result, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts || this.isNonRetriableError(error)) break;
        await sleep(baseDelay * 2 ** (attempt - 1) + Math.random() * 100);
      }
    }

    throw lastError;
  }

  private isNonRetriableError(error: unknown): boolean {
    if (error instanceof UpstreamResponseTooLargeError) return true;
    const code = (error as { code?: string } | null)?.code;
    return code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN';
  }

  private recordResponseTime(hostname: string, responseTime: number): void {
    const times = this.responseTimes.get(hostname) ?? [];
    times.push(responseTime);
    if (times.length > 100) times.splice(0, times.length - 100);
    this.responseTimes.set(hostname, times);

    let total = 0;
    let count = 0;
    for (const hostTimes of this.responseTimes.values()) {
      for (const time of hostTimes) {
        total += time;
        count++;
      }
    }
    this.stats.averageResponseTime = count > 0 ? total / count : 0;
  }

  getStats(): RequestStats {
    return { ...this.stats };
  }

  getDetailedStats(): {
    global: RequestStats;
    byHost: Record<string, HostStats>;
    circuits: Record<string, CircuitState>;
    connections: { http: AgentStats; https: AgentStats };
  } {
    const byHost: Record<string, HostStats> = {};
    for (const [hostname, times] of this.responseTimes.entries()) {
      if (times.length === 0) continue;
      byHost[hostname] = {
        responseCount: times.length,
        averageResponseTime: times.reduce((sum, t) => sum + t, 0) / times.length,
        minResponseTime: Math.min(...times),
        maxResponseTime: Math.max(...times),
      };
    }

    const agentStats = (agent: HttpAgent | HttpsAgent): AgentStats => ({
      totalSockets: countSockets(agent.sockets),
      freeSockets: countSockets(agent.freeSockets),
      pendingRequests: countSockets(agent.requests),
    });

    return {
      global: this.getStats(),
      byHost,
      circuits: Object.fromEntries(
        Array.from(this.circuits.entries(), ([host, state]) => [host, { ...state }])
      ),
      connections: { http: agentStats(this.httpAgent), https: agentStats(this.httpsAgent) },
    };
  }

  async warmupConnections(urls: string[], concurrency = 5): Promise<void> {
    for (let i = 0; i < urls.length; i += concurrency) {
      await Promise.allSettled(
        urls
          .slice(i, i + concurrency)
          .map((url) => this.request({ method: 'HEAD', url, timeout: 5000 }))
      );
    }
  }

  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  // ---- circuit breaker ----------------------------------------------------------------------

  getCircuitState(url: string): CircuitState | undefined {
    const state = this.circuits.get(new URL(url).hostname);
    return state ? { ...state } : undefined;
  }

  private allowRequest(host: string): boolean {
    const circuit = this.circuits.get(host);
    if (!circuit) {
      this.circuits.set(host, { failures: 0, lastFailureTime: 0, state: 'closed' });
      return true;
    }
    if (circuit.state === 'open') {
      if (Date.now() - circuit.lastFailureTime > this.circuitResetMs) {
        circuit.state = 'half-open';
        return true;
      }
      return false;
    }
    return true;
  }

  private recordOutcome(host: string, success: boolean): void {
    const circuit = this.circuits.get(host);
    if (!circuit) return;
    if (success) {
      circuit.failures = 0;
      circuit.state = 'closed';
      return;
    }
    circuit.failures++;
    circuit.lastFailureTime = Date.now();
    if (circuit.state === 'half-open' || circuit.failures >= this.failureThreshold) {
      circuit.state = 'open';
    }
  }

  /**
   * Request through the per-host circuit breaker. Transport errors and 5xx responses count as
   * failures; after `circuitFailureThreshold` consecutive failures the host is skipped for
   * `circuitResetMs`, then a single trial request decides whether it recovered.
   */
  async requestWithCircuitBreaker(options: PooledRequestOptions): Promise<PooledResponse> {
    const host = new URL(options.url).hostname;
    if (!this.allowRequest(host)) {
      throw new CircuitOpenError(host);
    }

    try {
      const result = await this.request(options);
      this.recordOutcome(host, result.status < 500);
      return result;
    } catch (error) {
      this.recordOutcome(host, false);
      throw error;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
