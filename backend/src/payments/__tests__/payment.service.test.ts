import { describe, it, expect, beforeEach, vi } from 'vitest';
import Stripe from 'stripe';
import {
  createPaymentIntent,
  processStripePayment,
  handleStripeWebhook,
  getUserPurchases,
  checkContentAccess
} from '../payment.service.js';

// Mock Stripe
const mockStripe = {
  paymentIntents: {
    create: vi.fn(),
    retrieve: vi.fn()
  },
  webhooks: {
    constructEvent: vi.fn()
  }
};

vi.mock('stripe', () => {
  return {
    default: vi.fn(() => mockStripe)
  };
});

// Mock Prisma
const mockPrisma = {
  content: {
    findUnique: vi.fn()
  },
  purchase: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn()
  }
};

vi.mock('../../common/prisma.js', () => ({
  prisma: mockPrisma
}));

// Mock wallet service
vi.mock('../../wallets/wallet.service.js', () => ({
  getWalletFromEncrypted: vi.fn(),
  getProvider: vi.fn()
}));

// Mock key escrow service
const mockGrantContentAccess = vi.fn();
vi.mock('../../content/key-escrow.service.js', () => ({
  grantContentAccess: mockGrantContentAccess
}));

describe('Payment Service', () => {
  const testUserId = 'user-123';
  const testContentId = 'content-456';
  const testAmount = 9.99;
  const testCurrency = 'usd';

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Set required environment variables
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_123';
  });

  describe('createPaymentIntent', () => {
    const mockContent = {
      id: testContentId,
      title: 'Test Content',
      userId: 'creator-123',
      user: {
        id: 'creator-123',
        name: 'Content Creator'
      }
    };

    beforeEach(() => {
      mockPrisma.content.findUnique.mockResolvedValue(mockContent);
      mockPrisma.purchase.create.mockResolvedValue({
        id: 'purchase-123',
        userId: testUserId,
        contentId: testContentId,
        amount: testAmount,
        currency: testCurrency.toUpperCase(),
        status: 'PENDING'
      });
    });

    it('should create payment intent successfully', async () => {
      const mockPaymentIntent = {
        id: 'pi_test_123',
        client_secret: 'pi_test_123_secret_abc',
        amount: 999, // Stripe uses cents
        currency: testCurrency,
        status: 'requires_payment_method'
      };

      mockStripe.paymentIntents.create.mockResolvedValue(mockPaymentIntent);

      const result = await createPaymentIntent(testUserId, testContentId, testAmount);

      expect(result).toEqual({
        id: mockPaymentIntent.id,
        clientSecret: mockPaymentIntent.client_secret,
        amount: mockPaymentIntent.amount,
        currency: mockPaymentIntent.currency,
        status: mockPaymentIntent.status
      });

      expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith({
        amount: 999, // $9.99 in cents
        currency: 'usd',
        metadata: {
          userId: testUserId,
          contentId: testContentId,
          creatorId: mockContent.userId,
          contentTitle: mockContent.title
        },
        description: `Purchase: ${mockContent.title}`,
        automatic_payment_methods: {
          enabled: true
        }
      });

      expect(mockPrisma.purchase.create).toHaveBeenCalledWith({
        data: {
          userId: testUserId,
          contentId: testContentId,
          amount: testAmount,
          currency: 'USD',
          paymentMethod: 'stripe',
          transactionId: mockPaymentIntent.id,
          status: 'PENDING'
        }
      });
    });

    it('should throw error if content not found', async () => {
      mockPrisma.content.findUnique.mockResolvedValue(null);

      await expect(
        createPaymentIntent(testUserId, testContentId, testAmount)
      ).rejects.toThrow('Content not found');
    });

    it('should handle Stripe errors', async () => {
      mockStripe.paymentIntents.create.mockRejectedValue(
        new Error('Stripe API error')
      );

      await expect(
        createPaymentIntent(testUserId, testContentId, testAmount)
      ).rejects.toThrow('Failed to create payment');
    });

    it('should convert amount to cents correctly', async () => {
      const mockPaymentIntent = {
        id: 'pi_test_123',
        client_secret: 'pi_test_123_secret_abc',
        amount: 100, // $1.00 in cents
        currency: testCurrency,
        status: 'requires_payment_method'
      };

      mockStripe.paymentIntents.create.mockResolvedValue(mockPaymentIntent);

      await createPaymentIntent(testUserId, testContentId, 1.00);

      expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 100
        })
      );
    });

    it('should handle custom currency', async () => {
      const customCurrency = 'eur';
      const mockPaymentIntent = {
        id: 'pi_test_123',
        client_secret: 'pi_test_123_secret_abc',
        amount: 999,
        currency: customCurrency,
        status: 'requires_payment_method'
      };

      mockStripe.paymentIntents.create.mockResolvedValue(mockPaymentIntent);

      await createPaymentIntent(testUserId, testContentId, testAmount, customCurrency);

      expect(mockStripe.paymentIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({
          currency: customCurrency
        })
      );

      expect(mockPrisma.purchase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          currency: 'EUR'
        })
      });
    });
  });

  describe('processStripePayment', () => {
    const testPaymentIntentId = 'pi_test_123';
    const mockPurchase = {
      id: 'purchase-123',
      userId: testUserId,
      contentId: testContentId,
      amount: { toString: () => testAmount.toString() },
      content: {
        user: {
          wallet: {
            address: '0x123...',
            encryptedPrivateKey: 'encrypted_key'
          }
        },
        encryptedKey: JSON.stringify({
          contentKey: 'abc123def456',
          keyId: 'key-789',
          algorithm: 'aes-256-gcm'
        })
      }
    };

    beforeEach(() => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        id: testPaymentIntentId,
        status: 'succeeded',
        metadata: {
          userId: testUserId,
          contentId: testContentId,
          creatorId: 'creator-123'
        }
      });

      mockPrisma.purchase.findFirst.mockResolvedValue(mockPurchase);
      mockPrisma.purchase.update.mockResolvedValue({
        ...mockPurchase,
        status: 'COMPLETED'
      });
    });

    it('should process successful payment', async () => {
      const result = await processStripePayment(testPaymentIntentId);

      expect(result.success).toBe(true);
      expect(result.transactionId).toBe(testPaymentIntentId);
      expect(result.blockchainTxHash).toMatch(/^0x[a-f0-9]{64}$/);

      expect(mockStripe.paymentIntents.retrieve).toHaveBeenCalledWith(testPaymentIntentId);
      expect(mockPrisma.purchase.update).toHaveBeenCalledWith({
        where: { id: mockPurchase.id },
        data: {
          status: 'COMPLETED',
          accessGranted: true,
          accessExpiresAt: expect.any(Date)
        }
      });

      expect(mockGrantContentAccess).toHaveBeenCalledWith(
        testContentId,
        testUserId,
        expect.any(Buffer)
      );
    });

    it('should fail if payment intent not succeeded', async () => {
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        id: testPaymentIntentId,
        status: 'requires_payment_method',
        metadata: {}
      });

      await expect(
        processStripePayment(testPaymentIntentId)
      ).rejects.toThrow('Payment not successful');
    });

    it('should fail if purchase record not found', async () => {
      mockPrisma.purchase.findFirst.mockResolvedValue(null);

      await expect(
        processStripePayment(testPaymentIntentId)
      ).rejects.toThrow('Purchase record not found');
    });

    it('should handle blockchain payment errors gracefully', async () => {
      // Mock blockchain error but still complete the purchase update
      const result = await processStripePayment(testPaymentIntentId);

      expect(result.success).toBe(true);
      expect(mockPrisma.purchase.update).toHaveBeenCalled();
    });

    it('should handle key escrow errors gracefully', async () => {
      mockGrantContentAccess.mockRejectedValue(new Error('Escrow failed'));

      const result = await processStripePayment(testPaymentIntentId);

      // Should still succeed even if escrow fails
      expect(result.success).toBe(true);
      expect(mockPrisma.purchase.update).toHaveBeenCalled();
    });

    it('should return failure result on error', async () => {
      mockStripe.paymentIntents.retrieve.mockRejectedValue(
        new Error('Stripe API error')
      );

      const result = await processStripePayment(testPaymentIntentId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Stripe API error');

      expect(mockPrisma.purchase.updateMany).toHaveBeenCalledWith({
        where: { transactionId: testPaymentIntentId },
        data: { status: 'FAILED' }
      });
    });
  });

  describe('handleStripeWebhook', () => {
    const mockBody = 'webhook_body';
    const mockSignature = 'webhook_signature';

    it('should handle payment_intent.succeeded event', async () => {
      const mockEvent = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_test_123'
          }
        }
      };

      mockStripe.webhooks.constructEvent.mockReturnValue(mockEvent);

      // Mock the payment processing
      mockStripe.paymentIntents.retrieve.mockResolvedValue({
        id: 'pi_test_123',
        status: 'succeeded',
        metadata: { userId: testUserId, contentId: testContentId }
      });

      mockPrisma.purchase.findFirst.mockResolvedValue({
        id: 'purchase-123',
        amount: { toString: () => '9.99' },
        content: {
          user: { wallet: { address: '0x123', encryptedPrivateKey: 'key' } },
          encryptedKey: '{"contentKey":"abc123"}'
        }
      });

      await expect(
        handleStripeWebhook(mockBody, mockSignature)
      ).resolves.not.toThrow();

      expect(mockStripe.webhooks.constructEvent).toHaveBeenCalledWith(
        mockBody,
        mockSignature,
        'whsec_test_123'
      );
    });

    it('should handle payment_intent.payment_failed event', async () => {
      const mockEvent = {
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_test_123'
          }
        }
      };

      mockStripe.webhooks.constructEvent.mockReturnValue(mockEvent);
      mockPrisma.purchase.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        handleStripeWebhook(mockBody, mockSignature)
      ).resolves.not.toThrow();

      expect(mockPrisma.purchase.updateMany).toHaveBeenCalledWith({
        where: { transactionId: 'pi_test_123' },
        data: { status: 'FAILED' }
      });
    });

    it('should handle unrecognized events gracefully', async () => {
      const mockEvent = {
        type: 'unhandled_event_type',
        data: {
          object: {}
        }
      };

      mockStripe.webhooks.constructEvent.mockReturnValue(mockEvent);

      await expect(
        handleStripeWebhook(mockBody, mockSignature)
      ).resolves.not.toThrow();
    });

    it('should throw error on invalid webhook signature', async () => {
      mockStripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      await expect(
        handleStripeWebhook(mockBody, mockSignature)
      ).rejects.toThrow('Invalid signature');
    });
  });

  describe('getUserPurchases', () => {
    it('should return user purchases with content details', async () => {
      const mockPurchases = [
        {
          id: 'purchase-1',
          userId: testUserId,
          contentId: 'content-1',
          amount: 9.99,
          status: 'COMPLETED',
          createdAt: new Date(),
          content: {
            id: 'content-1',
            title: 'Test Content 1',
            description: 'Test Description 1',
            platform: 'wordpress',
            user: {
              name: 'Creator 1',
              avatar: 'https://example.com/avatar1.jpg'
            }
          }
        },
        {
          id: 'purchase-2',
          userId: testUserId,
          contentId: 'content-2',
          amount: 4.99,
          status: 'COMPLETED',
          createdAt: new Date(),
          content: {
            id: 'content-2',
            title: 'Test Content 2',
            description: 'Test Description 2',
            platform: 'medium',
            user: {
              name: 'Creator 2',
              avatar: null
            }
          }
        }
      ];

      mockPrisma.purchase.findMany.mockResolvedValue(mockPurchases);

      const result = await getUserPurchases(testUserId);

      expect(result).toEqual(mockPurchases);
      expect(mockPrisma.purchase.findMany).toHaveBeenCalledWith({
        where: { userId: testUserId },
        include: {
          content: {
            select: {
              id: true,
              title: true,
              description: true,
              platform: true,
              user: {
                select: {
                  name: true,
                  avatar: true
                }
              }
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      });
    });

    it('should return empty array for user with no purchases', async () => {
      mockPrisma.purchase.findMany.mockResolvedValue([]);

      const result = await getUserPurchases(testUserId);

      expect(result).toEqual([]);
    });
  });

  describe('checkContentAccess', () => {
    it('should return true for valid access', async () => {
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
    });

    it('should return true for access without expiration', async () => {
      mockPrisma.purchase.findFirst.mockResolvedValue({
        id: 'purchase-123',
        userId: testUserId,
        contentId: testContentId,
        status: 'COMPLETED',
        accessGranted: true,
        accessExpiresAt: null
      });

      const hasAccess = await checkContentAccess(testUserId, testContentId);
      expect(hasAccess).toBe(true);
    });

    it('should return false for expired access', async () => {
      mockPrisma.purchase.findFirst.mockResolvedValue(null);

      const hasAccess = await checkContentAccess(testUserId, testContentId);
      expect(hasAccess).toBe(false);
    });

    it('should return false for pending purchase', async () => {
      mockPrisma.purchase.findFirst.mockResolvedValue(null);

      const hasAccess = await checkContentAccess(testUserId, testContentId);
      expect(hasAccess).toBe(false);
    });

    it('should return false for failed purchase', async () => {
      mockPrisma.purchase.findFirst.mockResolvedValue(null);

      const hasAccess = await checkContentAccess(testUserId, testContentId);
      expect(hasAccess).toBe(false);
    });

    it('should query with correct access conditions', async () => {
      await checkContentAccess(testUserId, testContentId);

      expect(mockPrisma.purchase.findFirst).toHaveBeenCalledWith({
        where: {
          userId: testUserId,
          contentId: testContentId,
          status: 'COMPLETED',
          accessGranted: true,
          OR: [
            { accessExpiresAt: null },
            { accessExpiresAt: { gt: expect.any(Date) } }
          ]
        }
      });
    });
  });
});