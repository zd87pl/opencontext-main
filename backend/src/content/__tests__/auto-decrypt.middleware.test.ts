import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { Request, Response } from 'express';
import {
  setupAutoDecryption,
  autoDecryptContent,
  manualDecryptContent,
  checkAutoDecryptionAvailable,
  cleanupSessionDecryption
} from '../auto-decrypt.middleware.js';
import { fakeUser } from '../../__tests__/fixtures.js';

// vi.mock is hoisted above the imports, so anything a factory references must be hoisted too.
const mocks = vi.hoisted(() => ({
  getUserSessionKey: vi.fn(),
  retrieveContentKeyFromEscrow: vi.fn(),
  decryptContent: vi.fn(),
  checkContentAccess: vi.fn(),
  prisma: {
    content: {
      findUnique: vi.fn()
    }
  }
}));

vi.mock('../key-escrow.service.js', () => ({
  getUserSessionKey: mocks.getUserSessionKey,
  retrieveContentKeyFromEscrow: mocks.retrieveContentKeyFromEscrow
}));

vi.mock('../encryption.service.js', () => ({
  decryptContent: mocks.decryptContent
}));

vi.mock('../../payments/access.service.js', () => ({
  checkContentAccess: mocks.checkContentAccess
}));

vi.mock('../../common/prisma.js', () => ({
  prisma: mocks.prisma
}));

const { getUserSessionKey, retrieveContentKeyFromEscrow, decryptContent, checkContentAccess, prisma } = mocks;

interface MockRequest {
  user?: Express.User | null;
  sessionKey?: Buffer;
  autoDecrypt?: boolean;
}

interface MockResponse {
  json: Mock<[unknown], unknown>;
}

interface ContentItem {
  id: string;
  title?: string;
  encrypted: boolean;
  decrypted: boolean;
  hasAccess?: boolean;
  content?: string;
}

const asRequest = (req: MockRequest): Request => req as unknown as Request;
const asResponse = (res: MockResponse): Response => res as unknown as Response;

describe('Auto-Decrypt Middleware', () => {
  let mockReq: MockRequest;
  let mockRes: MockResponse;
  let jsonMock: Mock<[unknown], unknown>;
  let mockNext: Mock<[unknown?], void>;

  beforeEach(() => {
    mockReq = {
      user: fakeUser()
    };

    jsonMock = vi.fn();
    mockRes = {
      json: jsonMock
    };

    mockNext = vi.fn();

    vi.clearAllMocks();
    global.sessionKeys = new Map();
  });

  describe('setupAutoDecryption', () => {
    it('should setup auto-decryption for authenticated user', async () => {
      const testSessionKey = Buffer.from('test-session-key');
      getUserSessionKey.mockResolvedValue(testSessionKey);

      setupAutoDecryption(asRequest(mockReq), asResponse(mockRes), mockNext);

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getUserSessionKey).toHaveBeenCalledWith('user-123');
      expect(mockReq.sessionKey).toEqual(testSessionKey);
      expect(mockReq.autoDecrypt).toBe(true);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should skip setup for unauthenticated user', () => {
      mockReq.user = undefined;

      setupAutoDecryption(asRequest(mockReq), asResponse(mockRes), mockNext);

      expect(getUserSessionKey).not.toHaveBeenCalled();
      expect(mockReq.sessionKey).toBeUndefined();
      expect(mockReq.autoDecrypt).toBeUndefined();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should continue without auto-decryption on session key error', async () => {
      getUserSessionKey.mockRejectedValue(new Error('Session key error'));

      setupAutoDecryption(asRequest(mockReq), asResponse(mockRes), mockNext);

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.sessionKey).toBeUndefined();
      expect(mockReq.autoDecrypt).toBeUndefined();
    });

    it('should handle synchronous errors gracefully', () => {
      mockReq.user = null; // Passport may leave a null user on a stale session

      expect(() => {
        setupAutoDecryption(asRequest(mockReq), asResponse(mockRes), mockNext);
      }).not.toThrow();

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('autoDecryptContent', () => {
    beforeEach(() => {
      mockReq.autoDecrypt = true;
      mockReq.sessionKey = Buffer.from('test-session-key');
      mockReq.user = fakeUser();
    });

    it('should skip auto-decryption if not enabled', () => {
      mockReq.autoDecrypt = false;

      autoDecryptContent(asRequest(mockReq), asResponse(mockRes), mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.json).toBe(jsonMock); // Original function preserved
    });

    it('should skip auto-decryption if no session key', () => {
      mockReq.sessionKey = undefined;

      autoDecryptContent(asRequest(mockReq), asResponse(mockRes), mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.json).toBe(jsonMock);
    });

    it('should skip auto-decryption if no user', () => {
      mockReq.user = undefined;

      autoDecryptContent(asRequest(mockReq), asResponse(mockRes), mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.json).toBe(jsonMock);
    });

    it('should decrypt single content object', async () => {
      const mockContent: ContentItem = {
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

      autoDecryptContent(asRequest(mockReq), asResponse(mockRes), mockNext);

      // Call the overridden res.json and wait for decryption to finish
      await mockRes.json(mockContent);

      expect(checkContentAccess).toHaveBeenCalledWith('user-123', 'content-123');
      expect(retrieveContentKeyFromEscrow).toHaveBeenCalledWith('content-123', 'user-123');
      expect(decryptContent).toHaveBeenCalledWith(mockEncryptedContent, testContentKey);
      expect(mockContent.content).toBe(decryptedText);
      expect(mockContent.decrypted).toBe(true);
      expect(jsonMock).toHaveBeenCalledWith(mockContent);
    });

    it('should handle content array decryption', async () => {
      const mockContentArray: ContentItem[] = [
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

      autoDecryptContent(asRequest(mockReq), asResponse(mockRes), mockNext);

      await mockRes.json(responseData);

      expect(checkContentAccess).toHaveBeenCalledTimes(2);
      expect(retrieveContentKeyFromEscrow).toHaveBeenCalledTimes(2);
      expect(jsonMock).toHaveBeenCalledWith(responseData);
    });

    it('should handle access denied gracefully', async () => {
      const mockContent: ContentItem = {
        id: 'content-123',
        encrypted: true,
        decrypted: false
      };

      checkContentAccess.mockResolvedValue(false);

      autoDecryptContent(asRequest(mockReq), asResponse(mockRes), mockNext);

      await mockRes.json(mockContent);

      expect(retrieveContentKeyFromEscrow).not.toHaveBeenCalled();
      expect(mockContent.hasAccess).toBe(false);
      expect(mockContent.decrypted).toBe(false);
    });

    it('should handle missing content key gracefully', async () => {
      const mockContent: ContentItem = {
        id: 'content-123',
        encrypted: true,
        decrypted: false
      };

      checkContentAccess.mockResolvedValue(true);
      retrieveContentKeyFromEscrow.mockResolvedValue(null);

      autoDecryptContent(asRequest(mockReq), asResponse(mockRes), mockNext);

      await mockRes.json(mockContent);

      expect(mockContent.hasAccess).toBe(true);
      expect(mockContent.decrypted).toBe(false);
    });

    it('should handle decryption errors gracefully', async () => {
      const mockContent: ContentItem = {
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

      autoDecryptContent(asRequest(mockReq), asResponse(mockRes), mockNext);

      await mockRes.json(mockContent);

      expect(mockContent.hasAccess).toBe(false);
      expect(mockContent.decrypted).toBe(false);
    });

    it('should pass through non-content responses unchanged', async () => {
      const nonContentResponse = {
        message: 'Hello world',
        status: 'success'
      };

      autoDecryptContent(asRequest(mockReq), asResponse(mockRes), mockNext);

      await mockRes.json(nonContentResponse);

      // res.json returns the Response, not the body, so check what was sent.
      expect(checkContentAccess).not.toHaveBeenCalled();
      expect(jsonMock).toHaveBeenCalledWith(nonContentResponse);
      expect(nonContentResponse).toEqual({ message: 'Hello world', status: 'success' });
    });
  });

  describe('manualDecryptContent', () => {
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
      global.sessionKeys.set(testUserId, {
        userId: testUserId,
        sessionKey: 'ab'.repeat(32),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });

      cleanupSessionDecryption(testUserId);

      expect(global.sessionKeys.has(testUserId)).toBe(false);
    });

    it('should handle missing global storage gracefully', () => {
      global.sessionKeys = undefined;

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
      setupAutoDecryption(asRequest(mockReq), asResponse(mockRes), mockNext);
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Test auto-decryption middleware
      autoDecryptContent(asRequest(mockReq), asResponse(mockRes), mockNext);

      // Test content response
      const contentResponse: ContentItem = {
        id: 'content-123',
        encrypted: true,
        decrypted: false
      };

      await mockRes.json(contentResponse);

      // Verify complete flow
      expect(mockReq.sessionKey).toEqual(testSessionKey);
      expect(mockReq.autoDecrypt).toBe(true);
      expect(checkContentAccess).toHaveBeenCalledWith('user-123', 'content-123');
      expect(retrieveContentKeyFromEscrow).toHaveBeenCalledWith('content-123', 'user-123');
      expect(decryptContent).toHaveBeenCalled();
      expect(contentResponse.content).toBe(decryptedText);
    });
  });
});
