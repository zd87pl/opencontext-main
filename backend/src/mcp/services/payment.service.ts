import { prisma } from '../../common/prisma.js';
import { logger } from '../../common/logger.js';
import { grantContentAccess } from '../../content/key-escrow.service.js';

export interface PurchaseParams {
  content_id: string;
  user_id: string;
  agent_id: string;
  payment_method: 'account_balance' | 'stripe' | 'crypto';
  note?: string;
}

export interface PurchaseResult {
  success: boolean;
  transaction_id?: string;
  amount?: number;
  expires_at?: Date;
  details?: any;
}

export class PaymentService {
  /**
   * Process content purchase for AI agent
   */
  async processPurchase(params: PurchaseParams): Promise<PurchaseResult> {
    try {
      // 1. Get content details
      const content = await prisma.content.findUnique({
        where: { id: params.content_id },
        select: {
          id: true,
          title: true,
          price: true,
          userId: true,
          encryptedKey: true
        }
      });

      if (!content) {
        return {
          success: false,
          details: { error: 'Content not found' }
        };
      }

      // 2. Check if already purchased
      const existingPurchase = await prisma.purchase.findFirst({
        where: {
          contentId: params.content_id,
          userId: params.user_id,
          status: 'COMPLETED',
          accessGranted: true,
          OR: [
            { accessExpiresAt: null },
            { accessExpiresAt: { gt: new Date() } }
          ]
        }
      });

      if (existingPurchase) {
        return {
          success: true,
          transaction_id: existingPurchase.id,
          amount: Number(existingPurchase.amount),
          details: { message: 'Already purchased' }
        };
      }

      // 3. Process payment based on method
      const paymentResult = await this.processPaymentMethod(params, content);
      if (!paymentResult.success) {
        return paymentResult;
      }

      // 4. Create purchase record
      const purchase = await prisma.purchase.create({
        data: {
          userId: params.user_id,
          contentId: params.content_id,
          amount: content.price,
          status: 'COMPLETED',
          paymentMethod: params.payment_method,
          accessGranted: true,
          accessExpiresAt: null, // Permanent access for now
          metadata: {
            agent_id: params.agent_id,
            note: params.note,
            payment_transaction_id: paymentResult.transaction_id
          }
        }
      });

      // 5. Grant content access via key escrow
      try {
        const contentKeyData = JSON.parse(content.encryptedKey);
        const contentKey = Buffer.from(contentKeyData.contentKey, 'hex');
        await grantContentAccess(params.content_id, params.user_id, contentKey);
      } catch (error) {
        logger.error('Failed to grant content access:', error);
        // Mark purchase as failed
        await prisma.purchase.update({
          where: { id: purchase.id },
          data: { 
            status: 'FAILED',
            accessGranted: false 
          }
        });
        
        return {
          success: false,
          details: { error: 'Failed to grant content access' }
        };
      }

      // 6. Update creator revenue
      await this.updateCreatorRevenue(content.userId, Number(content.price), params.content_id);

      // 7. Track purchase analytics
      await this.trackPurchaseAnalytics(params, purchase);

      logger.info(`Purchase completed: ${purchase.id}`, {
        content_id: params.content_id,
        user_id: params.user_id,
        agent_id: params.agent_id,
        amount: Number(content.price)
      });

      return {
        success: true,
        transaction_id: purchase.id,
        amount: Number(content.price),
        expires_at: purchase.accessExpiresAt ?? undefined
      };
    } catch (error) {
      logger.error('Purchase processing failed:', error);
      return {
        success: false,
        details: { error: 'Purchase processing failed' }
      };
    }
  }

  /**
   * Process payment based on method
   */
  private async processPaymentMethod(
    params: PurchaseParams,
    content: any
  ): Promise<PurchaseResult> {
    const amount = Number(content.price);

    switch (params.payment_method) {
      case 'account_balance':
        return this.processAccountBalance(params.user_id, amount);
      
      case 'stripe':
        return this.processStripePayment(params, amount);
      
      case 'crypto':
        return this.processCryptoPayment(params, amount);
      
      default:
        return {
          success: false,
          details: { error: 'Unsupported payment method' }
        };
    }
  }

  /**
   * Process account balance payment
   */
  private async processAccountBalance(userId: string, amount: number): Promise<PurchaseResult> {
    try {
      // Get user's current balance
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { accountBalance: true }
      });

      if (!user) {
        return {
          success: false,
          details: { error: 'User not found' }
        };
      }

      const currentBalance = Number(user.accountBalance) || 0;
      
      if (currentBalance < amount) {
        return {
          success: false,
          details: { 
            error: 'Insufficient balance',
            current_balance: currentBalance,
            required: amount
          }
        };
      }

      // Deduct from balance
      await prisma.user.update({
        where: { id: userId },
        data: {
          accountBalance: currentBalance - amount
        }
      });

      // Create balance transaction record
      await prisma.balanceTransaction.create({
        data: {
          userId,
          type: 'DEBIT',
          amount,
          description: 'Content purchase',
          balanceAfter: currentBalance - amount
        }
      });

      return {
        success: true,
        transaction_id: `bal_${Date.now()}`,
        amount
      };
    } catch (error) {
      logger.error('Account balance payment failed:', error);
      return {
        success: false,
        details: { error: 'Balance payment failed' }
      };
    }
  }

  /**
   * Process Stripe payment (for demo/integration)
   */
  private async processStripePayment(_params: PurchaseParams, amount: number): Promise<PurchaseResult> {
    try {
      // In demo mode, simulate successful payment
      if (process.env.DEMO_MODE === 'true') {
        return {
          success: true,
          transaction_id: `stripe_demo_${Date.now()}`,
          amount
        };
      }

      // TODO: Implement real Stripe integration
      // For now, return demo response
      return {
        success: true,
        transaction_id: `stripe_${Date.now()}`,
        amount
      };
    } catch (error) {
      logger.error('Stripe payment failed:', error);
      return {
        success: false,
        details: { error: 'Stripe payment failed' }
      };
    }
  }

  /**
   * Process crypto payment
   */
  private async processCryptoPayment(_params: PurchaseParams, amount: number): Promise<PurchaseResult> {
    try {
      // TODO: Implement crypto payment processing
      // For now, simulate successful payment
      return {
        success: true,
        transaction_id: `crypto_${Date.now()}`,
        amount
      };
    } catch (error) {
      logger.error('Crypto payment failed:', error);
      return {
        success: false,
        details: { error: 'Crypto payment failed' }
      };
    }
  }

  /**
   * Update creator revenue
   */
  private async updateCreatorRevenue(creatorId: string, amount: number, contentId: string): Promise<void> {
    try {
      // Calculate platform fee (10%)
      const platformFee = amount * 0.10;
      const creatorRevenue = amount - platformFee;

      // Update creator's earnings
      await prisma.user.update({
        where: { id: creatorId },
        data: {
          totalEarnings: {
            increment: creatorRevenue
          }
        }
      });

      // Create revenue record
      await prisma.revenue.create({
        data: {
          userId: creatorId,
          contentId,
          amount: creatorRevenue,
          platformFee,
          totalAmount: amount,
          type: 'CONTENT_SALE'
        }
      });

      logger.info(`Updated creator revenue: ${creatorId}`, {
        content_id: contentId,
        creator_revenue: creatorRevenue,
        platform_fee: platformFee
      });
    } catch (error) {
      logger.error('Failed to update creator revenue:', error);
      // Non-critical error, don't fail the purchase
    }
  }

  /**
   * Track purchase analytics
   */
  private async trackPurchaseAnalytics(params: PurchaseParams, purchase: any): Promise<void> {
    try {
      // Create analytics event
      await prisma.analyticsEvent.create({
        data: {
          type: 'CONTENT_PURCHASE',
          userId: params.user_id,
          metadata: {
            content_id: params.content_id,
            agent_id: params.agent_id,
            payment_method: params.payment_method,
            amount: Number(purchase.amount),
            purchase_id: purchase.id
          }
        }
      });
    } catch (error) {
      logger.error('Failed to track purchase analytics:', error);
      // Non-critical error
    }
  }

  /**
   * Get user's account balance
   */
  async getUserBalance(userId: string): Promise<{
    current_balance: number;
    pending_credits: number;
    last_topup: Date | null;
  }> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { 
          accountBalance: true,
          updatedAt: true
        }
      });

      if (!user) {
        throw new Error('User not found');
      }

      // Get recent balance transactions
      const recentTransaction = await prisma.balanceTransaction.findFirst({
        where: { 
          userId,
          type: 'CREDIT'
        },
        orderBy: { createdAt: 'desc' }
      });

      return {
        current_balance: Number(user.accountBalance) || 0,
        pending_credits: 0, // TODO: Implement pending credits
        last_topup: recentTransaction?.createdAt || null
      };
    } catch (error) {
      logger.error('Failed to get user balance:', error);
      throw new Error('Failed to get user balance');
    }
  }

  /**
   * Add credits to user account
   */
  async addCredits(userId: string, amount: number, source: string): Promise<void> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { accountBalance: true }
      });

      if (!user) {
        throw new Error('User not found');
      }

      const currentBalance = Number(user.accountBalance) || 0;
      const newBalance = currentBalance + amount;

      // Update balance
      await prisma.user.update({
        where: { id: userId },
        data: { accountBalance: newBalance }
      });

      // Create transaction record
      await prisma.balanceTransaction.create({
        data: {
          userId,
          type: 'CREDIT',
          amount,
          description: `Credits added: ${source}`,
          balanceAfter: newBalance
        }
      });

      logger.info(`Added credits to user: ${userId}`, {
        amount,
        source,
        new_balance: newBalance
      });
    } catch (error) {
      logger.error('Failed to add credits:', error);
      throw new Error('Failed to add credits');
    }
  }

  /**
   * Get purchase history for user
   */
  async getUserPurchases(userId: string, limit = 50): Promise<any[]> {
    try {
      const purchases = await prisma.purchase.findMany({
        where: { userId },
        include: {
          content: {
            select: {
              title: true,
              price: true,
              platform: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: limit
      });

      return purchases.map(purchase => ({
        id: purchase.id,
        content_id: purchase.contentId,
        content_title: purchase.content.title,
        amount: Number(purchase.amount),
        status: purchase.status,
        payment_method: purchase.paymentMethod,
        purchased_at: purchase.createdAt,
        access_granted: purchase.accessGranted,
        expires_at: purchase.accessExpiresAt
      }));
    } catch (error) {
      logger.error('Failed to get user purchases:', error);
      throw new Error('Failed to get purchase history');
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await prisma.purchase.count();
      return true;
    } catch (error) {
      logger.error('Payment service health check failed:', error);
      return false;
    }
  }
}