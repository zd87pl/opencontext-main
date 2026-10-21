/**
 * End-to-end tests against the real application (`createApp`), driven through Fastify's
 * `inject` so no port is bound. The only fakes are at the network edge: the upstream partner
 * client (so `/proxy` never leaves the process) and `fetch` for DePIN node calls.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createApp } from '../src/app.js';
import { MeteringService } from '../src/metering.js';
import { StreamingService } from '../src/streaming.js';
import { DePINRouter } from '../src/depin.js';
import { BillingService } from '../src/billing.js';
import { AuthService } from '../src/auth.js';
import { MemoryStorage } from '../src/storage.js';
import type { MeteringRecord, PartnerConfig, StreamingSession } from '../src/types.js';
import type { ComputeNode, InferenceJob } from '../src/depin.js';
import { FakeUpstream } from './helpers.js';

// DePIN node calls go through global fetch; the app's own requests go through `inject`.
global.fetch = vi.fn();

describe('Gateway Integration Tests', () => {
  let app: FastifyInstance;
  let upstream: FakeUpstream;
  let metering: MeteringService;

  const api = (options: InjectOptions) => app.inject(options);
  const get = (url: string, headers: Record<string, string> = {}) => api({ method: 'GET', url, headers });
  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    api({ method: 'POST', url, payload: payload as InjectOptions['payload'], headers });

  beforeAll(async () => {
    const storage = new MemoryStorage();
    upstream = new FakeUpstream();
    metering = new MeteringService({ storage });

    app = await createApp({
      services: {
        metering,
        streaming: new StreamingService({ storage }),
        depin: new DePINRouter(),
        billing: new BillingService({ storage, flowReader: { getFlowrate: async () => 0n } }),
        auth: new AuthService(),
        upstream,
      },
      ipRateLimit: false,
      passportRateLimit: false,
      credentials: {},
    });
    await app.ready();

    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: 'test response' }),
    });
  });

  afterAll(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  describe('Health and Service Discovery', () => {
    it('should return healthy status', async () => {
      const response = await get('/health');
      const data = response.json<{ status: string; timestamp: string; storage: string }>();

      expect(response.statusCode).toBe(200);
      expect(data.status).toBe('ok');
      expect(data.timestamp).toBeDefined();
      expect(data.storage).toBe('memory');
    });

    it('should list available partners', async () => {
      const response = await get('/partners');
      const partners = response.json<Array<PartnerConfig & { proxyable: boolean }>>();

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(partners)).toBe(true);
      expect(partners.length).toBeGreaterThan(0);

      const partnerIds = partners.map((p) => p.id);
      expect(partnerIds).toContain('newswire');
      expect(partnerIds).toContain('github');
      expect(partnerIds).toContain('satellite');
      expect(partners.find((p) => p.id === 'compute')?.proxyable).toBe(false);
      expect(partners.find((p) => p.id === 'github')?.proxyable).toBe(true);
      // Credential env var names are not exposed.
      expect(JSON.stringify(partners)).not.toContain('envVar');
    });

    it('should list available DePIN nodes', async () => {
      const response = await get('/depin/nodes');
      const nodes = response.json<ComputeNode[]>();

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(nodes)).toBe(true);
      expect(nodes.length).toBeGreaterThan(0);

      nodes.forEach((node) => {
        expect(node.id).toBeDefined();
        expect(node.status).toBe('online');
        expect(node.capabilities).toBeDefined();
        expect(node.pricing).toBeDefined();
        expect(node.reputation).toBeDefined();
      });
    });

    it('should expose stats', async () => {
      const response = await get('/stats');
      const stats = response.json<{ upstream: { totalRequests: number }; streaming: { totalSessions: number } }>();
      expect(response.statusCode).toBe(200);
      expect(typeof stats.upstream.totalRequests).toBe('number');
      expect(typeof stats.streaming.totalSessions).toBe('number');
    });
  });

  describe('Proxy Integration', () => {
    const testPassportId = 'integration-test-passport';

    it('should proxy requests with metering', async () => {
      const response = await get('/proxy/newswire/test-endpoint?q=ai', { 'X-Passport-ID': testPassportId });
      const data = response.json<{ message: string; host: string; path: string; query: string }>();

      expect(response.statusCode).toBe(200);
      expect(data.message).toBe('Mock API response');
      expect(data.host).toBe('newsapi.org');
      expect(data.path).toBe('/v2/test-endpoint');
      expect(data.query).toBe('?q=ai');
      expect(response.headers['x-metering-cost']).toBeDefined();
      expect(response.headers['x-metering-bytes']).toBe(String(response.rawPayload.length));
      expect(response.headers['x-response-time']).toMatch(/^\d+ms$/);

      const forwarded = upstream.requests.at(-1)!;
      expect(forwarded.url).toBe('https://newsapi.org/v2/test-endpoint?q=ai');
      expect(forwarded.headers?.['x-passport-id']).toBeUndefined();
      expect(forwarded.headers?.['user-agent']).toMatch(/^OpenContext-Gateway/);
    });

    it('should reject requests without passport ID', async () => {
      const response = await get('/proxy/newswire/test-endpoint');
      const data = response.json<{ error: string; message: string }>();

      expect(response.statusCode).toBe(401);
      expect(data.error).toBe('Authentication Failed');
      expect(data.message).toContain('Passport ID required');
    });

    it('should reject requests for unknown partners', async () => {
      const response = await get('/proxy/unknown-partner/test-endpoint', { 'X-Passport-ID': testPassportId });
      const data = response.json<{ error: string; message: string }>();

      expect(response.statusCode).toBe(404);
      expect(data.error).toBe('Not Found');
      expect(data.message).toBe('Partner not found: unknown-partner');
    });

    it('should refuse to proxy to partners that are not reachable over HTTP', async () => {
      const response = await get('/proxy/compute/anything', { 'X-Passport-ID': testPassportId });
      expect(response.statusCode).toBe(404);
      expect(response.json<{ message: string }>().message).toContain('not reachable');
    });

    it('should track usage across multiple requests', async () => {
      // Make several proxy requests
      for (let i = 0; i < 3; i++) {
        await get(`/proxy/github/test-endpoint-${i}`, { 'X-Passport-ID': testPassportId });
      }

      // Check usage
      const usageResponse = await get(`/usage/${testPassportId}?partnerId=github`);
      const usageData = usageResponse.json<{ usage: MeteringRecord[]; totalCost: string }>();

      expect(usageResponse.statusCode).toBe(200);
      expect(usageData.usage.length).toBeGreaterThanOrEqual(3);
      expect(BigInt(usageData.totalCost)).toBeGreaterThan(0n);
    });
  });

  describe('Streaming Integration', () => {
    const testPassportId = 'streaming-test-passport';

    it('should create streaming session', async () => {
      const sessionRequest = {
        passportId: testPassportId,
        partnerId: 'satellite',
        totalSize: 1024 * 1024, // 1MB
        costPerByte: '10000000000', // 10 gwei
        chunkSize: 256 * 1024, // 256KB
      };

      const response = await post('/streaming/sessions', sessionRequest);
      const session = response.json<StreamingSession>();

      expect(response.statusCode).toBe(201);
      expect(session.id).toBeDefined();
      expect(session.passportId).toBe(testPassportId);
      expect(session.partnerId).toBe('satellite');
      expect(session.totalSize).toBe(1024 * 1024);
      expect(session.status).toBe('active');
      expect(BigInt(session.totalCost)).toBeGreaterThan(0n);

      const fetched = await get(`/streaming/sessions/${session.id}`);
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json<StreamingSession>().id).toBe(session.id);
    });

    it('should handle large file streaming parameters', async () => {
      const sessionRequest = {
        passportId: testPassportId,
        partnerId: 'satellite',
        totalSize: 100 * 1024 * 1024, // 100MB
        costPerByte: '5000000000', // 5 gwei
      };

      const response = await post('/streaming/sessions', sessionRequest);
      const session = response.json<StreamingSession>();

      expect(response.statusCode).toBe(201);
      expect(session.totalSize).toBe(100 * 1024 * 1024);
      expect(session.chunkSize).toBe(1024 * 1024); // Default 1MB chunks

      const expectedCost = (BigInt(100 * 1024 * 1024) * BigInt('5000000000')).toString();
      expect(session.totalCost).toBe(expectedCost);
    });

    it('should return 404 for unknown sessions', async () => {
      const response = await get('/streaming/sessions/nope');
      expect(response.statusCode).toBe(404);
    });
  });

  describe('DePIN Integration', () => {
    const testPassportId = 'depin-test-passport';

    it('should submit AI inference job', async () => {
      const jobRequest = {
        model: 'llama2-7b',
        input: {
          prompt: 'What is artificial intelligence?',
          max_tokens: 100,
        },
        priority: 'cost',
      };

      const response = await post('/depin/jobs', jobRequest, { 'X-Passport-ID': testPassportId });
      const job = response.json<InferenceJob>();

      expect(response.statusCode).toBe(201);
      expect(job.id).toBeDefined();
      expect(job.passportId).toBe(testPassportId);
      expect(job.model).toBe('llama2-7b');
      expect(job.nodeId).toBeDefined();
      expect(job.status).toBe('completed');
      expect(BigInt(job.cost)).toBeGreaterThan(0n);

      // Should have metering header
      expect(response.headers['x-metering-cost']).toBeDefined();

      const fetched = await get(`/depin/jobs/${job.id}`);
      expect(fetched.statusCode).toBe(200);
      const listed = await get('/depin/jobs', { 'X-Passport-ID': testPassportId });
      expect(listed.json<InferenceJob[]>().map((j) => j.id)).toContain(job.id);
    });

    it('should reject job without passport ID', async () => {
      const jobRequest = {
        model: 'llama2-7b',
        input: { prompt: 'Test' },
      };

      const response = await post('/depin/jobs', jobRequest);
      const data = response.json<{ error: string; message: string }>();

      expect(response.statusCode).toBe(401);
      expect(data.message).toContain('Passport ID required');
    });

    it('should handle invalid model requests', async () => {
      const jobRequest = {
        model: 'unknown-model',
        input: { prompt: 'Test' },
      };

      const response = await post('/depin/jobs', jobRequest, { 'X-Passport-ID': testPassportId });
      const data = response.json<{ error: string; message: string }>();

      expect(response.statusCode).toBe(400);
      expect(data.message).toContain('Model not found');
    });

    it('should not bill a job the node failed to run', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });
      const before = await metering.getTotals('unlucky-passport', 'compute');

      const response = await post(
        '/depin/jobs',
        { model: 'llama2-7b', input: { prompt: 'Test' } },
        { 'X-Passport-ID': 'unlucky-passport' }
      );

      expect(response.statusCode).toBe(502);
      expect(response.json<InferenceJob>().status).toBe('failed');
      expect(response.headers['x-metering-cost']).toBeUndefined();
      expect(await metering.getTotals('unlucky-passport', 'compute')).toEqual(before);
    });
  });

  describe('Cross-Service Integration', () => {
    const testPassportId = 'cross-service-test';

    it('should track usage across multiple services', async () => {
      // Make requests to different services
      await get('/proxy/newswire/headlines', { 'X-Passport-ID': testPassportId });
      await get('/proxy/github/user', { 'X-Passport-ID': testPassportId });
      await post(
        '/depin/jobs',
        { model: 'stable-diffusion-xl', input: { prompt: 'Generate an image' } },
        { 'X-Passport-ID': testPassportId }
      );

      // Check total usage
      const usageResponse = await get(`/usage/${testPassportId}`);
      const usageData = usageResponse.json<{ usage: MeteringRecord[]; totalCost: string }>();

      expect(usageResponse.statusCode).toBe(200);
      expect(usageData.usage.length).toBeGreaterThanOrEqual(3);

      const partnerIds = usageData.usage.map((u) => u.partnerId);
      expect(partnerIds).toContain('newswire');
      expect(partnerIds).toContain('github');
      expect(partnerIds).toContain('compute');

      expect(BigInt(usageData.totalCost)).toBeGreaterThan(0n);
    });

    it('should handle concurrent requests safely', async () => {
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          get(`/proxy/newswire/concurrent-${i}`, { 'X-Passport-ID': `concurrent-${i}` })
        )
      );

      responses.forEach((response) => {
        expect(response.statusCode).toBe(200);
        expect(response.headers['x-metering-cost']).toBeDefined();
      });
    });

    it('should maintain data integrity under load', async () => {
      const testId = 'load-test-passport';
      const requestCount = 20;

      // Make many requests quickly
      await Promise.all(
        Array.from({ length: requestCount }, (_, i) =>
          get(`/proxy/github/load-test-${i}`, { 'X-Passport-ID': testId })
        )
      );

      // Verify all requests were recorded
      const usageResponse = await get(`/usage/${testId}?partnerId=github`);
      const usageData = usageResponse.json<{ usage: MeteringRecord[]; totalCost: string }>();

      expect(usageResponse.statusCode).toBe(200);
      expect(usageData.usage.length).toBe(requestCount);

      // Verify cost calculation is correct
      const individualCosts = usageData.usage.map((u) => BigInt(u.cost));
      const calculatedTotal = individualCosts.reduce((sum, cost) => sum + cost, 0n);

      expect(usageData.totalCost).toBe(calculatedTotal.toString());
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle malformed JSON requests gracefully', async () => {
      const response = await api({
        method: 'POST',
        url: '/streaming/sessions',
        headers: { 'Content-Type': 'application/json' },
        payload: '{ invalid json }',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toBe('Bad Request');
    });

    it('should reject requests with missing required parameters', async () => {
      const response = await post('/streaming/sessions', { passportId: 'test' });
      const data = response.json<{ error: string; issues: Array<{ field: string }> }>();

      // Input validation is a client error, not a server error.
      expect(response.statusCode).toBe(400);
      expect(data.error).toBe('Validation Failed');
      expect(data.issues.map((issue) => issue.field)).toEqual(
        expect.arrayContaining(['partnerId', 'totalSize', 'costPerByte'])
      );
    });

    it('should return JSON for unknown routes', async () => {
      const response = await get('/nope');
      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: string }>().error).toBe('Not Found');
    });

    it('should handle extremely large usage queries', async () => {
      const largePassportId = 'large-usage-test';

      // Create many usage records
      for (let i = 0; i < 100; i++) {
        await get(`/proxy/newswire/bulk-${i}`, { 'X-Passport-ID': largePassportId });
      }

      const usageResponse = await get(`/usage/${largePassportId}`);
      const usageData = usageResponse.json<{ usage: MeteringRecord[]; totalCost: string }>();

      expect(usageResponse.statusCode).toBe(200);
      expect(usageData.usage.length).toBe(100);
      expect(BigInt(usageData.totalCost)).toBeGreaterThan(0n);
    });
  });
});
