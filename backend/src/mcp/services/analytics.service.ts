import { prisma } from '../../common/prisma.js';
import { logger } from '../../common/logger.js';

export interface UsageTrackingData {
  content_id: string;
  user_id: string;
  agent_id: string;
  usage_type: 'view' | 'download' | 'process' | 'reference';
  satisfaction?: number;
  feedback?: string;
}

export interface ContentAccessData {
  content_id: string;
  user_id: string;
  agent_id: string;
  format: string;
}

export interface ToolExecutionData {
  agent_id: string;
  tool: string;
  execution_time_ms: number;
  success: boolean;
  user_id: string;
}

export class AnalyticsService {
  /**
   * Track content usage and feedback
   */
  async trackUsage(data: UsageTrackingData): Promise<void> {
    try {
      // Create usage event
      await prisma.analyticsEvent.create({
        data: {
          type: 'CONTENT_USAGE',
          userId: data.user_id,
          metadata: {
            content_id: data.content_id,
            agent_id: data.agent_id,
            usage_type: data.usage_type,
            satisfaction: data.satisfaction,
            feedback: data.feedback
          }
        }
      });

      // Update content usage stats
      await this.updateContentStats(data.content_id, data.usage_type, data.satisfaction);

      logger.info(`Tracked content usage: ${data.content_id}`, {
        user_id: data.user_id,
        agent_id: data.agent_id,
        usage_type: data.usage_type
      });
    } catch (error) {
      logger.error('Failed to track usage:', error);
      throw new Error('Failed to track usage');
    }
  }

  /**
   * Track content access
   */
  async trackContentAccess(data: ContentAccessData): Promise<void> {
    try {
      await prisma.analyticsEvent.create({
        data: {
          type: 'CONTENT_ACCESS',
          userId: data.user_id,
          metadata: {
            content_id: data.content_id,
            agent_id: data.agent_id,
            format: data.format
          }
        }
      });

      // Update access count
      await prisma.content.update({
        where: { id: data.content_id },
        data: {
          accessCount: {
            increment: 1
          }
        }
      });

      logger.info(`Tracked content access: ${data.content_id}`, {
        user_id: data.user_id,
        agent_id: data.agent_id,
        format: data.format
      });
    } catch (error) {
      logger.error('Failed to track content access:', error);
      // Non-critical error, don't throw
    }
  }

  /**
   * Track MCP tool execution
   */
  async trackToolExecution(data: ToolExecutionData): Promise<void> {
    try {
      await prisma.analyticsEvent.create({
        data: {
          type: 'TOOL_EXECUTION',
          userId: data.user_id,
          metadata: {
            agent_id: data.agent_id,
            tool: data.tool,
            execution_time_ms: data.execution_time_ms,
            success: data.success
          }
        }
      });

      // Update agent usage stats
      await this.updateAgentStats(data.agent_id, data.tool, data.success);

      logger.debug(`Tracked tool execution: ${data.tool}`, {
        agent_id: data.agent_id,
        success: data.success,
        execution_time: data.execution_time_ms
      });
    } catch (error) {
      logger.error('Failed to track tool execution:', error);
      // Non-critical error, don't throw
    }
  }

  /**
   * Get content analytics
   */
  async getContentAnalytics(contentId: string, period = '30d'): Promise<any> {
    try {
      const since = this.getDateFromPeriod(period);

      const [views, purchases, usage, satisfaction] = await Promise.all([
        // View analytics
        prisma.analyticsEvent.count({
          where: {
            type: 'CONTENT_ACCESS',
            metadata: {
              path: ['content_id'],
              equals: contentId
            },
            createdAt: { gte: since }
          }
        }),
        
        // Purchase analytics
        prisma.purchase.count({
          where: {
            contentId,
            status: 'COMPLETED',
            createdAt: { gte: since }
          }
        }),

        // Usage breakdown
        prisma.analyticsEvent.groupBy({
          by: ['metadata'],
          where: {
            type: 'CONTENT_USAGE',
            metadata: {
              path: ['content_id'],
              equals: contentId
            },
            createdAt: { gte: since }
          },
          _count: { id: true }
        }),

        // Satisfaction scores
        prisma.analyticsEvent.findMany({
          where: {
            type: 'CONTENT_USAGE',
            metadata: {
              path: ['content_id'],
              equals: contentId
            },
            createdAt: { gte: since }
          },
          select: { metadata: true }
        })
      ]);

      // Calculate satisfaction average
      const satisfactionScores = satisfaction
        .map(event => event.metadata?.satisfaction)
        .filter(score => typeof score === 'number');
      
      const avgSatisfaction = satisfactionScores.length > 0
        ? satisfactionScores.reduce((a, b) => a + b, 0) / satisfactionScores.length
        : null;

      return {
        period,
        views,
        purchases,
        conversion_rate: views > 0 ? (purchases / views) * 100 : 0,
        avg_satisfaction: avgSatisfaction,
        usage_breakdown: this.processUsageBreakdown(usage),
        total_revenue: await this.getContentRevenue(contentId, since)
      };
    } catch (error) {
      logger.error('Failed to get content analytics:', error);
      throw new Error('Failed to get content analytics');
    }
  }

  /**
   * Get agent analytics
   */
  async getAgentAnalytics(agentId: string, period = '30d'): Promise<any> {
    try {
      const since = this.getDateFromPeriod(period);

      const [toolUsage, purchases, errors] = await Promise.all([
        // Tool usage breakdown
        prisma.analyticsEvent.groupBy({
          by: ['metadata'],
          where: {
            type: 'TOOL_EXECUTION',
            metadata: {
              path: ['agent_id'],
              equals: agentId
            },
            createdAt: { gte: since }
          },
          _count: { id: true }
        }),

        // Purchase analytics
        prisma.purchase.aggregate({
          where: {
            metadata: {
              path: ['agent_id'],
              equals: agentId
            },
            createdAt: { gte: since }
          },
          _count: { id: true },
          _sum: { amount: true }
        }),

        // Error rate
        prisma.analyticsEvent.count({
          where: {
            type: 'TOOL_EXECUTION',
            metadata: {
              path: ['agent_id'],
              equals: agentId,
              path: ['success'],
              equals: false
            },
            createdAt: { gte: since }
          }
        })
      ]);

      const totalToolCalls = toolUsage.reduce((sum, tool) => sum + tool._count.id, 0);
      const errorRate = totalToolCalls > 0 ? (errors / totalToolCalls) * 100 : 0;

      return {
        period,
        total_tool_calls: totalToolCalls,
        total_purchases: purchases._count.id,
        total_spent: Number(purchases._sum.amount) || 0,
        error_rate: errorRate,
        tool_breakdown: this.processToolBreakdown(toolUsage),
        avg_purchase_value: purchases._count.id > 0 
          ? Number(purchases._sum.amount) / purchases._count.id 
          : 0
      };
    } catch (error) {
      logger.error('Failed to get agent analytics:', error);
      throw new Error('Failed to get agent analytics');
    }
  }

  /**
   * Get platform-wide analytics
   */
  async getPlatformAnalytics(period = '30d'): Promise<any> {
    try {
      const since = this.getDateFromPeriod(period);

      const [totalPurchases, totalRevenue, activeAgents, topContent] = await Promise.all([
        // Purchase metrics
        prisma.purchase.count({
          where: {
            status: 'COMPLETED',
            createdAt: { gte: since }
          }
        }),

        // Revenue metrics
        prisma.purchase.aggregate({
          where: {
            status: 'COMPLETED',
            createdAt: { gte: since }
          },
          _sum: { amount: true }
        }),

        // Active agents
        prisma.analyticsEvent.findMany({
          where: {
            type: 'TOOL_EXECUTION',
            createdAt: { gte: since }
          },
          select: { metadata: true },
          distinct: ['metadata']
        }),

        // Top performing content
        prisma.purchase.groupBy({
          by: ['contentId'],
          where: {
            status: 'COMPLETED',
            createdAt: { gte: since }
          },
          _count: { contentId: true },
          _sum: { amount: true },
          orderBy: { _count: { contentId: 'desc' } },
          take: 10
        })
      ]);

      const uniqueAgents = new Set(
        activeAgents
          .map(event => event.metadata?.agent_id)
          .filter(Boolean)
      ).size;

      return {
        period,
        total_purchases: totalPurchases,
        total_revenue: Number(totalRevenue._sum.amount) || 0,
        active_agents: uniqueAgents,
        avg_purchase_value: totalPurchases > 0 
          ? Number(totalRevenue._sum.amount) / totalPurchases 
          : 0,
        top_content: await this.enrichTopContent(topContent)
      };
    } catch (error) {
      logger.error('Failed to get platform analytics:', error);
      throw new Error('Failed to get platform analytics');
    }
  }

  /**
   * Update content statistics
   */
  private async updateContentStats(
    contentId: string, 
    usageType: string, 
    satisfaction?: number
  ): Promise<void> {
    try {
      // This would update a content_stats table if we had one
      // For now, we rely on the analytics events
      logger.debug(`Updated content stats: ${contentId}`, {
        usage_type: usageType,
        satisfaction
      });
    } catch (error) {
      logger.error('Failed to update content stats:', error);
    }
  }

  /**
   * Update agent statistics
   */
  private async updateAgentStats(
    agentId: string, 
    tool: string, 
    success: boolean
  ): Promise<void> {
    try {
      // This would update an agent_stats table if we had one
      // For now, we rely on the analytics events
      logger.debug(`Updated agent stats: ${agentId}`, {
        tool,
        success
      });
    } catch (error) {
      logger.error('Failed to update agent stats:', error);
    }
  }

  /**
   * Get date from period string
   */
  private getDateFromPeriod(period: string): Date {
    const now = new Date();
    
    switch (period) {
      case '1d':
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case '7d':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case '30d':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      case '90d':
        return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      default:
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
  }

  /**
   * Process usage breakdown data
   */
  private processUsageBreakdown(usage: any[]): any {
    const breakdown = {
      view: 0,
      download: 0,
      process: 0,
      reference: 0
    };

    usage.forEach(item => {
      const usageType = item.metadata?.usage_type;
      if (usageType && breakdown.hasOwnProperty(usageType)) {
        breakdown[usageType] += item._count.id;
      }
    });

    return breakdown;
  }

  /**
   * Process tool breakdown data
   */
  private processToolBreakdown(toolUsage: any[]): any {
    const breakdown = {};

    toolUsage.forEach(item => {
      const tool = item.metadata?.tool;
      if (tool) {
        breakdown[tool] = (breakdown[tool] || 0) + item._count.id;
      }
    });

    return breakdown;
  }

  /**
   * Get content revenue for period
   */
  private async getContentRevenue(contentId: string, since: Date): Promise<number> {
    try {
      const result = await prisma.purchase.aggregate({
        where: {
          contentId,
          status: 'COMPLETED',
          createdAt: { gte: since }
        },
        _sum: { amount: true }
      });

      return Number(result._sum.amount) || 0;
    } catch (error) {
      logger.error('Failed to get content revenue:', error);
      return 0;
    }
  }

  /**
   * Enrich top content with metadata
   */
  private async enrichTopContent(topContent: any[]): Promise<any[]> {
    try {
      const contentIds = topContent.map(item => item.contentId);
      
      const contentDetails = await prisma.content.findMany({
        where: { id: { in: contentIds } },
        select: {
          id: true,
          title: true,
          platform: true,
          price: true
        }
      });

      return topContent.map(item => {
        const details = contentDetails.find(c => c.id === item.contentId);
        return {
          content_id: item.contentId,
          title: details?.title || 'Unknown',
          platform: details?.platform || 'Unknown',
          price: Number(details?.price) || 0,
          purchase_count: item._count.contentId,
          total_revenue: Number(item._sum.amount) || 0
        };
      });
    } catch (error) {
      logger.error('Failed to enrich top content:', error);
      return topContent;
    }
  }
}