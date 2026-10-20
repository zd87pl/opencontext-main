import { logger } from '../../common/logger.js';
import { ContentSearchService } from '../services/content-search.service.js';
import { ContentAccessService } from '../services/content-access.service.js';
import { PaymentService } from '../services/payment.service.js';
import { AnalyticsService } from '../services/analytics.service.js';
import { PreferencesService } from '../services/preferences.service.js';

export type AgentTier = 'free' | 'pro' | 'enterprise';

/** Maps a tier string from the database to a known tier, defaulting to free. */
export function toAgentTier(tier: string): AgentTier {
  return tier === 'pro' || tier === 'enterprise' ? tier : 'free';
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface MCPAgent {
  id: string;
  user_id: string;
  name: string;
  tier: AgentTier;
  api_key: string;
  permissions: string[];
  created_at: Date;
}

export interface MCPToolResult {
  success: boolean;
  data?: any;
  error?: string;
  details?: any;
}

export class MCPToolHandler {
  private contentSearch: ContentSearchService;
  private contentAccess: ContentAccessService;
  private paymentService: PaymentService;
  private analyticsService: AnalyticsService;
  private preferencesService: PreferencesService;

  constructor() {
    this.contentSearch = new ContentSearchService();
    this.contentAccess = new ContentAccessService();
    this.paymentService = new PaymentService();
    this.analyticsService = new AnalyticsService();
    this.preferencesService = new PreferencesService();
  }

  /**
   * Execute MCP tool
   */
  async execute(tool: string, args: any, agent: MCPAgent): Promise<MCPToolResult> {
    try {
      logger.info(`Executing MCP tool: ${tool}`, { agent_id: agent.id, args });

      switch (tool) {
        case 'search_premium_content':
          return await this.handleSearchContent(args, agent);
        
        case 'get_content_metadata':
          return await this.handleGetMetadata(args, agent);
        
        case 'purchase_content':
          return await this.handlePurchaseContent(args, agent);
        
        case 'get_content':
          return await this.handleGetContent(args, agent);
        
        case 'track_usage':
          return await this.handleTrackUsage(args, agent);
        
        case 'manage_preferences':
          return await this.handleManagePreferences(args, agent);
        
        default:
          return {
            success: false,
            error: `Unknown tool: ${tool}`,
            details: { available_tools: this.getAvailableTools() }
          };
      }
    } catch (error) {
      logger.error(`MCP tool execution failed: ${tool}`, { error, agent_id: agent.id });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Tool execution failed',
        details: { tool, agent_id: agent.id }
      };
    }
  }

  /**
   * Execute tool with streaming for large results
   */
  async executeStream(
    tool: string, 
    args: any, 
    agent: MCPAgent, 
    onChunk: (chunk: any) => void
  ): Promise<void> {
    try {
      // Only search supports streaming for now
      if (tool === 'search_premium_content') {
        await this.contentSearch.searchStream(args, agent, onChunk);
      } else {
        // For non-streaming tools, execute normally and send result
        const result = await this.execute(tool, args, agent);
        onChunk(result);
      }
    } catch (error) {
      logger.error(`MCP streaming execution failed: ${tool}`, { error, agent_id: agent.id });
      throw error;
    }
  }

  /**
   * Search premium content across platforms
   */
  private async handleSearchContent(args: any, agent: MCPAgent): Promise<MCPToolResult> {
    try {
      // Validate required parameters
      if (!args.query || typeof args.query !== 'string') {
        return {
          success: false,
          error: 'Query parameter is required and must be a string'
        };
      }

      // Apply tier-based limits
      const searchParams = this.applyTierLimits(args, agent);
      
      // Execute search
      const searchResults = await this.contentSearch.search(searchParams, agent);
      
      // Apply personalization if pro tier or higher
      if (agent.tier !== 'free') {
        searchResults.results = await this.contentSearch.personalizeResults(
          searchResults.results, 
          agent
        );
      }

      return {
        success: true,
        data: {
          results: searchResults.results,
          total_count: searchResults.total,
          search_time_ms: searchResults.searchTime,
          personalization_applied: agent.tier !== 'free',
          tier_limits: this.getTierLimits(agent.tier),
          facets: searchResults.facets
        }
      };
    } catch (error) {
      return {
        success: false,
        error: 'Content search failed',
        details: { message: errorMessage(error) }
      };
    }
  }

  /**
   * Get content metadata and preview
   */
  private async handleGetMetadata(args: any, agent: MCPAgent): Promise<MCPToolResult> {
    try {
      if (!args.content_id) {
        return {
          success: false,
          error: 'content_id parameter is required'
        };
      }

      const metadata = await this.contentAccess.getMetadata(
        args.content_id,
        agent,
        {
          includePreview: args.include_preview !== false,
          includeAnalytics: args.include_analytics === true && agent.tier !== 'free'
        }
      );

      if (!metadata) {
        return {
          success: false,
          error: 'Content not found',
          details: { content_id: args.content_id }
        };
      }

      return {
        success: true,
        data: metadata
      };
    } catch (error) {
      return {
        success: false,
        error: 'Failed to get content metadata',
        details: { message: errorMessage(error) }
      };
    }
  }

  /**
   * Purchase content access
   */
  private async handlePurchaseContent(args: any, agent: MCPAgent): Promise<MCPToolResult> {
    try {
      if (!args.content_id) {
        return {
          success: false,
          error: 'content_id parameter is required'
        };
      }

      // Check if user already has access
      const hasAccess = await this.contentAccess.checkAccess(args.content_id, agent.user_id);
      if (hasAccess) {
        return {
          success: true,
          data: {
            already_purchased: true,
            content_id: args.content_id,
            message: 'Content already accessible'
          }
        };
      }

      // Process purchase
      const purchaseResult = await this.paymentService.processPurchase({
        content_id: args.content_id,
        user_id: agent.user_id,
        agent_id: agent.id,
        payment_method: args.payment_method || 'account_balance',
        note: args.note
      });

      if (!purchaseResult.success) {
        return {
          success: false,
          error: 'Purchase failed',
          details: purchaseResult.details
        };
      }

      return {
        success: true,
        data: {
          transaction_id: purchaseResult.transaction_id,
          content_id: args.content_id,
          amount: purchaseResult.amount,
          access_granted: true,
          expires_at: purchaseResult.expires_at
        }
      };
    } catch (error) {
      return {
        success: false,
        error: 'Content purchase failed',
        details: { message: errorMessage(error) }
      };
    }
  }

  /**
   * Get purchased content
   */
  private async handleGetContent(args: any, agent: MCPAgent): Promise<MCPToolResult> {
    try {
      if (!args.content_id) {
        return {
          success: false,
          error: 'content_id parameter is required'
        };
      }

      // Check access
      const hasAccess = await this.contentAccess.checkAccess(args.content_id, agent.user_id);
      if (!hasAccess) {
        return {
          success: false,
          error: 'Access denied - content not purchased',
          details: { 
            content_id: args.content_id,
            suggestion: 'Use purchase_content tool first'
          }
        };
      }

      // Get content
      const content = await this.contentAccess.getContent(
        args.content_id,
        agent.user_id,
        {
          format: args.format || 'text'
        }
      );

      if (!content) {
        return {
          success: false,
          error: 'Content not found or access expired',
          details: { content_id: args.content_id }
        };
      }

      // Track access
      await this.analyticsService.trackContentAccess({
        content_id: args.content_id,
        user_id: agent.user_id,
        agent_id: agent.id,
        format: args.format || 'text'
      });

      return {
        success: true,
        data: content
      };
    } catch (error) {
      return {
        success: false,
        error: 'Failed to get content',
        details: { message: errorMessage(error) }
      };
    }
  }

  /**
   * Track content usage and provide feedback
   */
  private async handleTrackUsage(args: any, agent: MCPAgent): Promise<MCPToolResult> {
    try {
      if (!args.content_id || !args.usage_type) {
        return {
          success: false,
          error: 'content_id and usage_type parameters are required'
        };
      }

      await this.analyticsService.trackUsage({
        content_id: args.content_id,
        user_id: agent.user_id,
        agent_id: agent.id,
        usage_type: args.usage_type,
        satisfaction: args.satisfaction,
        feedback: args.feedback
      });

      return {
        success: true,
        data: {
          tracked: true,
          content_id: args.content_id,
          usage_type: args.usage_type
        }
      };
    } catch (error) {
      return {
        success: false,
        error: 'Failed to track usage',
        details: { message: errorMessage(error) }
      };
    }
  }

  /**
   * Manage AI agent preferences
   */
  private async handleManagePreferences(args: any, agent: MCPAgent): Promise<MCPToolResult> {
    try {
      // Update preferences if provided
      if (args.preferences) {
        await this.preferencesService.updatePreferences(agent.user_id, args.preferences);
      }

      // Update learning data if provided
      if (args.learning_data) {
        await this.preferencesService.updateLearningData(agent.user_id, args.learning_data);
      }

      // Get current preferences
      const currentPreferences = await this.preferencesService.getPreferences(agent.user_id);

      return {
        success: true,
        data: {
          preferences: currentPreferences,
          updated: !!(args.preferences || args.learning_data)
        }
      };
    } catch (error) {
      return {
        success: false,
        error: 'Failed to manage preferences',
        details: { message: errorMessage(error) }
      };
    }
  }

  /**
   * Apply tier-based limits to search parameters
   */
  private applyTierLimits(args: any, agent: MCPAgent): any {
    const tierLimits = this.getTierLimits(agent.tier);
    
    return {
      ...args,
      limit: Math.min(args.limit || 20, tierLimits.max_results),
      include_premium: agent.tier !== 'free' || args.include_premium === false
    };
  }

  /**
   * Get tier-based configuration
   */
  private getTierLimits(tier: string) {
    const limits: Record<AgentTier, {
      max_results: number;
      preview_length: number;
      monthly_searches: number;
      rate_limit: number;
      features: string[];
    }> = {
      free: {
        max_results: 20,
        preview_length: 200,
        monthly_searches: 1000,
        rate_limit: 100, // per hour
        features: ['basic_search', 'metadata_access']
      },
      pro: {
        max_results: 100,
        preview_length: 500,
        monthly_searches: -1, // unlimited
        rate_limit: 1000, // per hour
        features: ['unlimited_search', 'personalization', 'analytics', 'bulk_purchase']
      },
      enterprise: {
        max_results: 500,
        preview_length: 1000,
        monthly_searches: -1, // unlimited
        rate_limit: 10000, // per hour
        features: ['all_features', 'priority_support', 'custom_curation']
      }
    };

    return limits[toAgentTier(tier)];
  }

  /**
   * Get available tools
   */
  private getAvailableTools(): string[] {
    return [
      'search_premium_content',
      'get_content_metadata',
      'purchase_content', 
      'get_content',
      'track_usage',
      'manage_preferences'
    ];
  }

  /**
   * Health check for all services
   */
  async healthCheck(): Promise<any> {
    try {
      const checks = await Promise.allSettled([
        this.contentSearch.healthCheck(),
        this.contentAccess.healthCheck(),
        this.paymentService.healthCheck()
      ]);

      return {
        database: checks[0].status === 'fulfilled' && checks[0].value,
        search: checks[1].status === 'fulfilled' && checks[1].value,
        payments: checks[2].status === 'fulfilled' && checks[2].value
      };
    } catch (error) {
      logger.error('MCP health check failed:', error);
      return {
        database: false,
        search: false, 
        payments: false
      };
    }
  }
}