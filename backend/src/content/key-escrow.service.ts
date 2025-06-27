import crypto from 'crypto';
import { prisma } from '../common/prisma.js';
import { logger } from '../common/logger.js';
import { AppError } from '../common/middleware/error-handler.js';
import { createClient } from 'redis';

// Redis client for session key storage
let sessionRedisClient: any = null;

// Initialize Redis client for session storage
const initSessionStorage = async () => {
  if (!sessionRedisClient) {
    try {
      sessionRedisClient = createClient({
        url: process.env.REDIS_URL
      });
      await sessionRedisClient.connect();
      logger.info('Session storage Redis connected');
    } catch (error) {
      logger.warn('Failed to connect session Redis, falling back to memory storage');
      sessionRedisClient = null;
    }
  }
  return sessionRedisClient;
};

// Fallback in-memory storage for development
const memorySessionStore = new Map<string, any>();
import { 
  encryptContentKeyForUser, 
  decryptContentKeyForUser,
  EncryptedContent 
} from './encryption.service.js';

export interface ContentKeyEscrow {
  id: string;
  contentId: string;
  keyId: string;
  encryptedContentKey: EncryptedContent;
  createdAt: Date;
  expiresAt?: Date;
}

export interface SessionKey {
  userId: string;
  sessionKey: Buffer;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Generates a session-specific key for a user
 */
export function generateSessionKey(): Buffer {
  return crypto.randomBytes(32); // 256-bit session key
}

/**
 * Stores encrypted content key in escrow
 */
export async function storeContentKeyInEscrow(
  contentId: string,
  contentKey: Buffer,
  userId: string,
  expiresAt?: Date
): Promise<ContentKeyEscrow> {
  try {
    // Get user's current session key
    const sessionKey = await getUserSessionKey(userId);
    
    // Encrypt the content key with user's session key
    const encryptedContentKey = encryptContentKeyForUser(contentKey, sessionKey);
    
    // Store in escrow table
    const keyId = crypto.randomUUID();
    
    const escrowRecord = await prisma.contentKeyEscrow.create({
      data: {
        id: keyId,
        contentId,
        userId,
        encryptedContentKey: JSON.stringify(encryptedContentKey),
        expiresAt: expiresAt || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year default
      }
    });
    
    logger.info(`Stored content key in escrow: ${keyId} for content: ${contentId}`);
    
    return {
      id: escrowRecord.id,
      contentId: escrowRecord.contentId,
      keyId,
      encryptedContentKey,
      createdAt: escrowRecord.createdAt,
      expiresAt: escrowRecord.expiresAt || undefined
    };
  } catch (error) {
    logger.error('Failed to store content key in escrow:', error);
    throw new AppError(500, 'Failed to store content key securely');
  }
}

/**
 * Retrieves and decrypts content key from escrow
 */
export async function retrieveContentKeyFromEscrow(
  contentId: string,
  userId: string
): Promise<Buffer | null> {
  try {
    // Check if user has valid access
    const hasAccess = await checkUserContentAccess(userId, contentId);
    if (!hasAccess) {
      throw new AppError(403, 'Access denied to content');
    }
    
    // Get escrow record
    const escrowRecord = await prisma.contentKeyEscrow.findFirst({
      where: {
        contentId,
        userId,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } }
        ]
      }
    });
    
    if (!escrowRecord) {
      logger.warn(`No valid escrow record found for content: ${contentId}, user: ${userId}`);
      return null;
    }
    
    // Get user's session key
    const sessionKey = await getUserSessionKey(userId);
    
    // Decrypt the content key
    const encryptedContentKey: EncryptedContent = JSON.parse(escrowRecord.encryptedContentKey);
    const contentKey = decryptContentKeyForUser(encryptedContentKey, sessionKey);
    
    logger.info(`Retrieved content key from escrow for content: ${contentId}`);
    
    return contentKey;
  } catch (error) {
    logger.error('Failed to retrieve content key from escrow:', error);
    if (error instanceof AppError) throw error;
    throw new AppError(500, 'Failed to retrieve content key');
  }
}

/**
 * Gets or creates a session key for user
 */
export async function getUserSessionKey(userId: string): Promise<Buffer> {
  try {
    // Try to get existing session key from Redis/session store
    const existingKey = await getSessionKeyFromStore(userId);
    if (existingKey) {
      return existingKey;
    }
    
    // Generate new session key
    const sessionKey = generateSessionKey();
    
    // Store in session
    await storeSessionKey(userId, sessionKey);
    
    logger.info(`Generated new session key for user: ${userId}`);
    
    return sessionKey;
  } catch (error) {
    logger.error('Failed to get user session key:', error);
    throw new AppError(500, 'Failed to manage session key');
  }
}

/**
 * Stores session key securely (in Redis/session store)
 */
async function storeSessionKey(userId: string, sessionKey: Buffer): Promise<void> {
  const keyData = {
    userId,
    sessionKey: sessionKey.toString('hex'),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
  };
  
  const redisClient = await initSessionStorage();
  
  if (redisClient) {
    // Store in Redis with TTL
    try {
      await redisClient.setEx(
        `session:key:${userId}`, 
        24 * 60 * 60, // 24 hours TTL
        JSON.stringify(keyData)
      );
    } catch (error) {
      logger.warn('Failed to store session key in Redis, using memory fallback');
      memorySessionStore.set(userId, keyData);
    }
  } else {
    // Fallback to memory storage
    memorySessionStore.set(userId, keyData);
  }
}

/**
 * Retrieves session key from store
 */
async function getSessionKeyFromStore(userId: string): Promise<Buffer | null> {
  const redisClient = await initSessionStorage();
  
  let keyData = null;
  
  if (redisClient) {
    try {
      const stored = await redisClient.get(`session:key:${userId}`);
      if (stored) {
        keyData = JSON.parse(stored);
      }
    } catch (error) {
      logger.warn('Failed to get session key from Redis, checking memory fallback');
    }
  }
  
  // Fallback to memory storage
  if (!keyData) {
    keyData = memorySessionStore.get(userId);
  }
  
  if (!keyData) return null;
  
  // Check if expired
  if (new Date(keyData.expiresAt) < new Date()) {
    // Clean up expired key
    if (redisClient) {
      try {
        await redisClient.del(`session:key:${userId}`);
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    memorySessionStore.delete(userId);
    return null;
  }
  
  return Buffer.from(keyData.sessionKey, 'hex');
}

/**
 * Checks if user has valid access to content
 */
async function checkUserContentAccess(userId: string, contentId: string): Promise<boolean> {
  const purchase = await prisma.purchase.findFirst({
    where: {
      userId,
      contentId,
      status: 'COMPLETED',
      accessGranted: true,
      OR: [
        { accessExpiresAt: null },
        { accessExpiresAt: { gt: new Date() } }
      ]
    }
  });
  
  return !!purchase;
}

/**
 * Removes expired escrow records (cleanup job)
 */
export async function cleanupExpiredEscrowRecords(): Promise<number> {
  try {
    const result = await prisma.contentKeyEscrow.deleteMany({
      where: {
        expiresAt: {
          lt: new Date()
        }
      }
    });
    
    logger.info(`Cleaned up ${result.count} expired escrow records`);
    
    return result.count;
  } catch (error) {
    logger.error('Failed to cleanup expired escrow records:', error);
    return 0;
  }
}

/**
 * Grants access to content by storing key in escrow
 */
export async function grantContentAccess(
  contentId: string,
  userId: string,
  contentKey: Buffer
): Promise<void> {
  try {
    await storeContentKeyInEscrow(contentId, contentKey, userId);
    logger.info(`Granted content access: content=${contentId}, user=${userId}`);
  } catch (error) {
    logger.error('Failed to grant content access:', error);
    throw error;
  }
}

/**
 * Revokes access to content by removing escrow record
 */
export async function revokeContentAccess(
  contentId: string,
  userId: string
): Promise<void> {
  try {
    await prisma.contentKeyEscrow.deleteMany({
      where: {
        contentId,
        userId
      }
    });
    
    logger.info(`Revoked content access: content=${contentId}, user=${userId}`);
  } catch (error) {
    logger.error('Failed to revoke content access:', error);
    throw error;
  }
}

/**
 * Lists all content keys user has access to
 */
export async function getUserContentKeys(userId: string): Promise<ContentKeyEscrow[]> {
  try {
    const escrowRecords = await prisma.contentKeyEscrow.findMany({
      where: {
        userId,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } }
        ]
      },
      include: {
        content: {
          select: {
            title: true,
            description: true,
            platform: true
          }
        }
      }
    });
    
    return escrowRecords.map(record => ({
      id: record.id,
      contentId: record.contentId,
      keyId: record.id,
      encryptedContentKey: JSON.parse(record.encryptedContentKey),
      createdAt: record.createdAt,
      expiresAt: record.expiresAt || undefined
    }));
  } catch (error) {
    logger.error('Failed to get user content keys:', error);
    throw new AppError(500, 'Failed to retrieve content keys');
  }
}

/**
 * Cleanup function for session keys (should be called on logout)
 */
export async function cleanupSessionDecryption(userId: string): Promise<void> {
  try {
    const redisClient = await initSessionStorage();
    
    if (redisClient) {
      try {
        await redisClient.del(`session:key:${userId}`);
      } catch (error) {
        logger.warn('Failed to cleanup session key from Redis');
      }
    }
    
    // Clear from memory fallback
    memorySessionStore.delete(userId);
    
    logger.info(`Cleaned up session decryption for user: ${userId}`);
  } catch (error) {
    logger.warn(`Failed to cleanup session decryption for user ${userId}:`, error);
  }
}