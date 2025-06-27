import { prisma } from '../../common/prisma.js';
import { logger } from '../../common/logger.js';
import { 
  retrieveContentKeyFromEscrow,
  checkUserContentAccess 
} from '../../content/key-escrow.service.js';
import { decryptContent } from '../../content/encryption.service.js';
import { MCPAgent } from '../handlers/tool-handler.js';

export interface ContentMetadata {
  id: string;
  title: string;
  description?: string;
  author: string;
  author_avatar?: string;
  price: number;
  preview: string;
  platform: string;
  content_type: string;
  quality_score: number;
  created_at: Date;
  updated_at: Date;
  purchase_count?: number;
  rating?: number;
  tags?: string[];
  estimated_read_time?: number;
  analytics?: {
    views: number;
    purchases: number;
    satisfaction_score: number;
  };
}

export interface ContentData {
  id: string;
  title: string;
  content: string;
  format: string;
  metadata: ContentMetadata;
  access_info: {
    purchased_at: Date;
    expires_at?: Date;
    usage_rights: string[];
  };
}

export class ContentAccessService {
  /**
   * Get content metadata
   */
  async getMetadata(
    contentId: string,
    agent: MCPAgent,
    options: {
      includePreview?: boolean;
      includeAnalytics?: boolean;
    } = {}
  ): Promise<ContentMetadata | null> {
    try {
      const content = await prisma.content.findUnique({
        where: { id: contentId },
        include: {
          user: {
            select: { name: true, avatar: true }
          }
        }
      });

      if (!content) {
        return null;
      }

      // Get additional analytics if requested and tier allows
      let analytics = undefined;
      if (options.includeAnalytics && agent.tier !== 'free') {
        analytics = await this.getContentAnalytics(contentId);
      }

      // Calculate estimated read time
      const estimatedReadTime = this.calculateReadTime(content.preview || '');

      const metadata: ContentMetadata = {
        id: content.id,
        title: content.title,
        description: content.description,
        author: content.user.name || 'Anonymous',
        author_avatar: content.user.avatar,
        price: Number(content.price),
        preview: options.includePreview !== false ? content.preview || '' : '',
        platform: content.platform,
        content_type: this.inferContentType(content),
        quality_score: this.calculateQualityScore(content),
        created_at: content.createdAt,
        updated_at: content.updatedAt,
        estimated_read_time: estimatedReadTime,
        analytics
      };

      logger.info(`Retrieved metadata for content: ${contentId}`, {
        agent_id: agent.id,
        include_analytics: options.includeAnalytics
      });

      return metadata;
    } catch (error) {
      logger.error('Failed to get content metadata:', error);
      throw new Error('Failed to get content metadata');
    }
  }

  /**
   * Check if user has access to content
   */
  async checkAccess(contentId: string, userId: string): Promise<boolean> {
    try {
      return await checkUserContentAccess(userId, contentId);
    } catch (error) {
      logger.error('Failed to check content access:', error);
      return false;
    }
  }

  /**
   * Get decrypted content for user
   */
  async getContent(
    contentId: string,
    userId: string,
    options: {
      format?: 'text' | 'markdown' | 'html' | 'json';
    } = {}
  ): Promise<ContentData | null> {
    try {
      // Check access
      const hasAccess = await this.checkAccess(contentId, userId);
      if (!hasAccess) {
        logger.warn(`Access denied for content: ${contentId}, user: ${userId}`);
        return null;
      }

      // Get content record
      const content = await prisma.content.findUnique({
        where: { id: contentId },
        include: {
          user: {
            select: { name: true, avatar: true }
          }
        }
      });

      if (!content) {
        return null;
      }

      // Get decrypted content
      const contentKey = await retrieveContentKeyFromEscrow(contentId, userId);
      if (!contentKey) {
        logger.error(`No content key available for: ${contentId}, user: ${userId}`);
        return null;
      }

      // Decrypt content
      const encryptedContent = JSON.parse(content.encryptedContent);
      const decryptedContent = decryptContent(encryptedContent, contentKey);

      // Format content based on request
      const formattedContent = this.formatContent(decryptedContent, options.format || 'text');

      // Get access info
      const accessInfo = await this.getAccessInfo(contentId, userId);

      const contentData: ContentData = {
        id: content.id,
        title: content.title,
        content: formattedContent,
        format: options.format || 'text',
        metadata: {
          id: content.id,
          title: content.title,
          description: content.description,
          author: content.user.name || 'Anonymous',
          author_avatar: content.user.avatar,
          price: Number(content.price),
          preview: content.preview || '',
          platform: content.platform,
          content_type: this.inferContentType(content),
          quality_score: this.calculateQualityScore(content),
          created_at: content.createdAt,
          updated_at: content.updatedAt,
          estimated_read_time: this.calculateReadTime(decryptedContent)
        },
        access_info: accessInfo
      };

      logger.info(`Content accessed: ${contentId} by user: ${userId}`);

      return contentData;
    } catch (error) {
      logger.error('Failed to get content:', error);
      throw new Error('Failed to get content');
    }
  }

  /**
   * Get content analytics
   */
  private async getContentAnalytics(contentId: string): Promise<any> {
    try {
      const [purchases, usage] = await Promise.all([
        // Purchase analytics
        prisma.purchase.aggregate({
          where: { 
            contentId,
            status: 'COMPLETED'
          },
          _count: { id: true },
          _avg: { amount: true }
        }),
        // Usage analytics (if we had usage tracking)
        prisma.purchase.findMany({
          where: { 
            contentId,
            status: 'COMPLETED'
          },
          select: { createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 30 // Last 30 purchases for trends
        })
      ]);

      return {
        views: purchases._count.id * 2, // Estimate views as 2x purchases
        purchases: purchases._count.id,
        avg_price: Number(purchases._avg.amount) || 0,
        recent_purchases: usage.length,
        satisfaction_score: 4.2 // TODO: Implement actual satisfaction tracking
      };
    } catch (error) {
      logger.error('Failed to get content analytics:', error);
      return {
        views: 0,
        purchases: 0,
        satisfaction_score: 0
      };
    }
  }

  /**
   * Get access information for user
   */
  private async getAccessInfo(contentId: string, userId: string): Promise<any> {
    try {
      const purchase = await prisma.purchase.findFirst({
        where: {
          contentId,
          userId,
          status: 'COMPLETED',
          accessGranted: true
        },
        orderBy: { createdAt: 'desc' }
      });

      if (!purchase) {
        throw new Error('No valid purchase found');
      }

      return {
        purchased_at: purchase.createdAt,
        expires_at: purchase.accessExpiresAt,
        usage_rights: [
          'read',
          'reference',
          'ai_processing'
        ],
        purchase_id: purchase.id
      };
    } catch (error) {
      logger.error('Failed to get access info:', error);
      return {
        purchased_at: new Date(),
        usage_rights: ['read']
      };
    }
  }

  /**
   * Format content based on requested format
   */
  private formatContent(content: string, format: string): string {
    switch (format) {
      case 'html':
        // Simple markdown to HTML conversion
        return content
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<em>$1</em>')
          .replace(/\n\n/g, '</p><p>')
          .replace(/^(.*)$/gm, '<p>$1</p>')
          .replace(/<p><\/p>/g, '');
      
      case 'json':
        // Return structured JSON
        return JSON.stringify({
          content,
          metadata: {
            format: 'text',
            length: content.length,
            estimated_read_time: this.calculateReadTime(content)
          }
        }, null, 2);
      
      case 'markdown':
        // Return as-is if already markdown, otherwise add basic formatting
        return content;
      
      case 'text':
      default:
        // Clean text format
        return content.replace(/[#*_`]/g, ''); // Remove markdown symbols
    }
  }

  /**
   * Calculate estimated read time
   */
  private calculateReadTime(content: string): number {
    const wordsPerMinute = 200;
    const wordCount = content.split(/\s+/).length;
    return Math.ceil(wordCount / wordsPerMinute);
  }

  /**
   * Infer content type
   */
  private inferContentType(content: any): string {
    if (content.platform === 'github') return 'code';
    if (content.platform === 'wordpress') return 'article';
    if (content.platform === 'medium') return 'article';
    if (content.title?.toLowerCase().includes('tutorial')) return 'tutorial';
    if (content.title?.toLowerCase().includes('guide')) return 'guide';
    if (content.title?.toLowerCase().includes('api')) return 'documentation';
    return 'content';
  }

  /**
   * Calculate quality score
   */
  private calculateQualityScore(content: any): number {
    let score = 50;

    // Content length
    const previewLength = content.preview?.length || 0;
    if (previewLength > 500) score += 10;
    if (previewLength > 1000) score += 10;

    // Title and description quality
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

    // Recency
    const daysSinceCreated = (Date.now() - content.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCreated < 30) score += 10;

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Get user's purchased content list
   */
  async getUserPurchasedContent(userId: string, limit = 50): Promise<ContentMetadata[]> {
    try {
      const purchases = await prisma.purchase.findMany({
        where: {
          userId,
          status: 'COMPLETED',
          accessGranted: true,
          OR: [
            { accessExpiresAt: null },
            { accessExpiresAt: { gt: new Date() } }
          ]
        },
        include: {
          content: {
            include: {
              user: {
                select: { name: true, avatar: true }
              }
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: limit
      });

      return purchases.map(purchase => ({
        id: purchase.content.id,
        title: purchase.content.title,
        description: purchase.content.description,
        author: purchase.content.user.name || 'Anonymous',
        author_avatar: purchase.content.user.avatar,
        price: Number(purchase.content.price),
        preview: purchase.content.preview || '',
        platform: purchase.content.platform,
        content_type: this.inferContentType(purchase.content),
        quality_score: this.calculateQualityScore(purchase.content),
        created_at: purchase.content.createdAt,
        updated_at: purchase.content.updatedAt,
        estimated_read_time: this.calculateReadTime(purchase.content.preview || '')
      }));
    } catch (error) {
      logger.error('Failed to get user purchased content:', error);
      throw new Error('Failed to get purchased content');
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await prisma.content.count();
      return true;
    } catch (error) {
      logger.error('Content access health check failed:', error);
      return false;
    }
  }
}