import { MeteringRecord, PartnerConfig } from './types.js';
import { ethers } from 'ethers';

export class MeteringService {
  private records: Map<string, MeteringRecord[]> = new Map();
  private partners: Map<string, PartnerConfig> = new Map();

  constructor() {
    this.loadPartnerConfigs();
  }

  private loadPartnerConfigs() {
    const configs: PartnerConfig[] = [
      {
        id: 'newswire',
        name: 'Newswire API',
        baseUrl: 'https://newsapi.org/v2',
        costPerByte: ethers.parseUnits('0.001', 'gwei').toString(),
        costPerRequest: ethers.parseUnits('0.1', 'gwei').toString(),
        authRequired: true,
        rateLimits: { requests: 1000, window: 3600 }
      },
      {
        id: 'github',
        name: 'GitHub API',
        baseUrl: 'https://api.github.com',
        costPerByte: ethers.parseUnits('0.0005', 'gwei').toString(),
        costPerRequest: ethers.parseUnits('0.05', 'gwei').toString(),
        authRequired: true,
        rateLimits: { requests: 5000, window: 3600 }
      },
      {
        id: 'satellite',
        name: 'Satellite Imagery',
        baseUrl: 'https://api.planet.com/data/v1',
        costPerByte: ethers.parseUnits('0.01', 'gwei').toString(),
        costPerRequest: ethers.parseUnits('1', 'gwei').toString(),
        authRequired: true
      }
    ];

    for (const config of configs) {
      this.partners.set(config.id, config);
    }
  }

  recordUsage(passportId: string, partnerId: string, bytes: number): MeteringRecord {
    const partner = this.partners.get(partnerId);
    if (!partner) {
      throw new Error(`Unknown partner: ${partnerId}`);
    }

    const byteCost = BigInt(partner.costPerByte) * BigInt(bytes);
    const requestCost = BigInt(partner.costPerRequest);
    const totalCost = byteCost + requestCost;

    const record: MeteringRecord = {
      passportId,
      partnerId,
      timestamp: Date.now(),
      bytes,
      requests: 1,
      cost: totalCost.toString()
    };

    const key = `${passportId}:${partnerId}`;
    if (!this.records.has(key)) {
      this.records.set(key, []);
    }
    this.records.get(key)!.push(record);

    return record;
  }

  getUsage(passportId: string, partnerId?: string, since?: number): MeteringRecord[] {
    if (partnerId) {
      const key = `${passportId}:${partnerId}`;
      const records = this.records.get(key) || [];
      return since ? records.filter(r => r.timestamp >= since) : records;
    }

    const allRecords: MeteringRecord[] = [];
    for (const [key, records] of this.records.entries()) {
      if (key.startsWith(`${passportId}:`)) {
        const filtered = since ? records.filter(r => r.timestamp >= since) : records;
        allRecords.push(...filtered);
      }
    }
    return allRecords.sort((a, b) => a.timestamp - b.timestamp);
  }

  getTotalCost(passportId: string, partnerId?: string, since?: number): string {
    const records = this.getUsage(passportId, partnerId, since);
    const total = records.reduce((sum, record) => sum + BigInt(record.cost), 0n);
    return total.toString();
  }

  getPartnerConfig(partnerId: string): PartnerConfig | undefined {
    return this.partners.get(partnerId);
  }

  getAllPartners(): PartnerConfig[] {
    return Array.from(this.partners.values());
  }
}