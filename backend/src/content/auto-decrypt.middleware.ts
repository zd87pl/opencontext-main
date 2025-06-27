import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../common/logger.js';
import { AppError } from '../common/middleware/error-handler.js';
import { 
  getUserSessionKey,
  retrieveContentKeyFromEscrow 
} from './key-escrow.service.js';
import { decryptContent, EncryptedContent } from './encryption.service.js';
import { checkContentAccess } from '../payments/payment.service.js';

// Extend Express Request type to include session key
declare global {
  namespace Express {
    interface Request {
      sessionKey?: Buffer;
      autoDecrypt?: boolean;
    }
  }
}

/**
 * Middleware to automatically set up session-based decryption
 */
export function setupAutoDecryption(req: Request, res: Response, next: NextFunction) {
  // Only setup for authenticated users
  if (!req.user) {
    return next();
  }
  
  try {
    const userId = (req.user as any).id;
    
    // Get or create session key for user
    getUserSessionKey(userId)
      .then(sessionKey => {
        req.sessionKey = sessionKey;
        req.autoDecrypt = true;
        next();
      })
      .catch(error => {
        logger.warn(`Failed to setup auto-decryption for user ${userId}:`, error);
        // Continue without auto-decryption
        next();
      });
  } catch (error) {
    logger.error('Auto-decryption setup error:', error);
    next();
  }
}

/**
 * Middleware to automatically decrypt content in API responses
 */
export function autoDecryptContent(req: Request, res: Response, next: NextFunction) {
  // Only proceed if auto-decryption is enabled
  if (!req.autoDecrypt || !req.sessionKey || !req.user) {
    return next();
  }
  
  const userId = (req.user as any).id;
  
  // Store original res.json method
  const originalJson = res.json.bind(res);
  
  // Override res.json to intercept responses
  res.json = function(data: any) {
    // Check if response contains content that can be auto-decrypted
    if (data && typeof data === 'object') {
      // Handle single content object
      if (data.id && data.encrypted && !data.decrypted) {
        return handleContentDecryption(data, userId, req.sessionKey!, originalJson);
      }
      
      // Handle array of content objects
      if (data.content && Array.isArray(data.content)) {
        return handleContentArrayDecryption(data, userId, req.sessionKey!, originalJson);
      }
      
      // Handle search results
      if (data.results && Array.isArray(data.results)) {
        data.content = data.results; // Normalize structure
        return handleContentArrayDecryption(data, userId, req.sessionKey!, originalJson);
      }
    }
    
    // No auto-decryption needed, return original response
    return originalJson(data);
  };
  
  next();
}

/**
 * Handles decryption of a single content object
 */
async function handleContentDecryption(
  contentData: any,
  userId: string,
  sessionKey: Buffer,
  originalJson: Function
): Promise<void> {
  try {
    // Check if user has access to this content
    const hasAccess = await checkContentAccess(userId, contentData.id);
    
    if (hasAccess) {
      // Try to decrypt the content
      const contentKey = await retrieveContentKeyFromEscrow(contentData.id, userId);
      
      if (contentKey) {
        // Attempt to get encrypted content from database if not provided
        const encryptedContent = contentData.encryptedContent || 
          await getEncryptedContentFromDB(contentData.id);
        
        if (encryptedContent) {
          const decryptedContent = decryptContent(
            typeof encryptedContent === 'string' 
              ? JSON.parse(encryptedContent) 
              : encryptedContent,
            contentKey
          );
          
          // Add decrypted content to response
          contentData.content = decryptedContent;
          contentData.decrypted = true;
          contentData.hasAccess = true;
          
          logger.info(`Auto-decrypted content: ${contentData.id} for user: ${userId}`);
        }
      }
    }
    
    // Ensure access status is set
    contentData.hasAccess = hasAccess;
    
    return originalJson(contentData);
  } catch (error) {
    logger.warn(`Auto-decryption failed for content ${contentData.id}:`, error);
    
    // Return original data with access status
    contentData.hasAccess = false;
    contentData.decrypted = false;
    
    return originalJson(contentData);
  }
}

/**
 * Handles decryption of multiple content objects
 */
async function handleContentArrayDecryption(
  responseData: any,
  userId: string,
  sessionKey: Buffer,
  originalJson: Function
): Promise<void> {
  try {
    const contentArray = responseData.content || responseData.results || [];
    
    // Process each content item in parallel
    const decryptionPromises = contentArray.map(async (contentItem: any) => {
      if (contentItem.id && contentItem.encrypted && !contentItem.decrypted) {
        try {
          // Check access and decrypt if available
          const hasAccess = await checkContentAccess(userId, contentItem.id);
          
          if (hasAccess) {
            const contentKey = await retrieveContentKeyFromEscrow(contentItem.id, userId);
            
            if (contentKey) {
              const encryptedContent = await getEncryptedContentFromDB(contentItem.id);
              
              if (encryptedContent) {
                const decryptedContent = decryptContent(
                  typeof encryptedContent === 'string' 
                    ? JSON.parse(encryptedContent) 
                    : encryptedContent,
                  contentKey
                );
                
                contentItem.content = decryptedContent;
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
      }
      
      return contentItem;
    });
    
    // Wait for all decryption attempts to complete
    const processedContent = await Promise.all(decryptionPromises);
    
    // Update response data
    if (responseData.content) {
      responseData.content = processedContent;
    } else if (responseData.results) {
      responseData.results = processedContent;
    }
    
    // Count successful decryptions
    const decryptedCount = processedContent.filter(item => item.decrypted).length;
    if (decryptedCount > 0) {
      logger.info(`Auto-decrypted ${decryptedCount} content items for user: ${userId}`);
    }
    
    return originalJson(responseData);
  } catch (error) {
    logger.error('Batch auto-decryption failed:', error);
    return originalJson(responseData);
  }
}

/**
 * Helper function to get encrypted content from database
 */
async function getEncryptedContentFromDB(contentId: string): Promise<EncryptedContent | null> {
  try {
    const { prisma } = await import('../common/prisma.js');
    
    const content = await prisma.content.findUnique({
      where: { id: contentId },
      select: { encryptedContent: true }
    });
    
    if (!content || !content.encryptedContent) {
      return null;
    }
    
    return JSON.parse(content.encryptedContent);
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
    // Check access
    const hasAccess = await checkContentAccess(userId, contentId);
    if (!hasAccess) {
      return { success: false, error: 'Access denied' };
    }
    
    // Get content key
    const contentKey = await retrieveContentKeyFromEscrow(contentId, userId);
    if (!contentKey) {
      return { success: false, error: 'Decryption key not available' };
    }
    
    // Get encrypted content
    const encryptedContent = await getEncryptedContentFromDB(contentId);
    if (!encryptedContent) {
      return { success: false, error: 'Encrypted content not found' };
    }
    
    // Decrypt
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
  } catch (error) {
    return false;
  }
}

/**
 * Cleanup function for session keys (should be called on logout)
 */
export async function cleanupSessionDecryption(userId: string): Promise<void> {
  try {
    // Import the cleanup function from key-escrow service
    const { cleanupSessionDecryption: keyEscrowCleanup } = await import('./key-escrow.service.js');
    await keyEscrowCleanup(userId);
    
    logger.info(`Cleaned up session decryption for user: ${userId}`);
  } catch (error) {
    logger.warn(`Failed to cleanup session decryption for user ${userId}:`, error);
  }
}