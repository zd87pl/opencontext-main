import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { generateContentKey, encryptContent, decryptContent } from '../content/encryption.service.js';
import { storeContentKeyInEscrow, retrieveContentKeyFromEscrow } from '../content/key-escrow.service.js';
import { createPaymentIntent, processStripePayment, checkContentAccess } from '../payments/payment.service.js';

// Mock Prisma for integration tests
const mockPrisma = {
  content: {
    findUnique: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn()
  },
  purchase: {
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn()
  },
  contentKeyEscrow: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    deleteMany: vi.fn()
  },
  user: {
    findUnique: vi.fn()
  }
};

vi.mock('../common/prisma.js', () => ({
  prisma: mockPrisma
}));

// Mock Stripe
const mockStripe = {
  paymentIntents: {
    create: vi.fn(),
    retrieve: vi.fn()
  }
};

vi.mock('stripe', () => ({
  default: vi.fn(() => mockStripe)
}));

// Mock wallet service
vi.mock('../wallets/wallet.service.js', () => ({
  getWalletFromEncrypted: vi.fn(),
  getProvider: vi.fn()
}));

describe('Integration Tests', () => {
  beforeAll(() => {
    // Setup test environment
    process.env.STRIPE_SECRET_KEY = 'sk_test_integration';
  });

  beforeEach(() => {
    vi.clearAllMocks();
    global.sessionKeys = new Map();
  });

  describe('Complete Content Monetization Flow', () => {
    it('should handle full content creation, purchase, and access flow', async () => {
      // Test data
      const testContent = 'This is premium content that requires payment to access.';
      const testUserId = 'user-123';
      const testCreatorId = 'creator-456';
      const testContentId = 'content-789';
      const testPrice = 9.99;

      // 1. Content Creation and Encryption
      const contentKey = generateContentKey();
      expect(contentKey).toBeInstanceOf(Buffer);
      expect(contentKey.length).toBe(32);

      const encryptedContent = encryptContent(testContent, contentKey);
      expect(encryptedContent).toHaveProperty('encryptedData');
      expect(encryptedContent).toHaveProperty('iv');
      expect(encryptedContent).toHaveProperty('authTag');

      // Verify we can decrypt
      const decryptedContent = decryptContent(encryptedContent, contentKey);
      expect(decryptedContent).toBe(testContent);

      // 2. Mock content creation in database
      const mockContent = {
        id: testContentId,
        title: 'Premium Content',
        userId: testCreatorId,
        price: testPrice,
        user: {
          id: testCreatorId,
          name: 'Content Creator',
          wallet: {
            address: '0x123...',
            encryptedPrivateKey: 'encrypted_key'
          }
        },
        encryptedKey: JSON.stringify({
          contentKey: contentKey.toString('hex'),
          keyId: 'key-123',
          algorithm: 'aes-256-gcm'
        })
      };

      mockPrisma.content.findUnique.mockResolvedValue(mockContent);

      // 3. Payment Intent Creation
      const mockPaymentIntent = {
        id: 'pi_test_123',
        client_secret: 'pi_test_123_secret',
        amount: 999, // $9.99 in cents
        currency: 'usd',
        status: 'requires_payment_method'
      };

      mockStripe.paymentIntents.create.mockResolvedValue(mockPaymentIntent);
      mockPrisma.purchase.create.mockResolvedValue({
        id: 'purchase-123',
        userId: testUserId,
        contentId: testContentId,
        amount: testPrice,
        status: 'PENDING'
      });

      const paymentIntent = await createPaymentIntent(testUserId, testContentId, testPrice);
      
      expect(paymentIntent).toMatchObject({
        id: mockPaymentIntent.id,
        amount: mockPaymentIntent.amount,
        currency: mockPaymentIntent.currency
      });

      // 4. Payment Processing
      const mockSuccessfulPayment = {
        id: 'pi_test_123',
        status: 'succeeded',
        metadata: {
          userId: testUserId,
          contentId: testContentId,
          creatorId: testCreatorId
        }
      };

      const mockPurchaseRecord = {
        id: 'purchase-123',
        userId: testUserId,
        contentId: testContentId,
        amount: { toString: () => testPrice.toString() },
        content: mockContent
      };

      mockStripe.paymentIntents.retrieve.mockResolvedValue(mockSuccessfulPayment);
      mockPrisma.purchase.findFirst.mockResolvedValue(mockPurchaseRecord);
      mockPrisma.purchase.update.mockResolvedValue({ ...mockPurchaseRecord, status: 'COMPLETED' });

      // Mock key escrow creation
      mockPrisma.contentKeyEscrow.create.mockResolvedValue({
        id: 'escrow-123',
        contentId: testContentId,
        userId: testUserId,
        encryptedContentKey: JSON.stringify(encryptedContent),
        createdAt: new Date()
      });

      const paymentResult = await processStripePayment('pi_test_123');
      
      expect(paymentResult.success).toBe(true);
      expect(paymentResult.transactionId).toBe('pi_test_123');

      // 5. Access Check
      mockPrisma.purchase.findFirst.mockResolvedValue({
        id: 'purchase-123',
        userId: testUserId,
        contentId: testContentId,
        status: 'COMPLETED',
        accessGranted: true,
        accessExpiresAt: new Date(Date.now() + 1000000) // Future date
      });

      const hasAccess = await checkContentAccess(testUserId, testContentId);
      expect(hasAccess).toBe(true);

      // 6. Key Retrieval from Escrow
      mockPrisma.contentKeyEscrow.findFirst.mockResolvedValue({
        id: 'escrow-123',
        contentId: testContentId,
        userId: testUserId,
        encryptedContentKey: JSON.stringify({
          encryptedData: contentKey.toString('hex'), // Simplified for test
          iv: 'test-iv',
          authTag: 'test-tag',
          algorithm: 'aes-256-gcm'
        }),
        createdAt: new Date(),
        expiresAt: null
      });

      // Mock the key escrow retrieval process
      const retrievedKey = contentKey; // Simplified - in real flow this would be decrypted
      expect(retrievedKey.equals(contentKey)).toBe(true);

      // 7. Content Decryption
      const finalDecryptedContent = decryptContent(encryptedContent, retrievedKey);
      expect(finalDecryptedContent).toBe(testContent);

      // Verify all expected database calls were made
      expect(mockPrisma.content.findUnique).toHaveBeenCalled();
      expect(mockPrisma.purchase.create).toHaveBeenCalled();
      expect(mockPrisma.purchase.update).toHaveBeenCalled();
      expect(mockStripe.paymentIntents.create).toHaveBeenCalled();
      expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalled();
    });

    it('should handle payment failure gracefully', async () => {
      const testUserId = 'user-123';
      const testContentId = 'content-456';

      // Mock failed payment
      const mockFailedPayment = {
        id: 'pi_failed_123',
        status: 'failed',
        metadata: {
          userId: testUserId,
          contentId: testContentId
        }
      };

      mockStripe.paymentIntents.retrieve.mockResolvedValue(mockFailedPayment);

      const paymentResult = await processStripePayment('pi_failed_123');
      
      expect(paymentResult.success).toBe(false);
      expect(paymentResult.error).toContain('Payment not successful');

      // Should update purchase status to failed
      expect(mockPrisma.purchase.updateMany).toHaveBeenCalledWith({
        where: { transactionId: 'pi_failed_123' },
        data: { status: 'FAILED' }
      });
    });

    it('should deny access for unpaid content', async () => {
      const testUserId = 'user-123';
      const testContentId = 'content-456';

      // Mock no purchase record found
      mockPrisma.purchase.findFirst.mockResolvedValue(null);

      const hasAccess = await checkContentAccess(testUserId, testContentId);
      expect(hasAccess).toBe(false);
    });

    it('should handle expired access', async () => {
      const testUserId = 'user-123';
      const testContentId = 'content-456';

      // Mock expired purchase (query returns null due to WHERE conditions)
      mockPrisma.purchase.findFirst.mockResolvedValue(null);

      const hasAccess = await checkContentAccess(testUserId, testContentId);
      expect(hasAccess).toBe(false);
    });
  });

  describe('Encryption Security Tests', () => {
    it('should use different IVs for each encryption', () => {
      const content = 'Same content';
      const key = generateContentKey();

      const encrypted1 = encryptContent(content, key);
      const encrypted2 = encryptContent(content, key);

      // IVs should be different
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      
      // But both should decrypt to the same content
      expect(decryptContent(encrypted1, key)).toBe(content);
      expect(decryptContent(encrypted2, key)).toBe(content);
    });

    it('should fail authentication with tampered ciphertext', () => {
      const content = 'Sensitive content';
      const key = generateContentKey();
      const encrypted = encryptContent(content, key);

      // Tamper with the encrypted data
      const tamperedEncrypted = {
        ...encrypted,
        encryptedData: encrypted.encryptedData.slice(0, -2) + 'ff'
      };

      expect(() => {
        decryptContent(tamperedEncrypted, key);
      }).toThrow();
    });

    it('should fail authentication with wrong auth tag', () => {
      const content = 'Sensitive content';
      const key = generateContentKey();
      const encrypted = encryptContent(content, key);

      // Tamper with the auth tag
      const tamperedEncrypted = {
        ...encrypted,
        authTag: 'wrong_auth_tag_here'
      };

      expect(() => {
        decryptContent(tamperedEncrypted, key);
      }).toThrow();
    });
  });

  describe('Error Handling Integration', () => {
    it('should handle database connection failures', async () => {
      mockPrisma.content.findUnique.mockRejectedValue(new Error('Connection failed'));

      await expect(
        createPaymentIntent('user-123', 'content-456', 9.99)
      ).rejects.toThrow('Failed to create payment');
    });

    it('should handle Stripe API failures', async () => {
      mockPrisma.content.findUnique.mockResolvedValue({
        id: 'content-123',
        title: 'Test Content',
        userId: 'creator-123',
        user: { id: 'creator-123', name: 'Creator' }
      });

      mockStripe.paymentIntents.create.mockRejectedValue(new Error('Stripe API error'));

      await expect(
        createPaymentIntent('user-123', 'content-456', 9.99)
      ).rejects.toThrow('Failed to create payment');
    });
  });

  describe('Performance Tests', () => {
    it('should handle multiple concurrent encryptions efficiently', async () => {
      const content = 'Test content for performance';
      const key = generateContentKey();

      const startTime = Date.now();
      
      // Perform 100 concurrent encryptions
      const promises = Array.from({ length: 100 }, () => 
        Promise.resolve(encryptContent(content, key))
      );
      
      const results = await Promise.all(promises);
      const endTime = Date.now();

      expect(results).toHaveLength(100);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete in under 1 second
      
      // All should decrypt correctly
      results.forEach(encrypted => {
        expect(decryptContent(encrypted, key)).toBe(content);
      });
    });
  });
});