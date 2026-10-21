import { Request } from 'express';
import crypto from 'crypto';
import { prisma } from '../../common/prisma.js';
import { logger } from '../../common/logger.js';
import { MCPAgent, AgentTier, toAgentTier } from '../handlers/tool-handler.js';

export type AuthResult =
  | { success: true; agent: MCPAgent }
  | { success: false; error: string };

const TIER_RATE_LIMITS: Record<AgentTier, number> = {
  free: 100,        // 100 requests per hour
  pro: 1000,        // 1000 requests per hour
  enterprise: 10000 // 10000 requests per hour
};

const TIER_SEARCH_LIMITS: Record<AgentTier, number> = {
  free: 1000,  // 1000 searches per month
  pro: -1,     // unlimited
  enterprise: -1 // unlimited
};

export class MCPAuth {
  /**
   * Authenticate MCP request
   */
  async authenticate(req: Request): Promise<AuthResult> {
    try {
      // 1. Check API key
      const apiKey = req.headers['opencontext-api-key'] as string;
      if (!apiKey) {
        return { success: false, error: 'Missing API key' };
      }

      // 2. Validate API key format
      if (!this.isValidApiKeyFormat(apiKey)) {
        return { success: false, error: 'Invalid API key format' };
      }

      // 3. Get agent from database
      const agent = await this.getAgentByApiKey(apiKey);
      if (!agent) {
        return { success: false, error: 'Invalid API key' };
      }

      // 4. Check if agent is active
      if (!agent.active) {
        return { success: false, error: 'Agent account suspended' };
      }

      // 5. Verify request signature if provided
      const signature = req.headers['opencontext-signature'] as string;
      if (signature) {
        const signatureValid = await this.verifyRequestSignature(
          req.body,
          signature,
          agent.secret_key
        );
        if (!signatureValid) {
          return { success: false, error: 'Invalid request signature' };
        }
      }

      // 6. Update last seen
      await this.updateLastSeen(agent.id);

      return {
        success: true,
        agent: {
          id: agent.id,
          user_id: agent.userId,
          name: agent.name,
          tier: agent.tier as 'free' | 'pro' | 'enterprise',
          api_key: agent.apiKey,
          permissions: agent.permissions || [],
          created_at: agent.createdAt
        }
      };
    } catch (error) {
      logger.error('MCP authentication failed:', error);
      return { success: false, error: 'Authentication error' };
    }
  }

  /**
   * Create new AI agent for user
   */
  async createAgent(userId: string, agentData: {
    name: string;
    description?: string;
    tier?: 'free' | 'pro' | 'enterprise';
    permissions?: string[];
  }): Promise<MCPAgent> {
    try {
      const apiKey = this.generateApiKey();
      const secretKey = this.generateSecretKey();

      const agent = await prisma.aIAgent.create({
        data: {
          userId,
          name: agentData.name,
          description: agentData.description,
          apiKey,
          secretKey,
          tier: agentData.tier || 'free',
          permissions: agentData.permissions || ['search', 'purchase', 'access'],
          active: true,
          rateLimitHour: this.getTierRateLimit(agentData.tier || 'free'),
          monthlySearchLimit: this.getTierSearchLimit(agentData.tier || 'free')
        }
      });

      logger.info(`Created AI agent: ${agent.id} for user: ${userId}`);

      return {
        id: agent.id,
        user_id: agent.userId,
        name: agent.name,
        tier: agent.tier as 'free' | 'pro' | 'enterprise',
        api_key: agent.apiKey,
        permissions: agent.permissions || [],
        created_at: agent.createdAt
      };
    } catch (error) {
      logger.error('Failed to create AI agent:', error);
      throw new Error('Failed to create AI agent');
    }
  }

  /**
   * Update agent tier (for upgrades/downgrades)
   */
  async updateAgentTier(agentId: string, newTier: 'free' | 'pro' | 'enterprise'): Promise<void> {
    try {
      await prisma.aIAgent.update({
        where: { id: agentId },
        data: {
          tier: newTier,
          rateLimitHour: this.getTierRateLimit(newTier),
          monthlySearchLimit: this.getTierSearchLimit(newTier),
          updatedAt: new Date()
        }
      });

      logger.info(`Updated agent ${agentId} to tier: ${newTier}`);
    } catch (error) {
      logger.error('Failed to update agent tier:', error);
      throw new Error('Failed to update agent tier');
    }
  }

  /**
   * Revoke API key (security)
   */
  async revokeApiKey(agentId: string): Promise<string> {
    try {
      const newApiKey = this.generateApiKey();
      
      await prisma.aIAgent.update({
        where: { id: agentId },
        data: {
          apiKey: newApiKey,
          updatedAt: new Date()
        }
      });

      logger.info(`Revoked and regenerated API key for agent: ${agentId}`);
      return newApiKey;
    } catch (error) {
      logger.error('Failed to revoke API key:', error);
      throw new Error('Failed to revoke API key');
    }
  }

  /**
   * Get agent by API key
   */
  private async getAgentByApiKey(apiKey: string): Promise<any> {
    try {
      return await prisma.aIAgent.findUnique({
        where: { apiKey },
        include: {
          user: {
            select: { id: true, name: true, email: true }
          }
        }
      });
    } catch (error) {
      logger.error('Failed to get agent by API key:', error);
      return null;
    }
  }

  /**
   * Verify request signature for additional security
   */
  private async verifyRequestSignature(
    requestBody: any,
    signature: string,
    secretKey: string
  ): Promise<boolean> {
    try {
      const bodyString = JSON.stringify(requestBody);
      const expectedSignature = crypto
        .createHmac('sha256', secretKey)
        .update(bodyString)
        .digest('hex');

      return crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expectedSignature, 'hex')
      );
    } catch (error) {
      logger.error('Signature verification failed:', error);
      return false;
    }
  }

  /**
   * Update agent last seen timestamp
   */
  private async updateLastSeen(agentId: string): Promise<void> {
    try {
      await prisma.aIAgent.update({
        where: { id: agentId },
        data: { lastSeenAt: new Date() }
      });
    } catch (error) {
      // Non-critical error, just log
      logger.warn('Failed to update agent last seen:', error);
    }
  }

  /**
   * Generate secure API key
   */
  private generateApiKey(): string {
    const prefix = 'oc_';
    const randomPart = crypto.randomBytes(24).toString('hex');
    return `${prefix}${randomPart}`;
  }

  /**
   * Generate secret key for signatures
   */
  private generateSecretKey(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Validate API key format
   */
  private isValidApiKeyFormat(apiKey: string): boolean {
    return /^oc_[a-f0-9]{48}$/.test(apiKey);
  }

  /**
   * Get rate limit for tier
   */
  private getTierRateLimit(tier: string): number {
    return TIER_RATE_LIMITS[toAgentTier(tier)];
  }

  /**
   * Get search limit for tier
   */
  private getTierSearchLimit(tier: string): number {
    return TIER_SEARCH_LIMITS[toAgentTier(tier)];
  }

  /**
   * List user's AI agents
   */
  async getUserAgents(userId: string): Promise<MCPAgent[]> {
    try {
      const agents = await prisma.aIAgent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' }
      });

      return agents.map(agent => ({
        id: agent.id,
        user_id: agent.userId,
        name: agent.name,
        tier: agent.tier as 'free' | 'pro' | 'enterprise',
        api_key: agent.apiKey,
        permissions: agent.permissions || [],
        created_at: agent.createdAt
      }));
    } catch (error) {
      logger.error('Failed to get user agents:', error);
      throw new Error('Failed to get user agents');
    }
  }

  /**
   * Delete AI agent
   */
  async deleteAgent(agentId: string, userId: string): Promise<void> {
    try {
      await prisma.aIAgent.deleteMany({
        where: {
          id: agentId,
          userId // Ensure user owns the agent
        }
      });

      logger.info(`Deleted AI agent: ${agentId} for user: ${userId}`);
    } catch (error) {
      logger.error('Failed to delete AI agent:', error);
      throw new Error('Failed to delete AI agent');
    }
  }
}