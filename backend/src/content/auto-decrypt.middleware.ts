import { Request, Response, NextFunction } from 'express';
import { logger } from '../common/logger.js';
import { prisma } from '../common/prisma.js';
import { getUserSessionKey, retrieveContentKeyFromEscrow } from './key-escrow.service.js';
import { decryptContent, EncryptedContent } from './encryption.service.js';
import { deleteSessionKey } from './session-key-store.js';
import { checkContentAccess } from '../payments/access.service.js';

// Extend Express Request type to include session key
declare global {
  namespace Express {
    interface Request {
      sessionKey?: Buffer;
      autoDecrypt?: boolean;
    }
  }
}

/** Shape of a content item in an API response that auto-decryption can act on. */
interface ContentResponseItem {
  id: string;
  encrypted?: boolean;
  decrypted?: boolean;
  hasAccess?: boolean;
  content?: string;
  encryptedContent?: string | EncryptedContent;
  [key: string]: unknown;
}

type JsonSender = (body: unknown) => Response;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEncryptedContentItem(value: unknown): value is ContentResponseItem {
  return isRecord(value) && typeof value.id === 'string' && value.encrypted === true && value.decrypted !== true;
}

/**
 * Middleware to automatically set up session-based decryption
 */
export function setupAutoDecryption(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next();
    return;
  }

  const userId = req.user.id;

  getUserSessionKey(userId)
    .then((sessionKey) => {
      req.sessionKey = sessionKey;
      req.autoDecrypt = true;
      next();
    })
    .catch((error) => {
      logger.warn(`Failed to setup auto-decryption for user ${userId}:`, error);
      next();
    });
}

/**
 * Middleware that decrypts content items in JSON responses for users who have
 * purchased them. It wraps `res.json`.
 */
export function autoDecryptContent(req: Request, res: Response, next: NextFunction): void {
  if (!req.autoDecrypt || !req.sessionKey || !req.user) {
    next();
    return;
  }

  const userId = req.user.id;
  const originalJson: JsonSender = res.json.bind(res);

  const jsonWithAutoDecrypt = (data: unknown): Response | Promise<Response> => {
    if (isRecord(data)) {
      if (isEncryptedContentItem(data)) {
        return handleContentDecryption(data, userId, originalJson);
      }

      if (Array.isArray(data.content) || Array.isArray(data.results)) {
        return handleContentArrayDecryption(data, userId, originalJson);
      }
    }

    return originalJson(data);
  };

  // Express never uses res.json's return value, so handing back the in-flight
  // promise is harmless and lets callers (and tests) await completion.
  res.json = jsonWithAutoDecrypt as Response['json'];

  next();
}

/**
 * Handles decryption of a single content object
 */
async function handleContentDecryption(
  contentData: ContentResponseItem,
  userId: string,
  originalJson: JsonSender
): Promise<Response> {
  try {
    const hasAccess = await checkContentAccess(userId, contentData.id);

    if (hasAccess) {
      const contentKey = await retrieveContentKeyFromEscrow(contentData.id, userId);

      if (contentKey) {
        const encryptedContent = contentData.encryptedContent
          ? parseEncryptedContent(contentData.encryptedContent)
          : await getEncryptedContentFromDB(contentData.id);

        if (encryptedContent) {
          contentData.content = decryptContent(encryptedContent, contentKey);
          contentData.decrypted = true;
          contentData.hasAccess = true;

          logger.info(`Auto-decrypted content: ${contentData.id} for user: ${userId}`);
        }
      }
    }

    contentData.hasAccess = hasAccess;
    return originalJson(contentData);
  } catch (error) {
    logger.warn(`Auto-decryption failed for content ${contentData.id}:`, error);

    contentData.hasAccess = false;
    contentData.decrypted = false;
    return originalJson(contentData);
  }
}

/**
 * Handles decryption of multiple content objects
 */
async function handleContentArrayDecryption(
  responseData: Record<string, unknown>,
  userId: string,
  originalJson: JsonSender
): Promise<Response> {
  try {
    const listKey = Array.isArray(responseData.content) ? 'content' : 'results';
    const contentArray = responseData[listKey] as unknown[];

    const processedContent = await Promise.all(
      contentArray.map(async (contentItem) => {
        if (!isEncryptedContentItem(contentItem)) {
          return contentItem;
        }

        try {
          const hasAccess = await checkContentAccess(userId, contentItem.id);

          if (hasAccess) {
            const contentKey = await retrieveContentKeyFromEscrow(contentItem.id, userId);

            if (contentKey) {
              const encryptedContent = await getEncryptedContentFromDB(contentItem.id);

              if (encryptedContent) {
                contentItem.content = decryptContent(encryptedContent, contentKey);
                contentItem.decrypted = true;
                contentItem.hasAccess = true;
                return contentItem;
              }
            }
          }

          contentItem.hasAccess = hasAccess;
          contentItem.decrypted = false;
        } catch (error) {
          logger.warn(`Auto-decryption failed for content ${contentItem.id}:`, error);
          contentItem.hasAccess = false;
          contentItem.decrypted = false;
        }

        return contentItem;
      })
    );

    responseData[listKey] = processedContent;

    const decryptedCount = processedContent.filter((item) => isRecord(item) && item.decrypted === true).length;
    if (decryptedCount > 0) {
      logger.info(`Auto-decrypted ${decryptedCount} content items for user: ${userId}`);
    }

    return originalJson(responseData);
  } catch (error) {
    logger.error('Batch auto-decryption failed:', error);
    return originalJson(responseData);
  }
}

function parseEncryptedContent(value: string | EncryptedContent): EncryptedContent {
  return typeof value === 'string' ? (JSON.parse(value) as EncryptedContent) : value;
}

/**
 * Helper function to get encrypted content from database
 */
async function getEncryptedContentFromDB(contentId: string): Promise<EncryptedContent | null> {
  try {
    const content = await prisma.content.findUnique({
      where: { id: contentId },
      select: { encryptedContent: true }
    });

    if (!content || !content.encryptedContent) {
      return null;
    }

    return JSON.parse(content.encryptedContent) as EncryptedContent;
  } catch (error) {
    logger.error(`Failed to get encrypted content from DB: ${contentId}`, error);
    return null;
  }
}

/**
 * Manual decryption function for specific use cases
 */
export async function manualDecryptContent(
  contentId: string,
  userId: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    const hasAccess = await checkContentAccess(userId, contentId);
    if (!hasAccess) {
      return { success: false, error: 'Access denied' };
    }

    const contentKey = await retrieveContentKeyFromEscrow(contentId, userId);
    if (!contentKey) {
      return { success: false, error: 'Decryption key not available' };
    }

    const encryptedContent = await getEncryptedContentFromDB(contentId);
    if (!encryptedContent) {
      return { success: false, error: 'Encrypted content not found' };
    }

    const decryptedContent = decryptContent(encryptedContent, contentKey);

    return { success: true, content: decryptedContent };
  } catch (error) {
    logger.error(`Manual decryption failed for content ${contentId}:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Decryption failed'
    };
  }
}

/**
 * Utility to check if auto-decryption is available for user
 */
export async function checkAutoDecryptionAvailable(userId: string): Promise<boolean> {
  try {
    const sessionKey = await getUserSessionKey(userId);
    return !!sessionKey;
  } catch {
    return false;
  }
}

/**
 * Forgets the user's session key (call on logout). The in-memory copy is gone
 * before this returns its promise; the Redis copy is removed asynchronously.
 */
export async function cleanupSessionDecryption(userId: string): Promise<void> {
  try {
    await deleteSessionKey(userId);
    logger.info(`Cleaned up session decryption for user: ${userId}`);
  } catch (error) {
    logger.warn(`Failed to cleanup session decryption for user ${userId}:`, error);
  }
}
