/**
 * Usage metering: prices every partner request per byte and per request, keeps the individual
 * records for a retention window and maintains atomic running totals (lifetime and daily).
 */

import { randomUUID } from 'node:crypto';
import type { MeteringRecord, PartnerConfig } from './types.js';
import { MemoryStorage, type StorageAdapter } from './storage.js';
import { DEFAULT_PARTNERS } from '../partners/index.js';

const DAY_SECONDS = 24 * 60 * 60;
const DEFAULT_RECORD_TTL_SECONDS = 30 * DAY_SECONDS;
const DAILY_TOTAL_TTL_SECONDS = 90 * DAY_SECONDS;

export interface MeteringOptions {
  storage?: StorageAdapter;
  partners?: readonly PartnerConfig[];
  /** Retention of individual records in seconds. Aggregated totals are kept indefinitely. */
  recordTtlSeconds?: number;
}

export interface RecordUsageOptions {
  /** Extra wei on top of the partner's per-byte/per-request pricing, e.g. a compute job's price. */
  additionalCost?: bigint | string;
}

export interface UsageTotals {
  bytes: string;
  cost: string;
  requests: number;
}

export interface DailyUsage extends UsageTotals {
  date: string;
}

export interface UsageAnalytics {
  totalRequests: number;
  totalBytes: string;
  totalCost: string;
  dailyBreakdown: DailyUsage[];
}

function utcDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export class MeteringService {
  private readonly storage: StorageAdapter;
  private readonly partners = new Map<string, PartnerConfig>();
  private readonly recordTtl: number;

  constructor(options: MeteringOptions = {}) {
    this.storage = options.storage ?? new MemoryStorage();
    this.recordTtl = options.recordTtlSeconds ?? DEFAULT_RECORD_TTL_SECONDS;
    for (const partner of options.partners ?? DEFAULT_PARTNERS) {
      this.partners.set(partner.id, partner);
    }
  }

  get storageKind(): StorageAdapter['kind'] {
    return this.storage.kind;
  }

  getPartnerConfig(partnerId: string): PartnerConfig | undefined {
    return this.partners.get(partnerId);
  }

  getAllPartners(): PartnerConfig[] {
    return Array.from(this.partners.values());
  }

  registerPartner(partner: PartnerConfig): void {
    this.partners.set(partner.id, partner);
  }

  /** Price a request without recording it. */
  calculateCost(partnerId: string, bytes: number, additionalCost: bigint | string = 0n): bigint {
    const partner = this.partners.get(partnerId);
    if (!partner) {
      throw new Error(`Unknown partner: ${partnerId}`);
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError(`bytes must be a non-negative integer, got ${bytes}`);
    }
    const extra = BigInt(additionalCost);
    if (extra < 0n) {
      throw new RangeError('additionalCost must not be negative');
    }
    return BigInt(partner.costPerByte) * BigInt(bytes) + BigInt(partner.costPerRequest) + extra;
  }

  async recordUsage(
    passportId: string,
    partnerId: string,
    bytes: number,
    options: RecordUsageOptions = {}
  ): Promise<MeteringRecord> {
    const cost = this.calculateCost(partnerId, bytes, options.additionalCost ?? 0n);
    const sequence = await this.storage.incr('metering:seq');
    const record: MeteringRecord = {
      id: randomUUID(),
      sequence,
      passportId,
      partnerId,
      timestamp: Date.now(),
      bytes,
      requests: 1,
      cost: cost.toString(),
    };

    await this.storage.set(`metering:record:${record.id}`, JSON.stringify(record), this.recordTtl);

    const stamp = record.timestamp.toString();
    await this.storage.hset(`metering:index:${passportId}`, record.id, stamp);
    await this.storage.hset(`metering:index:${passportId}:${partnerId}`, record.id, stamp);

    await this.addTotals(`metering:totals:${passportId}`, bytes, cost);
    await this.addTotals(`metering:totals:${passportId}:${partnerId}`, bytes, cost);

    const dailyKey = `metering:daily:${utcDate(record.timestamp)}:${passportId}:${partnerId}`;
    await this.addTotals(dailyKey, bytes, cost);
    await this.storage.expire(dailyKey, DAILY_TOTAL_TTL_SECONDS);

    return record;
  }

  private async addTotals(key: string, bytes: number, cost: bigint): Promise<void> {
    await this.storage.hincrby(key, 'bytes', BigInt(bytes));
    await this.storage.hincrby(key, 'cost', cost);
    await this.storage.hincrby(key, 'requests', 1n);
  }

  /**
   * Records for a passport (optionally one partner) since a timestamp, oldest first. Index entries
   * whose record has expired are pruned as they are encountered.
   */
  async getUsage(passportId: string, partnerId?: string, since?: number): Promise<MeteringRecord[]> {
    const indexKey = partnerId
      ? `metering:index:${passportId}:${partnerId}`
      : `metering:index:${passportId}`;
    const entries = await this.storage.hgetall(indexKey);
    const records: MeteringRecord[] = [];

    for (const [recordId, timestamp] of Object.entries(entries)) {
      if (since !== undefined && Number(timestamp) < since) continue;
      const raw = await this.storage.get(`metering:record:${recordId}`);
      if (raw) {
        records.push(JSON.parse(raw) as MeteringRecord);
      } else {
        await this.storage.hdel(indexKey, recordId);
      }
    }

    return records.sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Total cost in wei. Without `since` this is the lifetime total (which outlives record
   * retention); with `since` it is summed from the retained records.
   */
  async getTotalCost(passportId: string, partnerId?: string, since?: number): Promise<string> {
    if (since !== undefined) {
      const records = await this.getUsage(passportId, partnerId, since);
      return records.reduce((sum, record) => sum + BigInt(record.cost), 0n).toString();
    }
    return (await this.getTotals(passportId, partnerId)).cost;
  }

  async getTotals(passportId: string, partnerId?: string): Promise<UsageTotals> {
    const key = partnerId
      ? `metering:totals:${passportId}:${partnerId}`
      : `metering:totals:${passportId}`;
    const totals = await this.storage.hgetall(key);
    return {
      bytes: totals.bytes ?? '0',
      cost: totals.cost ?? '0',
      requests: Number(totals.requests ?? '0'),
    };
  }

  /** Daily breakdown over the last `days` UTC days, oldest day first. */
  async getAnalytics(passportId?: string, partnerId?: string, days = 30): Promise<UsageAnalytics> {
    const dailyBreakdown: DailyUsage[] = [];
    let totalRequests = 0;
    let totalBytes = 0n;
    let totalCost = 0n;

    for (let i = days - 1; i >= 0; i--) {
      const date = utcDate(Date.now() - i * DAY_SECONDS * 1000);
      const keys =
        passportId && partnerId
          ? [`metering:daily:${date}:${passportId}:${partnerId}`]
          : await this.storage.keys(
              `metering:daily:${date}:${passportId ?? '*'}:${partnerId ?? '*'}`
            );

      let dayBytes = 0n;
      let dayCost = 0n;
      let dayRequests = 0;
      for (const key of keys) {
        const totals = await this.storage.hgetall(key);
        dayBytes += BigInt(totals.bytes ?? '0');
        dayCost += BigInt(totals.cost ?? '0');
        dayRequests += Number(totals.requests ?? '0');
      }

      dailyBreakdown.push({
        date,
        bytes: dayBytes.toString(),
        cost: dayCost.toString(),
        requests: dayRequests,
      });
      totalRequests += dayRequests;
      totalBytes += dayBytes;
      totalCost += dayCost;
    }

    return {
      totalRequests,
      totalBytes: totalBytes.toString(),
      totalCost: totalCost.toString(),
      dailyBreakdown,
    };
  }

  async close(): Promise<void> {
    await this.storage.close();
  }
}
