import crypto from 'crypto';
import { logger } from '../common/logger.js';
import { AppError } from '../common/middleware/error-handler.js';

const ALGORITHM = 'aes-256-gcm';

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
export function encryptContent(content: string, key: Buffer): EncryptedContent {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(content, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return {
      encryptedData: encrypted,
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
      algorithm: ALGORITHM
    };
  } catch (error) {
    logger.error('Content encryption failed:', error);
    throw new AppError(500, 'Failed to encrypt content');
  }
}

/**
 * Decrypts content using AES-256-GCM. Throws on a wrong key, a tampered
 * ciphertext/auth tag, or a blob that does not declare this algorithm.
 */
export function decryptContent(encryptedContent: EncryptedContent, key: Buffer): string {
  try {
    const { encryptedData, iv, authTag, algorithm } = encryptedContent;
    if (algorithm !== ALGORITHM) {
      throw new Error(`Unsupported encryption algorithm: ${String(algorithm)}`);
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
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
export function encryptContentKeyForUser(contentKey: Buffer, userSessionKey: Buffer): EncryptedContent {
  return encryptContent(contentKey.toString('hex'), userSessionKey);
}

/**
 * Decrypts content key for user
 */
export function decryptContentKeyForUser(encryptedKey: EncryptedContent, userSessionKey: Buffer): Buffer {
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

  return words.slice(0, wordLimit).join(' ') + '...';
}

/**
 * Creates a content hash for integrity verification
 */
export function createContentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Verifies content integrity in constant time.
 */
export function verifyContentHash(content: string, expectedHash: string): boolean {
  const actual = Buffer.from(createContentHash(content), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Server-side stand-in for the client-side encryption step.
 *
 * In the intended design the browser (or a CMS plugin) encrypts content before
 * it reaches the server. `POST /api/content/create` does not implement that yet:
 * it receives plaintext and runs this function instead, so the server sees the
 * content once at creation time.
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
    const contentKey = generateContentKey();
    const encryptedContent = encryptContent(content, contentKey);
    const preview = generatePreview(content, 50);

    const keyId = crypto.randomUUID();
    const contentKeyData: ContentKeyData = {
      contentKey: contentKey.toString('hex'),
      keyId,
      algorithm: ALGORITHM,
      createdAt: new Date().toISOString()
    };

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

    return { publicData, contentKeyData };
  } catch (error) {
    logger.error('Client-side encryption simulation failed:', error);
    throw new AppError(500, 'Failed to encrypt content');
  }
}

/**
 * Browser-side encryption helper served at GET /api/content/lib/encryption.js.
 *
 * Note: this reference implementation emits WebCrypto's combined
 * ciphertext+tag as a byte array, which is not the hex `EncryptedContent` shape
 * the server decrypts today. It is a starting point for a CMS plugin, not a
 * drop-in client for the current API.
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
    const contentKey = await this.generateContentKey();
    const encryptedContent = await this.encryptContent(content, contentKey);
    const exportedKey = await crypto.subtle.exportKey("raw", contentKey);
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
