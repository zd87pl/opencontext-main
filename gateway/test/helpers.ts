import type { PooledRequestOptions, PooledResponse, UpstreamClient } from '../src/connection-pool.js';

/**
 * Stand-in for the outbound HTTP client: records every proxied request and answers with a JSON
 * echo, or with whatever `respond` returns (it may also throw to simulate transport failures).
 */
export class FakeUpstream implements UpstreamClient {
  requests: PooledRequestOptions[] = [];
  respond: (options: PooledRequestOptions) => Partial<PooledResponse> = () => ({});

  async request(options: PooledRequestOptions): Promise<PooledResponse> {
    this.requests.push(options);
    const url = new URL(options.url);
    const echo = {
      message: 'Mock API response',
      host: url.hostname,
      path: url.pathname,
      query: url.search,
      method: options.method,
      timestamp: new Date().toISOString(),
    };
    return {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(echo)),
      responseTime: 1,
      ...this.respond(options),
    };
  }

  requestWithCircuitBreaker(options: PooledRequestOptions): Promise<PooledResponse> {
    return this.request(options);
  }

  getStats() {
    return {
      totalRequests: this.requests.length,
      activeConnections: 0,
      poolHits: 0,
      poolMisses: 0,
      timeouts: 0,
      errors: 0,
      averageResponseTime: 0,
    };
  }
}
