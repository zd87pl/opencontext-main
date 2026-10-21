import { prisma } from '../../common/prisma.js';
import { logger } from '../../common/logger.js';

// Type aliases (not interfaces) so these are assignable to Prisma's Json input type.
export type UserPreferences = {
  content_types?: string[];
  max_price_per_item?: number;
  preferred_platforms?: string[];
  quality_threshold?: number;
  auto_purchase_enabled?: boolean;
  notification_settings?: {
    new_content: boolean;
    price_drops: boolean;
    recommendations: boolean;
  };
}

export type LearningData = {
  interests?: string[];
  interaction_patterns?: any;
  feedback_history?: any;
  custom_data?: any;
}

export class PreferencesService {
  /**
   * Update user preferences
   */
  async updatePreferences(userId: string, preferences: UserPreferences): Promise<void> {
    try {
      // Validate preferences
      const validatedPreferences = this.validatePreferences(preferences);

      // Update or create preferences record
      await prisma.userPreferences.upsert({
        where: { userId },
        update: {
          preferences: validatedPreferences,
          updatedAt: new Date()
        },
        create: {
          userId,
          preferences: validatedPreferences
        }
      });

      logger.info(`Updated preferences for user: ${userId}`, {
        preferences: validatedPreferences
      });
    } catch (error) {
      logger.error('Failed to update preferences:', error);
      throw new Error('Failed to update preferences');
    }
  }

  /**
   * Get user preferences
   */
  async getPreferences(userId: string): Promise<UserPreferences> {
    try {
      const userPreferences = await prisma.userPreferences.findUnique({
        where: { userId }
      });

      if (!userPreferences) {
        // Return default preferences
        return this.getDefaultPreferences();
      }

      return userPreferences.preferences as UserPreferences;
    } catch (error) {
      logger.error('Failed to get preferences:', error);
      // Return defaults on error
      return this.getDefaultPreferences();
    }
  }

  /**
   * Update learning data for personalization
   */
  async updateLearningData(userId: string, learningData: LearningData): Promise<void> {
    try {
      // Validate and sanitize learning data
      const validatedData = this.validateLearningData(learningData);

      // Update or create learning data record
      await prisma.userLearningData.upsert({
        where: { userId },
        update: {
          learningData: validatedData,
          updatedAt: new Date()
        },
        create: {
          userId,
          learningData: validatedData
        }
      });

      logger.info(`Updated learning data for user: ${userId}`);
    } catch (error) {
      logger.error('Failed to update learning data:', error);
      throw new Error('Failed to update learning data');
    }
  }

  /**
   * Get user learning data
   */
  async getLearningData(userId: string): Promise<LearningData> {
    try {
      const learningData = await prisma.userLearningData.findUnique({
        where: { userId }
      });

      return learningData?.learningData as LearningData || {};
    } catch (error) {
      logger.error('Failed to get learning data:', error);
      return {};
    }
  }

  /**
   * Generate recommendations based on preferences and learning data
   */
  async generateRecommendations(userId: string, limit = 20): Promise<any[]> {
    try {
      const [preferences, learningData, purchaseHistory] = await Promise.all([
        this.getPreferences(userId),
        this.getLearningData(userId),
        this.getUserPurchaseHistory(userId)
      ]);

      // Build recommendation query
      const whereClause = this.buildRecommendationQuery(preferences, learningData, purchaseHistory);

      // Get recommended content
      const recommendations = await prisma.content.findMany({
        where: whereClause,
        include: {
          user: {
            select: { name: true, avatar: true }
          }
        },
        orderBy: [
          { createdAt: 'desc' },
          { accessCount: 'desc' }
        ],
        take: limit
      });

      // Score and rank recommendations
      const scoredRecommendations = recommendations.map(content => ({
        id: content.id,
        title: content.title,
        description: content.description,
        author: content.user.name || 'Anonymous',
        price: Number(content.price),
        preview: content.preview || '',
        platform: content.platform,
        score: this.calculateRecommendationScore(content, preferences, learningData),
        reason: this.generateRecommendationReason(content, preferences, learningData)
      }));

      // Sort by score
      return scoredRecommendations.sort((a, b) => b.score - a.score);
    } catch (error) {
      logger.error('Failed to generate recommendations:', error);
      throw new Error('Failed to generate recommendations');
    }
  }

  /**
   * Track user interaction for learning
   */
  async trackInteraction(userId: string, interaction: {
    type: 'search' | 'view' | 'purchase' | 'feedback';
    content_id?: string;
    query?: string;
    rating?: number;
    metadata?: any;
  }): Promise<void> {
    try {
      // Get current learning data
      const currentData = await this.getLearningData(userId);

      // Update interaction patterns
      const updatedPatterns = this.updateInteractionPatterns(currentData, interaction);

      // Save updated learning data
      await this.updateLearningData(userId, {
        ...currentData,
        interaction_patterns: updatedPatterns
      });

      logger.debug(`Tracked interaction for user: ${userId}`, {
        type: interaction.type,
        content_id: interaction.content_id
      });
    } catch (error) {
      logger.error('Failed to track interaction:', error);
      // Non-critical error, don't throw
    }
  }

  /**
   * Validate preferences data
   */
  private validatePreferences(preferences: UserPreferences): UserPreferences {
    const validated: UserPreferences = {};

    // Validate content types
    if (preferences.content_types && Array.isArray(preferences.content_types)) {
      validated.content_types = preferences.content_types.filter(
        type => typeof type === 'string' && type.length > 0
      );
    }

    // Validate max price
    if (typeof preferences.max_price_per_item === 'number' && preferences.max_price_per_item > 0) {
      validated.max_price_per_item = Math.min(preferences.max_price_per_item, 1000); // Cap at $1000
    }

    // Validate platforms
    if (preferences.preferred_platforms && Array.isArray(preferences.preferred_platforms)) {
      const validPlatforms = ['wordpress', 'github', 'medium', 'static'];
      validated.preferred_platforms = preferences.preferred_platforms.filter(
        platform => validPlatforms.includes(platform)
      );
    }

    // Validate quality threshold
    if (typeof preferences.quality_threshold === 'number') {
      validated.quality_threshold = Math.max(1, Math.min(5, preferences.quality_threshold));
    }

    // Validate auto purchase
    if (typeof preferences.auto_purchase_enabled === 'boolean') {
      validated.auto_purchase_enabled = preferences.auto_purchase_enabled;
    }

    // Validate notification settings
    if (preferences.notification_settings && typeof preferences.notification_settings === 'object') {
      validated.notification_settings = {
        new_content: Boolean(preferences.notification_settings.new_content),
        price_drops: Boolean(preferences.notification_settings.price_drops),
        recommendations: Boolean(preferences.notification_settings.recommendations)
      };
    }

    return validated;
  }

  /**
   * Validate learning data
   */
  private validateLearningData(learningData: LearningData): LearningData {
    const validated: LearningData = {};

    // Validate interests
    if (learningData.interests && Array.isArray(learningData.interests)) {
      validated.interests = learningData.interests.filter(
        interest => typeof interest === 'string' && interest.length > 0
      ).slice(0, 50); // Limit to 50 interests
    }

    // Validate interaction patterns (allow any structure but limit size)
    if (learningData.interaction_patterns && typeof learningData.interaction_patterns === 'object') {
      const serialized = JSON.stringify(learningData.interaction_patterns);
      if (serialized.length < 100000) { // Limit to 100KB
        validated.interaction_patterns = learningData.interaction_patterns;
      }
    }

    // Validate feedback history
    if (learningData.feedback_history && typeof learningData.feedback_history === 'object') {
      validated.feedback_history = learningData.feedback_history;
    }

    // Validate custom data
    if (learningData.custom_data && typeof learningData.custom_data === 'object') {
      const serialized = JSON.stringify(learningData.custom_data);
      if (serialized.length < 50000) { // Limit to 50KB
        validated.custom_data = learningData.custom_data;
      }
    }

    return validated;
  }

  /**
   * Get default preferences
   */
  private getDefaultPreferences(): UserPreferences {
    return {
      content_types: ['article', 'tutorial', 'guide'],
      max_price_per_item: 10,
      preferred_platforms: ['wordpress', 'github'],
      quality_threshold: 3,
      auto_purchase_enabled: false,
      notification_settings: {
        new_content: true,
        price_drops: true,
        recommendations: true
      }
    };
  }

  /**
   * Build recommendation query based on preferences
   */
  private buildRecommendationQuery(
    preferences: UserPreferences,
    _learningData: LearningData,
    purchaseHistory: any[]
  ): any {
    const where: any = {
      published: true
    };

    // Exclude already purchased content
    if (purchaseHistory.length > 0) {
      const purchasedIds = purchaseHistory.map(p => p.contentId);
      where.id = { notIn: purchasedIds };
    }

    // Filter by preferred platforms
    if (preferences.preferred_platforms && preferences.preferred_platforms.length > 0) {
      where.platform = { in: preferences.preferred_platforms };
    }

    // Filter by max price
    if (preferences.max_price_per_item) {
      where.price = { lte: preferences.max_price_per_item };
    }

    return where;
  }

  /**
   * Calculate recommendation score
   */
  private calculateRecommendationScore(
    content: any,
    preferences: UserPreferences,
    learningData: LearningData
  ): number {
    let score = 50; // Base score

    // Platform preference
    if (preferences.preferred_platforms?.includes(content.platform)) {
      score += 20;
    }

    // Price preference
    if (preferences.max_price_per_item && content.price <= preferences.max_price_per_item) {
      score += 15;
    }

    // Quality threshold
    const qualityScore = this.calculateContentQuality(content);
    if (preferences.quality_threshold && qualityScore >= preferences.quality_threshold) {
      score += 10;
    }

    // Interest matching
    if (learningData.interests) {
      const interestMatch = this.calculateInterestMatch(content, learningData.interests);
      score += interestMatch * 20;
    }

    // Recency bonus
    const daysSinceCreated = (Date.now() - content.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCreated < 7) score += 5;
    if (daysSinceCreated < 30) score += 3;

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Calculate content quality score
   */
  private calculateContentQuality(content: any): number {
    let quality = 3; // Base quality

    if (content.description && content.description.length > 100) quality += 0.5;
    if (content.preview && content.preview.length > 500) quality += 0.5;
    if (content.accessCount > 10) quality += 0.5;

    return Math.min(5, quality);
  }

  /**
   * Calculate interest match score
   */
  private calculateInterestMatch(content: any, interests: string[]): number {
    const contentText = `${content.title} ${content.description} ${content.preview}`.toLowerCase();
    
    let matches = 0;
    for (const interest of interests) {
      if (contentText.includes(interest.toLowerCase())) {
        matches++;
      }
    }

    return Math.min(1, matches / interests.length);
  }

  /**
   * Generate recommendation reason
   */
  private generateRecommendationReason(
    content: any,
    preferences: UserPreferences,
    learningData: LearningData
  ): string {
    const reasons = [];

    if (preferences.preferred_platforms?.includes(content.platform)) {
      reasons.push(`Matches your ${content.platform} preference`);
    }

    if (preferences.max_price_per_item && content.price <= preferences.max_price_per_item) {
      reasons.push('Within your price range');
    }

    if (learningData.interests) {
      const contentText = `${content.title} ${content.description}`.toLowerCase();
      const matchingInterests = learningData.interests.filter(
        interest => contentText.includes(interest.toLowerCase())
      );
      if (matchingInterests.length > 0) {
        reasons.push(`Matches your interest in ${matchingInterests[0]}`);
      }
    }

    const daysSinceCreated = (Date.now() - content.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCreated < 7) {
      reasons.push('Recently published');
    }

    return reasons.length > 0 ? reasons.join(', ') : 'Recommended for you';
  }

  /**
   * Update interaction patterns
   */
  private updateInteractionPatterns(currentData: LearningData, interaction: any): any {
    const patterns = currentData.interaction_patterns || {};
    
    // Track interaction type frequency
    patterns[interaction.type] = (patterns[interaction.type] || 0) + 1;
    
    // Track search queries
    if (interaction.type === 'search' && interaction.query) {
      patterns.search_queries = patterns.search_queries || [];
      patterns.search_queries.push({
        query: interaction.query,
        timestamp: new Date().toISOString()
      });
      
      // Keep only last 100 queries
      if (patterns.search_queries.length > 100) {
        patterns.search_queries = patterns.search_queries.slice(-100);
      }
    }
    
    // Track ratings
    if (interaction.rating) {
      patterns.ratings = patterns.ratings || [];
      patterns.ratings.push({
        content_id: interaction.content_id,
        rating: interaction.rating,
        timestamp: new Date().toISOString()
      });
      
      // Keep only last 50 ratings
      if (patterns.ratings.length > 50) {
        patterns.ratings = patterns.ratings.slice(-50);
      }
    }

    return patterns;
  }

  /**
   * Get user purchase history
   */
  private async getUserPurchaseHistory(userId: string): Promise<any[]> {
    try {
      return await prisma.purchase.findMany({
        where: {
          userId,
          status: 'COMPLETED'
        },
        select: { contentId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100
      });
    } catch (error) {
      logger.error('Failed to get purchase history:', error);
      return [];
    }
  }
}