import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

// Singleton pattern for Prisma client
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' 
    ? ['query', 'error', 'warn'] 
    : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// Log database queries in development
prisma.$use(async (params, next) => {
  const before = Date.now();
  const result = await next(params);
  const after = Date.now();
  
  if (process.env.NODE_ENV === 'development') {
    logger.debug(`Query ${params.model}.${params.action} took ${after - before}ms`);
  }
  
  return result;
});

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});