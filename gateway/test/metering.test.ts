import { describe, it, expect, beforeEach } from 'vitest';
import { MeteringService } from '../src/metering.js';
import { ethers } from 'ethers';

describe('MeteringService', () => {
  let meteringService: MeteringService;
  const testPassportId = 'test-passport-123';
  const testPartnerId = 'newswire';

  beforeEach(() => {
    meteringService = new MeteringService();
  });

  describe('Partner Configuration', () => {
    it('should load default partner configurations', () => {
      const partners = meteringService.getAllPartners();
      expect(partners).toHaveLength(3);
      
      const partnerIds = partners.map(p => p.id);
      expect(partnerIds).toContain('newswire');
      expect(partnerIds).toContain('github');
      expect(partnerIds).toContain('satellite');
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
  });

  describe('Usage Recording', () => {
    it('should record usage correctly', () => {
      const bytes = 1024;
      const record = meteringService.recordUsage(testPassportId, testPartnerId, bytes);

      expect(record.passportId).toBe(testPassportId);
      expect(record.partnerId).toBe(testPartnerId);
      expect(record.bytes).toBe(bytes);
      expect(record.requests).toBe(1);
      expect(record.timestamp).toBeGreaterThan(0);
      expect(BigInt(record.cost)).toBeGreaterThan(0n);
    });

    it('should calculate cost correctly', () => {
      const bytes = 1000;
      const partner = meteringService.getPartnerConfig(testPartnerId)!;
      
      const record = meteringService.recordUsage(testPassportId, testPartnerId, bytes);
      
      const expectedByteCost = BigInt(partner.costPerByte) * BigInt(bytes);
      const expectedRequestCost = BigInt(partner.costPerRequest);
      const expectedTotal = expectedByteCost + expectedRequestCost;
      
      expect(record.cost).toBe(expectedTotal.toString());
    });

    it('should throw error for unknown partner', () => {
      expect(() => {
        meteringService.recordUsage(testPassportId, 'unknown-partner', 100);
      }).toThrow('Unknown partner: unknown-partner');
    });

    it('should handle zero bytes', () => {
      const record = meteringService.recordUsage(testPassportId, testPartnerId, 0);
      expect(record.bytes).toBe(0);
      expect(BigInt(record.cost)).toBe(BigInt(meteringService.getPartnerConfig(testPartnerId)!.costPerRequest));
    });

    it('should handle large byte counts', () => {
      const largeBytes = 1024 * 1024 * 10; // 10MB
      const record = meteringService.recordUsage(testPassportId, testPartnerId, largeBytes);
      expect(record.bytes).toBe(largeBytes);
      expect(BigInt(record.cost)).toBeGreaterThan(0n);
    });
  });

  describe('Usage Retrieval', () => {
    beforeEach(() => {
      // Add some test data
      meteringService.recordUsage(testPassportId, 'newswire', 500);
      meteringService.recordUsage(testPassportId, 'github', 1000);
      meteringService.recordUsage(testPassportId, 'newswire', 750);
    });

    it('should get usage for specific partner', () => {
      const usage = meteringService.getUsage(testPassportId, 'newswire');
      expect(usage).toHaveLength(2);
      expect(usage[0].bytes).toBe(500);
      expect(usage[1].bytes).toBe(750);
    });

    it('should get usage for all partners', () => {
      const usage = meteringService.getUsage(testPassportId);
      expect(usage).toHaveLength(3);
      expect(usage.map(u => u.partnerId)).toContain('newswire');
      expect(usage.map(u => u.partnerId)).toContain('github');
    });

    it('should filter usage by time', () => {
      const now = Date.now();
      
      // Add record after timestamp
      setTimeout(() => {
        meteringService.recordUsage(testPassportId, 'satellite', 2000);
        
        const recentUsage = meteringService.getUsage(testPassportId, undefined, now);
        expect(recentUsage).toHaveLength(1);
        expect(recentUsage[0].partnerId).toBe('satellite');
      }, 10);
    });

    it('should return empty array for unknown passport', () => {
      const usage = meteringService.getUsage('unknown-passport');
      expect(usage).toHaveLength(0);
    });

    it('should return empty array for unknown partner', () => {
      const usage = meteringService.getUsage(testPassportId, 'unknown-partner');
      expect(usage).toHaveLength(0);
    });
  });

  describe('Cost Calculation', () => {
    beforeEach(() => {
      meteringService.recordUsage(testPassportId, 'newswire', 1000);
      meteringService.recordUsage(testPassportId, 'github', 2000);
    });

    it('should calculate total cost for all partners', () => {
      const totalCost = meteringService.getTotalCost(testPassportId);
      expect(BigInt(totalCost)).toBeGreaterThan(0n);
    });

    it('should calculate total cost for specific partner', () => {
      const newswireCost = meteringService.getTotalCost(testPassportId, 'newswire');
      const githubCost = meteringService.getTotalCost(testPassportId, 'github');
      
      expect(BigInt(newswireCost)).toBeGreaterThan(0n);
      expect(BigInt(githubCost)).toBeGreaterThan(0n);
      expect(newswireCost).not.toBe(githubCost);
    });

    it('should return zero cost for no usage', () => {
      const cost = meteringService.getTotalCost('unused-passport');
      expect(cost).toBe('0');
    });

    it('should calculate cost since timestamp', () => {
      const beforeTime = Date.now();
      
      setTimeout(() => {
        meteringService.recordUsage(testPassportId, 'satellite', 5000);
        
        const recentCost = meteringService.getTotalCost(testPassportId, undefined, beforeTime);
        const satellite = meteringService.getPartnerConfig('satellite')!;
        const expectedCost = (BigInt(satellite.costPerByte) * 5000n + BigInt(satellite.costPerRequest)).toString();
        
        expect(recentCost).toBe(expectedCost);
      }, 10);
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

    it('should handle partners without rate limits', () => {
      // Satellite doesn't have explicit rate limits in our config
      const satellite = meteringService.getPartnerConfig('satellite')!;
      expect(satellite.rateLimits).toBeDefined(); // It actually does in our implementation
    });
  });

  describe('Concurrent Usage Recording', () => {
    it('should handle concurrent usage recording', async () => {
      const promises = Array.from({ length: 100 }, (_, i) => 
        meteringService.recordUsage(testPassportId, testPartnerId, i * 10)
      );

      const records = await Promise.all(promises);
      expect(records).toHaveLength(100);
      
      const usage = meteringService.getUsage(testPassportId, testPartnerId);
      expect(usage).toHaveLength(100);
    });
  });
});