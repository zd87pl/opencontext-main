/**
 * HTTP connection pooling for external API requests
 */

import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { LRUCache } from 'lru-cache';

export interface ConnectionPoolConfig {
  maxSockets?: number;
  maxFreeSockets?: number;
  timeout?: number;
  keepAlive?: boolean;
  keepAliveMsecs?: number;
  maxCachedSessions?: number;
  scheduling?: 'lifo' | 'fifo';
}

export interface PooledRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
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

export class ConnectionPool {
  private httpAgent: HttpAgent;
  private httpsAgent: HttpsAgent;
  private stats: RequestStats;
  private responseTimeCache: LRUCache<string, number[]>;

  constructor(config: ConnectionPoolConfig = {}) {
    const agentConfig = {
      keepAlive: config.keepAlive ?? true,
      keepAliveMsecs: config.keepAliveMsecs ?? 1000,
      maxSockets: config.maxSockets ?? 50,
      maxFreeSockets: config.maxFreeSockets ?? 10,
      timeout: config.timeout ?? 30000,
      scheduling: config.scheduling ?? 'lifo' as const,
    };

    this.httpAgent = new HttpAgent(agentConfig);
    this.httpsAgent = new HttpsAgent({
      ...agentConfig,
      maxCachedSessions: config.maxCachedSessions ?? 100,
    });

    this.stats = {
      totalRequests: 0,
      activeConnections: 0,
      poolHits: 0,
      poolMisses: 0,
      timeouts: 0,
      errors: 0,
      averageResponseTime: 0,
    };

    this.responseTimeCache = new LRUCache<string, number[]>({
      max: 1000,
      ttl: 300000, // 5 minutes
    });
  }

  async request(options: PooledRequestOptions): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    responseTime: number;
  }> {
    const startTime = Date.now();
    this.stats.totalRequests++;
    this.stats.activeConnections++;

    try {
      const url = new URL(options.url);
      const agent = url.protocol === 'https:' ? this.httpsAgent : this.httpAgent;

      // Track if this is a pool hit (reused connection)
      const socketCount = agent.sockets[`${url.hostname}:${url.port}`]?.length || 0;
      const freeSocketCount = agent.freeSockets[`${url.hostname}:${url.port}`]?.length || 0;
      
      if (freeSocketCount > 0) {
        this.stats.poolHits++;
      } else {
        this.stats.poolMisses++;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        this.stats.timeouts++;
      }, options.timeout || 30000);

      const response = await fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
        // @ts-ignore - Node.js specific option
        agent: (parsedUrl: any) => {
          return parsedUrl.protocol === 'https:' ? this.httpsAgent : this.httpAgent;
        },
      });

      clearTimeout(timeoutId);

      const body = await response.text();
      const responseTime = Date.now() - startTime;

      // Update response time statistics
      this.updateResponseTimeStats(options.url, responseTime);

      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        responseTime,
      };
    } catch (error) {
      this.stats.errors++;
      throw error;
    } finally {
      this.stats.activeConnections--;
    }
  }

  async requestWithRetry(options: PooledRequestOptions): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    responseTime: number;
    attempts: number;
  }> {
    const maxRetries = options.retries || 3;
    const baseDelay = options.retryDelay || 1000;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.request(options);
        return {
          ...result,
          attempts: attempt,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Don't retry on the last attempt
        if (attempt === maxRetries) {
          break;
        }

        // Don't retry on non-retriable errors
        if (this.isNonRetriableError(error)) {
          break;
        }

        // Exponential backoff with jitter
        const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  private isNonRetriableError(error: any): boolean {
    // Don't retry on client errors (4xx) except for specific cases
    if (error.status >= 400 && error.status < 500) {
      // Retry on rate limiting and certain auth errors
      return ![401, 408, 429].includes(error.status);
    }

    // Don't retry on certain network errors
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return true;
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private updateResponseTimeStats(url: string, responseTime: number): void {
    const hostname = new URL(url).hostname;
    let times = this.responseTimeCache.get(hostname) || [];
    
    times.push(responseTime);
    
    // Keep only last 100 response times
    if (times.length > 100) {
      times = times.slice(-100);
    }
    
    this.responseTimeCache.set(hostname, times);
    
    // Update global average
    const allTimes: number[] = [];
    for (const hostTimes of this.responseTimeCache.values()) {
      allTimes.push(...hostTimes);
    }
    
    this.stats.averageResponseTime = allTimes.length > 0
      ? allTimes.reduce((sum, time) => sum + time, 0) / allTimes.length
      : 0;
  }

  getStats(): RequestStats {
    return { ...this.stats };
  }

  getDetailedStats(): {
    global: RequestStats;
    byHost: Map<string, {
      responseCount: number;
      averageResponseTime: number;
      minResponseTime: number;
      maxResponseTime: number;
    }>;
    connections: {
      http: {
        totalSockets: number;
        freeSockets: number;
        requests: number;
      };
      https: {
        totalSockets: number;
        freeSockets: number;
        requests: number;
      };
    };
  } {
    const byHost = new Map();
    
    for (const [hostname, times] of this.responseTimeCache.entries()) {
      if (times.length > 0) {
        byHost.set(hostname, {
          responseCount: times.length,
          averageResponseTime: times.reduce((sum, time) => sum + time, 0) / times.length,
          minResponseTime: Math.min(...times),
          maxResponseTime: Math.max(...times),
        });
      }
    }

    return {
      global: this.getStats(),
      byHost,
      connections: {
        http: {
          totalSockets: Object.keys(this.httpAgent.sockets).length,
          freeSockets: Object.keys(this.httpAgent.freeSockets).length,
          requests: this.httpAgent.requests ? Object.keys(this.httpAgent.requests).length : 0,
        },
        https: {
          totalSockets: Object.keys(this.httpsAgent.sockets).length,
          freeSockets: Object.keys(this.httpsAgent.freeSockets).length,
          requests: this.httpsAgent.requests ? Object.keys(this.httpsAgent.requests).length : 0,
        },
      },
    };
  }

  async warmupConnections(urls: string[], concurrency: number = 5): Promise<void> {
    const chunks: string[][] = [];
    for (let i = 0; i < urls.length; i += concurrency) {
      chunks.push(urls.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      await Promise.allSettled(
        chunk.map(url => 
          this.request({
            method: 'HEAD',
            url,
            timeout: 5000,
          }).catch(() => {
            // Ignore errors during warmup
          })
        )
      );
    }
  }

  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  // Circuit breaker functionality
  private circuitBreakers = new Map<string, {
    failures: number;
    lastFailureTime: number;
    state: 'closed' | 'open' | 'half-open';
  }>();

  private getCircuitBreakerKey(url: string): string {
    return new URL(url).hostname;
  }

  private checkCircuitBreaker(url: string): boolean {
    const key = this.getCircuitBreakerKey(url);
    const breaker = this.circuitBreakers.get(key);

    if (!breaker) {
      this.circuitBreakers.set(key, {
        failures: 0,
        lastFailureTime: 0,
        state: 'closed',
      });
      return true;
    }

    const now = Date.now();
    const timeSinceLastFailure = now - breaker.lastFailureTime;

    switch (breaker.state) {
      case 'closed':
        return true;

      case 'open':
        // After 60 seconds, try half-open
        if (timeSinceLastFailure > 60000) {
          breaker.state = 'half-open';
          return true;
        }
        return false;

      case 'half-open':
        return true;
    }
  }

  private recordCircuitBreakerResult(url: string, success: boolean): void {
    const key = this.getCircuitBreakerKey(url);
    const breaker = this.circuitBreakers.get(key);

    if (!breaker) return;

    if (success) {
      if (breaker.state === 'half-open') {
        breaker.state = 'closed';
        breaker.failures = 0;
      }
    } else {
      breaker.failures++;
      breaker.lastFailureTime = Date.now();

      // Open circuit after 5 failures
      if (breaker.failures >= 5) {
        breaker.state = 'open';
      }
    }
  }

  async requestWithCircuitBreaker(options: PooledRequestOptions): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    responseTime: number;
  }> {
    if (!this.checkCircuitBreaker(options.url)) {
      throw new Error(`Circuit breaker is open for ${new URL(options.url).hostname}`);
    }

    try {
      const result = await this.request(options);
      this.recordCircuitBreakerResult(options.url, true);
      return result;
    } catch (error) {
      this.recordCircuitBreakerResult(options.url, false);
      throw error;
    }
  }
}