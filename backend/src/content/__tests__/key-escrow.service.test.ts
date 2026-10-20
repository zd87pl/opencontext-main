import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import {
  generateSessionKey,
  storeContentKeyInEscrow,
  retrieveContentKeyFromEscrow,
  getUserSessionKey,
  grantContentAccess,
  revokeContentAccess,
  getUserContentKeys,
  cleanupExpiredEscrowRecords
} from '../key-escrow.service.js';
import { encryptContentKeyForUser } from '../encryption.service.js';

// vi.mock is hoisted above the imports, so anything a factory references must be hoisted too.
const { mockPrisma, mockCheckContentAccess } = vi.hoisted(() => ({
  mockPrisma: {
    contentKeyEscrow: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn()
    }
  },
  mockCheckContentAccess: vi.fn()
}));

vi.mock('../../common/prisma.js', () => ({
  prisma: mockPrisma
}));

// The access check lives in access.service.ts (the one place that owns it).
vi.mock('../../payments/access.service.js', () => ({
  checkContentAccess: mockCheckContentAccess
}));

/** Makes the create mock return what it was asked to store, like a real insert. */
function echoEscrowCreate(): void {
  mockPrisma.contentKeyEscrow.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data,
    createdAt: new Date()
  }));
}

describe('Key Escrow Service', () => {
  let testContentKey: Buffer;
  let testUserId: string;
  let testContentId: string;

  beforeEach(() => {
    testContentKey = crypto.randomBytes(32);
    testUserId = 'user-123';
    testContentId = 'content-456';

    // Clear global session keys before each test
    global.sessionKeys = new Map();

    // Reset all mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up global state
    global.sessionKeys = new Map();
  });

  describe('generateSessionKey', () => {
    it('should generate a 32-byte session key', () => {
      const sessionKey = generateSessionKey();
      expect(sessionKey).toBeInstanceOf(Buffer);
      expect(sessionKey.length).toBe(32);
    });

    it('should generate unique session keys', () => {
      const key1 = generateSessionKey();
      const key2 = generateSessionKey();
      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('getUserSessionKey', () => {
    it('should create new session key for new user', async () => {
      const sessionKey = await getUserSessionKey(testUserId);

      expect(sessionKey).toBeInstanceOf(Buffer);
      expect(sessionKey.length).toBe(32);

      // Should store in global cache
      expect(global.sessionKeys?.has(testUserId)).toBe(true);
    });

    it('should return existing session key for existing user', async () => {
      const firstKey = await getUserSessionKey(testUserId);
      const secondKey = await getUserSessionKey(testUserId);

      expect(firstKey.equals(secondKey)).toBe(true);
    });

    it('should create new key if existing key is expired', async () => {
      // Manually set an expired key
      const expiredKeyData = {
        userId: testUserId,
        sessionKey: crypto.randomBytes(32).toString('hex'),
        createdAt: new Date(Date.now() - 2000).toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString() // Expired 1 second ago
      };

      global.sessionKeys = new Map();
      global.sessionKeys.set(testUserId, expiredKeyData);

      const newKey = await getUserSessionKey(testUserId);

      expect(newKey).toBeInstanceOf(Buffer);
      expect(newKey.toString('hex')).not.toBe(expiredKeyData.sessionKey);
    });
  });

  describe('storeContentKeyInEscrow', () => {
    beforeEach(() => {
      mockPrisma.contentKeyEscrow.create.mockResolvedValue({
        id: 'escrow-123',
        contentId: testContentId,
        userId: testUserId,
        encryptedContentKey: '{"encryptedData":"test","iv":"test","authTag":"test","algorithm":"aes-256-gcm"}',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      });
    });

    it('should store content key in escrow successfully', async () => {
      const result = await storeContentKeyInEscrow(testContentId, testContentKey, testUserId);

      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('contentId', testContentId);
      expect(result).toHaveProperty('encryptedContentKey');
      expect(result).toHaveProperty('createdAt');

      expect(mockPrisma.contentKeyEscrow.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          contentId: testContentId,
          userId: testUserId,
          encryptedContentKey: expect.any(String)
        })
      });
    });

    it('should handle custom expiration date', async () => {
      const customExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      await storeContentKeyInEscrow(testContentId, testContentKey, testUserId, customExpiry);

      expect(mockPrisma.contentKeyEscrow.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          expiresAt: customExpiry
        })
      });
    });
  });

  describe('retrieveContentKeyFromEscrow', () => {
    beforeEach(() => {
      // Mock successful access check
      mockCheckContentAccess.mockResolvedValue(true);
      echoEscrowCreate();
    });

    it('should retrieve and decrypt content key successfully', async () => {
      // First store a key to retrieve
      await storeContentKeyInEscrow(testContentId, testContentKey, testUserId);

      // Mock the database response
      const sessionKey = await getUserSessionKey(testUserId);
      const encryptedKey = encryptContentKeyForUser(testContentKey, sessionKey);

      mockPrisma.contentKeyEscrow.findFirst.mockResolvedValue({
        id: 'escrow-123',
        contentId: testContentId,
        userId: testUserId,
        encryptedContentKey: JSON.stringify(encryptedKey),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      });

      const retrievedKey = await retrieveContentKeyFromEscrow(testContentId, testUserId);

      expect(retrievedKey).toBeInstanceOf(Buffer);
      expect(retrievedKey?.equals(testContentKey)).toBe(true);
    });

    it('should return null if user has no access', async () => {
      mockCheckContentAccess.mockResolvedValue(false);

      await expect(retrieveContentKeyFromEscrow(testContentId, testUserId)).rejects.toThrow(
        'Access denied to content'
      );
    });

    it('should return null if no escrow record found', async () => {
      mockCheckContentAccess.mockResolvedValue(true);

      mockPrisma.contentKeyEscrow.findFirst.mockResolvedValue(null);

      const result = await retrieveContentKeyFromEscrow(testContentId, testUserId);
      expect(result).toBeNull();
    });

    it('should handle expired escrow records', async () => {
      mockCheckContentAccess.mockResolvedValue(true);

      // Mock expired record
      mockPrisma.contentKeyEscrow.findFirst.mockResolvedValue(null);

      const result = await retrieveContentKeyFromEscrow(testContentId, testUserId);
      expect(result).toBeNull();
    });
  });

  describe('grantContentAccess', () => {
    it('should grant access by storing key in escrow', async () => {
      mockPrisma.contentKeyEscrow.create.mockResolvedValue({
        id: 'escrow-123',
        contentId: testContentId,
        userId: testUserId,
        encryptedContentKey: '{}',
        createdAt: new Date(),
        expiresAt: null
      });

      await expect(grantContentAccess(testContentId, testUserId, testContentKey)).resolves.not.toThrow();

      expect(mockPrisma.contentKeyEscrow.create).toHaveBeenCalled();
    });
  });

  describe('revokeContentAccess', () => {
    it('should revoke access by deleting escrow records', async () => {
      mockPrisma.contentKeyEscrow.deleteMany.mockResolvedValue({ count: 1 });

      await expect(revokeContentAccess(testContentId, testUserId)).resolves.not.toThrow();

      expect(mockPrisma.contentKeyEscrow.deleteMany).toHaveBeenCalledWith({
        where: {
          contentId: testContentId,
          userId: testUserId
        }
      });
    });
  });

  describe('getUserContentKeys', () => {
    it('should return user content keys with content details', async () => {
      const mockEscrowRecords = [
        {
          id: 'escrow-1',
          contentId: 'content-1',
          userId: testUserId,
          encryptedContentKey: '{"test": "data"}',
          createdAt: new Date(),
          expiresAt: null,
          content: {
            title: 'Test Content 1',
            description: 'Test Description 1',
            platform: 'wordpress'
          }
        },
        {
          id: 'escrow-2',
          contentId: 'content-2',
          userId: testUserId,
          encryptedContentKey: '{"test": "data2"}',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 1000000),
          content: {
            title: 'Test Content 2',
            description: 'Test Description 2',
            platform: 'medium'
          }
        }
      ];

      mockPrisma.contentKeyEscrow.findMany.mockResolvedValue(mockEscrowRecords);

      const result = await getUserContentKeys(testUserId);

      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('id', 'escrow-1');
      expect(result[0]).toHaveProperty('contentId', 'content-1');
      expect(result[0]).toHaveProperty('encryptedContentKey');
      expect(result[1]).toHaveProperty('expiresAt');

      expect(mockPrisma.contentKeyEscrow.findMany).toHaveBeenCalledWith({
        where: {
          userId: testUserId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]
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
    });

    it('should handle empty result', async () => {
      mockPrisma.contentKeyEscrow.findMany.mockResolvedValue([]);

      const result = await getUserContentKeys(testUserId);
      expect(result).toHaveLength(0);
    });
  });

  describe('cleanupExpiredEscrowRecords', () => {
    it('should delete expired records and return count', async () => {
      mockPrisma.contentKeyEscrow.deleteMany.mockResolvedValue({ count: 5 });

      const deletedCount = await cleanupExpiredEscrowRecords();

      expect(deletedCount).toBe(5);
      expect(mockPrisma.contentKeyEscrow.deleteMany).toHaveBeenCalledWith({
        where: {
          expiresAt: {
            lt: expect.any(Date)
          }
        }
      });
    });

    it('should handle cleanup errors gracefully', async () => {
      mockPrisma.contentKeyEscrow.deleteMany.mockRejectedValue(new Error('Database error'));

      const deletedCount = await cleanupExpiredEscrowRecords();
      expect(deletedCount).toBe(0);
    });
  });

  describe('Session Key Management', () => {
    it('should handle concurrent session key requests', async () => {
      // Simulate multiple concurrent requests for the same user
      const promises = Array.from({ length: 5 }, () => getUserSessionKey(testUserId));
      const results = await Promise.all(promises);

      // All should return the same key
      const firstKey = results[0];
      results.forEach((key) => {
        expect(key.equals(firstKey)).toBe(true);
      });
    });

    it('should properly expire session keys', async () => {
      // Get initial key
      const initialKey = await getUserSessionKey(testUserId);

      // Manually expire the key
      const keyData = global.sessionKeys?.get(testUserId);
      if (keyData) {
        keyData.expiresAt = new Date(Date.now() - 1000).toISOString();
      }

      // Request key again - should get new one
      const newKey = await getUserSessionKey(testUserId);

      expect(newKey.equals(initialKey)).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle database connection errors', async () => {
      mockPrisma.contentKeyEscrow.create.mockRejectedValue(new Error('Connection failed'));

      await expect(storeContentKeyInEscrow(testContentId, testContentKey, testUserId)).rejects.toThrow();
    });

    it('should handle invalid encrypted content key format', async () => {
      mockCheckContentAccess.mockResolvedValue(true);

      mockPrisma.contentKeyEscrow.findFirst.mockResolvedValue({
        id: 'escrow-123',
        contentId: testContentId,
        userId: testUserId,
        encryptedContentKey: 'invalid-json',
        createdAt: new Date(),
        expiresAt: null
      });

      await expect(retrieveContentKeyFromEscrow(testContentId, testUserId)).rejects.toThrow();
    });
  });
});
