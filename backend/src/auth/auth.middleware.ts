import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../common/middleware/error-handler.js';
import { prisma } from '../common/prisma.js';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      user?: any;
    }
  }
}

// Require authenticated user
export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.isAuthenticated()) {
    throw new AppError(401, 'Authentication required');
  }
  next();
};

// JWT token authentication for API access
export const authenticateToken = async (
  req: Request, 
  res: Response, 
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
    
    if (!token) {
      throw new AppError(401, 'Access token required');
    }
    
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new AppError(500, 'JWT_SECRET not configured');
    }
    
    const decoded = jwt.verify(token, jwtSecret) as any;
    
    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });
    
    if (!user) {
      throw new AppError(401, 'Invalid token');
    }
    
    req.userId = decoded.userId;
    req.user = user as any;
    
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      throw new AppError(401, 'Invalid token');
    }
    next(error);
  }
};

// Optional authentication - sets user if authenticated but doesn't require it
export const optionalAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];
    
    if (token) {
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        throw new AppError(500, 'JWT_SECRET not configured');
      }
      
      const decoded = jwt.verify(token, jwtSecret) as any;
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId }
      });
      
      if (user) {
        req.userId = decoded.userId;
        req.user = user as any;
      }
    }
    
    next();
  } catch (error) {
    // Continue without authentication
    next();
  }
};