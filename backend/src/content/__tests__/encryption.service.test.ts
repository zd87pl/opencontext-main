import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import {
  generateContentKey,
  encryptContent,
  decryptContent,
  encryptContentKeyForUser,
  decryptContentKeyForUser,
  generatePreview,
  createContentHash,
  verifyContentHash,
  simulateClientSideEncryption
} from '../encryption.service.js';

describe('Encryption Service', () => {
  let testContent: string;
  let testContentKey: Buffer;
  let testSessionKey: Buffer;

  beforeEach(() => {
    testContent = 'This is a test content that will be encrypted for secure storage.';
    testContentKey = generateContentKey();
    testSessionKey = crypto.randomBytes(32);
  });

  describe('generateContentKey', () => {
    it('should generate a 32-byte key', () => {
      const key = generateContentKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it('should generate unique keys', () => {
      const key1 = generateContentKey();
      const key2 = generateContentKey();
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('encryptContent and decryptContent', () => {
    it('should encrypt and decrypt content successfully', () => {
      const encrypted = encryptContent(testContent, testContentKey);
      
      expect(encrypted).toHaveProperty('encryptedData');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('authTag');
      expect(encrypted.algorithm).toBe('aes-256-gcm');
      
      // Verify all fields are hex strings
      expect(encrypted.encryptedData).toMatch(/^[a-f0-9]+$/i);
      expect(encrypted.iv).toMatch(/^[a-f0-9]+$/i);
      expect(encrypted.authTag).toMatch(/^[a-f0-9]+$/i);
      
      const decrypted = decryptContent(encrypted, testContentKey);
      expect(decrypted).toBe(testContent);
    });

    it('should fail decryption with wrong key', () => {
      const encrypted = encryptContent(testContent, testContentKey);
      const wrongKey = generateContentKey();
      
      expect(() => {
        decryptContent(encrypted, wrongKey);
      }).toThrow();
    });

    it('should fail decryption with tampered data', () => {
      const encrypted = encryptContent(testContent, testContentKey);
      
      // Tamper with encrypted data
      const tamperedEncrypted = {
        ...encrypted,
        encryptedData: encrypted.encryptedData.replace('a', 'b')
      };
      
      expect(() => {
        decryptContent(tamperedEncrypted, testContentKey);
      }).toThrow();
    });

    it('should handle empty content', () => {
      const emptyContent = '';
      const encrypted = encryptContent(emptyContent, testContentKey);
      const decrypted = decryptContent(encrypted, testContentKey);
      expect(decrypted).toBe(emptyContent);
    });

    it('should handle unicode content', () => {
      const unicodeContent = '🔒 This is encrypted content with émojis and spëcial chars! 中文';
      const encrypted = encryptContent(unicodeContent, testContentKey);
      const decrypted = decryptContent(encrypted, testContentKey);
      expect(decrypted).toBe(unicodeContent);
    });
  });

  describe('encryptContentKeyForUser and decryptContentKeyForUser', () => {
    it('should encrypt and decrypt content key for user', () => {
      const encryptedKey = encryptContentKeyForUser(testContentKey, testSessionKey);
      const decryptedKey = decryptContentKeyForUser(encryptedKey, testSessionKey);
      
      expect(decryptedKey.equals(testContentKey)).toBe(true);
    });

    it('should fail with wrong session key', () => {
      const encryptedKey = encryptContentKeyForUser(testContentKey, testSessionKey);
      const wrongSessionKey = crypto.randomBytes(32);
      
      expect(() => {
        decryptContentKeyForUser(encryptedKey, wrongSessionKey);
      }).toThrow();
    });
  });

  describe('generatePreview', () => {
    it('should generate preview with default word limit', () => {
      const longContent = 'word '.repeat(100); // 100 words
      const preview = generatePreview(longContent);
      const words = preview.split(' ');
      
      expect(words.length).toBeLessThanOrEqual(51); // 50 words + "..."
      expect(preview.endsWith('...')).toBe(true);
    });

    it('should return full content if under limit', () => {
      const shortContent = 'This is short content';
      const preview = generatePreview(shortContent);
      expect(preview).toBe(shortContent);
    });

    it('should respect custom word limit', () => {
      const content = 'word '.repeat(20);
      const preview = generatePreview(content, 10);
      const words = preview.split(' ');
      
      expect(words.length).toBeLessThanOrEqual(11); // 10 words + "..."
    });

    it('should handle empty content', () => {
      const preview = generatePreview('');
      expect(preview).toBe('');
    });
  });

  describe('createContentHash and verifyContentHash', () => {
    it('should create and verify content hash', () => {
      const hash = createContentHash(testContent);
      expect(hash).toMatch(/^[a-f0-9]{64}$/i); // SHA-256 hex string
      expect(verifyContentHash(testContent, hash)).toBe(true);
    });

    it('should fail verification with different content', () => {
      const hash = createContentHash(testContent);
      const differentContent = testContent + ' modified';
      expect(verifyContentHash(differentContent, hash)).toBe(false);
    });

    it('should create consistent hashes', () => {
      const hash1 = createContentHash(testContent);
      const hash2 = createContentHash(testContent);
      expect(hash1).toBe(hash2);
    });
  });

  describe('simulateClientSideEncryption', () => {
    const testMetadata = {
      title: 'Test Article',
      author: 'Test Author',
      price: 1.99,
      userId: 'user-123'
    };

    it('should simulate complete client-side encryption flow', () => {
      const result = simulateClientSideEncryption(testContent, testMetadata);
      
      // Check public data structure
      expect(result.publicData).toHaveProperty('id');
      expect(result.publicData).toHaveProperty('title', testMetadata.title);
      expect(result.publicData).toHaveProperty('author', testMetadata.author);
      expect(result.publicData).toHaveProperty('price', testMetadata.price);
      expect(result.publicData).toHaveProperty('preview');
      expect(result.publicData).toHaveProperty('encrypted_blob');
      expect(result.publicData.opencontext_encrypted).toBe(true);
      
      // Check content key data
      expect(result.contentKeyData).toHaveProperty('contentKey');
      expect(result.contentKeyData).toHaveProperty('keyId');
      expect(result.contentKeyData).toHaveProperty('algorithm', 'aes-256-gcm');
      expect(result.contentKeyData).toHaveProperty('createdAt');
      
      // Verify encryption blob structure
      const encryptedBlob = result.publicData.encrypted_blob;
      expect(encryptedBlob).toHaveProperty('encryptedData');
      expect(encryptedBlob).toHaveProperty('iv');
      expect(encryptedBlob).toHaveProperty('authTag');
      expect(encryptedBlob.algorithm).toBe('aes-256-gcm');
      
      // Verify we can decrypt with the provided key
      const contentKey = Buffer.from(result.contentKeyData.contentKey, 'hex');
      const decryptedContent = decryptContent(encryptedBlob, contentKey);
      expect(decryptedContent).toBe(testContent);
    });

    it('should generate unique IDs and keys', () => {
      const result1 = simulateClientSideEncryption(testContent, testMetadata);
      const result2 = simulateClientSideEncryption(testContent, testMetadata);
      
      expect(result1.publicData.id).not.toBe(result2.publicData.id);
      expect(result1.contentKeyData.keyId).not.toBe(result2.contentKeyData.keyId);
      expect(result1.contentKeyData.contentKey).not.toBe(result2.contentKeyData.contentKey);
    });

    it('should create valid preview', () => {
      const result = simulateClientSideEncryption(testContent, testMetadata);
      const preview = result.publicData.preview;
      
      expect(preview.length).toBeGreaterThan(0);
      expect(preview.length).toBeLessThanOrEqual(testContent.length);
      
      // Preview should contain part of original content
      const firstWords = testContent.split(' ').slice(0, 5).join(' ');
      expect(preview).toContain(firstWords);
    });

    it('should handle long content with preview truncation', () => {
      const longContent = 'word '.repeat(100);
      const result = simulateClientSideEncryption(longContent, testMetadata);
      
      expect(result.publicData.preview).toContain('...');
      expect(result.publicData.preview.split(' ').length).toBeLessThanOrEqual(51);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid hex strings in decryption', () => {
      const invalidEncrypted = {
        encryptedData: 'invalid-hex',
        iv: 'also-invalid',
        authTag: 'not-hex-either',
        algorithm: 'aes-256-gcm'
      };
      
      expect(() => {
        decryptContent(invalidEncrypted, testContentKey);
      }).toThrow();
    });

    it('should handle missing properties in encrypted object', () => {
      const incompleteEncrypted = {
        encryptedData: 'abcd1234',
        iv: 'efgh5678'
        // Missing authTag and algorithm
      } as any;
      
      expect(() => {
        decryptContent(incompleteEncrypted, testContentKey);
      }).toThrow();
    });
  });

  describe('Performance', () => {
    it('should encrypt and decrypt large content efficiently', () => {
      const largeContent = 'A'.repeat(1024 * 1024); // 1MB of content
      
      const startTime = Date.now();
      const encrypted = encryptContent(largeContent, testContentKey);
      const decrypted = decryptContent(encrypted, testContentKey);
      const endTime = Date.now();
      
      expect(decrypted).toBe(largeContent);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete in under 1 second
    });
  });
});