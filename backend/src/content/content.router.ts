import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken, optionalAuth } from '../auth/auth.middleware.js';
import { AppError } from '../common/middleware/error-handler.js';
import { logger } from '../common/logger.js';
import { 
  simulateClientSideEncryption,
  decryptContent,
  generatePreview
} from './encryption.service.js';
import { 
  retrieveContentKeyFromEscrow,
  grantContentAccess,
  getUserContentKeys
} from './key-escrow.service.js';
import { checkContentAccess } from '../payments/payment.service.js';
import { prisma } from '../common/prisma.js';

export const contentRouter = Router();

// Validation schemas
const createContentSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  content: z.string().min(1),
  platform: z.string().default('static'),
  platformId: z.string().optional(),
  price: z.number().positive()
});

const getContentSchema = z.object({
  decrypt: z.boolean().optional().default(false)
});

/**
 * Create encrypted content
 */
contentRouter.post('/create', authenticateToken, async (req, res, next) => {
  try {
    const { title, description, content, platform, platformId, price } = createContentSchema.parse(req.body);
    const userId = (req.user as any).id;
    
    // Simulate client-side encryption
    const encryptionResult = simulateClientSideEncryption(content, {
      title,
      author: (req.user as any).name || 'Anonymous',
      price,
      userId
    });
    
    // Store content in database
    const contentRecord = await prisma.content.create({
      data: {
        userId,
        title,
        description,
        platform,
        platformId,
        price,
        encryptedContent: JSON.stringify(encryptionResult.publicData.encrypted_blob),
        encryptedKey: JSON.stringify(encryptionResult.contentKeyData),
        preview: encryptionResult.publicData.preview,
        published: true
      }
    });
    
    // Grant creator access to their own content
    const contentKey = Buffer.from(encryptionResult.contentKeyData.contentKey, 'hex');
    await grantContentAccess(contentRecord.id, userId, contentKey);
    
    logger.info(`Created encrypted content: ${contentRecord.id} by user: ${userId}`);
    
    res.status(201).json({
      success: true,
      content: {
        id: contentRecord.id,
        title: contentRecord.title,
        description: contentRecord.description,
        preview: contentRecord.preview,
        price: contentRecord.price,
        platform: contentRecord.platform,
        encrypted: true,
        createdAt: contentRecord.createdAt
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Get content by ID (with optional decryption for authenticated users)
 */
contentRouter.get('/:contentId', optionalAuth, async (req, res, next) => {
  try {
    const { contentId } = req.params;
    const { decrypt } = getContentSchema.parse(req.query);
    const userId = (req.user as any)?.id;
    
    // Get content from database
    const content = await prisma.content.findUnique({
      where: { id: contentId },
      include: {
        user: {
          select: {
            name: true,
            avatar: true
          }
        }
      }
    });
    
    if (!content) {
      throw new AppError(404, 'Content not found');
    }
    
    // Basic response structure
    const response = {
      id: content.id,
      title: content.title,
      description: content.description,
      preview: content.preview,
      price: content.price,
      platform: content.platform,
      author: content.user.name || 'Anonymous',
      authorAvatar: content.user.avatar,
      encrypted: true,
      createdAt: content.createdAt
    };
    
    // If user is authenticated and wants decryption, try to decrypt
    if (decrypt && userId) {
      try {
        // Check if user has access
        const hasAccess = await checkContentAccess(userId, contentId);
        
        if (hasAccess) {
          // Retrieve content key from escrow
          const contentKey = await retrieveContentKeyFromEscrow(contentId, userId);
          
          if (contentKey) {
            // Decrypt the content
            const encryptedContent = JSON.parse(content.encryptedContent);
            const decryptedContent = decryptContent(encryptedContent, contentKey);
            
            // Return with decrypted content
            res.json({
              ...response,
              content: decryptedContent,
              decrypted: true,
              hasAccess: true
            });
            return;
          }
        }
        
        // User doesn't have access
        res.json({
          ...response,
          decrypted: false,
          hasAccess: false,
          message: 'Purchase required to access full content'
        });
        return;
      } catch (error) {
        logger.warn(`Failed to decrypt content for user ${userId}:`, error);
        // Fall through to return encrypted version
      }
    }
    
    // Return public (encrypted) version
    res.json({
      ...response,
      decrypted: false,
      hasAccess: false
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Get user's accessible content (purchased + owned)
 */
contentRouter.get('/my/accessible', authenticateToken, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    
    // Get all content keys user has access to
    const contentKeys = await getUserContentKeys(userId);
    
    // Get content details for each
    const contentIds = contentKeys.map(key => key.contentId);
    
    const content = await prisma.content.findMany({
      where: {
        id: { in: contentIds }
      },
      include: {
        user: {
          select: {
            name: true,
            avatar: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const accessibleContent = content.map(item => {
      const keyData = contentKeys.find(key => key.contentId === item.id);
      return {
        id: item.id,
        title: item.title,
        description: item.description,
        preview: item.preview,
        price: item.price,
        platform: item.platform,
        author: item.user.name || 'Anonymous',
        authorAvatar: item.user.avatar,
        encrypted: true,
        hasAccess: true,
        accessGrantedAt: keyData?.createdAt,
        accessExpiresAt: keyData?.expiresAt,
        createdAt: item.createdAt
      };
    });
    
    res.json({
      content: accessibleContent,
      total: accessibleContent.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * List user's content
 */
contentRouter.get('/user/:userId', optionalAuth, async (req, res, next) => {
  try {
    const { userId } = req.params;
    const currentUserId = (req.user as any)?.id;
    
    // Only allow users to see their own content or public previews
    const isOwner = currentUserId === userId;
    
    const content = await prisma.content.findMany({
      where: { 
        userId,
        published: true
      },
      include: {
        user: {
          select: {
            name: true,
            avatar: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    
    const contentList = content.map(item => ({
      id: item.id,
      title: item.title,
      description: item.description,
      preview: item.preview,
      price: item.price,
      platform: item.platform,
      author: item.user.name || 'Anonymous',
      authorAvatar: item.user.avatar,
      encrypted: true,
      createdAt: item.createdAt,
      isOwner
    }));
    
    res.json({
      content: contentList,
      total: contentList.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Search public content
 */
contentRouter.get('/search', optionalAuth, async (req, res, next) => {
  try {
    const { q, platform, minPrice, maxPrice, limit = 20 } = req.query;
    
    const whereClause: any = {
      published: true
    };
    
    // Add search filters
    if (q) {
      whereClause.OR = [
        { title: { contains: q as string, mode: 'insensitive' } },
        { description: { contains: q as string, mode: 'insensitive' } },
        { preview: { contains: q as string, mode: 'insensitive' } }
      ];
    }
    
    if (platform) {
      whereClause.platform = platform;
    }
    
    if (minPrice || maxPrice) {
      whereClause.price = {};
      if (minPrice) whereClause.price.gte = parseFloat(minPrice as string);
      if (maxPrice) whereClause.price.lte = parseFloat(maxPrice as string);
    }
    
    const content = await prisma.content.findMany({
      where: whereClause,
      include: {
        user: {
          select: {
            name: true,
            avatar: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string)
    });
    
    const searchResults = content.map(item => ({
      id: item.id,
      title: item.title,
      description: item.description,
      preview: item.preview,
      price: item.price,
      platform: item.platform,
      author: item.user.name || 'Anonymous',
      authorAvatar: item.user.avatar,
      encrypted: true,
      createdAt: item.createdAt
    }));
    
    res.json({
      results: searchResults,
      total: searchResults.length,
      query: q || '',
      filters: { platform, minPrice, maxPrice }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Serve client-side encryption library
 */
contentRouter.get('/lib/encryption.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
// OpenContext Client-Side Encryption Library
class OpenContextEncryption {
  
  // Generate a new AES-256-GCM key
  static async generateContentKey() {
    return await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }
  
  // Encrypt content with given key
  static async encryptContent(content, key) {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      data
    );
    
    return {
      encrypted: Array.from(new Uint8Array(encrypted)),
      iv: Array.from(iv),
      algorithm: "AES-GCM"
    };
  }
  
  // Decrypt content with given key
  static async decryptContent(encryptedBlob, key) {
    const iv = new Uint8Array(encryptedBlob.iv);
    const encrypted = new Uint8Array(encryptedBlob.encrypted);
    
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      encrypted
    );
    
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  }
  
  // Generate preview from content
  static generatePreview(content, wordLimit = 50) {
    const words = content.split(/\\s+/);
    if (words.length <= wordLimit) return content;
    return words.slice(0, wordLimit).join(' ') + '...';
  }
  
  // Main encryption function for content creators
  static async encrypt(content, metadata) {
    // Generate content key
    const contentKey = await this.generateContentKey();
    
    // Encrypt content
    const encryptedContent = await this.encryptContent(content, contentKey);
    
    // Export key for storage
    const exportedKey = await crypto.subtle.exportKey("raw", contentKey);
    
    // Generate preview
    const preview = this.generatePreview(content);
    
    return {
      publicData: {
        id: crypto.randomUUID(),
        title: metadata.title,
        author: metadata.author,
        preview,
        price: metadata.price,
        encrypted_blob: encryptedContent,
        opencontext_encrypted: true
      },
      contentKey: Array.from(new Uint8Array(exportedKey)),
      contentId: crypto.randomUUID()
    };
  }
}

// Export for use in WordPress plugin or other platforms
window.OpenContextEncryption = OpenContextEncryption;
  `);
});