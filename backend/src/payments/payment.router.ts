import { Router } from 'express';
import { z } from 'zod';
import { authenticateToken } from '../auth/auth.middleware.js';
import { requireUser } from '../auth/current-user.js';
import { AppError } from '../common/middleware/error-handler.js';
import { prisma } from '../common/prisma.js';
import {
  createPaymentIntent,
  processStripePayment,
  handleStripeWebhook,
  getUserPurchases,
  checkContentAccess
} from './payment.service.js';

export const paymentRouter = Router();

const createPaymentSchema = z.object({
  contentId: z.string().uuid(),
  amount: z.number().positive(),
  currency: z.string().optional().default('usd')
});

/**
 * Create payment intent for content purchase
 */
paymentRouter.post('/intent', authenticateToken, async (req, res, next) => {
  try {
    const { contentId, amount, currency } = createPaymentSchema.parse(req.body);
    const userId = requireUser(req).id;

    const hasAccess = await checkContentAccess(userId, contentId);
    if (hasAccess) {
      throw new AppError(400, 'You already have access to this content');
    }

    const paymentIntent = await createPaymentIntent(userId, contentId, amount, currency);

    res.json({ success: true, paymentIntent });
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

    if (typeof paymentIntentId !== 'string' || !paymentIntentId) {
      throw new AppError(400, 'Payment intent ID required');
    }

    const result = await processStripePayment(paymentIntentId);

    if (!result.success) {
      throw new AppError(400, result.error || 'Payment processing failed');
    }

    res.json({
      success: true,
      message: 'Payment processed successfully',
      transactionId: result.transactionId,
      blockchainTx: result.blockchainTxHash
    });
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
    const userId = requireUser(req).id;

    const hasAccess = await checkContentAccess(userId, contentId);

    res.json({ hasAccess, contentId, userId });
  } catch (error) {
    next(error);
  }
});

/**
 * Get user's purchase history
 */
paymentRouter.get('/purchases', authenticateToken, async (req, res, next) => {
  try {
    const userId = requireUser(req).id;
    const purchases = await getUserPurchases(userId);

    res.json({ purchases, total: purchases.length });
  } catch (error) {
    next(error);
  }
});

/**
 * Stripe webhook endpoint. index.ts mounts `express.raw()` on this path so the
 * signature can be verified against the untouched body.
 */
paymentRouter.post('/webhook/stripe', async (req, res, next) => {
  try {
    const signature = req.headers['stripe-signature'];

    if (typeof signature !== 'string') {
      throw new AppError(400, 'Missing Stripe signature');
    }

    if (!Buffer.isBuffer(req.body) && typeof req.body !== 'string') {
      throw new AppError(500, 'Stripe webhook requires the raw request body');
    }

    await handleStripeWebhook(req.body, signature);

    res.json({ received: true });
  } catch (error) {
    next(error);
  }
});

/**
 * One-step purchase for logged-in users.
 *
 * PoC behaviour: the payment intent is "confirmed" immediately without charging
 * a payment method, so this only works against a Stripe test account.
 */
paymentRouter.post('/instant-purchase', authenticateToken, async (req, res, next) => {
  try {
    const { contentId, paymentMethodId } = req.body;
    const userId = requireUser(req).id;

    if (typeof contentId !== 'string' || typeof paymentMethodId !== 'string') {
      throw new AppError(400, 'Content ID and payment method required');
    }

    const hasAccess = await checkContentAccess(userId, contentId);
    if (hasAccess) {
      throw new AppError(400, 'You already have access to this content');
    }

    const content = await prisma.content.findUnique({ where: { id: contentId } });
    if (!content) {
      throw new AppError(404, 'Content not found');
    }

    const paymentIntent = await createPaymentIntent(userId, contentId, Number(content.price));
    const result = await processStripePayment(paymentIntent.id);

    res.json({
      success: result.success,
      message: result.success ? 'Content purchased successfully' : 'Purchase failed',
      access: result.success,
      error: result.error
    });
  } catch (error) {
    next(error);
  }
});
