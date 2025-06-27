import { prisma } from '../../common/prisma.js';
import { logger } from '../../common/logger.js';
import { MCPAgent } from '../handlers/tool-handler.js';

export interface SearchParams {
  query: string;
  categories?: string[];
  price_range?: { min?: number; max?: number };
  platforms?: string[];
  content_types?: string[];
  sort_by?: 'relevance' | 'price' | 'date' | 'quality' | 'popularity';
  limit?: number;
  include_premium?: boolean;
}

export interface SearchResult {
  id: string;
  title: string;
  description?: string;
  author: string;
  price: number;
  preview: string;
  platform: string;
  content_type: string;
  quality_score: number;
  created_at: Date;
  personalized_score?: number;
  recommendation_reason?: string;
}

export interface SearchResults {
  results: SearchResult[];
  total: number;
  searchTime: number;
  facets: any;
}

export class ContentSearchService {
  /**
   * Search for content across all platforms
   */
  async search(params: SearchParams, agent: MCPAgent): Promise<SearchResults> {
    try {
      const startTime = Date.now();
      
      // Build where clause for Prisma
      const whereClause = this.buildWhereClause(params);
      
      // Build order by clause
      const orderBy = this.buildOrderBy(params.sort_by || 'relevance');
      
      // Execute search with pagination
      const [results, total] = await Promise.all([
        prisma.content.findMany({
          where: whereClause,
          orderBy,
          take: params.limit || 20,
          include: {
            user: {
              select: { name: true, avatar: true }
            }
          }
        }),
        prisma.content.count({ where: whereClause })
      ]);

      // Transform results
      const searchResults: SearchResult[] = results.map(content => ({
        id: content.id,
        title: content.title,
        description: content.description,
        author: content.user.name || 'Anonymous',
        price: Number(content.price),
        preview: content.preview || '',
        platform: content.platform,
        content_type: this.inferContentType(content),
        quality_score: this.calculateQualityScore(content),
        created_at: content.createdAt
      }));

      // Get facets for filtering
      const facets = await this.getFacets(whereClause);

      const searchTime = Date.now() - startTime;

      logger.info(`Content search completed`, {
        agent_id: agent.id,
        query: params.query,
        results_count: searchResults.length,
        total,
        search_time_ms: searchTime
      });

      return {
        results: searchResults,
        total,
        searchTime,
        facets
      };
    } catch (error) {
      logger.error('Content search failed:', error);
      throw new Error('Content search failed');
    }
  }

  /**
   * Search with streaming for large result sets
   */
  async searchStream(
    params: SearchParams, 
    agent: MCPAgent, 
    onChunk: (chunk: any) => void
  ): Promise<void> {
    try {
      const whereClause = this.buildWhereClause(params);
      const orderBy = this.buildOrderBy(params.sort_by || 'relevance');
      
      const batchSize = 10;
      let skip = 0;
      let hasMore = true;

      while (hasMore) {
        const batch = await prisma.content.findMany({
          where: whereClause,
          orderBy,
          take: batchSize,
          skip,
          include: {
            user: {
              select: { name: true, avatar: true }
            }
          }
        });

        if (batch.length === 0) {
          hasMore = false;
          break;
        }

        const results: SearchResult[] = batch.map(content => ({
          id: content.id,
          title: content.title,
          description: content.description,
          author: content.user.name || 'Anonymous',
          price: Number(content.price),
          preview: content.preview || '',
          platform: content.platform,
          content_type: this.inferContentType(content),
          quality_score: this.calculateQualityScore(content),
          created_at: content.createdAt
        }));

        // Send chunk
        onChunk({
          type: 'batch',
          data: results,
          batch_number: Math.floor(skip / batchSize) + 1
        });

        skip += batchSize;
        
        if (batch.length < batchSize) {
          hasMore = false;
        }
      }
    } catch (error) {
      logger.error('Streaming search failed:', error);
      throw error;
    }
  }

  /**
   * Personalize search results based on user history
   */
  async personalizeResults(results: SearchResult[], agent: MCPAgent): Promise<SearchResult[]> {
    try {
      // Get user's purchase history and preferences
      const [purchaseHistory, preferences] = await Promise.all([
        this.getUserPurchaseHistory(agent.user_id),
        this.getUserPreferences(agent.user_id)
      ]);

      // Score results based on personalization
      const personalizedResults = results.map(result => {
        const personalizedScore = this.calculatePersonalizedScore(
          result,
          purchaseHistory,
          preferences
        );

        return {
          ...result,
          personalized_score: personalizedScore,
          recommendation_reason: this.generateRecommendationReason(
            result, 
            purchaseHistory,
            preferences
          )
        };
      });

      // Re-sort by personalized score
      return personalizedResults.sort((a, b) => 
        (b.personalized_score || 0) - (a.personalized_score || 0)
      );
    } catch (error) {
      logger.error('Result personalization failed:', error);
      // Return original results if personalization fails
      return results;
    }
  }

  /**
   * Build Prisma where clause from search parameters
   */
  private buildWhereClause(params: SearchParams): any {
    const where: any = {
      published: true // Only published content
    };

    // Text search on title, description, and preview
    if (params.query) {
      where.OR = [
        { title: { contains: params.query, mode: 'insensitive' } },
        { description: { contains: params.query, mode: 'insensitive' } },
        { preview: { contains: params.query, mode: 'insensitive' } }
      ];
    }

    // Platform filter
    if (params.platforms && params.platforms.length > 0) {
      where.platform = { in: params.platforms };
    }

    // Price range filter
    if (params.price_range) {
      where.price = {};
      if (params.price_range.min !== undefined) {
        where.price.gte = params.price_range.min;
      }
      if (params.price_range.max !== undefined) {
        where.price.lte = params.price_range.max;
      }
    }

    return where;
  }

  /**
   * Build order by clause
   */
  private buildOrderBy(sortBy: string): any {
    switch (sortBy) {
      case 'price':
        return { price: 'asc' };
      case 'date':
        return { createdAt: 'desc' };
      case 'popularity':
        return [{ createdAt: 'desc' }, { price: 'asc' }]; // Proxy for popularity
      case 'quality':
        return [{ createdAt: 'desc' }]; // TODO: Implement quality scoring
      case 'relevance':
      default:
        return { createdAt: 'desc' }; // Default to newest first
    }
  }

  /**
   * Get search facets for filtering
   */
  private async getFacets(whereClause: any): Promise<any> {
    try {
      const [platforms, priceRanges] = await Promise.all([
        // Platform facets
        prisma.content.groupBy({
          by: ['platform'],
          where: whereClause,
          _count: { platform: true }
        }),
        // Price range facets
        prisma.content.findMany({
          where: whereClause,
          select: { price: true }
        })
      ]);

      // Calculate price range buckets
      const prices = priceRanges.map(p => Number(p.price));
      const priceStats = {
        min: Math.min(...prices),
        max: Math.max(...prices),
        avg: prices.reduce((a, b) => a + b, 0) / prices.length
      };

      return {
        platforms: platforms.map(p => ({
          value: p.platform,
          count: p._count.platform
        })),
        price_stats: priceStats,
        total_count: platforms.reduce((sum, p) => sum + p._count.platform, 0)
      };
    } catch (error) {
      logger.error('Failed to get search facets:', error);
      return {};
    }
  }

  /**
   * Infer content type from content data
   */
  private inferContentType(content: any): string {
    // Simple heuristic based on platform and content
    if (content.platform === 'github') return 'code';
    if (content.platform === 'wordpress') return 'article';
    if (content.platform === 'medium') return 'article';
    if (content.title?.toLowerCase().includes('tutorial')) return 'tutorial';
    if (content.title?.toLowerCase().includes('guide')) return 'guide';
    return 'content';
  }

  /**
   * Calculate quality score for content
   */
  private calculateQualityScore(content: any): number {
    let score = 50; // Base score

    // Length factor
    const previewLength = content.preview?.length || 0;
    if (previewLength > 500) score += 10;
    if (previewLength > 1000) score += 10;

    // Title quality
    if (content.title && content.title.length > 10) score += 5;
    if (content.description && content.description.length > 50) score += 5;

    // Platform reputation
    const platformScores = {
      'github': 10,
      'wordpress': 5,
      'medium': 5,
      'static': 0
    };
    score += platformScores[content.platform] || 0;

    // Recency bonus
    const daysSinceCreated = (Date.now() - content.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCreated < 30) score += 10;
    if (daysSinceCreated < 7) score += 5;

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Get user purchase history for personalization
   */
  private async getUserPurchaseHistory(userId: string): Promise<any[]> {
    try {
      const purchases = await prisma.purchase.findMany({
        where: {
          userId,
          status: 'COMPLETED'
        },
        include: {
          content: {
            select: {
              platform: true,
              price: true,
              title: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 50 // Last 50 purchases
      });

      return purchases;
    } catch (error) {
      logger.error('Failed to get purchase history:', error);
      return [];
    }
  }

  /**
   * Get user preferences
   */
  private async getUserPreferences(userId: string): Promise<any> {
    try {
      // This would come from a preferences table/service
      // For now, derive from purchase history
      const purchases = await this.getUserPurchaseHistory(userId);
      
      const platformCounts = purchases.reduce((acc, p) => {
        const platform = p.content?.platform;
        if (platform) {
          acc[platform] = (acc[platform] || 0) + 1;
        }
        return acc;
      }, {});

      const avgPrice = purchases.length > 0 
        ? purchases.reduce((sum, p) => sum + Number(p.content?.price || 0), 0) / purchases.length
        : 5;

      return {
        preferred_platforms: Object.keys(platformCounts).sort((a, b) => 
          platformCounts[b] - platformCounts[a]
        ),
        avg_price: avgPrice,
        purchase_count: purchases.length
      };
    } catch (error) {
      logger.error('Failed to get user preferences:', error);
      return {};
    }
  }

  /**
   * Calculate personalized score
   */
  private calculatePersonalizedScore(
    result: SearchResult,
    purchaseHistory: any[],
    preferences: any
  ): number {
    let score = result.quality_score;

    // Platform preference boost
    if (preferences.preferred_platforms?.includes(result.platform)) {
      score += 20;
    }

    // Price preference (favor content near user's average)
    if (preferences.avg_price) {
      const priceDiff = Math.abs(result.price - preferences.avg_price);
      const priceScore = Math.max(0, 10 - priceDiff);
      score += priceScore;
    }

    // Content type similarity
    const similarContent = purchaseHistory.filter(p => 
      result.content_type === this.inferContentType(p.content)
    ).length;
    if (similarContent > 0) {
      score += Math.min(15, similarContent * 3);
    }

    return Math.min(100, score);
  }

  /**
   * Generate recommendation reason
   */
  private generateRecommendationReason(
    result: SearchResult,
    purchaseHistory: any[],
    preferences: any
  ): string {
    const reasons = [];

    if (preferences.preferred_platforms?.includes(result.platform)) {
      reasons.push(`Popular ${result.platform} content`);
    }

    if (preferences.avg_price && Math.abs(result.price - preferences.avg_price) < 2) {
      reasons.push('Matches your price range');
    }

    const similarContent = purchaseHistory.filter(p => 
      result.content_type === this.inferContentType(p.content)
    ).length;
    if (similarContent > 2) {
      reasons.push(`You've enjoyed similar ${result.content_type} content`);
    }

    if (result.quality_score > 80) {
      reasons.push('High quality content');
    }

    return reasons.length > 0 ? reasons.join(', ') : 'Matches your search';
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await prisma.content.count();
      return true;
    } catch (error) {
      logger.error('Content search health check failed:', error);
      return false;
    }
  }
}