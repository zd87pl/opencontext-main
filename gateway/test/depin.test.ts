import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DePINRouter } from '../src/depin.js';

// Mock fetch globally
global.fetch = vi.fn();

describe('DePINRouter', () => {
  let depinRouter: DePINRouter;
  const testPassportId = 'test-passport-123';

  beforeEach(() => {
    depinRouter = new DePINRouter();
    vi.clearAllMocks();
  });

  describe('Node Management', () => {
    it('should load sample nodes on initialization', () => {
      const nodes = depinRouter.getAvailableNodes();
      expect(nodes.length).toBeGreaterThan(0);
      
      const nodeIds = nodes.map(n => n.id);
      expect(nodeIds).toContain('akash-node-1');
      expect(nodeIds).toContain('gensyn-node-1');
    });

    it('should return only online nodes', () => {
      const nodes = depinRouter.getAvailableNodes();
      nodes.forEach(node => {
        expect(node.status).toBe('online');
      });
    });

    it('should sort nodes by reputation score', () => {
      const nodes = depinRouter.getAvailableNodes();
      for (let i = 1; i < nodes.length; i++) {
        expect(nodes[i-1].reputation.score).toBeGreaterThanOrEqual(nodes[i].reputation.score);
      }
    });

    it('should register new nodes', () => {
      const newNode = {
        id: 'test-node-1',
        address: '0x1234567890123456789012345678901234567890',
        endpoint: 'https://test-node.example.com',
        capabilities: {
          gpu: ['NVIDIA RTX 3080'],
          memory: 16,
          vcpus: 8,
          storage: 500
        },
        pricing: {
          perSecond: '1000000000',
          perGPUHour: '50000000000',
          perGB: '100000000'
        },
        reputation: {
          score: 85,
          totalJobs: 100,
          successRate: 0.95
        },
        status: 'online' as const,
        lastSeen: Date.now()
      };

      depinRouter.registerNode(newNode);
      const nodes = depinRouter.getAvailableNodes();
      
      expect(nodes.some(n => n.id === 'test-node-1')).toBe(true);
    });

    it('should update node status', () => {
      const nodes = depinRouter.getAvailableNodes();
      const firstNode = nodes[0];
      
      depinRouter.updateNodeStatus(firstNode.id, 'offline');
      
      const updatedNodes = depinRouter.getAvailableNodes();
      expect(updatedNodes.some(n => n.id === firstNode.id)).toBe(false);
    });
  });

  describe('Model Management', () => {
    it('should load sample models on initialization', () => {
      const models = depinRouter.getAvailableModels();
      expect(models.length).toBeGreaterThan(0);
      
      const modelNames = models.map(m => m.name);
      expect(modelNames).toContain('llama2-7b');
      expect(modelNames).toContain('stable-diffusion-xl');
    });

    it('should have correct model specifications', () => {
      const models = depinRouter.getAvailableModels();
      const llama = models.find(m => m.name === 'llama2-7b');
      
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

    it('should return null for unknown model', () => {
      expect(() => {
        depinRouter.findOptimalNode('unknown-model');
      }).toThrow('Model not found: unknown-model');
    });

    it('should return null when no nodes meet requirements', () => {
      // Update all nodes to be offline
      const nodes = depinRouter.getAvailableNodes();
      nodes.forEach(node => {
        depinRouter.updateNodeStatus(node.id, 'offline');
      });

      const node = depinRouter.findOptimalNode('llama2-7b');
      expect(node).toBeNull();
    });

    it('should filter nodes by model requirements', () => {
      const models = depinRouter.getAvailableModels();
      const highMemoryModel = {
        name: 'huge-model',
        version: '1.0',
        framework: 'pytorch' as const,
        requirements: {
          minMemory: 1000, // Require 1TB memory
          gpuRequired: true,
          minGpuMemory: 500
        },
        endpoints: {
          predict: '/predict',
          health: '/health'
        }
      };

      // Temporarily add the model
      (depinRouter as any).models.set('huge-model', highMemoryModel);

      const node = depinRouter.findOptimalNode('huge-model');
      expect(node).toBeNull(); // No nodes should meet this requirement
    });
  });

  describe('Job Execution', () => {
    beforeEach(() => {
      // Mock successful API response
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            text: 'This is a test response from the AI model.'
          }]
        })
      });
    });

    it('should submit and execute inference job successfully', async () => {
      const job = await depinRouter.submitInferenceJob(
        testPassportId,
        'llama2-7b',
        {
          prompt: 'Test prompt',
          max_tokens: 50
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
      const job = await depinRouter.submitInferenceJob(
        testPassportId,
        'llama2-7b',
        { prompt: 'Test' }
      );

      const node = depinRouter.getAvailableNodes().find(n => n.id === job.nodeId);
      expect(node).toBeDefined();
      
      // Cost should be based on estimated runtime (30 seconds)
      const expectedCost = (BigInt(node!.pricing.perSecond) * 30n).toString();
      expect(job.cost).toBe(expectedCost);
    });

    it('should handle job execution failure', async () => {
      // Mock API failure
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });

      const job = await depinRouter.submitInferenceJob(
        testPassportId,
        'llama2-7b',
        { prompt: 'Test' }
      );

      expect(job.status).toBe('failed');
      expect(job.error).toBeDefined();
      expect(job.endTime).toBeDefined();
    });

    it('should make correct API request to node', async () => {
      await depinRouter.submitInferenceJob(
        testPassportId,
        'llama2-7b',
        {
          prompt: 'Test prompt',
          max_tokens: 50,
          temperature: 0.7
        }
      );

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/v1/completions'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': expect.stringMatching(/^Bearer 0x/),
            'User-Agent': undefined // Node doesn't set user agent in our mock
          }),
          body: JSON.stringify({
            model: 'llama2-7b',
            prompt: 'Test prompt',
            max_tokens: 50,
            temperature: 0.7
          })
        })
      );
    });

    it('should fail when no nodes are available', async () => {
      await expect(
        depinRouter.submitInferenceJob(testPassportId, 'unknown-model', {})
      ).rejects.toThrow('Model not found: unknown-model');
    });

    it('should update node reputation on job completion', async () => {
      const nodesBefore = depinRouter.getAvailableNodes();
      const targetNode = nodesBefore[0];
      const initialJobs = targetNode.reputation.totalJobs;
      const initialSuccessRate = targetNode.reputation.successRate;

      await depinRouter.submitInferenceJob(
        testPassportId,
        'llama2-7b',
        { prompt: 'Test' }
      );

      const nodesAfter = depinRouter.getAvailableNodes();
      const updatedNode = nodesAfter.find(n => n.id === targetNode.id);

      expect(updatedNode?.reputation.totalJobs).toBe(initialJobs + 1);
      expect(updatedNode?.lastSeen).toBeGreaterThan(targetNode.lastSeen);
    });

    it('should update node reputation on job failure', async () => {
      // Mock API failure
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });

      const nodesBefore = depinRouter.getAvailableNodes();
      const targetNode = nodesBefore[0];
      const initialJobs = targetNode.reputation.totalJobs;

      await depinRouter.submitInferenceJob(
        testPassportId,
        'llama2-7b',
        { prompt: 'Test' }
      );

      const nodesAfter = depinRouter.getAvailableNodes();
      const updatedNode = nodesAfter.find(n => n.id === targetNode.id);

      expect(updatedNode?.reputation.totalJobs).toBe(initialJobs + 1);
      expect(updatedNode?.reputation.successRate).toBeLessThan(targetNode.reputation.successRate);
    });
  });

  describe('Job Management', () => {
    let jobId: string;

    beforeEach(async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: 'test' })
      });

      const job = await depinRouter.submitInferenceJob(
        testPassportId,
        'llama2-7b',
        { prompt: 'Test' }
      );
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
      // Add another job with slight delay
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const job2 = await depinRouter.submitInferenceJob(
        testPassportId,
        'stable-diffusion-xl',
        { prompt: 'Generate image' }
      );

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
        parseInt(prev.pricing.perSecond) < parseInt(current.pricing.perSecond) ? prev : current
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
      (global.fetch as any).mockRejectedValue(new Error('Network timeout'));

      const job = await depinRouter.submitInferenceJob(
        testPassportId,
        'llama2-7b',
        { prompt: 'Test' }
      );

      expect(job.status).toBe('failed');
      expect(job.error).toContain('Network timeout');
    });

    it('should handle malformed responses', async () => {
      // Mock malformed JSON response
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error('Invalid JSON'))
      });

      const job = await depinRouter.submitInferenceJob(
        testPassportId,
        'llama2-7b',
        { prompt: 'Test' }
      );

      expect(job.status).toBe('failed');
      expect(job.error).toContain('Invalid JSON');
    });
  });
});