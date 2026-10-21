import { createClient } from 'redis';
import { logger } from '../../common/logger.js';
import { MCPAgent, AgentTier, toAgentTier } from '../handlers/tool-handler.js';

export interface RateLimitResult {
  exceeded: boolean;
  limit: number;
  remaining: number;
  retryAfter?: number;
}

export class MCPRateLimit {
  private redisClient: any;
  private fallbackStore: Map<string, any> = new Map();

  constructor() {
    this.initRedis();
  }

  /**
   * Initialize Redis connection for rate limiting
   */
  private async initRedis() {
    try {
      if (process.env.REDIS_URL) {
        this.redisClient = createClient({ url: process.env.REDIS_URL });
        await this.redisClient.connect();
        logger.info('MCP Rate limiting using Redis');
      } else {
        logger.warn('No Redis URL provided, using memory-based rate limiting');
      }
    } catch (error) {
      logger.warn('Failed to connect to Redis for rate limiting, using memory fallback');
      this.redisClient = null;
    }
  }

  /**
   * Check rate limit for agent and tool
   */
  async checkLimit(agent: MCPAgent, tool: string): Promise<RateLimitResult> {
    try {
      const now = Date.now();
      const windowMs = 60 * 60 * 1000; // 1 hour window
      const limit = this.getTierRateLimit(agent.tier);
      
      // Create key for this agent/hour window
      const hourKey = Math.floor(now / windowMs);
      const key = `rate_limit:${agent.id}:${hourKey}`;

      let current = 0;

      if (this.redisClient) {
        // Use Redis for distributed rate limiting
        current = await this.checkRedisLimit(key, limit, windowMs);
      } else {
        // Use memory fallback
        current = this.checkMemoryLimit(key, limit, windowMs, now);
      }

      const remaining = Math.max(0, limit - current);
      const exceeded = current > limit;
      
      // Log rate limit usage for monitoring
      if (current % 10 === 0) { // Log every 10th request
        logger.info(`Rate limit check: ${agent.id}`, {
          current,
          limit,
          remaining,
          tier: agent.tier,
          tool
        });
      }

      return {
        exceeded,
        limit,
        remaining,
        retryAfter: exceeded ? this.calculateRetryAfter(windowMs, now) : undefined
      };
    } catch (error) {
      logger.error('Rate limit check failed:', error);
      // On error, allow the request but log the issue
      return {
        exceeded: false,
        limit: this.getTierRateLimit(agent.tier),
        remaining: this.getTierRateLimit(agent.tier)
      };
    }
  }

  /**
   * Check rate limit using Redis
   */
  private async checkRedisLimit(key: string, limit: number, windowMs: number): Promise<number> {
    try {
      // Use Redis pipeline for atomic operations
      const pipeline = this.redisClient.multi();
      pipeline.incr(key);
      pipeline.expire(key, Math.ceil(windowMs / 1000));
      
      const results = await pipeline.exec();
      return results[0][1]; // Return the incremented count
    } catch (error) {
      logger.error('Redis rate limit check failed:', error);
      // Fallback to memory if Redis fails
      return this.checkMemoryLimit(key, limit, windowMs, Date.now());
    }
  }

  /**
   * Check rate limit using memory (fallback)
   */
  private checkMemoryLimit(key: string, _limit: number, windowMs: number, now: number): number {
    const data = this.fallbackStore.get(key);
    
    if (!data || now - data.windowStart > windowMs) {
      // New window
      this.fallbackStore.set(key, {
        count: 1,
        windowStart: now
      });
      return 1;
    } else {
      // Same window, increment
      data.count++;
      this.fallbackStore.set(key, data);
      return data.count;
    }
  }

  /**
   * Calculate retry after time in seconds
   */
  private calculateRetryAfter(windowMs: number, now: number): number {
    const hourKey = Math.floor(now / windowMs);
    const nextHour = (hourKey + 1) * windowMs;
    return Math.ceil((nextHour - now) / 1000);
  }

  /**
   * Get rate limit for tier
   */
  private getTierRateLimit(tier: string): number {
    const limits: Record<AgentTier, number> = {
      free: 100,        // 100 requests per hour
      pro: 1000,        // 1000 requests per hour
      enterprise: 10000 // 10000 requests per hour
    };
    return limits[toAgentTier(tier)];
  }

  /**
   * Reset rate limit for agent (admin function)
   */
  async resetLimit(agentId: string): Promise<void> {
    try {
      if (this.redisClient) {
        const pattern = `rate_limit:${agentId}:*`;
        const keys = await this.redisClient.keys(pattern);
        if (keys.length > 0) {
          await this.redisClient.del(keys);
        }
      } else {
        // Clear from memory store
        for (const key of this.fallbackStore.keys()) {
          if (key.startsWith(`rate_limit:${agentId}:`)) {
            this.fallbackStore.delete(key);
          }
        }
      }
      
      logger.info(`Reset rate limit for agent: ${agentId}`);
    } catch (error) {
      logger.error('Failed to reset rate limit:', error);
      throw new Error('Failed to reset rate limit');
    }
  }

  /**
   * Get current usage for agent
   */
  async getCurrentUsage(agent: MCPAgent): Promise<{
    hourly: { current: number; limit: number };
    daily: { current: number; limit: number };
    monthly: { current: number; limit: number };
  }> {
    try {
      const now = Date.now();
      const hourMs = 60 * 60 * 1000;
      const dayMs = 24 * hourMs;
      const monthMs = 30 * dayMs;

      const hourKey = Math.floor(now / hourMs);
      const dayKey = Math.floor(now / dayMs);
      const monthKey = Math.floor(now / monthMs);

      let hourly = 0, daily = 0, monthly = 0;

      if (this.redisClient) {
        const [hourResult, dayResult, monthResult] = await Promise.all([
          this.redisClient.get(`rate_limit:${agent.id}:${hourKey}`),
          this.redisClient.get(`rate_limit_daily:${agent.id}:${dayKey}`),
          this.redisClient.get(`rate_limit_monthly:${agent.id}:${monthKey}`)
        ]);
        
        hourly = parseInt(hourResult) || 0;
        daily = parseInt(dayResult) || 0;
        monthly = parseInt(monthResult) || 0;
      } else {
        // Estimate from memory store (less accurate)
        hourly = this.fallbackStore.get(`rate_limit:${agent.id}:${hourKey}`)?.count || 0;
        daily = this.fallbackStore.get(`rate_limit_daily:${agent.id}:${dayKey}`)?.count || 0;
        monthly = this.fallbackStore.get(`rate_limit_monthly:${agent.id}:${monthKey}`)?.count || 0;
      }

      const tierLimits = this.getTierLimits(agent.tier);

      return {
        hourly: { current: hourly, limit: tierLimits.hourly },
        daily: { current: daily, limit: tierLimits.daily },
        monthly: { current: monthly, limit: tierLimits.monthly }
      };
    } catch (error) {
      logger.error('Failed to get current usage:', error);
      const tierLimits = this.getTierLimits(agent.tier);
      return {
        hourly: { current: 0, limit: tierLimits.hourly },
        daily: { current: 0, limit: tierLimits.daily },
        monthly: { current: 0, limit: tierLimits.monthly }
      };
    }
  }

  /**
   * Get all tier limits
   */
  private getTierLimits(tier: string) {
    const limits: Record<AgentTier, { hourly: number; daily: number; monthly: number }> = {
      free: {
        hourly: 100,
        daily: 1000,
        monthly: 10000
      },
      pro: {
        hourly: 1000,
        daily: 20000,
        monthly: -1 // unlimited
      },
      enterprise: {
        hourly: 10000,
        daily: 200000,
        monthly: -1 // unlimited
      }
    };
    return limits[toAgentTier(tier)];
  }

  /**
   * Track daily and monthly usage (called after successful request)
   */
  async trackUsage(agent: MCPAgent, _tool: string): Promise<void> {
    try {
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const monthMs = 30 * dayMs;

      const dayKey = Math.floor(now / dayMs);
      const monthKey = Math.floor(now / monthMs);

      const dailyKey = `rate_limit_daily:${agent.id}:${dayKey}`;
      const monthlyKey = `rate_limit_monthly:${agent.id}:${monthKey}`;

      if (this.redisClient) {
        const pipeline = this.redisClient.multi();
        pipeline.incr(dailyKey);
        pipeline.expire(dailyKey, Math.ceil(dayMs / 1000));
        pipeline.incr(monthlyKey);
        pipeline.expire(monthlyKey, Math.ceil(monthMs / 1000));
        await pipeline.exec();
      } else {
        // Update memory store
        this.updateMemoryCounter(dailyKey, dayMs, now);
        this.updateMemoryCounter(monthlyKey, monthMs, now);
      }
    } catch (error) {
      logger.error('Failed to track usage:', error);
      // Non-critical error, don't throw
    }
  }

  /**
   * Update memory counter
   */
  private updateMemoryCounter(key: string, windowMs: number, now: number) {
    const data = this.fallbackStore.get(key);
    
    if (!data || now - data.windowStart > windowMs) {
      this.fallbackStore.set(key, {
        count: 1,
        windowStart: now
      });
    } else {
      data.count++;
      this.fallbackStore.set(key, data);
    }
  }

  /**
   * Cleanup expired entries (run periodically)
   */
  async cleanup(): Promise<void> {
    try {
      const now = Date.now();
      const hourMs = 60 * 60 * 1000;

      // Clean memory store
      for (const [key, data] of this.fallbackStore.entries()) {
        if (data.windowStart && now - data.windowStart > hourMs) {
          this.fallbackStore.delete(key);
        }
      }

      logger.debug('Rate limit cleanup completed');
    } catch (error) {
      logger.error('Rate limit cleanup failed:', error);
    }
  }
}