import Stripe from 'stripe';
import { ethers } from 'ethers';
import fetch from 'node-fetch';
import { prisma } from '../common/prisma.js';
import { logger } from '../common/logger.js';
import { AppError } from '../common/middleware/error-handler.js';
import { getWalletFromEncrypted, getProvider } from '../wallets/wallet.service.js';
import { grantContentAccess } from '../content/key-escrow.service.js';

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20'
});

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
    // Get content details
    const content = await prisma.content.findUnique({
      where: { id: contentId },
      include: { user: true }
    });
    
    if (!content) {
      throw new AppError(404, 'Content not found');
    }
    
    // Create Stripe payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
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
    
    // Store pending purchase record
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
    logger.error('Failed to create payment intent:', error);
    throw new AppError(500, 'Failed to create payment');
  }
}

/**
 * Processes successful Stripe payment and converts to USDC
 */
export async function processStripePayment(
  paymentIntentId: string
): Promise<PaymentResult> {
  try {
    // Retrieve payment intent from Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status !== 'succeeded') {
      throw new AppError(400, 'Payment not successful');
    }
    
    const { userId, contentId, creatorId } = paymentIntent.metadata;
    
    // Get purchase record
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
    
    // Convert USD to USDC and transfer to creator
    const blockchainResult = await processBlockchainPayment(
      parseFloat(purchase.amount.toString()),
      purchase.content.user.wallet!.address,
      purchase.content.user.wallet!.encryptedPrivateKey
    );
    
    // Update purchase status
    await prisma.purchase.update({
      where: { id: purchase.id },
      data: {
        status: 'COMPLETED',
        accessGranted: true,
        accessExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year access
      }
    });
    
    // Grant access by storing content key in escrow
    try {
      // Get the content key from encrypted storage
      if (!purchase.content.encryptedKey) {
        throw new Error('Content encrypted key not found');
      }
      
      let contentKeyData;
      try {
        contentKeyData = JSON.parse(purchase.content.encryptedKey);
      } catch (parseError) {
        throw new Error('Invalid encrypted key format');
      }
      
      if (!contentKeyData.contentKey) {
        throw new Error('Content key not found in encrypted data');
      }
      
      const contentKey = Buffer.from(contentKeyData.contentKey, 'hex');
      
      // Grant access to the purchasing user
      await grantContentAccess(contentId, userId, contentKey);
      
      logger.info(`Granted content access via escrow: content=${contentId}, user=${userId}`);
    } catch (escrowError) {
      logger.error(`Failed to grant content access via escrow: ${escrowError}`);
      // Don't fail the payment, but log the issue
    }
    
    logger.info(`Processed payment: ${paymentIntentId} -> blockchain: ${blockchainResult.txHash}`);
    
    return {
      success: true,
      transactionId: paymentIntentId,
      blockchainTxHash: blockchainResult.txHash
    };
  } catch (error) {
    logger.error('Failed to process Stripe payment:', error);
    
    // Update purchase status to failed
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
 * Converts USD to USDC and transfers to creator (simplified for PoC)
 */
async function processBlockchainPayment(
  usdAmount: number,
  creatorWalletAddress: string,
  creatorEncryptedPrivateKey: string
): Promise<{ txHash: string; usdcAmount: string }> {
  try {
    // For PoC, we'll simulate the conversion
    // In production, this would use Coinbase Commerce or similar
    
    // Simulate USD to USDC conversion (1:1 for simplicity)
    const usdcAmount = usdAmount.toString();
    
    // Get provider and creator wallet
    const provider = getProvider();
    const creatorWallet = await getWalletFromEncrypted(creatorEncryptedPrivateKey, provider);
    
    // For PoC, we'll create a mock transaction
    // In production, this would transfer actual USDC
    const mockTxHash = ethers.keccak256(
      ethers.toUtf8Bytes(`payment_${Date.now()}_${creatorWalletAddress}`)
    );
    
    logger.info(`Mock USDC transfer: ${usdcAmount} USDC to ${creatorWalletAddress}`);
    
    return {
      txHash: mockTxHash,
      usdcAmount
    };
  } catch (error) {
    logger.error('Blockchain payment failed:', error);
    throw error;
  }
}

/**
 * Handles Stripe webhooks
 */
export async function handleStripeWebhook(
  body: any,
  signature: string
): Promise<void> {
  try {
    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
    
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

/**
 * Checks if user has access to specific content
 */
export async function checkContentAccess(
  userId: string,
  contentId: string
): Promise<boolean> {
  const purchase = await prisma.purchase.findFirst({
    where: {
      userId,
      contentId,
      status: 'COMPLETED',
      accessGranted: true,
      OR: [
        { accessExpiresAt: null },
        { accessExpiresAt: { gt: new Date() } }
      ]
    }
  });
  
  return !!purchase;
}