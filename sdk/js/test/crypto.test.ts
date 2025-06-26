import { describe, it, expect } from 'vitest';
import { ContextCrypto } from '../src/crypto.js';

describe('ContextCrypto', () => {
  const testData = 'Hello, OpenContext Network!';
  const testPassword = 'test-password-123';

  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt data successfully', async () => {
      const encrypted = await ContextCrypto.encrypt(testData, testPassword);
      expect(encrypted).toBeTruthy();
      expect(encrypted).not.toBe(testData);

      const decrypted = await ContextCrypto.decrypt(encrypted, testPassword);
      expect(decrypted).toBe(testData);
    });

    it('should produce different ciphertext for same data (random IV)', async () => {
      const encrypted1 = await ContextCrypto.encrypt(testData, testPassword);
      const encrypted2 = await ContextCrypto.encrypt(testData, testPassword);
      
      expect(encrypted1).not.toBe(encrypted2);
      
      const decrypted1 = await ContextCrypto.decrypt(encrypted1, testPassword);
      const decrypted2 = await ContextCrypto.decrypt(encrypted2, testPassword);
      
      expect(decrypted1).toBe(testData);
      expect(decrypted2).toBe(testData);
    });

    it('should fail with wrong password', async () => {
      const encrypted = await ContextCrypto.encrypt(testData, testPassword);
      
      await expect(
        ContextCrypto.decrypt(encrypted, 'wrong-password')
      ).rejects.toThrow();
    });

    it('should handle empty data', async () => {
      const encrypted = await ContextCrypto.encrypt('', testPassword);
      const decrypted = await ContextCrypto.decrypt(encrypted, testPassword);
      expect(decrypted).toBe('');
    });

    it('should handle large data', async () => {
      const largeData = 'x'.repeat(100000); // 100KB
      const encrypted = await ContextCrypto.encrypt(largeData, testPassword);
      const decrypted = await ContextCrypto.decrypt(encrypted, testPassword);
      expect(decrypted).toBe(largeData);
    });

    it('should handle unicode characters', async () => {
      const unicodeData = '🌐 OpenContext Network 日本語 emoji test 🚀';
      const encrypted = await ContextCrypto.encrypt(unicodeData, testPassword);
      const decrypted = await ContextCrypto.decrypt(encrypted, testPassword);
      expect(decrypted).toBe(unicodeData);
    });
  });

  describe('generatePassword', () => {
    it('should generate random passwords', () => {
      const password1 = ContextCrypto.generatePassword();
      const password2 = ContextCrypto.generatePassword();
      
      expect(password1).toBeTruthy();
      expect(password2).toBeTruthy();
      expect(password1).not.toBe(password2);
      expect(password1).toHaveLength(64); // 32 bytes * 2 hex chars
    });
  });

  describe('derivePasswordFromPrivateKey', () => {
    it('should derive consistent password from private key', () => {
      const privateKey = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      
      const password1 = ContextCrypto.derivePasswordFromPrivateKey(privateKey);
      const password2 = ContextCrypto.derivePasswordFromPrivateKey(privateKey);
      
      expect(password1).toBe(password2);
      expect(password1).toBeTruthy();
    });

    it('should produce different passwords for different keys', () => {
      const key1 = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const key2 = '0x1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      
      const password1 = ContextCrypto.derivePasswordFromPrivateKey(key1);
      const password2 = ContextCrypto.derivePasswordFromPrivateKey(key2);
      
      expect(password1).not.toBe(password2);
    });
  });

  describe('base64 utilities', () => {
    it('should encode and decode base64', () => {
      const encoded = ContextCrypto.encodeBase64(testData);
      const decoded = ContextCrypto.decodeBase64(encoded);
      
      expect(decoded).toBe(testData);
      expect(encoded).toBe(Buffer.from(testData).toString('base64'));
    });
  });
});