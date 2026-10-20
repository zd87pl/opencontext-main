import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeteringService } from '../src/metering.js';
import { MemoryStorage } from '../src/storage.js';

describe('MeteringService', () => {
  let meteringService: MeteringService;
  const testPassportId = 'test-passport-123';
  const testPartnerId = 'newswire';

  beforeEach(() => {
    meteringService = new MeteringService();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await meteringService.close();
  });

  describe('Partner Configuration', () => {
    it('should load default partner configurations', () => {
      const partners = meteringService.getAllPartners();
      expect(partners).toHaveLength(4);

      const partnerIds = partners.map((p) => p.id);
      expect(partnerIds).toContain('newswire');
      expect(partnerIds).toContain('github');
      expect(partnerIds).toContain('satellite');
      // DePIN jobs are metered under the "compute" partner.
      expect(partnerIds).toContain('compute');
    });

    it('should return correct partner config', () => {
      const config = meteringService.getPartnerConfig('newswire');
      expect(config).toBeDefined();
      expect(config?.name).toBe('Newswire API');
      expect(config?.baseUrl).toBe('https://newsapi.org/v2');
      expect(config?.authRequired).toBe(true);
    });

    it('should return undefined for unknown partner', () => {
      const config = meteringService.getPartnerConfig('unknown');
      expect(config).toBeUndefined();
    });

    it('should allow registering additional partners', () => {
      meteringService.registerPartner({
        id: 'weather',
        name: 'Weather API',
        baseUrl: 'https://api.weather.example',
        costPerByte: '1',
        costPerRequest: '10',
        authRequired: false,
      });
      expect(meteringService.getPartnerConfig('weather')?.name).toBe('Weather API');
      expect(meteringService.getAllPartners()).toHaveLength(5);
    });
  });

  describe('Usage Recording', () => {
    it('should record usage correctly', async () => {
      const bytes = 1024;
      const record = await meteringService.recordUsage(testPassportId, testPartnerId, bytes);

      expect(record.id).toBeDefined();
      expect(record.passportId).toBe(testPassportId);
      expect(record.partnerId).toBe(testPartnerId);
      expect(record.bytes).toBe(bytes);
      expect(record.requests).toBe(1);
      expect(record.timestamp).toBeGreaterThan(0);
      expect(BigInt(record.cost)).toBeGreaterThan(0n);
    });

    it('should calculate cost correctly', async () => {
      const bytes = 1000;
      const partner = meteringService.getPartnerConfig(testPartnerId)!;

      const record = await meteringService.recordUsage(testPassportId, testPartnerId, bytes);

      const expectedByteCost = BigInt(partner.costPerByte) * BigInt(bytes);
      const expectedRequestCost = BigInt(partner.costPerRequest);
      const expectedTotal = expectedByteCost + expectedRequestCost;

      expect(record.cost).toBe(expectedTotal.toString());
      expect(meteringService.calculateCost(testPartnerId, bytes)).toBe(expectedTotal);
    });

    it('should add an additional cost on top of the partner pricing', async () => {
      const record = await meteringService.recordUsage(testPassportId, 'compute', 0, {
        additionalCost: '12345',
      });
      const compute = meteringService.getPartnerConfig('compute')!;
      expect(BigInt(record.cost)).toBe(BigInt(compute.costPerRequest) + 12345n);
    });

    it('should throw error for unknown partner', async () => {
      await expect(
        meteringService.recordUsage(testPassportId, 'unknown-partner', 100)
      ).rejects.toThrow('Unknown partner: unknown-partner');
    });

    it('should reject negative or fractional byte counts', async () => {
      await expect(meteringService.recordUsage(testPassportId, testPartnerId, -1)).rejects.toThrow(
        RangeError
      );
      await expect(meteringService.recordUsage(testPassportId, testPartnerId, 1.5)).rejects.toThrow(
        RangeError
      );
    });

    it('should handle zero bytes', async () => {
      const record = await meteringService.recordUsage(testPassportId, testPartnerId, 0);
      expect(record.bytes).toBe(0);
      expect(BigInt(record.cost)).toBe(
        BigInt(meteringService.getPartnerConfig(testPartnerId)!.costPerRequest)
      );
    });

    it('should handle large byte counts', async () => {
      const largeBytes = 1024 * 1024 * 10; // 10MB
      const record = await meteringService.recordUsage(testPassportId, testPartnerId, largeBytes);
      expect(record.bytes).toBe(largeBytes);
      expect(BigInt(record.cost)).toBeGreaterThan(0n);
    });
  });

  describe('Usage Retrieval', () => {
    beforeEach(async () => {
      await meteringService.recordUsage(testPassportId, 'newswire', 500);
      await meteringService.recordUsage(testPassportId, 'github', 1000);
      await meteringService.recordUsage(testPassportId, 'newswire', 750);
    });

    it('should get usage for specific partner', async () => {
      const usage = await meteringService.getUsage(testPassportId, 'newswire');
      expect(usage).toHaveLength(2);
      expect(usage[0].bytes).toBe(500);
      expect(usage[1].bytes).toBe(750);
    });

    it('should get usage for all partners in chronological order', async () => {
      const usage = await meteringService.getUsage(testPassportId);
      expect(usage).toHaveLength(3);
      expect(usage.map((u) => u.partnerId)).toEqual(['newswire', 'github', 'newswire']);
    });

    it('should filter usage by time', async () => {
      // Only the clock is faked so that storage promises still settle normally.
      vi.useFakeTimers({ toFake: ['Date'] });
      const cutoff = Date.now() + 1000;
      vi.setSystemTime(cutoff);

      await meteringService.recordUsage(testPassportId, 'satellite', 2000);

      const recentUsage = await meteringService.getUsage(testPassportId, undefined, cutoff);
      expect(recentUsage).toHaveLength(1);
      expect(recentUsage[0].partnerId).toBe('satellite');
    });

    it('should return empty array for unknown passport', async () => {
      const usage = await meteringService.getUsage('unknown-passport');
      expect(usage).toHaveLength(0);
    });

    it('should return empty array for unknown partner', async () => {
      const usage = await meteringService.getUsage(testPassportId, 'unknown-partner');
      expect(usage).toHaveLength(0);
    });

    it('should not return another passport\'s records', async () => {
      await meteringService.recordUsage('someone-else', 'newswire', 10);
      const usage = await meteringService.getUsage(testPassportId, 'newswire');
      expect(usage.every((record) => record.passportId === testPassportId)).toBe(true);
    });
  });

  describe('Cost Calculation', () => {
    beforeEach(async () => {
      await meteringService.recordUsage(testPassportId, 'newswire', 1000);
      await meteringService.recordUsage(testPassportId, 'github', 2000);
    });

    it('should calculate total cost for all partners', async () => {
      const totalCost = await meteringService.getTotalCost(testPassportId);
      const usage = await meteringService.getUsage(testPassportId);
      const expected = usage.reduce((sum, record) => sum + BigInt(record.cost), 0n);
      expect(BigInt(totalCost)).toBeGreaterThan(0n);
      expect(totalCost).toBe(expected.toString());
    });

    it('should calculate total cost for specific partner', async () => {
      const newswireCost = await meteringService.getTotalCost(testPassportId, 'newswire');
      const githubCost = await meteringService.getTotalCost(testPassportId, 'github');

      expect(BigInt(newswireCost)).toBeGreaterThan(0n);
      expect(BigInt(githubCost)).toBeGreaterThan(0n);
      expect(newswireCost).not.toBe(githubCost);
    });

    it('should return zero cost for no usage', async () => {
      const cost = await meteringService.getTotalCost('unused-passport');
      expect(cost).toBe('0');
    });

    it('should calculate cost since timestamp', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const beforeTime = Date.now() + 1000;
      vi.setSystemTime(beforeTime);

      await meteringService.recordUsage(testPassportId, 'satellite', 5000);

      const recentCost = await meteringService.getTotalCost(testPassportId, undefined, beforeTime);
      const satellite = meteringService.getPartnerConfig('satellite')!;
      const expectedCost = (
        BigInt(satellite.costPerByte) * 5000n +
        BigInt(satellite.costPerRequest)
      ).toString();

      expect(recentCost).toBe(expectedCost);
    });

    it('should expose running totals per passport and partner', async () => {
      const totals = await meteringService.getTotals(testPassportId);
      expect(totals.requests).toBe(2);
      expect(totals.bytes).toBe('3000');

      const github = await meteringService.getTotals(testPassportId, 'github');
      expect(github.requests).toBe(1);
      expect(github.bytes).toBe('2000');
    });
  });

  describe('Analytics', () => {
    it('should break usage down by UTC day', async () => {
      await meteringService.recordUsage(testPassportId, 'newswire', 100);
      await meteringService.recordUsage(testPassportId, 'github', 200);

      const analytics = await meteringService.getAnalytics(testPassportId, undefined, 3);
      expect(analytics.dailyBreakdown).toHaveLength(3);
      expect(analytics.totalRequests).toBe(2);
      expect(analytics.totalBytes).toBe('300');

      const today = analytics.dailyBreakdown.at(-1)!;
      expect(today.date).toBe(new Date().toISOString().slice(0, 10));
      expect(today.requests).toBe(2);

      const githubOnly = await meteringService.getAnalytics(testPassportId, 'github', 1);
      expect(githubOnly.totalBytes).toBe('200');
    });
  });

  describe('Record Retention', () => {
    it('should drop expired records from usage but keep lifetime totals', async () => {
      let now = Date.now();
      const storage = new MemoryStorage({ now: () => now });
      const service = new MeteringService({ storage, recordTtlSeconds: 60 });

      await service.recordUsage(testPassportId, 'newswire', 100);
      expect(await service.getUsage(testPassportId)).toHaveLength(1);

      now += 61 * 1000;
      expect(await service.getUsage(testPassportId)).toHaveLength(0);
      expect((await service.getTotals(testPassportId)).requests).toBe(1);
      await service.close();
    });
  });

  describe('Rate Limiting Configuration', () => {
    it('should have rate limits for partners that require them', () => {
      const newswire = meteringService.getPartnerConfig('newswire')!;
      expect(newswire.rateLimits).toBeDefined();
      expect(newswire.rateLimits!.requests).toBe(1000);
      expect(newswire.rateLimits!.window).toBe(3600);

      const github = meteringService.getPartnerConfig('github')!;
      expect(github.rateLimits).toBeDefined();
      expect(github.rateLimits!.requests).toBe(5000);
    });

    it('should carry the satellite partner rate limits from its partner module', () => {
      const satellite = meteringService.getPartnerConfig('satellite')!;
      expect(satellite.rateLimits).toBeDefined();
      expect(satellite.rateLimits!.requests).toBe(100);
    });

    it('should mark the compute partner as not proxyable', () => {
      const compute = meteringService.getPartnerConfig('compute')!;
      expect(compute.baseUrl.startsWith('http')).toBe(false);
    });
  });

  describe('Concurrent Usage Recording', () => {
    it('should handle concurrent usage recording without losing totals', async () => {
      const promises = Array.from({ length: 100 }, (_, i) =>
        meteringService.recordUsage(testPassportId, testPartnerId, i * 10)
      );

      const records = await Promise.all(promises);
      expect(records).toHaveLength(100);
      expect(new Set(records.map((r) => r.id)).size).toBe(100);

      const usage = await meteringService.getUsage(testPassportId, testPartnerId);
      expect(usage).toHaveLength(100);

      const summed = records.reduce((sum, record) => sum + BigInt(record.cost), 0n);
      expect(await meteringService.getTotalCost(testPassportId, testPartnerId)).toBe(summed.toString());
      expect((await meteringService.getTotals(testPassportId)).bytes).toBe(
        records.reduce((sum, r) => sum + r.bytes, 0).toString()
      );
    });
  });
});
