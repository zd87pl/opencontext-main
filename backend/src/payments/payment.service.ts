import Stripe from 'stripe';
import { ethers } from 'ethers';
import { prisma } from '../common/prisma.js';
import { logger } from '../common/logger.js';
import { AppError } from '../common/middleware/error-handler.js';
import { getWalletFromEncrypted, getProvider } from '../wallets/wallet.service.js';
import { grantContentAccess } from '../content/key-escrow.service.js';

export { checkContentAccess } from './access.service.js';

// STRIPE_SECRET_KEY is validated lazily so the module can load (and be tested)
// without Stripe configured; the first payment call reports the missing key.
let stripeClient: Stripe | null = null;

function stripe(): Stripe {
  if (!stripeClient) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new AppError(500, 'STRIPE_SECRET_KEY not configured');
    }
    stripeClient = new Stripe(secretKey, { apiVersion: '2024-04-10' });
  }
  return stripeClient;
}

export interface PaymentIntent {
  id: string;
  clientSecret: string;
  amount: number;
  currency: string;
  status: string;
}

export interface PaymentResult {
  success: boolean;
  transactionId?: string;
  error?: string;
  blockchainTxHash?: string;
}

const PURCHASE_ACCESS_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year of access

/**
 * Creates a Stripe payment intent for content purchase
 */
export async function createPaymentIntent(
  userId: string,
  contentId: string,
  amount: number,
  currency: string = 'usd'
): Promise<PaymentIntent> {
  try {
    const content = await prisma.content.findUnique({
      where: { id: contentId },
      include: { user: true }
    });

    if (!content) {
      throw new AppError(404, 'Content not found');
    }

    const paymentIntent = await stripe().paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe amounts are in cents
      currency,
      metadata: {
        userId,
        contentId,
        creatorId: content.userId,
        contentTitle: content.title
      },
      description: `Purchase: ${content.title}`,
      automatic_payment_methods: {
        enabled: true
      }
    });

    await prisma.purchase.create({
      data: {
        userId,
        contentId,
        amount,
        currency: currency.toUpperCase(),
        paymentMethod: 'stripe',
        transactionId: paymentIntent.id,
        status: 'PENDING'
      }
    });

    logger.info(`Created payment intent: ${paymentIntent.id} for content: ${contentId}`);

    return {
      id: paymentIntent.id,
      clientSecret: paymentIntent.client_secret!,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: paymentIntent.status
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Failed to create payment intent:', error);
    throw new AppError(500, 'Failed to create payment');
  }
}

/**
 * Completes a purchase once its Stripe payment intent has succeeded.
 *
 * Expected conditions (intent not succeeded, no pending purchase) are thrown as
 * AppErrors and leave the purchase untouched, since the payment may still be in
 * progress. Unexpected failures mark the purchase FAILED and return
 * `{ success: false }`.
 */
export async function processStripePayment(paymentIntentId: string): Promise<PaymentResult> {
  try {
    const paymentIntent = await stripe().paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      throw new AppError(400, 'Payment not successful');
    }

    const { userId, contentId } = paymentIntent.metadata;

    const purchase = await prisma.purchase.findFirst({
      where: {
        transactionId: paymentIntentId,
        status: 'PENDING'
      },
      include: {
        content: {
          include: { user: { include: { wallet: true } } }
        }
      }
    });

    if (!purchase) {
      throw new AppError(404, 'Purchase record not found');
    }

    const creatorWallet = purchase.content.user.wallet;
    if (!creatorWallet) {
      throw new Error('Creator has no wallet');
    }

    const blockchainResult = await processBlockchainPayment(
      parseFloat(purchase.amount.toString()),
      creatorWallet.address,
      creatorWallet.encryptedPrivateKey
    );

    await prisma.purchase.update({
      where: { id: purchase.id },
      data: {
        status: 'COMPLETED',
        accessGranted: true,
        accessExpiresAt: new Date(Date.now() + PURCHASE_ACCESS_TTL_MS)
      }
    });

    // Grant access by storing content key in escrow. The purchase stays
    // COMPLETED even if this fails; access can be re-granted later.
    try {
      if (!purchase.content.encryptedKey) {
        throw new Error('Content encrypted key not found');
      }

      let contentKeyData: { contentKey?: unknown };
      try {
        contentKeyData = JSON.parse(purchase.content.encryptedKey);
      } catch {
        throw new Error('Invalid encrypted key format');
      }

      if (typeof contentKeyData.contentKey !== 'string') {
        throw new Error('Content key not found in encrypted data');
      }

      const contentKey = Buffer.from(contentKeyData.contentKey, 'hex');
      await grantContentAccess(contentId, userId, contentKey);

      logger.info(`Granted content access via escrow: content=${contentId}, user=${userId}`);
    } catch (escrowError) {
      logger.error(`Failed to grant content access via escrow: ${escrowError}`);
    }

    logger.info(`Processed payment: ${paymentIntentId} -> blockchain: ${blockchainResult.txHash}`);

    return {
      success: true,
      transactionId: paymentIntentId,
      blockchainTxHash: blockchainResult.txHash
    };
  } catch (error) {
    if (error instanceof AppError) throw error;

    logger.error('Failed to process Stripe payment:', error);

    await prisma.purchase.updateMany({
      where: { transactionId: paymentIntentId },
      data: { status: 'FAILED' }
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Payment processing failed'
    };
  }
}

/**
 * Placeholder for the USD -> USDC leg of a purchase.
 *
 * No funds move today: this verifies the creator's managed wallet decrypts and
 * returns a keccak256 hash as a stand-in transaction id. A real implementation
 * would convert the fiat amount and transfer USDC on Base.
 */
async function processBlockchainPayment(
  usdAmount: number,
  creatorWalletAddress: string,
  creatorEncryptedPrivateKey: string
): Promise<{ txHash: string; usdcAmount: string }> {
  try {
    const usdcAmount = usdAmount.toString(); // 1:1 for the PoC

    const provider = getProvider();
    await getWalletFromEncrypted(creatorEncryptedPrivateKey, provider);

    const mockTxHash = ethers.keccak256(ethers.toUtf8Bytes(`payment_${Date.now()}_${creatorWalletAddress}`));

    logger.info(`Mock USDC transfer: ${usdcAmount} USDC to ${creatorWalletAddress}`);

    return { txHash: mockTxHash, usdcAmount };
  } catch (error) {
    logger.error('Blockchain payment failed:', error);
    throw error;
  }
}

/**
 * Handles Stripe webhooks. `body` must be the raw request body: the signature
 * check fails on a re-serialised JSON object.
 */
export async function handleStripeWebhook(body: string | Buffer, signature: string): Promise<void> {
  try {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new AppError(500, 'STRIPE_WEBHOOK_SECRET not configured');
    }

    const event = stripe().webhooks.constructEvent(body, signature, webhookSecret);

    switch (event.type) {
      case 'payment_intent.succeeded':
        await processStripePayment(event.data.object.id);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentFailure(event.data.object.id);
        break;

      default:
        logger.info(`Unhandled Stripe event: ${event.type}`);
    }
  } catch (error) {
    logger.error('Stripe webhook error:', error);
    throw error;
  }
}

/**
 * Handles payment failures
 */
async function handlePaymentFailure(paymentIntentId: string): Promise<void> {
  try {
    await prisma.purchase.updateMany({
      where: { transactionId: paymentIntentId },
      data: { status: 'FAILED' }
    });

    logger.info(`Marked payment as failed: ${paymentIntentId}`);
  } catch (error) {
    logger.error('Failed to handle payment failure:', error);
  }
}

/**
 * Gets user's purchase history
 */
export async function getUserPurchases(userId: string) {
  return prisma.purchase.findMany({
    where: { userId },
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
}
