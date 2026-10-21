import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken, optionalAuth } from '../auth/auth.middleware.js';
import { requireUser } from '../auth/current-user.js';
import { AppError } from '../common/middleware/error-handler.js';
import { logger } from '../common/logger.js';
import { simulateClientSideEncryption, decryptContent, clientSideEncryptionCode } from './encryption.service.js';
import { retrieveContentKeyFromEscrow, grantContentAccess, getUserContentKeys } from './key-escrow.service.js';
import { checkContentAccess } from '../payments/access.service.js';
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

// Query strings are strings: `?decrypt=true` must not be parsed with z.boolean().
const queryFlag = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((value) => value === 'true' || value === '1');

const getContentSchema = z.object({
  decrypt: queryFlag
});

const searchSchema = z.object({
  q: z.string().max(100).optional(),
  platform: z.string().max(50).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  limit: z.coerce.number().min(1).max(100).default(20)
});

const publicUserSelect = { user: { select: { name: true, avatar: true } } } as const;

// Static paths are registered before `/:contentId` so "search" is never looked up as an id.

/**
 * Serve client-side encryption library
 */
contentRouter.get('/lib/encryption.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(clientSideEncryptionCode);
});

/**
 * Search public content
 */
contentRouter.get('/search', optionalAuth, async (req, res, next) => {
  try {
    const { q, platform, minPrice, maxPrice, limit } = searchSchema.parse(req.query);

    const whereClause: Record<string, unknown> = { published: true };

    if (q) {
      whereClause.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { preview: { contains: q, mode: 'insensitive' } }
      ];
    }

    if (platform) {
      whereClause.platform = platform;
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      whereClause.price = {
        ...(minPrice !== undefined && { gte: minPrice }),
        ...(maxPrice !== undefined && { lte: maxPrice })
      };
    }

    const content = await prisma.content.findMany({
      where: whereClause,
      include: publicUserSelect,
      orderBy: { createdAt: 'desc' },
      take: limit
    });

    const searchResults = content.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      preview: item.preview,
      price: Number(item.price),
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
 * Get user's accessible content (purchased + owned)
 */
contentRouter.get('/my/accessible', authenticateToken, async (req, res, next) => {
  try {
    const userId = requireUser(req).id;

    const contentKeys = await getUserContentKeys(userId);
    const contentIds = contentKeys.map((key) => key.contentId);

    const content = await prisma.content.findMany({
      where: { id: { in: contentIds } },
      include: publicUserSelect,
      orderBy: { createdAt: 'desc' }
    });

    const accessibleContent = content.map((item) => {
      const keyData = contentKeys.find((key) => key.contentId === item.id);
      return {
        id: item.id,
        title: item.title,
        description: item.description,
        preview: item.preview,
        price: Number(item.price),
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
 * List a user's published content
 */
contentRouter.get('/user/:userId', optionalAuth, async (req, res, next) => {
  try {
    const { userId } = req.params;
    const isOwner = req.user?.id === userId;

    const content = await prisma.content.findMany({
      where: { userId, published: true },
      include: publicUserSelect,
      orderBy: { createdAt: 'desc' }
    });

    const contentList = content.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      preview: item.preview,
      price: Number(item.price),
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
 * Create encrypted content
 */
contentRouter.post('/create', authenticateToken, async (req, res, next) => {
  try {
    const { title, description, content, platform, platformId, price } = createContentSchema.parse(req.body);
    const user = requireUser(req);

    // The server encrypts on the creator's behalf; see simulateClientSideEncryption.
    const encryptionResult = simulateClientSideEncryption(content, {
      title,
      author: user.name || 'Anonymous',
      price,
      userId: user.id
    });

    const contentRecord = await prisma.content.create({
      data: {
        userId: user.id,
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

    // Creators always have access to their own content.
    const contentKey = Buffer.from(encryptionResult.contentKeyData.contentKey, 'hex');
    await grantContentAccess(contentRecord.id, user.id, contentKey);

    logger.info(`Created encrypted content: ${contentRecord.id} by user: ${user.id}`);

    res.status(201).json({
      success: true,
      content: {
        id: contentRecord.id,
        title: contentRecord.title,
        description: contentRecord.description,
        preview: contentRecord.preview,
        price: Number(contentRecord.price),
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
    const userId = req.user?.id;

    const content = await prisma.content.findUnique({
      where: { id: contentId },
      include: publicUserSelect
    });

    if (!content) {
      throw new AppError(404, 'Content not found');
    }

    const response = {
      id: content.id,
      title: content.title,
      description: content.description,
      preview: content.preview,
      price: Number(content.price),
      platform: content.platform,
      author: content.user.name || 'Anonymous',
      authorAvatar: content.user.avatar,
      encrypted: true,
      createdAt: content.createdAt
    };

    if (decrypt && userId) {
      try {
        const hasAccess = await checkContentAccess(userId, contentId);

        if (hasAccess) {
          const contentKey = await retrieveContentKeyFromEscrow(contentId, userId);

          if (contentKey) {
            const encryptedContent = JSON.parse(content.encryptedContent);
            const decryptedContent = decryptContent(encryptedContent, contentKey);

            res.json({
              ...response,
              content: decryptedContent,
              decrypted: true,
              hasAccess: true
            });
            return;
          }
        }

        res.json({
          ...response,
          decrypted: false,
          hasAccess: false,
          message: 'Purchase required to access full content'
        });
        return;
      } catch (error) {
        logger.warn(`Failed to decrypt content for user ${userId}:`, error);
        // Fall through to the public (encrypted) version
      }
    }

    res.json({
      ...response,
      decrypted: false,
      hasAccess: false
    });
  } catch (error) {
    next(error);
  }
});
