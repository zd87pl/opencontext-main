import crypto from 'crypto';
import { logger } from '../common/logger.js';
import { AppError } from '../common/middleware/error-handler.js';

export interface EncryptedContent {
  encryptedData: string;
  iv: string;
  authTag: string;
  algorithm: string;
}

export interface ContentKeyData {
  contentKey: string;
  keyId: string;
  algorithm: string;
  createdAt: string;
}

export interface EncryptionResult {
  publicData: {
    id: string;
    title: string;
    author: string;
    preview: string;
    price: number;
    encrypted_blob: EncryptedContent;
    opencontext_encrypted: boolean;
  };
  contentKeyData: ContentKeyData;
}

/**
 * Generates a new AES-256-GCM key for content encryption
 */
export function generateContentKey(): Buffer {
  return crypto.randomBytes(32); // 256 bits
}

/**
 * Encrypts content using AES-256-GCM
 */
export function encryptContent(
  content: string,
  key: Buffer
): EncryptedContent {
  try {
    const algorithm = 'aes-256-gcm';
    const iv = crypto.randomBytes(16); // 128 bits for GCM
    
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    
    let encrypted = cipher.update(content, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return {
      encryptedData: encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      algorithm
    };
  } catch (error) {
    logger.error('Content encryption failed:', error);
    throw new AppError(500, 'Failed to encrypt content');
  }
}

/**
 * Decrypts content using AES-256-GCM
 */
export function decryptContent(
  encryptedContent: EncryptedContent,
  key: Buffer
): string {
  try {
    const { encryptedData, iv, authTag, algorithm } = encryptedContent;
    
    const decipher = crypto.createDecipheriv(
      algorithm,
      key,
      Buffer.from(iv, 'hex')
    );
    
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));
    
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    logger.error('Content decryption failed:', error);
    throw new AppError(500, 'Failed to decrypt content');
  }
}

/**
 * Encrypts content key with user's session key
 */
export function encryptContentKeyForUser(
  contentKey: Buffer,
  userSessionKey: Buffer
): EncryptedContent {
  return encryptContent(contentKey.toString('hex'), userSessionKey);
}

/**
 * Decrypts content key for user
 */
export function decryptContentKeyForUser(
  encryptedKey: EncryptedContent,
  userSessionKey: Buffer
): Buffer {
  const decryptedKeyHex = decryptContent(encryptedKey, userSessionKey);
  return Buffer.from(decryptedKeyHex, 'hex');
}

/**
 * Generates preview from content (first N words)
 */
export function generatePreview(content: string, wordLimit: number = 50): string {
  const words = content.split(/\s+/);
  if (words.length <= wordLimit) {
    return content;
  }
  
  const preview = words.slice(0, wordLimit).join(' ');
  return preview + '...';
}

/**
 * Creates a content hash for integrity verification
 */
export function createContentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Verifies content integrity
 */
export function verifyContentHash(content: string, expectedHash: string): boolean {
  const actualHash = createContentHash(content);
  return crypto.timingSafeEqual(
    Buffer.from(actualHash, 'hex'),
    Buffer.from(expectedHash, 'hex')
  );
}

/**
 * Simulates client-side encryption process (for server-side processing)
 */
export function simulateClientSideEncryption(
  content: string,
  metadata: {
    title: string;
    author: string;
    price: number;
    userId: string;
  }
): EncryptionResult {
  try {
    // Generate content-specific key
    const contentKey = generateContentKey();
    
    // Encrypt the content
    const encryptedContent = encryptContent(content, contentKey);
    
    // Generate preview
    const preview = generatePreview(content, 50);
    
    // Create content key data
    const keyId = crypto.randomUUID();
    const contentKeyData: ContentKeyData = {
      contentKey: contentKey.toString('hex'),
      keyId,
      algorithm: 'aes-256-gcm',
      createdAt: new Date().toISOString()
    };
    
    // Create public data (what gets stored on platform)
    const publicData = {
      id: crypto.randomUUID(),
      title: metadata.title,
      author: metadata.author,
      preview,
      price: metadata.price,
      encrypted_blob: encryptedContent,
      opencontext_encrypted: true
    };
    
    logger.info(`Encrypted content: ${publicData.id} with key: ${keyId}`);
    
    return {
      publicData,
      contentKeyData
    };
  } catch (error) {
    logger.error('Client-side encryption simulation failed:', error);
    throw new AppError(500, 'Failed to encrypt content');
  }
}

/**
 * JavaScript client-side encryption code (to be served to frontend)
 */
export const clientSideEncryptionCode = `
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
`;