import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { ethers } from 'ethers';

// Mock external APIs
global.fetch = vi.fn();

describe('End-to-End Integration Tests', () => {
  let gatewayProcess: ChildProcess;
  const gatewayUrl = 'http://localhost:3002'; // Use different port for tests
  const testWallet = ethers.Wallet.createRandom();
  const testPassportId = `test-passport-${Date.now()}`;

  beforeAll(async () => {
    // Start gateway server for testing
    gatewayProcess = spawn('npm', ['run', 'start'], {
      cwd: 'gateway',
      env: {
        ...process.env,
        PORT: '3002',
        NODE_ENV: 'test',
        JWT_SECRET: 'test-secret-for-integration-tests-12345',
        GITHUB_CLIENT_ID: 'test-github-client-id',
        GITHUB_CLIENT_SECRET: 'test-github-client-secret',
        MOCK_EXTERNAL_APIS: 'true',
        SKIP_RATE_LIMITING: 'true',
      },
      stdio: 'pipe',
    });

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Mock external API responses
    (global.fetch as any).mockImplementation((url: string, options?: any) => {
      if (url.includes('github.com/login/oauth/access_token')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ access_token: 'test-token' }),
        });
      }
      
      if (url.includes('api.github.com/user')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: 12345,
            login: 'testuser',
            name: 'Test User',
            email: 'test@example.com',
            avatar_url: 'https://github.com/test.png',
          }),
        });
      }

      if (url.includes('newsapi.org')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({
            status: 'ok',
            totalResults: 1,
            articles: [
              {
                source: { id: 'test', name: 'Test News' },
                title: 'Test Article',
                description: 'Test Description',
                url: 'https://test.com/article',
                publishedAt: new Date().toISOString(),
              },
            ],
          })),
          headers: new Map([['content-type', 'application/json']]),
        });
      }

      // Default mock response
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve('{"status": "ok"}'),
        json: () => Promise.resolve({ status: 'ok' }),
        headers: new Map([['content-type', 'application/json']]),
      });
    });
  }, 10000);

  afterAll(async () => {
    if (gatewayProcess) {
      gatewayProcess.kill();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  });

  describe('Health and Service Discovery', () => {
    it('should return healthy status', async () => {
      const response = await fetch(`${gatewayUrl}/health`);
      expect(response.ok).toBe(true);
      
      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.timestamp).toBeDefined();
    });

    it('should list available partners', async () => {
      const response = await fetch(`${gatewayUrl}/partners`);
      expect(response.ok).toBe(true);
      
      const partners = await response.json();
      expect(Array.isArray(partners)).toBe(true);
      expect(partners.length).toBeGreaterThan(0);
      
      const partnerIds = partners.map((p: any) => p.id);
      expect(partnerIds).toContain('newswire');
      expect(partnerIds).toContain('github');
      expect(partnerIds).toContain('satellite');
    });

    it('should list available DePIN nodes', async () => {
      const response = await fetch(`${gatewayUrl}/depin/nodes`);
      expect(response.ok).toBe(true);
      
      const nodes = await response.json();
      expect(Array.isArray(nodes)).toBe(true);
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('should list available AI models', async () => {
      const response = await fetch(`${gatewayUrl}/depin/models`);
      expect(response.ok).toBe(true);
      
      const models = await response.json();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });
  });

  describe('API Proxy and Metering', () => {
    it('should proxy requests with proper metering', async () => {
      const response = await fetch(`${gatewayUrl}/proxy/newswire/top-headlines?country=us`, {
        headers: {
          'X-Passport-ID': testPassportId,
        },
      });

      expect(response.ok).toBe(true);
      expect(response.headers.get('x-metering-cost')).toBeDefined();
      expect(response.headers.get('x-metering-bytes')).toBeDefined();
      expect(response.headers.get('x-response-time')).toBeDefined();

      const data = await response.json();
      expect(data).toBeDefined();
    });

    it('should track usage across multiple requests', async () => {
      // Make several requests
      for (let i = 0; i < 3; i++) {
        await fetch(`${gatewayUrl}/proxy/github/user`, {
          headers: {
            'X-Passport-ID': testPassportId,
          },
        });
      }

      // Check usage
      const usageResponse = await fetch(`${gatewayUrl}/usage/${testPassportId}?partnerId=github`);
      expect(usageResponse.ok).toBe(true);

      const usageData = await usageResponse.json();
      expect(usageData.usage.length).toBeGreaterThanOrEqual(3);
      expect(parseInt(usageData.totalCost)).toBeGreaterThan(0);
    });

    it('should reject requests without passport ID', async () => {
      const response = await fetch(`${gatewayUrl}/proxy/newswire/test`);
      expect(response.status).toBe(401);

      const error = await response.json();
      expect(error.error).toBe('Authentication Failed');
    });

    it('should reject requests for unknown partners', async () => {
      const response = await fetch(`${gatewayUrl}/proxy/unknown-partner/test`, {
        headers: {
          'X-Passport-ID': testPassportId,
        },
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toBe('Validation Failed');
    });
  });

  describe('Streaming Sessions', () => {
    it('should create streaming session', async () => {
      const sessionRequest = {
        passportId: testPassportId,
        partnerId: 'satellite',
        totalSize: 1024 * 1024, // 1MB
        costPerByte: '10000000000', // 10 gwei
        chunkSize: 256 * 1024, // 256KB
      };

      const response = await fetch(`${gatewayUrl}/streaming/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sessionRequest),
      });

      expect(response.ok).toBe(true);
      const session = await response.json();

      expect(session.id).toBeDefined();
      expect(session.passportId).toBe(testPassportId);
      expect(session.partnerId).toBe('satellite');
      expect(session.status).toBe('active');
    });

    it('should validate streaming session parameters', async () => {
      const invalidRequest = {
        passportId: '', // Invalid empty passport ID
        partnerId: 'satellite',
        totalSize: -1, // Invalid negative size
        costPerByte: 'invalid', // Invalid cost format
      };

      const response = await fetch(`${gatewayUrl}/streaming/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(invalidRequest),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toBe('Validation Failed');
      expect(error.issues).toBeDefined();
    });
  });

  describe('DePIN Compute Jobs', () => {
    it('should submit AI inference job', async () => {
      const jobRequest = {
        model: 'llama2-7b',
        input: {
          prompt: 'What is artificial intelligence?',
          max_tokens: 100,
        },
        priority: 'cost',
      };

      const response = await fetch(`${gatewayUrl}/depin/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Passport-ID': testPassportId,
        },
        body: JSON.stringify(jobRequest),
      });

      expect(response.ok).toBe(true);
      expect(response.headers.get('x-metering-cost')).toBeDefined();

      const job = await response.json();
      expect(job.id).toBeDefined();
      expect(job.passportId).toBe(testPassportId);
      expect(job.model).toBe('llama2-7b');
      expect(['pending', 'running', 'completed', 'failed']).toContain(job.status);
    });

    it('should reject job without passport ID', async () => {
      const jobRequest = {
        model: 'llama2-7b',
        input: { prompt: 'Test' },
      };

      const response = await fetch(`${gatewayUrl}/depin/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(jobRequest),
      });

      expect(response.status).toBe(401);
      const error = await response.json();
      expect(error.error).toBe('Authentication Failed');
    });

    it('should handle invalid model requests', async () => {
      const jobRequest = {
        model: 'unknown-model',
        input: { prompt: 'Test' },
      };

      const response = await fetch(`${gatewayUrl}/depin/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Passport-ID': testPassportId,
        },
        body: JSON.stringify(jobRequest),
      });

      expect(response.status).toBe(400);
      const error = await response.json();
      expect(error.error).toBe('Validation Failed');
    });
  });

  describe('Cross-Service Integration', () => {
    it('should track usage across multiple services', async () => {
      const testPassport = `integration-test-${Date.now()}`;

      // Make requests to different services
      await fetch(`${gatewayUrl}/proxy/newswire/headlines`, {
        headers: { 'X-Passport-ID': testPassport },
      });

      await fetch(`${gatewayUrl}/proxy/github/user`, {
        headers: { 'X-Passport-ID': testPassport },
      });

      await fetch(`${gatewayUrl}/depin/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Passport-ID': testPassport,
        },
        body: JSON.stringify({
          model: 'stable-diffusion-xl',
          input: { prompt: 'Generate an image' },
        }),
      });

      // Check total usage
      const usageResponse = await fetch(`${gatewayUrl}/usage/${testPassport}`);
      expect(usageResponse.ok).toBe(true);

      const usageData = await usageResponse.json();
      expect(usageData.usage.length).toBeGreaterThanOrEqual(3);

      const partnerIds = usageData.usage.map((u: any) => u.partnerId);
      expect(partnerIds).toContain('newswire');
      expect(partnerIds).toContain('github');
      expect(partnerIds).toContain('compute');
    });

    it('should handle concurrent requests safely', async () => {
      const concurrentPassport = `concurrent-test-${Date.now()}`;
      const requestCount = 10;

      const promises = Array.from({ length: requestCount }, (_, i) =>
        fetch(`${gatewayUrl}/proxy/newswire/concurrent-${i}`, {
          headers: { 'X-Passport-ID': concurrentPassport },
        })
      );

      const responses = await Promise.all(promises);

      responses.forEach((response, i) => {
        expect(response.ok).toBe(true);
        expect(response.headers.get('x-metering-cost')).toBeDefined();
      });

      // Verify all requests were recorded
      const usageResponse = await fetch(`${gatewayUrl}/usage/${concurrentPassport}`);
      const usageData = await usageResponse.json();
      expect(usageData.usage.length).toBe(requestCount);
    });
  });

  describe('Error Handling and Validation', () => {
    it('should handle malformed JSON requests', async () => {
      const response = await fetch(`${gatewayUrl}/streaming/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: '{ invalid json }',
      });

      expect(response.status).toBe(400);
    });

    it('should return structured error responses', async () => {
      const response = await fetch(`${gatewayUrl}/proxy/unknown/test`, {
        headers: {
          'X-Passport-ID': 'test',
        },
      });

      expect(response.status).toBe(400);
      const error = await response.json();

      expect(error.error).toBeDefined();
      expect(error.message).toBeDefined();
      expect(error.timestamp).toBeDefined();
      expect(error.requestId).toBeDefined();
    });

    it('should validate passport ID format', async () => {
      const response = await fetch(`${gatewayUrl}/usage/invalid-passport-format`);
      expect(response.status).toBe(400);

      const error = await response.json();
      expect(error.error).toBe('Validation Failed');
    });

    it('should handle request timeouts gracefully', async () => {
      // Mock a slow external API
      (global.fetch as any).mockImplementationOnce(
        () => new Promise(resolve => setTimeout(resolve, 35000)) // Longer than 30s timeout
      );

      const response = await fetch(`${gatewayUrl}/proxy/newswire/slow-endpoint`, {
        headers: {
          'X-Passport-ID': testPassportId,
        },
      });

      expect(response.status).toBe(408);
      const error = await response.json();
      expect(error.error).toBe('External Service Error');
      expect(error.message).toContain('timeout');
    });
  });

  describe('Security Headers and CORS', () => {
    it('should include security headers', async () => {
      const response = await fetch(`${gatewayUrl}/health`);
      
      // Check for basic security headers (helmet adds these)
      expect(response.headers.get('x-frame-options')).toBeDefined();
      expect(response.headers.get('x-content-type-options')).toBeDefined();
    });

    it('should handle OPTIONS requests for CORS', async () => {
      const response = await fetch(`${gatewayUrl}/health`, {
        method: 'OPTIONS',
      });

      expect(response.ok).toBe(true);
      expect(response.headers.get('access-control-allow-origin')).toBeDefined();
      expect(response.headers.get('access-control-allow-methods')).toBeDefined();
    });
  });
});