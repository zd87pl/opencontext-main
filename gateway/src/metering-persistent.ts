/**
 * Persistent metering service using storage adapter
 */

import { MeteringRecord, PartnerConfig } from './types.js';
import { StorageAdapter, createStorageAdapter, StorageConfig } from './storage.js';
import { ethers } from 'ethers';

export class PersistentMeteringService {
  private storage: StorageAdapter;
  private partners: Map<string, PartnerConfig> = new Map();

  constructor(storageConfig?: StorageConfig) {
    this.storage = createStorageAdapter(storageConfig);
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
      },
      {
        id: 'compute',
        name: 'DePIN Compute',
        baseUrl: 'internal://depin',
        costPerByte: ethers.parseUnits('0.05', 'gwei').toString(),
        costPerRequest: ethers.parseUnits('10', 'gwei').toString(),
        authRequired: true
      }
    ];

    for (const config of configs) {
      this.partners.set(config.id, config);
    }
  }

  async recordUsage(passportId: string, partnerId: string, bytes: number): Promise<MeteringRecord> {
    const partner = this.partners.get(partnerId);
    if (!partner) {
      throw new Error(`Unknown partner: ${partnerId}`);
    }

    const cost = this.calculateCost(bytes, partner);
    const record: MeteringRecord = {
      id: `${passportId}-${partnerId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      passportId,
      partnerId,
      timestamp: Date.now(),
      bytes,
      cost,
      requestId: this.generateRequestId()
    };

    // Store record in Redis with TTL of 30 days
    const recordKey = `metering:record:${record.id}`;
    await this.storage.set(recordKey, JSON.stringify(record), 30 * 24 * 60 * 60);

    // Add to passport index
    const passportKey = `metering:passport:${passportId}`;
    await this.storage.hset(passportKey, record.id, record.timestamp.toString());

    // Add to partner index
    const partnerKey = `metering:partner:${partnerId}`;
    await this.storage.hset(partnerKey, record.id, record.timestamp.toString());

    // Update totals
    await this.updateTotals(passportId, partnerId, bytes, cost);

    return record;
  }

  private calculateCost(bytes: number, partner: PartnerConfig): string {
    const byteCost = BigInt(partner.costPerByte) * BigInt(bytes);
    const requestCost = BigInt(partner.costPerRequest || '0');
    const totalCost = byteCost + requestCost;
    return totalCost.toString();
  }

  private async updateTotals(passportId: string, partnerId: string, bytes: number, cost: string) {
    // Update passport totals
    const passportTotalKey = `totals:passport:${passportId}`;
    await this.storage.hset(passportTotalKey, 'bytes', 
      (BigInt(await this.storage.hget(passportTotalKey, 'bytes') || '0') + BigInt(bytes)).toString()
    );
    await this.storage.hset(passportTotalKey, 'cost', 
      (BigInt(await this.storage.hget(passportTotalKey, 'cost') || '0') + BigInt(cost)).toString()
    );

    // Update partner totals
    const partnerTotalKey = `totals:partner:${partnerId}`;
    await this.storage.hset(partnerTotalKey, 'bytes', 
      (BigInt(await this.storage.hget(partnerTotalKey, 'bytes') || '0') + BigInt(bytes)).toString()
    );
    await this.storage.hset(partnerTotalKey, 'cost', 
      (BigInt(await this.storage.hget(partnerTotalKey, 'cost') || '0') + BigInt(cost)).toString()
    );

    // Update daily totals for analytics
    const today = new Date().toISOString().split('T')[0];
    const dailyKey = `daily:${today}:${passportId}:${partnerId}`;
    await this.storage.hset(dailyKey, 'bytes', 
      (BigInt(await this.storage.hget(dailyKey, 'bytes') || '0') + BigInt(bytes)).toString()
    );
    await this.storage.hset(dailyKey, 'cost', 
      (BigInt(await this.storage.hget(dailyKey, 'cost') || '0') + BigInt(cost)).toString()
    );
    await this.storage.expire(dailyKey, 90 * 24 * 60 * 60); // 90 days TTL
  }

  async getUsage(passportId: string, partnerId?: string, since?: number): Promise<MeteringRecord[]> {
    const records: MeteringRecord[] = [];
    const sinceTimestamp = since || 0;

    if (partnerId) {
      // Get records for specific partner
      const partnerKey = `metering:partner:${partnerId}`;
      const recordIds = await this.storage.hgetall(partnerKey);
      
      for (const [recordId, timestamp] of Object.entries(recordIds)) {
        if (parseInt(timestamp) >= sinceTimestamp) {
          const record = await this.getRecord(recordId);
          if (record && record.passportId === passportId) {
            records.push(record);
          }
        }
      }
    } else {
      // Get all records for passport
      const passportKey = `metering:passport:${passportId}`;
      const recordIds = await this.storage.hgetall(passportKey);
      
      for (const [recordId, timestamp] of Object.entries(recordIds)) {
        if (parseInt(timestamp) >= sinceTimestamp) {
          const record = await this.getRecord(recordId);
          if (record) {
            records.push(record);
          }
        }
      }
    }

    return records.sort((a, b) => b.timestamp - a.timestamp);
  }

  private async getRecord(recordId: string): Promise<MeteringRecord | null> {
    const recordKey = `metering:record:${recordId}`;
    const data = await this.storage.get(recordKey);
    return data ? JSON.parse(data) : null;
  }

  async getTotalCost(passportId: string, partnerId?: string, since?: number): Promise<string> {
    if (partnerId && since) {
      // Calculate from records
      const records = await this.getUsage(passportId, partnerId, since);
      return records.reduce((total, record) => {
        return (BigInt(total) + BigInt(record.cost)).toString();
      }, '0');
    }

    if (partnerId) {
      // Get from daily totals for better performance
      const today = new Date();
      const sinceDays = since ? Math.ceil((Date.now() - since) / (24 * 60 * 60 * 1000)) : 30;
      let totalCost = BigInt(0);

      for (let i = 0; i < sinceDays; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        const dailyKey = `daily:${dateStr}:${passportId}:${partnerId}`;
        const cost = await this.storage.hget(dailyKey, 'cost');
        if (cost) {
          totalCost += BigInt(cost);
        }
      }

      return totalCost.toString();
    }

    // Get total for passport
    const passportTotalKey = `totals:passport:${passportId}`;
    return await this.storage.hget(passportTotalKey, 'cost') || '0';
  }

  getPartnerConfig(partnerId: string): PartnerConfig | undefined {
    return this.partners.get(partnerId);
  }

  getAllPartners(): PartnerConfig[] {
    return Array.from(this.partners.values());
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async getAnalytics(passportId?: string, partnerId?: string, days: number = 30): Promise<{
    totalRequests: number;
    totalBytes: string;
    totalCost: string;
    dailyBreakdown: Array<{
      date: string;
      requests: number;
      bytes: string;
      cost: string;
    }>;
  }> {
    const today = new Date();
    const dailyBreakdown: Array<{
      date: string;
      requests: number;
      bytes: string;
      cost: string;
    }> = [];

    let totalRequests = 0;
    let totalBytes = BigInt(0);
    let totalCost = BigInt(0);

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];

      let dayBytes = BigInt(0);
      let dayCost = BigInt(0);
      let dayRequests = 0;

      if (passportId && partnerId) {
        const dailyKey = `daily:${dateStr}:${passportId}:${partnerId}`;
        const bytes = await this.storage.hget(dailyKey, 'bytes');
        const cost = await this.storage.hget(dailyKey, 'cost');
        if (bytes) {
          dayBytes = BigInt(bytes);
          dayCost = BigInt(cost || '0');
          dayRequests = 1; // Approximate
        }
      } else {
        // Aggregate across all passports/partners for this date
        for await (const key of this.storage.scan(`daily:${dateStr}:*`)) {
          const bytes = await this.storage.hget(key, 'bytes');
          const cost = await this.storage.hget(key, 'cost');
          if (bytes) {
            dayBytes += BigInt(bytes);
            dayCost += BigInt(cost || '0');
            dayRequests++;
          }
        }
      }

      dailyBreakdown.unshift({
        date: dateStr,
        requests: dayRequests,
        bytes: dayBytes.toString(),
        cost: dayCost.toString()
      });

      totalRequests += dayRequests;
      totalBytes += dayBytes;
      totalCost += dayCost;
    }

    return {
      totalRequests,
      totalBytes: totalBytes.toString(),
      totalCost: totalCost.toString(),
      dailyBreakdown
    };
  }

  async cleanup(): Promise<void> {
    await this.storage.close();
  }
}