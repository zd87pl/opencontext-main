import { ethers } from 'ethers';

export interface ComputeNode {
  id: string;
  address: string;
  endpoint: string;
  capabilities: {
    gpu: string[];
    memory: number; // GB
    vcpus: number;
    storage: number; // GB
  };
  pricing: {
    perSecond: string; // Wei per second
    perGPUHour: string; // Wei per GPU hour
    perGB: string; // Wei per GB memory
  };
  reputation: {
    score: number; // 0-100
    totalJobs: number;
    successRate: number;
  };
  status: 'online' | 'offline' | 'busy';
  lastSeen: number;
}

export interface InferenceJob {
  id: string;
  passportId: string;
  nodeId: string;
  model: string;
  input: any;
  output?: any;
  status: 'pending' | 'running' | 'completed' | 'failed';
  cost: string; // Wei
  startTime: number;
  endTime?: number;
  error?: string;
}

export interface ModelSpec {
  name: string;
  version: string;
  framework: 'pytorch' | 'tensorflow' | 'onnx';
  requirements: {
    minMemory: number; // GB
    gpuRequired: boolean;
    minGpuMemory?: number; // GB
  };
  endpoints: {
    predict: string;
    health: string;
  };
}

export class DePINRouter {
  private nodes: Map<string, ComputeNode> = new Map();
  private jobs: Map<string, InferenceJob> = new Map();
  private models: Map<string, ModelSpec> = new Map();

  constructor() {
    this.loadSampleNodes();
    this.loadSampleModels();
  }

  private loadSampleNodes() {
    const sampleNodes: ComputeNode[] = [
      {
        id: 'akash-node-1',
        address: '0x742d35Cc6639C0532fEb99E7638d5Bb6D1E7f652',
        endpoint: 'https://akash-gpu-1.opencontext.network',
        capabilities: {
          gpu: ['NVIDIA RTX 4090'],
          memory: 32,
          vcpus: 16,
          storage: 1000
        },
        pricing: {
          perSecond: ethers.parseUnits('0.001', 'gwei').toString(),
          perGPUHour: ethers.parseUnits('100', 'gwei').toString(),
          perGB: ethers.parseUnits('0.1', 'gwei').toString()
        },
        reputation: {
          score: 95,
          totalJobs: 1420,
          successRate: 0.98
        },
        status: 'online',
        lastSeen: Date.now()
      },
      {
        id: 'gensyn-node-1',
        address: '0x8b3a3b9b83f1c4c6c2a2f5e8e5d2c1a1b3c4d5e6',
        endpoint: 'https://gensyn-worker-1.compute.network',
        capabilities: {
          gpu: ['NVIDIA H100'],
          memory: 80,
          vcpus: 32,
          storage: 2000
        },
        pricing: {
          perSecond: ethers.parseUnits('0.01', 'gwei').toString(),
          perGPUHour: ethers.parseUnits('500', 'gwei').toString(),
          perGB: ethers.parseUnits('0.05', 'gwei').toString()
        },
        reputation: {
          score: 98,
          totalJobs: 892,
          successRate: 0.99
        },
        status: 'online',
        lastSeen: Date.now()
      }
    ];

    for (const node of sampleNodes) {
      this.nodes.set(node.id, node);
    }
  }

  private loadSampleModels() {
    const sampleModels: ModelSpec[] = [
      {
        name: 'llama2-7b',
        version: '1.0',
        framework: 'pytorch',
        requirements: {
          minMemory: 16,
          gpuRequired: true,
          minGpuMemory: 8
        },
        endpoints: {
          predict: '/v1/completions',
          health: '/health'
        }
      },
      {
        name: 'stable-diffusion-xl',
        version: '1.0',
        framework: 'pytorch',
        requirements: {
          minMemory: 8,
          gpuRequired: true,
          minGpuMemory: 12
        },
        endpoints: {
          predict: '/v1/images/generations',
          health: '/health'
        }
      }
    ];

    for (const model of sampleModels) {
      this.models.set(model.name, model);
    }
  }

  findOptimalNode(modelName: string, priority: 'cost' | 'speed' | 'reliability' = 'cost'): ComputeNode | null {
    const model = this.models.get(modelName);
    if (!model) {
      throw new Error(`Model not found: ${modelName}`);
    }

    const eligibleNodes = Array.from(this.nodes.values()).filter(node => {
      return (
        node.status === 'online' &&
        node.capabilities.memory >= model.requirements.minMemory &&
        (!model.requirements.gpuRequired || node.capabilities.gpu.length > 0)
      );
    });

    if (eligibleNodes.length === 0) {
      return null;
    }

    switch (priority) {
      case 'cost':
        return eligibleNodes.sort((a, b) => 
          parseInt(a.pricing.perSecond) - parseInt(b.pricing.perSecond)
        )[0];
        
      case 'speed':
        return eligibleNodes.sort((a, b) => 
          b.capabilities.vcpus - a.capabilities.vcpus
        )[0];
        
      case 'reliability':
        return eligibleNodes.sort((a, b) => 
          b.reputation.score - a.reputation.score
        )[0];
        
      default:
        return eligibleNodes[0];
    }
  }

  async submitInferenceJob(
    passportId: string,
    modelName: string,
    input: any,
    priority: 'cost' | 'speed' | 'reliability' = 'cost'
  ): Promise<InferenceJob> {
    const node = this.findOptimalNode(modelName, priority);
    if (!node) {
      throw new Error(`No available nodes for model: ${modelName}`);
    }

    const jobId = ethers.hexlify(ethers.randomBytes(16));
    const estimatedRuntime = 30; // seconds
    const cost = (BigInt(node.pricing.perSecond) * BigInt(estimatedRuntime)).toString();

    const job: InferenceJob = {
      id: jobId,
      passportId,
      nodeId: node.id,
      model: modelName,
      input,
      status: 'pending',
      cost,
      startTime: Date.now()
    };

    this.jobs.set(jobId, job);

    try {
      const result = await this.executeJobOnNode(job, node);
      job.output = result;
      job.status = 'completed';
      job.endTime = Date.now();
      
      this.updateNodeReputation(node.id, true);
      
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Unknown error';
      job.endTime = Date.now();
      
      this.updateNodeReputation(node.id, false);
    }

    return job;
  }

  private async executeJobOnNode(job: InferenceJob, node: ComputeNode): Promise<any> {
    const model = this.models.get(job.model);
    if (!model) {
      throw new Error(`Model spec not found: ${job.model}`);
    }

    const endpoint = `${node.endpoint}${model.endpoints.predict}`;
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${node.address}` // Node authentication
      },
      body: JSON.stringify({
        model: job.model,
        ...job.input
      })
    });

    if (!response.ok) {
      throw new Error(`Node execution failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  private updateNodeReputation(nodeId: string, success: boolean) {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    node.reputation.totalJobs += 1;
    
    if (success) {
      const successfulJobs = Math.floor(node.reputation.successRate * (node.reputation.totalJobs - 1)) + 1;
      node.reputation.successRate = successfulJobs / node.reputation.totalJobs;
    } else {
      const successfulJobs = Math.floor(node.reputation.successRate * (node.reputation.totalJobs - 1));
      node.reputation.successRate = successfulJobs / node.reputation.totalJobs;
    }

    node.reputation.score = Math.floor(node.reputation.successRate * 100);
    node.lastSeen = Date.now();
  }

  getJob(jobId: string): InferenceJob | undefined {
    return this.jobs.get(jobId);
  }

  getJobsByPassport(passportId: string): InferenceJob[] {
    return Array.from(this.jobs.values())
      .filter(job => job.passportId === passportId)
      .sort((a, b) => b.startTime - a.startTime);
  }

  getAvailableNodes(): ComputeNode[] {
    return Array.from(this.nodes.values())
      .filter(node => node.status === 'online')
      .sort((a, b) => b.reputation.score - a.reputation.score);
  }

  getAvailableModels(): ModelSpec[] {
    return Array.from(this.models.values());
  }

  registerNode(node: ComputeNode): void {
    this.nodes.set(node.id, node);
  }

  updateNodeStatus(nodeId: string, status: ComputeNode['status']): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.status = status;
      node.lastSeen = Date.now();
    }
  }

  calculateJobCost(nodeId: string, estimatedSeconds: number): string {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    return (BigInt(node.pricing.perSecond) * BigInt(estimatedSeconds)).toString();
  }
}