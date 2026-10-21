import { prisma } from '../common/prisma.js';

/**
 * The single source of truth for "may this user read this content".
 *
 * Lives apart from payment.service.ts so the key-escrow layer can depend on it
 * without pulling Stripe/ethers into its module graph (and without an import
 * cycle, since payment.service.ts depends on key-escrow).
 */
export async function checkContentAccess(userId: string, contentId: string): Promise<boolean> {
  const purchase = await prisma.purchase.findFirst({
    where: {
      userId,
      contentId,
      status: 'COMPLETED',
      accessGranted: true,
      OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: new Date() } }]
    }
  });

  return purchase !== null;
}
