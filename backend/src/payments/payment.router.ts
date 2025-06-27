import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken } from '../auth/auth.middleware.js';
import { AppError } from '../common/middleware/error-handler.js';
import { logger } from '../common/logger.js';
import { prisma } from '../common/prisma.js';
import {
  createPaymentIntent,
  processStripePayment,
  handleStripeWebhook,
  getUserPurchases,
  checkContentAccess
} from './payment.service.js';

export const paymentRouter = Router();

// Validation schemas
const createPaymentSchema = z.object({
  contentId: z.string().uuid(),
  amount: z.number().positive(),
  currency: z.string().optional().default('usd')
});

const webhookBodySchema = z.any(); // Stripe webhook body

/**
 * Create payment intent for content purchase
 */
paymentRouter.post('/intent', authenticateToken, async (req, res, next) => {
  try {
    const { contentId, amount, currency } = createPaymentSchema.parse(req.body);
    const userId = (req.user as any).id;
    
    // Check if user already has access
    const hasAccess = await checkContentAccess(userId, contentId);
    if (hasAccess) {
      throw new AppError(400, 'You already have access to this content');
    }
    
    const paymentIntent = await createPaymentIntent(userId, contentId, amount, currency);
    
    res.json({
      success: true,
      paymentIntent
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Confirm payment after successful Stripe payment
 */
paymentRouter.post('/confirm', authenticateToken, async (req, res, next) => {
  try {
    const { paymentIntentId } = req.body;
    
    if (!paymentIntentId) {
      throw new AppError(400, 'Payment intent ID required');
    }
    
    const result = await processStripePayment(paymentIntentId);
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Payment processed successfully',
        transactionId: result.transactionId,
        blockchainTx: result.blockchainTxHash
      });
    } else {
      throw new AppError(400, result.error || 'Payment processing failed');
    }
  } catch (error) {
    next(error);
  }
});

/**
 * Check if user has access to specific content
 */
paymentRouter.get('/access/:contentId', authenticateToken, async (req, res, next) => {
  try {
    const { contentId } = req.params;
    const userId = (req.user as any).id;
    
    const hasAccess = await checkContentAccess(userId, contentId);
    
    res.json({
      hasAccess,
      contentId,
      userId
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Get user's purchase history
 */
paymentRouter.get('/purchases', authenticateToken, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    const purchases = await getUserPurchases(userId);
    
    res.json({
      purchases,
      total: purchases.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Stripe webhook endpoint
 */
paymentRouter.post('/webhook/stripe', async (req, res, next) => {
  try {
    const signature = req.headers['stripe-signature'] as string;
    
    if (!signature) {
      throw new AppError(400, 'Missing Stripe signature');
    }
    
    await handleStripeWebhook(req.body, signature);
    
    res.json({ received: true });
  } catch (error) {
    logger.error('Stripe webhook error:', error);
    next(error);
  }
});

/**
 * Create instant purchase (for logged-in users)
 */
paymentRouter.post('/instant-purchase', authenticateToken, async (req, res, next) => {
  try {
    const { contentId, paymentMethodId } = req.body;
    const userId = (req.user as any).id;
    
    if (!contentId || !paymentMethodId) {
      throw new AppError(400, 'Content ID and payment method required');
    }
    
    // Check if user already has access
    const hasAccess = await checkContentAccess(userId, contentId);
    if (hasAccess) {
      throw new AppError(400, 'You already have access to this content');
    }
    
    // Get content details for pricing
    const content = await prisma.content.findUnique({
      where: { id: contentId }
    });
    
    if (!content) {
      throw new AppError(404, 'Content not found');
    }
    
    // Create and confirm payment in one step
    const paymentIntent = await createPaymentIntent(
      userId, 
      contentId, 
      parseFloat(content.price.toString())
    );
    
    // For PoC, auto-confirm the payment
    // In production, this would use the actual payment method
    const result = await processStripePayment(paymentIntent.id);
    
    res.json({
      success: result.success,
      message: 'Content purchased successfully',
      access: result.success,
      error: result.error
    });
  } catch (error) {
    next(error);
  }
});