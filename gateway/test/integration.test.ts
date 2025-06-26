import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import { MeteringService } from '../src/metering.js';
import { AuthService } from '../src/auth.js';
import { StreamingService } from '../src/streaming.js';
import { DePINRouter } from '../src/depin.js';
import { ethers } from 'ethers';

// Mock fetch globally
global.fetch = vi.fn();

describe('Gateway Integration Tests', () => {
  let fastify: any;
  let baseUrl: string;

  beforeAll(async () => {
    // Create test server instance
    fastify = Fastify({ logger: false });
    
    // Initialize services
    const metering = new MeteringService();
    const auth = new AuthService({
      github: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        redirectUri: 'http://localhost:3002/auth/github/callback'
      },
      jwt: {
        secret: 'test-secret',
        expiresIn: '24h'
      }
    });
    const streaming = new StreamingService();
    const depin = new DePINRouter();

    // Register routes (simplified version of main proxy)
    fastify.get('/health', async () => {
      return { status: 'ok', timestamp: new Date().toISOString() };
    });

    fastify.get('/partners', async () => {
      return metering.getAllPartners();
    });

    fastify.get('/usage/:passportId', async (request: any) => {
      const { passportId } = request.params;
      const { partnerId, since } = request.query;
      
      const sinceTime = since ? parseInt(since) : undefined;
      const usage = metering.getUsage(passportId, partnerId, sinceTime);
      const totalCost = metering.getTotalCost(passportId, partnerId, sinceTime);
      
      return { usage, totalCost };
    });

    fastify.post('/streaming/sessions', async (request: any) => {
      const { passportId, partnerId, totalSize, costPerByte, chunkSize } = request.body;
      const session = streaming.createSession(passportId, partnerId, totalSize, costPerByte, chunkSize);
      return session;
    });

    fastify.get('/depin/nodes', async () => {
      return depin.getAvailableNodes();
    });

    fastify.post('/depin/jobs', async (request: any, reply: any) => {
      const passportId = request.headers['x-passport-id'];
      if (!passportId) {
        return reply.code(401).send({ error: 'Passport ID required' });
      }

      const { model, input, priority } = request.body;

      try {
        const job = await depin.submitInferenceJob(passportId, model, input, priority);
        const record = metering.recordUsage(passportId, 'compute', 0);
        reply.header('x-metering-cost', record.cost);
        return job;
      } catch (error) {
        return reply.code(400).send({ 
          error: error instanceof Error ? error.message : 'Job submission failed' 
        });
      }
    });

    fastify.all('/proxy/:partnerId/*', async (request: any, reply: any) => {
      const { partnerId } = request.params;
      const partnerConfig = metering.getPartnerConfig(partnerId);
      
      if (!partnerConfig) {
        return reply.code(404).send({ error: 'Partner not found' });
      }

      const passportId = request.headers['x-passport-id'];
      if (!passportId) {
        return reply.code(401).send({ error: 'Passport ID required' });
      }

      // Mock successful proxy response
      const mockResponseData = { 
        message: 'Mock API response', 
        partner: partnerId,
        timestamp: new Date().toISOString()
      };
      const responseText = JSON.stringify(mockResponseData);
      const bytes = Buffer.byteLength(responseText, 'utf8');
      
      const record = metering.recordUsage(passportId, partnerId, bytes);
      
      reply.header('x-metering-cost', record.cost);
      reply.header('x-metering-bytes', bytes.toString());
      reply.code(200);
      
      return mockResponseData;
    });

    // Start test server
    const address = await fastify.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = address.replace('[::]', '127.0.0.1');
    
    // Mock external API calls for DePIN tests
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ result: 'test response' })
    });
  });

  afterAll(async () => {
    await fastify.close();
    vi.clearAllMocks();
  });

  describe('Health and Service Discovery', () => {
    it('should return healthy status', async () => {
      const response = await fetch(`${baseUrl}/health`);
      const data = await response.json();
      
      expect(response.ok).toBe(true);
      expect(data.status).toBe('ok');
      expect(data.timestamp).toBeDefined();
    });

    it('should list available partners', async () => {
      const response = await fetch(`${baseUrl}/partners`);
      const partners = await response.json();
      
      expect(response.ok).toBe(true);
      expect(Array.isArray(partners)).toBe(true);
      expect(partners.length).toBeGreaterThan(0);
      
      const partnerIds = partners.map((p: any) => p.id);
      expect(partnerIds).toContain('newswire');
      expect(partnerIds).toContain('github');
      expect(partnerIds).toContain('satellite');
    });

    it('should list available DePIN nodes', async () => {
      const response = await fetch(`${baseUrl}/depin/nodes`);
      const nodes = await response.json();
      
      expect(response.ok).toBe(true);
      expect(Array.isArray(nodes)).toBe(true);
      expect(nodes.length).toBeGreaterThan(0);
      
      nodes.forEach((node: any) => {
        expect(node.id).toBeDefined();
        expect(node.status).toBe('online');
        expect(node.capabilities).toBeDefined();
        expect(node.pricing).toBeDefined();
        expect(node.reputation).toBeDefined();
      });
    });
  });

  describe('Proxy Integration', () => {
    const testPassportId = 'integration-test-passport';

    it('should proxy requests with metering', async () => {
      const response = await fetch(`${baseUrl}/proxy/newswire/test-endpoint`, {
        headers: {
          'X-Passport-ID': testPassportId
        }
      });
      
      const data = await response.json();
      
      expect(response.ok).toBe(true);
      expect(data.partner).toBe('newswire');
      expect(response.headers.get('x-metering-cost')).toBeDefined();
      expect(response.headers.get('x-metering-bytes')).toBeDefined();
    });

    it('should reject requests without passport ID', async () => {
      const response = await fetch(`${baseUrl}/proxy/newswire/test-endpoint`);
      const data = await response.json();
      
      expect(response.status).toBe(401);
      expect(data.error).toBe('Passport ID required');
    });

    it('should reject requests for unknown partners', async () => {
      const response = await fetch(`${baseUrl}/proxy/unknown-partner/test-endpoint`, {
        headers: {
          'X-Passport-ID': testPassportId
        }
      });
      const data = await response.json();
      
      expect(response.status).toBe(404);
      expect(data.error).toBe('Partner not found');
    });

    it('should track usage across multiple requests', async () => {
      // Make several proxy requests
      for (let i = 0; i < 3; i++) {
        await fetch(`${baseUrl}/proxy/github/test-endpoint-${i}`, {
          headers: {
            'X-Passport-ID': testPassportId
          }
        });
      }

      // Check usage
      const usageResponse = await fetch(`${baseUrl}/usage/${testPassportId}?partnerId=github`);
      const usageData = await usageResponse.json();
      
      expect(usageResponse.ok).toBe(true);
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
        chunkSize: 256 * 1024 // 256KB
      };

      const response = await fetch(`${baseUrl}/streaming/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(sessionRequest)
      });

      const session = await response.json();
      
      expect(response.ok).toBe(true);
      expect(session.id).toBeDefined();
      expect(session.passportId).toBe(testPassportId);
      expect(session.partnerId).toBe('satellite');
      expect(session.totalSize).toBe(1024 * 1024);
      expect(session.status).toBe('active');
      expect(BigInt(session.totalCost)).toBeGreaterThan(0n);
    });

    it('should handle large file streaming parameters', async () => {
      const sessionRequest = {
        passportId: testPassportId,
        partnerId: 'satellite',
        totalSize: 100 * 1024 * 1024, // 100MB
        costPerByte: '5000000000' // 5 gwei
      };

      const response = await fetch(`${baseUrl}/streaming/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(sessionRequest)
      });

      const session = await response.json();
      
      expect(response.ok).toBe(true);
      expect(session.totalSize).toBe(100 * 1024 * 1024);
      expect(session.chunkSize).toBe(1024 * 1024); // Default 1MB chunks
      
      const expectedCost = (BigInt(100 * 1024 * 1024) * BigInt('5000000000')).toString();
      expect(session.totalCost).toBe(expectedCost);
    });
  });

  describe('DePIN Integration', () => {
    const testPassportId = 'depin-test-passport';

    it('should submit AI inference job', async () => {
      const jobRequest = {
        model: 'llama2-7b',
        input: {
          prompt: 'What is artificial intelligence?',
          max_tokens: 100
        },
        priority: 'cost'
      };

      const response = await fetch(`${baseUrl}/depin/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Passport-ID': testPassportId
        },
        body: JSON.stringify(jobRequest)
      });

      const job = await response.json();
      
      expect(response.ok).toBe(true);
      expect(job.id).toBeDefined();
      expect(job.passportId).toBe(testPassportId);
      expect(job.model).toBe('llama2-7b');
      expect(job.nodeId).toBeDefined();
      expect(['pending', 'running', 'completed', 'failed']).toContain(job.status);
      expect(BigInt(job.cost)).toBeGreaterThan(0n);
      
      // Should have metering header
      expect(response.headers.get('x-metering-cost')).toBeDefined();
    });

    it('should reject job without passport ID', async () => {
      const jobRequest = {
        model: 'llama2-7b',
        input: { prompt: 'Test' }
      };

      const response = await fetch(`${baseUrl}/depin/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(jobRequest)
      });

      const data = await response.json();
      
      expect(response.status).toBe(401);
      expect(data.error).toBe('Passport ID required');
    });

    it('should handle invalid model requests', async () => {
      const jobRequest = {
        model: 'unknown-model',
        input: { prompt: 'Test' }
      };

      const response = await fetch(`${baseUrl}/depin/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Passport-ID': testPassportId
        },
        body: JSON.stringify(jobRequest)
      });

      const data = await response.json();
      
      expect(response.status).toBe(400);
      expect(data.error).toContain('Model not found');
    });
  });

  describe('Cross-Service Integration', () => {
    const testPassportId = 'cross-service-test';

    it('should track usage across multiple services', async () => {
      // Make requests to different services
      await fetch(`${baseUrl}/proxy/newswire/headlines`, {
        headers: { 'X-Passport-ID': testPassportId }
      });

      await fetch(`${baseUrl}/proxy/github/user`, {
        headers: { 'X-Passport-ID': testPassportId }
      });

      await fetch(`${baseUrl}/depin/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Passport-ID': testPassportId
        },
        body: JSON.stringify({
          model: 'stable-diffusion-xl',
          input: { prompt: 'Generate an image' }
        })
      });

      // Check total usage
      const usageResponse = await fetch(`${baseUrl}/usage/${testPassportId}`);
      const usageData = await usageResponse.json();
      
      expect(usageResponse.ok).toBe(true);
      expect(usageData.usage.length).toBeGreaterThanOrEqual(3);
      
      const partnerIds = usageData.usage.map((u: any) => u.partnerId);
      expect(partnerIds).toContain('newswire');
      expect(partnerIds).toContain('github');
      expect(partnerIds).toContain('compute');
      
      expect(BigInt(usageData.totalCost)).toBeGreaterThan(0n);
    });

    it('should handle concurrent requests safely', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        fetch(`${baseUrl}/proxy/newswire/concurrent-${i}`, {
          headers: { 'X-Passport-ID': `concurrent-${i}` }
        })
      );

      const responses = await Promise.all(promises);
      
      responses.forEach((response, i) => {
        expect(response.ok).toBe(true);
        expect(response.headers.get('x-metering-cost')).toBeDefined();
      });
    });

    it('should maintain data integrity under load', async () => {
      const testId = 'load-test-passport';
      const requestCount = 20;

      // Make many requests quickly
      const promises = Array.from({ length: requestCount }, (_, i) =>
        fetch(`${baseUrl}/proxy/github/load-test-${i}`, {
          headers: { 'X-Passport-ID': testId }
        })
      );

      await Promise.all(promises);

      // Verify all requests were recorded
      const usageResponse = await fetch(`${baseUrl}/usage/${testId}?partnerId=github`);
      const usageData = await usageResponse.json();
      
      expect(usageResponse.ok).toBe(true);
      expect(usageData.usage.length).toBe(requestCount);
      
      // Verify cost calculation is correct
      const individualCosts = usageData.usage.map((u: any) => BigInt(u.cost));
      const calculatedTotal = individualCosts.reduce((sum: bigint, cost: bigint) => sum + cost, 0n);
      
      expect(usageData.totalCost).toBe(calculatedTotal.toString());
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle malformed JSON requests gracefully', async () => {
      const response = await fetch(`${baseUrl}/streaming/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: '{ invalid json }'
      });

      expect(response.status).toBe(400);
    });

    it('should handle missing required parameters', async () => {
      const response = await fetch(`${baseUrl}/streaming/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          passportId: 'test'
          // Missing required fields
        })
      });

      expect(response.status).toBe(500); // Internal server error due to missing fields
    });

    it('should handle extremely large usage queries', async () => {
      const largePassportId = 'large-usage-test';
      
      // Create many usage records
      for (let i = 0; i < 100; i++) {
        await fetch(`${baseUrl}/proxy/newswire/bulk-${i}`, {
          headers: { 'X-Passport-ID': largePassportId }
        });
      }

      const usageResponse = await fetch(`${baseUrl}/usage/${largePassportId}`);
      const usageData = await usageResponse.json();
      
      expect(usageResponse.ok).toBe(true);
      expect(usageData.usage.length).toBe(100);
      expect(BigInt(usageData.totalCost)).toBeGreaterThan(0n);
    });
  });
});