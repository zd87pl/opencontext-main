import { Router } from 'express';
import { prisma } from '../common/prisma.js';
import { AppError } from '../common/middleware/error-handler.js';
import { requireAuth } from '../auth/auth.middleware.js';

export const userRouter = Router();

// Get user profile
userRouter.get('/profile', requireAuth, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        wallet: true,
        oauthAccounts: {
          select: {
            provider: true,
            createdAt: true
          }
        },
        _count: {
          select: {
            content: true,
            purchases: true
          }
        }
      }
    });
    
    if (!user) {
      throw new AppError(404, 'User not found');
    }
    
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      emailVerified: user.emailVerified,
      walletAddress: user.wallet?.address,
      linkedAccounts: user.oauthAccounts,
      stats: {
        contentCreated: user._count.content,
        contentPurchased: user._count.purchases
      },
      createdAt: user.createdAt
    });
  } catch (error) {
    next(error);
  }
});

// Update user profile
userRouter.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    const { name, avatar } = req.body;
    
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(name !== undefined && { name }),
        ...(avatar !== undefined && { avatar })
      },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true
      }
    });
    
    res.json(updatedUser);
  } catch (error) {
    next(error);
  }
});

// Get user's purchased content
userRouter.get('/purchases', requireAuth, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    
    const purchases = await prisma.purchase.findMany({
      where: {
        userId,
        status: 'COMPLETED'
      },
      include: {
        content: {
          select: {
            id: true,
            title: true,
            description: true,
            platform: true,
            price: true,
            user: {
              select: {
                name: true,
                avatar: true
              }
            }
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    res.json(purchases);
  } catch (error) {
    next(error);
  }
});

// Get user's created content
userRouter.get('/content', requireAuth, async (req, res, next) => {
  try {
    const userId = (req.user as any).id;
    
    const content = await prisma.content.findMany({
      where: { userId },
      include: {
        _count: {
          select: {
            purchases: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    // Calculate earnings for each content
    const contentWithEarnings = await Promise.all(
      content.map(async (item) => {
        const earnings = await prisma.purchase.aggregate({
          where: {
            contentId: item.id,
            status: 'COMPLETED'
          },
          _sum: {
            amount: true
          }
        });
        
        return {
          ...item,
          earnings: earnings._sum.amount || 0,
          purchaseCount: item._count.purchases
        };
      })
    );
    
    res.json(contentWithEarnings);
  } catch (error) {
    next(error);
  }
});