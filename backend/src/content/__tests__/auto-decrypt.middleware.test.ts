import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import {
  setupAutoDecryption,
  autoDecryptContent,
  manualDecryptContent,
  checkAutoDecryptionAvailable,
  cleanupSessionDecryption
} from '../auto-decrypt.middleware.js';

// Mock dependencies
vi.mock('../key-escrow.service.js', () => ({
  getUserSessionKey: vi.fn(),
  retrieveContentKeyFromEscrow: vi.fn()
}));

vi.mock('../encryption.service.js', () => ({
  decryptContent: vi.fn()
}));

vi.mock('../../payments/payment.service.js', () => ({
  checkContentAccess: vi.fn()
}));

vi.mock('../../common/prisma.js', () => ({
  prisma: {
    content: {
      findUnique: vi.fn()
    }
  }
}));

describe('Auto-Decrypt Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      user: { id: 'user-123', name: 'Test User' }
    };
    
    const jsonMock = vi.fn();
    mockRes = {
      json: jsonMock
    };
    
    mockNext = vi.fn();
    
    vi.clearAllMocks();
    global.sessionKeys = new Map();
  });

  describe('setupAutoDecryption', () => {
    const { getUserSessionKey } = require('../key-escrow.service.js');

    it('should setup auto-decryption for authenticated user', async () => {
      const testSessionKey = Buffer.from('test-session-key');
      getUserSessionKey.mockResolvedValue(testSessionKey);

      setupAutoDecryption(mockReq as Request, mockRes as Response, mockNext);

      // Wait for async operation
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(getUserSessionKey).toHaveBeenCalledWith('user-123');
      expect(mockReq.sessionKey).toEqual(testSessionKey);
      expect(mockReq.autoDecrypt).toBe(true);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should skip setup for unauthenticated user', () => {
      mockReq.user = undefined;

      setupAutoDecryption(mockReq as Request, mockRes as Response, mockNext);

      expect(getUserSessionKey).not.toHaveBeenCalled();
      expect(mockReq.sessionKey).toBeUndefined();
      expect(mockReq.autoDecrypt).toBeUndefined();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should continue without auto-decryption on session key error', async () => {
      getUserSessionKey.mockRejectedValue(new Error('Session key error'));

      setupAutoDecryption(mockReq as Request, mockRes as Response, mockNext);

      // Wait for async operation
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.sessionKey).toBeUndefined();
      expect(mockReq.autoDecrypt).toBeUndefined();
    });

    it('should handle synchronous errors gracefully', () => {
      mockReq.user = null; // This should cause an error in accessing .id

      expect(() => {
        setupAutoDecryption(mockReq as Request, mockRes as Response, mockNext);
      }).not.toThrow();

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('autoDecryptContent', () => {
    const { checkContentAccess } = require('../../payments/payment.service.js');
    const { retrieveContentKeyFromEscrow } = require('../key-escrow.service.js');
    const { decryptContent } = require('../encryption.service.js');
    const { prisma } = require('../../common/prisma.js');

    beforeEach(() => {
      mockReq.autoDecrypt = true;
      mockReq.sessionKey = Buffer.from('test-session-key');
      mockReq.user = { id: 'user-123' };
    });

    it('should skip auto-decryption if not enabled', () => {
      mockReq.autoDecrypt = false;

      autoDecryptContent(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.json).toEqual(expect.any(Function)); // Original function preserved
    });

    it('should skip auto-decryption if no session key', () => {
      mockReq.sessionKey = undefined;

      autoDecryptContent(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should skip auto-decryption if no user', () => {
      mockReq.user = undefined;

      autoDecryptContent(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should decrypt single content object', async () => {
      const mockContent = {
        id: 'content-123',
        title: 'Test Content',
        encrypted: true,
        decrypted: false
      };

      const mockEncryptedContent = {
        encryptedData: 'encrypted',
        iv: 'iv',
        authTag: 'tag',
        algorithm: 'aes-256-gcm'
      };

      const testContentKey = Buffer.from('content-key');
      const decryptedText = 'This is the decrypted content';

      checkContentAccess.mockResolvedValue(true);
      retrieveContentKeyFromEscrow.mockResolvedValue(testContentKey);
      prisma.content.findUnique.mockResolvedValue({
        encryptedContent: JSON.stringify(mockEncryptedContent)
      });
      decryptContent.mockReturnValue(decryptedText);

      autoDecryptContent(mockReq as Request, mockRes as Response, mockNext);

      // Simulate calling the overridden res.json
      const originalJson = mockRes.json;
      await (originalJson as any)(mockContent);

      expect(checkContentAccess).toHaveBeenCalledWith('user-123', 'content-123');
      expect(retrieveContentKeyFromEscrow).toHaveBeenCalledWith('content-123', 'user-123');
      expect(decryptContent).toHaveBeenCalledWith(mockEncryptedContent, testContentKey);
    });

    it('should handle content array decryption', async () => {
      const mockContentArray = [
        { id: 'content-1', encrypted: true, decrypted: false },
        { id: 'content-2', encrypted: true, decrypted: false }
      ];

      const responseData = {
        content: mockContentArray,
        total: 2
      };

      checkContentAccess.mockResolvedValue(true);
      retrieveContentKeyFromEscrow.mockResolvedValue(Buffer.from('key'));
      prisma.content.findUnique.mockResolvedValue({
        encryptedContent: JSON.stringify({ test: 'data' })
      });
      decryptContent.mockReturnValue('decrypted content');

      autoDecryptContent(mockReq as Request, mockRes as Response, mockNext);

      const originalJson = mockRes.json;
      await (originalJson as any)(responseData);

      expect(checkContentAccess).toHaveBeenCalledTimes(2);
      expect(retrieveContentKeyFromEscrow).toHaveBeenCalledTimes(2);
    });

    it('should handle access denied gracefully', async () => {
      const mockContent = {
        id: 'content-123',
        encrypted: true,
        decrypted: false
      };

      checkContentAccess.mockResolvedValue(false);

      autoDecryptContent(mockReq as Request, mockRes as Response, mockNext);

      const originalJson = mockRes.json;
      await (originalJson as any)(mockContent);

      expect(retrieveContentKeyFromEscrow).not.toHaveBeenCalled();
      expect(mockContent.hasAccess).toBe(false);
      expect(mockContent.decrypted).toBe(false);
    });

    it('should handle missing content key gracefully', async () => {
      const mockContent = {
        id: 'content-123',
        encrypted: true,
        decrypted: false
      };

      checkContentAccess.mockResolvedValue(true);
      retrieveContentKeyFromEscrow.mockResolvedValue(null);

      autoDecryptContent(mockReq as Request, mockRes as Response, mockNext);

      const originalJson = mockRes.json;
      await (originalJson as any)(mockContent);

      expect(mockContent.hasAccess).toBe(true);
      expect(mockContent.decrypted).toBe(false);
    });

    it('should handle decryption errors gracefully', async () => {
      const mockContent = {
        id: 'content-123',
        encrypted: true,
        decrypted: false
      };

      checkContentAccess.mockResolvedValue(true);
      retrieveContentKeyFromEscrow.mockResolvedValue(Buffer.from('key'));
      prisma.content.findUnique.mockResolvedValue({
        encryptedContent: JSON.stringify({ test: 'data' })
      });
      decryptContent.mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      autoDecryptContent(mockReq as Request, mockRes as Response, mockNext);

      const originalJson = mockRes.json;
      await (originalJson as any)(mockContent);

      expect(mockContent.hasAccess).toBe(false);
      expect(mockContent.decrypted).toBe(false);
    });

    it('should pass through non-content responses unchanged', async () => {
      const nonContentResponse = {
        message: 'Hello world',
        status: 'success'
      };

      autoDecryptContent(mockReq as Request, mockRes as Response, mockNext);

      const originalJson = mockRes.json;
      const result = await (originalJson as any)(nonContentResponse);

      expect(checkContentAccess).not.toHaveBeenCalled();
      expect(result).toEqual(nonContentResponse);
    });
  });

  describe('manualDecryptContent', () => {
    const { checkContentAccess } = require('../../payments/payment.service.js');
    const { retrieveContentKeyFromEscrow } = require('../key-escrow.service.js');
    const { decryptContent } = require('../encryption.service.js');
    const { prisma } = require('../../common/prisma.js');

    const testContentId = 'content-123';
    const testUserId = 'user-123';

    it('should decrypt content successfully', async () => {
      const testContentKey = Buffer.from('content-key');
      const decryptedText = 'This is the decrypted content';
      const mockEncryptedContent = {
        encryptedData: 'encrypted',
        iv: 'iv',
        authTag: 'tag',
        algorithm: 'aes-256-gcm'
      };

      checkContentAccess.mockResolvedValue(true);
      retrieveContentKeyFromEscrow.mockResolvedValue(testContentKey);
      prisma.content.findUnique.mockResolvedValue({
        encryptedContent: JSON.stringify(mockEncryptedContent)
      });
      decryptContent.mockReturnValue(decryptedText);

      const result = await manualDecryptContent(testContentId, testUserId);

      expect(result.success).toBe(true);
      expect(result.content).toBe(decryptedText);
      expect(result.error).toBeUndefined();
    });

    it('should fail if user has no access', async () => {
      checkContentAccess.mockResolvedValue(false);

      const result = await manualDecryptContent(testContentId, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
      expect(result.content).toBeUndefined();
    });

    it('should fail if content key not available', async () => {
      checkContentAccess.mockResolvedValue(true);
      retrieveContentKeyFromEscrow.mockResolvedValue(null);

      const result = await manualDecryptContent(testContentId, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Decryption key not available');
    });

    it('should fail if encrypted content not found', async () => {
      checkContentAccess.mockResolvedValue(true);
      retrieveContentKeyFromEscrow.mockResolvedValue(Buffer.from('key'));
      prisma.content.findUnique.mockResolvedValue(null);

      const result = await manualDecryptContent(testContentId, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Encrypted content not found');
    });

    it('should handle decryption errors', async () => {
      checkContentAccess.mockResolvedValue(true);
      retrieveContentKeyFromEscrow.mockResolvedValue(Buffer.from('key'));
      prisma.content.findUnique.mockResolvedValue({
        encryptedContent: JSON.stringify({ test: 'data' })
      });
      decryptContent.mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      const result = await manualDecryptContent(testContentId, testUserId);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Decryption failed');
    });
  });

  describe('checkAutoDecryptionAvailable', () => {
    const { getUserSessionKey } = require('../key-escrow.service.js');

    it('should return true if session key available', async () => {
      getUserSessionKey.mockResolvedValue(Buffer.from('session-key'));

      const available = await checkAutoDecryptionAvailable('user-123');

      expect(available).toBe(true);
      expect(getUserSessionKey).toHaveBeenCalledWith('user-123');
    });

    it('should return false if session key not available', async () => {
      getUserSessionKey.mockResolvedValue(null);

      const available = await checkAutoDecryptionAvailable('user-123');

      expect(available).toBe(false);
    });

    it('should return false on error', async () => {
      getUserSessionKey.mockRejectedValue(new Error('Session error'));

      const available = await checkAutoDecryptionAvailable('user-123');

      expect(available).toBe(false);
    });
  });

  describe('cleanupSessionDecryption', () => {
    it('should remove session key from global storage', () => {
      const testUserId = 'user-123';
      global.sessionKeys = new Map();
      global.sessionKeys.set(testUserId, { test: 'data' });

      cleanupSessionDecryption(testUserId);

      expect(global.sessionKeys.has(testUserId)).toBe(false);
    });

    it('should handle missing global storage gracefully', () => {
      global.sessionKeys = undefined as any;

      expect(() => {
        cleanupSessionDecryption('user-123');
      }).not.toThrow();
    });

    it('should handle missing user gracefully', () => {
      global.sessionKeys = new Map();

      expect(() => {
        cleanupSessionDecryption('nonexistent-user');
      }).not.toThrow();
    });
  });

  describe('Integration Tests', () => {
    it('should handle complete auto-decryption flow', async () => {
      const { getUserSessionKey } = require('../key-escrow.service.js');
      const { checkContentAccess } = require('../../payments/payment.service.js');
      const { retrieveContentKeyFromEscrow } = require('../key-escrow.service.js');
      const { decryptContent } = require('../encryption.service.js');
      const { prisma } = require('../../common/prisma.js');

      // Setup
      const testSessionKey = Buffer.from('session-key');
      const testContentKey = Buffer.from('content-key');
      const decryptedText = 'Decrypted content';

      getUserSessionKey.mockResolvedValue(testSessionKey);
      checkContentAccess.mockResolvedValue(true);
      retrieveContentKeyFromEscrow.mockResolvedValue(testContentKey);
      prisma.content.findUnique.mockResolvedValue({
        encryptedContent: JSON.stringify({ test: 'encrypted' })
      });
      decryptContent.mockReturnValue(decryptedText);

      // Test setup middleware
      setupAutoDecryption(mockReq as Request, mockRes as Response, mockNext);
      await new Promise(resolve => setTimeout(resolve, 0));

      // Test auto-decryption middleware
      autoDecryptContent(mockReq as Request, mockRes as Response, mockNext);

      // Test content response
      const contentResponse = {
        id: 'content-123',
        encrypted: true,
        decrypted: false
      };

      const originalJson = mockRes.json;
      await (originalJson as any)(contentResponse);

      // Verify complete flow
      expect(mockReq.sessionKey).toEqual(testSessionKey);
      expect(mockReq.autoDecrypt).toBe(true);
      expect(checkContentAccess).toHaveBeenCalledWith('user-123', 'content-123');
      expect(retrieveContentKeyFromEscrow).toHaveBeenCalledWith('content-123', 'user-123');
      expect(decryptContent).toHaveBeenCalled();
    });
  });
});