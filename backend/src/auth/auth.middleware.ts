import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { OAuthAccount, User as PrismaUser, Wallet } from '@prisma/client';
import { AppError } from '../common/middleware/error-handler.js';
import { prisma } from '../common/prisma.js';

declare global {
  namespace Express {
    // Passport stores the Prisma user on `req.user`; the session deserializer
    // and the OAuth callback include these relations.
    interface User extends PrismaUser {
      wallet?: Wallet | null;
      oauthAccounts?: OAuthAccount[];
    }
    interface Request {
      userId?: string;
    }
  }
}

const BEARER_TOKEN = /^\s*Bearer\s+(\S+)\s*$/i;

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = BEARER_TOKEN.exec(header);
  return match ? match[1] : null;
}

/**
 * Verifies a JWT and loads the user it names. Returns null when the token is
 * malformed, expired, signed with another secret, or names a deleted user.
 */
async function resolveUserFromToken(token: string): Promise<Express.User | null> {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new AppError(500, 'JWT_SECRET not configured');
  }

  const decoded = jwt.verify(token, jwtSecret);
  if (typeof decoded !== 'object' || decoded === null || typeof decoded.userId !== 'string') {
    return null;
  }

  return prisma.user.findUnique({ where: { id: decoded.userId } });
}

/** Session-based guard for routes that go through the Passport login flow. */
export const requireAuth = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.isAuthenticated()) {
    throw new AppError(401, 'Authentication required');
  }
  next();
};

/**
 * Bearer-token guard for API access. Failures are reported through `next(err)`
 * rather than thrown: Express 4 does not catch rejected promises from async
 * middleware, so throwing here would leave the request hanging.
 */
export const authenticateToken = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      throw new AppError(401, 'Access token required');
    }

    const user = await resolveUserFromToken(token);
    if (!user) {
      throw new AppError(401, 'Invalid token');
    }

    req.userId = user.id;
    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      next(new AppError(401, 'Invalid token'));
      return;
    }
    next(error);
  }
};

/** Sets `req.user` when a valid bearer token is present; never rejects the request. */
export const optionalAuth = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    const token = extractBearerToken(req);
    if (token) {
      const user = await resolveUserFromToken(token);
      if (user) {
        req.userId = user.id;
        req.user = user;
      }
    }
  } catch {
    // Anonymous access is fine here; a bad token just means no user.
  }
  next();
};
