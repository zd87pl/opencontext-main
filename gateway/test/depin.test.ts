import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DePINRouter, USER_AGENT, type ComputeNode } from '../src/depin.js';

// Mock fetch globally
global.fetch = vi.fn();

describe('DePINRouter', () => {
  let depinRouter: DePINRouter;
  const testPassportId = 'test-passport-123';

  beforeEach(() => {
    depinRouter = new DePINRouter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Node Management', () => {
    it('should load sample nodes on initialization', () => {
      const nodes = depinRouter.getAvailableNodes();
      expect(nodes.length).toBeGreaterThan(0);

      const nodeIds = nodes.map((n) => n.id);
      expect(nodeIds).toContain('akash-node-1');
      expect(nodeIds).toContain('gensyn-node-1');
    });

    it('should return only online nodes', () => {
      const nodes = depinRouter.getAvailableNodes();
      nodes.forEach((node) => {
        expect(node.status).toBe('online');
      });
    });

    it('should sort nodes by reputation score', () => {
      const nodes = depinRouter.getAvailableNodes();
      for (let i = 1; i < nodes.length; i++) {
        expect(nodes[i - 1].reputation.score).toBeGreaterThanOrEqual(nodes[i].reputation.score);
      }
    });

    it('should return snapshots that do not alias internal state', () => {
      const [first] = depinRouter.getAvailableNodes();
      first.status = 'offline';
      first.reputation.score = 0;

      const [again] = depinRouter.getAvailableNodes();
      expect(again.id).toBe(first.id);
      expect(again.status).toBe('online');
      expect(again.reputation.score).not.toBe(0);
    });

    it('should register new nodes', () => {
      const newNode: ComputeNode = {
        id: 'test-node-1',
        address: '0x1234567890123456789012345678901234567890',
        endpoint: 'https://test-node.example.com',
        capabilities: {
          gpu: ['NVIDIA RTX 3080'],
          memory: 16,
          vcpus: 8,
          storage: 500,
        },
        pricing: {
          perSecond: '1000000000',
          perGPUHour: '50000000000',
          perGB: '100000000',
        },
        reputation: {
          score: 85,
          totalJobs: 100,
          successRate: 0.95,
        },
        status: 'online',
        lastSeen: Date.now(),
      };

      depinRouter.registerNode(newNode);
      const nodes = depinRouter.getAvailableNodes();

      expect(nodes.some((n) => n.id === 'test-node-1')).toBe(true);
    });

    it('should update node status', () => {
      const nodes = depinRouter.getAvailableNodes();
      const firstNode = nodes[0];

      depinRouter.updateNodeStatus(firstNode.id, 'offline');

      const updatedNodes = depinRouter.getAvailableNodes();
      expect(updatedNodes.some((n) => n.id === firstNode.id)).toBe(false);
    });
  });

  describe('Model Management', () => {
    it('should load sample models on initialization', () => {
      const models = depinRouter.getAvailableModels();
      expect(models.length).toBeGreaterThan(0);

      const modelNames = models.map((m) => m.name);
      expect(modelNames).toContain('llama2-7b');
      expect(modelNames).toContain('stable-diffusion-xl');
    });

    it('should have correct model specifications', () => {
      const models = depinRouter.getAvailableModels();
      const llama = models.find((m) => m.name === 'llama2-7b');

      expect(llama).toBeDefined();
      expect(llama?.requirements.gpuRequired).toBe(true);
      expect(llama?.requirements.minMemory).toBeGreaterThan(0);
      expect(llama?.endpoints.predict).toBe('/v1/completions');
      expect(llama?.endpoints.health).toBe('/health');
    });
  });

  describe('Node Selection', () => {
    it('should find optimal node for cost priority', () => {
      const node = depinRouter.findOptimalNode('llama2-7b', 'cost');
      expect(node).toBeDefined();
      expect(node?.status).toBe('online');
      expect(node?.capabilities.memory).toBeGreaterThanOrEqual(16); // LLaMA requires 16GB
    });

    it('should find optimal node for speed priority', () => {
      const node = depinRouter.findOptimalNode('llama2-7b', 'speed');
      expect(node).toBeDefined();
      expect(node?.status).toBe('online');
    });

    it('should find optimal node for reliability priority', () => {
      const node = depinRouter.findOptimalNode('llama2-7b', 'reliability');
      expect(node).toBeDefined();
      expect(node?.status).toBe('online');
      expect(node?.reputation.score).toBeGreaterThan(0);
    });

    it('should throw for unknown model', () => {
      expect(() => {
        depinRouter.findOptimalNode('unknown-model');
      }).toThrow('Model not found: unknown-model');
    });

    it('should return null when no nodes meet requirements', () => {
      // Update all nodes to be offline
      const nodes = depinRouter.getAvailableNodes();
      nodes.forEach((node) => {
        depinRouter.updateNodeStatus(node.id, 'offline');
      });

      const node = depinRouter.findOptimalNode('llama2-7b');
      expect(node).toBeNull();
    });

    it('should filter nodes by model requirements', () => {
      depinRouter.registerModel({
        name: 'huge-model',
        version: '1.0',
        framework: 'pytorch',
        requirements: {
          minMemory: 1000, // Require 1TB memory
          gpuRequired: true,
          minGpuMemory: 500,
        },
        endpoints: {
          predict: '/predict',
          health: '/health',
        },
      });

      const node = depinRouter.findOptimalNode('huge-model');
      expect(node).toBeNull(); // No nodes should meet this requirement
    });
  });

  describe('Job Execution', () => {
    beforeEach(() => {
      // Mock successful API response
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                text: 'This is a test response from the AI model.',
              },
            ],
          }),
      });
    });

    it('should submit and execute inference job successfully', async () => {
      const job = await depinRouter.submitInferenceJob(
        testPassportId,
        'llama2-7b',
        {
          prompt: 'Test prompt',
          max_tokens: 50,
        },
        'cost'
      );

      expect(job).toBeDefined();
      expect(job.passportId).toBe(testPassportId);
      expect(job.model).toBe('llama2-7b');
      expect(job.status).toBe('completed');
      expect(job.output).toBeDefined();
      expect(job.endTime).toBeDefined();
      expect(BigInt(job.cost)).toBeGreaterThan(0n);
    });

    it('should calculate job cost correctly', async () => {
      const job = await depinRouter.submitInferenceJob(testPassportId, 'llama2-7b', { prompt: 'Test' });

      const node = depinRouter.getAvailableNodes().find((n) => n.id === job.nodeId);
      expect(node).toBeDefined();

      // Cost should be based on estimated runtime (30 seconds)
      const expectedCost = (BigInt(node!.pricing.perSecond) * 30n).toString();
      expect(job.cost).toBe(expectedCost);
    });

    it('should handle job execution failure', async () => {
      // Mock API failure
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const job = await depinRouter.submitInferenceJob(testPassportId, 'llama2-7b', { prompt: 'Test' });

      expect(job.status).toBe('failed');
      expect(job.error).toBeDefined();
      expect(job.endTime).toBeDefined();
    });

    it('should make correct API request to node', async () => {
      await depinRouter.submitInferenceJob(testPassportId, 'llama2-7b', {
        prompt: 'Test prompt',
        max_tokens: 50,
        temperature: 0.7,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/completions'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
            'X-OpenContext-Passport': testPassportId,
          }),
          body: JSON.stringify({
            model: 'llama2-7b',
            prompt: 'Test prompt',
            max_tokens: 50,
            temperature: 0.7,
          }),
        })
      );

      // The sample nodes have no credential, so nothing is sent as Authorization.
      const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(init.headers).not.toHaveProperty('Authorization');
    });

    it('should send the node credential as a bearer token when one is configured', async () => {
      depinRouter.registerNode({
        id: 'private-node',
        address: '0x1234567890123456789012345678901234567890',
        endpoint: 'https://private-node.example.com',
        authToken: 'node-secret',
        capabilities: { gpu: ['NVIDIA A100'], memory: 64, vcpus: 8, storage: 100 },
        pricing: { perSecond: '1', perGPUHour: '1', perGB: '1' }, // cheapest => selected for 'cost'
        reputation: { score: 50, totalJobs: 0, successRate: 0 },
        status: 'online',
        lastSeen: Date.now(),
      });

      const job = await depinRouter.submitInferenceJob(testPassportId, 'llama2-7b', { prompt: 'Test' });
      expect(job.nodeId).toBe('private-node');

      const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(init.headers).toHaveProperty('Authorization', 'Bearer node-secret');
    });

    it('should fail when no nodes are available', async () => {
      await expect(
        depinRouter.submitInferenceJob(testPassportId, 'unknown-model', {})
      ).rejects.toThrow('Model not found: unknown-model');

      depinRouter.getAvailableNodes().forEach((node) => depinRouter.updateNodeStatus(node.id, 'offline'));
      await expect(
        depinRouter.submitInferenceJob(testPassportId, 'llama2-7b', { prompt: 'x' })
      ).rejects.toThrow('No available nodes for model: llama2-7b');
    });

    it('should update node reputation on job completion', async () => {
      // The job goes to the cost-optimal node, which is not necessarily the top-reputation one.
      const targetNode = depinRouter.findOptimalNode('llama2-7b', 'cost')!;
      const initialJobs = targetNode.reputation.totalJobs;
      const initialSuccessRate = targetNode.reputation.successRate;

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(targetNode.lastSeen + 1000);

      const job = await depinRouter.submitInferenceJob(testPassportId, 'llama2-7b', { prompt: 'Test' });
      expect(job.nodeId).toBe(targetNode.id);

      const updatedNode = depinRouter.getAvailableNodes().find((n) => n.id === targetNode.id);
      expect(updatedNode?.reputation.totalJobs).toBe(initialJobs + 1);
      expect(updatedNode?.reputation.successRate).toBeGreaterThan(initialSuccessRate);
      expect(updatedNode?.lastSeen).toBeGreaterThan(targetNode.lastSeen);
    });

    it('should update node reputation on job failure', async () => {
      // Mock API failure
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const targetNode = depinRouter.findOptimalNode('llama2-7b', 'cost')!;
      const initialJobs = targetNode.reputation.totalJobs;

      const job = await depinRouter.submitInferenceJob(testPassportId, 'llama2-7b', { prompt: 'Test' });
      expect(job.nodeId).toBe(targetNode.id);

      const updatedNode = depinRouter.getAvailableNodes().find((n) => n.id === targetNode.id);
      expect(updatedNode?.reputation.totalJobs).toBe(initialJobs + 1);
      expect(updatedNode?.reputation.successRate).toBeLessThan(targetNode.reputation.successRate);
      expect(updatedNode?.reputation.score).toBeLessThanOrEqual(targetNode.reputation.score);
    });
  });

  describe('Job Management', () => {
    let jobId: string;

    beforeEach(async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: 'test' }),
      });

      const job = await depinRouter.submitInferenceJob(testPassportId, 'llama2-7b', { prompt: 'Test' });
      jobId = job.id;
    });

    it('should retrieve job by ID', () => {
      const job = depinRouter.getJob(jobId);
      expect(job).toBeDefined();
      expect(job?.id).toBe(jobId);
      expect(job?.passportId).toBe(testPassportId);
    });

    it('should return undefined for unknown job ID', () => {
      const job = depinRouter.getJob('unknown-job-id');
      expect(job).toBeUndefined();
    });

    it('should get jobs by passport ID', () => {
      const jobs = depinRouter.getJobsByPassport(testPassportId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(jobId);
    });

    it('should return empty array for unknown passport ID', () => {
      const jobs = depinRouter.getJobsByPassport('unknown-passport');
      expect(jobs).toHaveLength(0);
    });

    it('should sort jobs by start time (newest first)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10);

      const job2 = await depinRouter.submitInferenceJob(testPassportId, 'stable-diffusion-xl', {
        prompt: 'Generate image',
      });

      const jobs = depinRouter.getJobsByPassport(testPassportId);
      expect(jobs).toHaveLength(2);
      expect(jobs[0].id).toBe(job2.id); // Newest first
      expect(jobs[1].id).toBe(jobId);
    });
  });

  describe('Cost Calculation', () => {
    it('should calculate job cost correctly', () => {
      const nodes = depinRouter.getAvailableNodes();
      const node = nodes[0];
      const estimatedSeconds = 60;

      const cost = depinRouter.calculateJobCost(node.id, estimatedSeconds);
      const expectedCost = (BigInt(node.pricing.perSecond) * BigInt(estimatedSeconds)).toString();

      expect(cost).toBe(expectedCost);
    });

    it('should throw error for unknown node', () => {
      expect(() => {
        depinRouter.calculateJobCost('unknown-node', 60);
      }).toThrow('Node not found: unknown-node');
    });

    it('should handle zero runtime', () => {
      const nodes = depinRouter.getAvailableNodes();
      const cost = depinRouter.calculateJobCost(nodes[0].id, 0);
      expect(cost).toBe('0');
    });

    it('should handle large runtime values', () => {
      const nodes = depinRouter.getAvailableNodes();
      const largeRuntime = 24 * 60 * 60; // 24 hours
      const cost = depinRouter.calculateJobCost(nodes[0].id, largeRuntime);

      const expectedCost = (BigInt(nodes[0].pricing.perSecond) * BigInt(largeRuntime)).toString();
      expect(cost).toBe(expectedCost);
    });
  });

  describe('Priority-based Node Selection', () => {
    it('should select cheapest node for cost priority', () => {
      const nodes = depinRouter.getAvailableNodes();
      const costOptimal = depinRouter.findOptimalNode('llama2-7b', 'cost');

      // Should select node with lowest per-second cost
      const cheapestNode = nodes.reduce((prev, current) =>
        BigInt(prev.pricing.perSecond) < BigInt(current.pricing.perSecond) ? prev : current
      );

      expect(costOptimal?.id).toBe(cheapestNode.id);
    });

    it('should select fastest node for speed priority', () => {
      const nodes = depinRouter.getAvailableNodes();
      const speedOptimal = depinRouter.findOptimalNode('llama2-7b', 'speed');

      // Should select node with most vCPUs
      const fastestNode = nodes.reduce((prev, current) =>
        prev.capabilities.vcpus > current.capabilities.vcpus ? prev : current
      );

      expect(speedOptimal?.id).toBe(fastestNode.id);
    });

    it('should select most reliable node for reliability priority', () => {
      const nodes = depinRouter.getAvailableNodes();
      const reliabilityOptimal = depinRouter.findOptimalNode('llama2-7b', 'reliability');

      // Should select node with highest reputation score
      const mostReliableNode = nodes.reduce((prev, current) =>
        prev.reputation.score > current.reputation.score ? prev : current
      );

      expect(reliabilityOptimal?.id).toBe(mostReliableNode.id);
    });
  });

  describe('Network and Error Handling', () => {
    it('should handle network timeouts', async () => {
      // Mock network timeout
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network timeout'));

      const job = await depinRouter.submitInferenceJob(testPassportId, 'llama2-7b', { prompt: 'Test' });

      expect(job.status).toBe('failed');
      expect(job.error).toContain('Network timeout');
    });

    it('should handle malformed responses', async () => {
      // Mock malformed JSON response
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error('Invalid JSON')),
      });

      const job = await depinRouter.submitInferenceJob(testPassportId, 'llama2-7b', { prompt: 'Test' });

      expect(job.status).toBe('failed');
      expect(job.error).toContain('Invalid JSON');
    });
  });
});
