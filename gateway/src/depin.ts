/**
 * Routes AI inference jobs to DePIN compute nodes.
 *
 * The bundled nodes and models are placeholders so the router can be exercised end to end
 * (their endpoints do not resolve); real deployments register nodes with `registerNode` or
 * pass `nodes`/`models` to the constructor.
 */

import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';

export interface ComputeNode {
  id: string;
  /** Payout address of the node operator. */
  address: string;
  endpoint: string;
  /** Bearer token the node expects from this gateway, if it requires one. */
  authToken?: string;
  capabilities: {
    gpu: string[];
    /** GB */
    memory: number;
    vcpus: number;
    /** GB */
    storage: number;
  };
  pricing: {
    /** Wei per second. */
    perSecond: string;
    /** Wei per GPU hour. */
    perGPUHour: string;
    /** Wei per GB of memory. */
    perGB: string;
  };
  reputation: {
    /** 0-100 */
    score: number;
    totalJobs: number;
    /** 0-1 */
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
  input: Record<string, unknown>;
  output?: unknown;
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Quoted cost in wei (node price * estimated runtime). */
  cost: string;
  startTime: number;
  endTime?: number;
  error?: string;
}

export interface ModelSpec {
  name: string;
  version: string;
  framework: 'pytorch' | 'tensorflow' | 'onnx';
  requirements: {
    /** GB */
    minMemory: number;
    gpuRequired: boolean;
    /** GB */
    minGpuMemory?: number;
  };
  endpoints: {
    predict: string;
    health: string;
  };
}

export type JobPriority = 'cost' | 'speed' | 'reliability';

export interface DePINRouterOptions {
  nodes?: ComputeNode[];
  models?: ModelSpec[];
  /** Assumed runtime used to quote a job before it runs. */
  estimatedRuntimeSeconds?: number;
  /** Timeout for a node call in milliseconds. */
  requestTimeoutMs?: number;
}

export const USER_AGENT = 'OpenContext-Gateway/0.2';

export function sampleNodes(): ComputeNode[] {
  const now = Date.now();
  return [
    {
      id: 'akash-node-1',
      address: '0x742d35Cc6639C0532fEb99E7638d5Bb6D1E7f652',
      endpoint: 'https://akash-gpu-1.opencontext.network',
      capabilities: { gpu: ['NVIDIA RTX 4090'], memory: 32, vcpus: 16, storage: 1000 },
      pricing: {
        perSecond: ethers.parseUnits('0.001', 'gwei').toString(),
        perGPUHour: ethers.parseUnits('100', 'gwei').toString(),
        perGB: ethers.parseUnits('0.1', 'gwei').toString(),
      },
      reputation: { score: 95, totalJobs: 1420, successRate: 0.95 },
      status: 'online',
      lastSeen: now,
    },
    {
      id: 'gensyn-node-1',
      address: '0x8b3a3b9b83f1c4c6c2a2f5e8e5d2c1a1b3c4d5e6',
      endpoint: 'https://gensyn-worker-1.compute.network',
      capabilities: { gpu: ['NVIDIA H100'], memory: 80, vcpus: 32, storage: 2000 },
      pricing: {
        perSecond: ethers.parseUnits('0.01', 'gwei').toString(),
        perGPUHour: ethers.parseUnits('500', 'gwei').toString(),
        perGB: ethers.parseUnits('0.05', 'gwei').toString(),
      },
      reputation: { score: 98, totalJobs: 892, successRate: 0.98 },
      status: 'online',
      lastSeen: now,
    },
  ];
}

export function sampleModels(): ModelSpec[] {
  return [
    {
      name: 'llama2-7b',
      version: '1.0',
      framework: 'pytorch',
      requirements: { minMemory: 16, gpuRequired: true, minGpuMemory: 8 },
      endpoints: { predict: '/v1/completions', health: '/health' },
    },
    {
      name: 'stable-diffusion-xl',
      version: '1.0',
      framework: 'pytorch',
      requirements: { minMemory: 8, gpuRequired: true, minGpuMemory: 12 },
      endpoints: { predict: '/v1/images/generations', health: '/health' },
    },
  ];
}

export class DePINRouter {
  private readonly nodes = new Map<string, ComputeNode>();
  private readonly jobs = new Map<string, InferenceJob>();
  private readonly models = new Map<string, ModelSpec>();
  private readonly estimatedRuntimeSeconds: number;
  private readonly requestTimeoutMs: number;

  constructor(options: DePINRouterOptions = {}) {
    for (const node of options.nodes ?? sampleNodes()) this.nodes.set(node.id, node);
    for (const model of options.models ?? sampleModels()) this.models.set(model.name, model);
    this.estimatedRuntimeSeconds = options.estimatedRuntimeSeconds ?? 30;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60000;
  }

  /** Online nodes able to run `modelName`, ranked by `priority`. Null when none qualifies. */
  findOptimalNode(modelName: string, priority: JobPriority = 'cost'): ComputeNode | null {
    const model = this.models.get(modelName);
    if (!model) {
      throw new Error(`Model not found: ${modelName}`);
    }

    const eligible = Array.from(this.nodes.values()).filter(
      (node) =>
        node.status === 'online' &&
        node.capabilities.memory >= model.requirements.minMemory &&
        (!model.requirements.gpuRequired || node.capabilities.gpu.length > 0)
    );
    if (eligible.length === 0) {
      return null;
    }

    const rank: Record<JobPriority, (a: ComputeNode, b: ComputeNode) => number> = {
      cost: (a, b) => Number(BigInt(a.pricing.perSecond) - BigInt(b.pricing.perSecond)),
      speed: (a, b) => b.capabilities.vcpus - a.capabilities.vcpus,
      reliability: (a, b) => b.reputation.score - a.reputation.score,
    };
    return structuredClone(eligible.sort(rank[priority])[0]);
  }

  async submitInferenceJob(
    passportId: string,
    modelName: string,
    input: Record<string, unknown>,
    priority: JobPriority = 'cost'
  ): Promise<InferenceJob> {
    const node = this.findOptimalNode(modelName, priority);
    if (!node) {
      throw new Error(`No available nodes for model: ${modelName}`);
    }

    const job: InferenceJob = {
      id: ethers.hexlify(randomBytes(16)),
      passportId,
      nodeId: node.id,
      model: modelName,
      input,
      status: 'running',
      cost: this.calculateJobCost(node.id, this.estimatedRuntimeSeconds),
      startTime: Date.now(),
    };
    this.jobs.set(job.id, job);

    try {
      job.output = await this.executeJobOnNode(job, node);
      job.status = 'completed';
      this.updateNodeReputation(node.id, true);
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Unknown error';
      this.updateNodeReputation(node.id, false);
    }
    job.endTime = Date.now();

    return job;
  }

  private async executeJobOnNode(job: InferenceJob, node: ComputeNode): Promise<unknown> {
    const model = this.models.get(job.model);
    if (!model) {
      throw new Error(`Model spec not found: ${job.model}`);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-OpenContext-Passport': job.passportId,
      'X-OpenContext-Job': job.id,
    };
    if (node.authToken) {
      headers['Authorization'] = `Bearer ${node.authToken}`;
    }

    const response = await fetch(`${node.endpoint}${model.endpoints.predict}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: job.model, ...job.input }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Node execution failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Fold one outcome into the node's running success rate. The stored rate is a ratio, so the
   * previous success count is recovered by rounding (flooring would silently drop a success).
   */
  private updateNodeReputation(nodeId: string, success: boolean): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    const previousSuccesses = Math.round(node.reputation.successRate * node.reputation.totalJobs);
    node.reputation.totalJobs += 1;
    node.reputation.successRate = (previousSuccesses + (success ? 1 : 0)) / node.reputation.totalJobs;
    node.reputation.score = Math.floor(node.reputation.successRate * 100);
    node.lastSeen = Date.now();
  }

  getJob(jobId: string): InferenceJob | undefined {
    return this.jobs.get(jobId);
  }

  /** Newest first. */
  getJobsByPassport(passportId: string): InferenceJob[] {
    return Array.from(this.jobs.values())
      .filter((job) => job.passportId === passportId)
      .sort((a, b) => b.startTime - a.startTime);
  }

  /** Snapshots of online nodes, highest reputation first. */
  getAvailableNodes(): ComputeNode[] {
    return Array.from(this.nodes.values())
      .filter((node) => node.status === 'online')
      .sort((a, b) => b.reputation.score - a.reputation.score)
      .map((node) => structuredClone(node));
  }

  getAvailableModels(): ModelSpec[] {
    return Array.from(this.models.values(), (model) => structuredClone(model));
  }

  registerNode(node: ComputeNode): void {
    this.nodes.set(node.id, structuredClone(node));
  }

  registerModel(model: ModelSpec): void {
    this.models.set(model.name, structuredClone(model));
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
