import crypto from 'crypto';
import { prisma } from '../common/prisma.js';
import { logger } from '../common/logger.js';
import { AppError } from '../common/middleware/error-handler.js';
import { checkContentAccess } from '../payments/access.service.js';
import {
  encryptContentKeyForUser,
  decryptContentKeyForUser,
  EncryptedContent
} from './encryption.service.js';
import {
  deleteSessionKey,
  loadSessionKey,
  saveSessionKeyIfAbsent,
  SESSION_KEY_TTL_SECONDS
} from './session-key-store.js';

/**
 * Key escrow: each content item has its own AES key; when a user gains access
 * we encrypt that key with the user's session key and store the result.
 *
 * TODO(op-context): session keys expire after 24h while escrow rows live for a
 * year, so a row becomes undecryptable once its wrapping key rotates. Escrow
 * needs a stable per-user wrapping key (or re-wrapping on rotation) before this
 * can be relied on beyond a single session.
 */

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

const ESCROW_DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

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
    const sessionKey = await getUserSessionKey(userId);
    const encryptedContentKey = encryptContentKeyForUser(contentKey, sessionKey);
    const keyId = crypto.randomUUID();

    const escrowRecord = await prisma.contentKeyEscrow.create({
      data: {
        id: keyId,
        contentId,
        userId,
        encryptedContentKey: JSON.stringify(encryptedContentKey),
        expiresAt: expiresAt || new Date(Date.now() + ESCROW_DEFAULT_TTL_MS)
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
 * Retrieves and decrypts content key from escrow. Returns null when the user
 * has access but no live escrow record exists; throws 403 without access.
 */
export async function retrieveContentKeyFromEscrow(contentId: string, userId: string): Promise<Buffer | null> {
  try {
    const hasAccess = await checkContentAccess(userId, contentId);
    if (!hasAccess) {
      throw new AppError(403, 'Access denied to content');
    }

    const escrowRecord = await prisma.contentKeyEscrow.findFirst({
      where: {
        contentId,
        userId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      }
    });

    if (!escrowRecord) {
      logger.warn(`No valid escrow record found for content: ${contentId}, user: ${userId}`);
      return null;
    }

    const sessionKey = await getUserSessionKey(userId);
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

// Concurrent first requests for the same user must agree on one key, otherwise
// escrow rows get wrapped with a key that is immediately overwritten.
const sessionKeyRequests = new Map<string, Promise<Buffer>>();

/**
 * Gets or creates a session key for user
 */
export function getUserSessionKey(userId: string): Promise<Buffer> {
  const inFlight = sessionKeyRequests.get(userId);
  if (inFlight) return inFlight;

  const request = (async () => {
    try {
      const existing = await loadSessionKey(userId);
      if (existing) {
        return Buffer.from(existing.sessionKey, 'hex');
      }

      const now = Date.now();
      const stored = await saveSessionKeyIfAbsent({
        userId,
        sessionKey: generateSessionKey().toString('hex'),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + SESSION_KEY_TTL_SECONDS * 1000).toISOString()
      });

      logger.info(`Generated new session key for user: ${userId}`);
      return Buffer.from(stored.sessionKey, 'hex');
    } catch (error) {
      logger.error('Failed to get user session key:', error);
      throw new AppError(500, 'Failed to manage session key');
    } finally {
      sessionKeyRequests.delete(userId);
    }
  })();

  sessionKeyRequests.set(userId, request);
  return request;
}

/**
 * Removes expired escrow records (cleanup job)
 */
export async function cleanupExpiredEscrowRecords(): Promise<number> {
  try {
    const result = await prisma.contentKeyEscrow.deleteMany({
      where: { expiresAt: { lt: new Date() } }
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
export async function grantContentAccess(contentId: string, userId: string, contentKey: Buffer): Promise<void> {
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
export async function revokeContentAccess(contentId: string, userId: string): Promise<void> {
  try {
    await prisma.contentKeyEscrow.deleteMany({
      where: { contentId, userId }
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
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
      },
      include: {
        content: {
          select: { title: true, description: true, platform: true }
        }
      }
    });

    return escrowRecords.map((record) => ({
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
 * Forgets the user's session key (call on logout).
 */
export async function cleanupSessionDecryption(userId: string): Promise<void> {
  try {
    await deleteSessionKey(userId);
    logger.info(`Cleaned up session decryption for user: ${userId}`);
  } catch (error) {
    logger.warn(`Failed to cleanup session decryption for user ${userId}:`, error);
  }
}
