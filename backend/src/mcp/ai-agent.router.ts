import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken } from '../auth/auth.middleware.js';
import { logger } from '../common/logger.js';
import { MCPAuth } from './auth/mcp-auth.js';
import { MCPRateLimit } from './middleware/rate-limit.js';
import { AgentTier, toAgentTier } from './handlers/tool-handler.js';

export const aiAgentRouter = Router();

const mcpAuth = new MCPAuth();
const mcpRateLimit = new MCPRateLimit();

// Validation schemas
const createAgentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  tier: z.enum(['free', 'pro', 'enterprise']).default('free'),
  permissions: z.array(z.string()).default(['search', 'purchase', 'access'])
});

const updateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  active: z.boolean().optional()
});

/**
 * Create new AI agent
 */
aiAgentRouter.post('/', authenticateToken, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    const agentData = createAgentSchema.parse(req.body);

    // Check if user has reached agent limit
    const existingAgents = await mcpAuth.getUserAgents(userId);
    const tierLimits = {
      free: 1,
      pro: 5,
      enterprise: 20
    };

    const userTier = agentData.tier; // In real app, get from user subscription
    if (existingAgents.length >= tierLimits[userTier]) {
      res.status(400).json({
        error: 'Agent limit reached',
        limit: tierLimits[userTier],
        current: existingAgents.length,
        upgrade_message: userTier === 'free'
          ? 'Upgrade to Pro for more AI agents'
          : 'Contact us for enterprise limits'
      });
      return;
    }

    // Create the agent
    const agent = await mcpAuth.createAgent(userId, agentData);

    res.status(201).json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        api_key: agent.api_key,
        tier: agent.tier,
        permissions: agent.permissions,
        created_at: agent.created_at
      },
      usage_info: {
        rate_limit: getTierRateLimit(agent.tier),
        monthly_searches: getTierSearchLimit(agent.tier),
        features: getTierFeatures(agent.tier)
      }
    });

    logger.info(`Created AI agent: ${agent.id} for user: ${userId}`);
  } catch (error) {
    logger.error('Failed to create AI agent:', error);
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Invalid input',
        details: error.errors
      });
      return;
    }
    next(error);
  }
});

/**
 * List user's AI agents
 */
aiAgentRouter.get('/', authenticateToken, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    const agents = await mcpAuth.getUserAgents(userId);

    // Get usage for each agent
    const agentsWithUsage = await Promise.all(
      agents.map(async (agent) => {
        const usage = await mcpRateLimit.getCurrentUsage(agent);
        return {
          id: agent.id,
          name: agent.name,
          tier: agent.tier,
          permissions: agent.permissions,
          created_at: agent.created_at,
          api_key: agent.api_key.substring(0, 8) + '...', // Masked API key
          usage: {
            hourly: usage.hourly,
            daily: usage.daily,
            monthly: usage.monthly
          }
        };
      })
    );

    res.json({
      agents: agentsWithUsage,
      total: agents.length
    });
  } catch (error) {
    logger.error('Failed to list AI agents:', error);
    next(error);
  }
});

/**
 * Get specific AI agent details
 */
aiAgentRouter.get('/:agentId', authenticateToken, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    const { agentId } = req.params;

    const agents = await mcpAuth.getUserAgents(userId);
    const agent = agents.find(a => a.id === agentId);

    if (!agent) {
      res.status(404).json({
        error: 'Agent not found'
      });
      return;
    }

    // Get detailed usage
    const usage = await mcpRateLimit.getCurrentUsage(agent);

    res.json({
      agent: {
        id: agent.id,
        name: agent.name,
        tier: agent.tier,
        permissions: agent.permissions,
        created_at: agent.created_at,
        api_key: agent.api_key, // Full API key for owner
        usage,
        limits: {
          rate_limit: getTierRateLimit(agent.tier),
          monthly_searches: getTierSearchLimit(agent.tier),
          features: getTierFeatures(agent.tier)
        }
      }
    });
  } catch (error) {
    logger.error('Failed to get AI agent:', error);
    next(error);
  }
});

/**
 * Update AI agent
 */
aiAgentRouter.put('/:agentId', authenticateToken, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    const { agentId } = req.params;
    const updateData = updateAgentSchema.parse(req.body);

    // Verify agent ownership
    const agents = await mcpAuth.getUserAgents(userId);
    const agent = agents.find(a => a.id === agentId);

    if (!agent) {
      res.status(404).json({
        error: 'Agent not found'
      });
      return;
    }

    // Update agent (simplified - in real implementation, update database)
    // For now, we'll just return success
    res.json({
      success: true,
      message: 'Agent updated successfully',
      agent: {
        id: agent.id,
        name: updateData.name || agent.name,
        tier: agent.tier,
        permissions: agent.permissions,
        updated_at: new Date().toISOString()
      }
    });

    logger.info(`Updated AI agent: ${agentId} for user: ${userId}`);
  } catch (error) {
    logger.error('Failed to update AI agent:', error);
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Invalid input',
        details: error.errors
      });
      return;
    }
    next(error);
  }
});

/**
 * Regenerate API key
 */
aiAgentRouter.post('/:agentId/regenerate-key', authenticateToken, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    const { agentId } = req.params;

    // Verify agent ownership
    const agents = await mcpAuth.getUserAgents(userId);
    const agent = agents.find(a => a.id === agentId);

    if (!agent) {
      res.status(404).json({
        error: 'Agent not found'
      });
      return;
    }

    // Regenerate API key
    const newApiKey = await mcpAuth.revokeApiKey(agentId);

    res.json({
      success: true,
      new_api_key: newApiKey,
      message: 'API key regenerated successfully',
      warning: 'Update your applications with the new API key'
    });

    logger.info(`Regenerated API key for agent: ${agentId}`);
  } catch (error) {
    logger.error('Failed to regenerate API key:', error);
    next(error);
  }
});

/**
 * Delete AI agent
 */
aiAgentRouter.delete('/:agentId', authenticateToken, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    const { agentId } = req.params;

    // Verify agent ownership
    const agents = await mcpAuth.getUserAgents(userId);
    const agent = agents.find(a => a.id === agentId);

    if (!agent) {
      res.status(404).json({
        error: 'Agent not found'
      });
      return;
    }

    // Delete agent
    await mcpAuth.deleteAgent(agentId, userId);

    res.json({
      success: true,
      message: 'AI agent deleted successfully'
    });

    logger.info(`Deleted AI agent: ${agentId} for user: ${userId}`);
  } catch (error) {
    logger.error('Failed to delete AI agent:', error);
    next(error);
  }
});

/**
 * Get agent usage analytics
 */
aiAgentRouter.get('/:agentId/analytics', authenticateToken, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    const { agentId } = req.params;
    const period = (req.query.period as string) || '30d';

    // Verify agent ownership
    const agents = await mcpAuth.getUserAgents(userId);
    const agent = agents.find(a => a.id === agentId);

    if (!agent) {
      res.status(404).json({
        error: 'Agent not found'
      });
      return;
    }

    // Get analytics (simplified for now)
    const analytics = {
      period,
      total_requests: 0,
      successful_requests: 0,
      error_rate: 0,
      avg_response_time: 0,
      top_tools: [],
      spending: {
        total_amount: 0,
        content_purchases: 0,
        avg_purchase_value: 0
      }
    };

    res.json({
      agent_id: agentId,
      analytics
    });
  } catch (error) {
    logger.error('Failed to get agent analytics:', error);
    next(error);
  }
});

/**
 * Reset agent rate limits (admin function)
 */
aiAgentRouter.post('/:agentId/reset-limits', authenticateToken, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    const { agentId } = req.params;

    // Verify agent ownership
    const agents = await mcpAuth.getUserAgents(userId);
    const agent = agents.find(a => a.id === agentId);

    if (!agent) {
      res.status(404).json({
        error: 'Agent not found'
      });
      return;
    }

    // Reset rate limits
    await mcpRateLimit.resetLimit(agentId);

    res.json({
      success: true,
      message: 'Rate limits reset successfully'
    });

    logger.info(`Reset rate limits for agent: ${agentId}`);
  } catch (error) {
    logger.error('Failed to reset rate limits:', error);
    next(error);
  }
});

// Helper functions
function getTierRateLimit(tier: string): number {
  const limits: Record<AgentTier, number> = {
    free: 100,
    pro: 1000,
    enterprise: 10000
  };
  return limits[toAgentTier(tier)];
}

function getTierSearchLimit(tier: string): number {
  const limits: Record<AgentTier, number> = {
    free: 1000,
    pro: -1, // unlimited
    enterprise: -1 // unlimited
  };
  return limits[toAgentTier(tier)];
}

function getTierFeatures(tier: string): string[] {
  const features: Record<AgentTier, string[]> = {
    free: ['basic_search', 'content_access'],
    pro: ['unlimited_search', 'personalization', 'analytics', 'priority_support'],
    enterprise: ['all_features', 'custom_integrations', 'dedicated_support', 'sla']
  };
  return features[toAgentTier(tier)];
}