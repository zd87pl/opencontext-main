import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import {
  requireAuth,
  authenticateToken,
  optionalAuth
} from '../auth.middleware.js';

// Mock Prisma
const mockPrisma = {
  user: {
    findUnique: vi.fn()
  }
};

vi.mock('../../common/prisma.js', () => ({
  prisma: mockPrisma
}));

// Mock JWT
vi.mock('jsonwebtoken');

describe('Auth Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      headers: {},
      isAuthenticated: vi.fn()
    };
    mockRes = {};
    mockNext = vi.fn();
    
    vi.clearAllMocks();
    
    // Set JWT_SECRET environment variable
    process.env.JWT_SECRET = 'test-secret-key';
  });

  describe('requireAuth', () => {
    it('should call next() if user is authenticated', () => {
      (mockReq.isAuthenticated as any).mockReturnValue(true);
      
      requireAuth(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should throw AppError if user is not authenticated', () => {
      (mockReq.isAuthenticated as any).mockReturnValue(false);
      
      expect(() => {
        requireAuth(mockReq as Request, mockRes as Response, mockNext);
      }).toThrow('Authentication required');
    });
  });

  describe('authenticateToken', () => {
    const validToken = 'valid.jwt.token';
    const validUserId = 'user-123';
    const mockUser = {
      id: validUserId,
      email: 'test@example.com',
      name: 'Test User'
    };

    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      (jwt.verify as any).mockReturnValue({ userId: validUserId });
    });

    it('should authenticate valid token successfully', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      await authenticateToken(mockReq as Request, mockRes as Response, mockNext);

      expect(jwt.verify).toHaveBeenCalledWith(validToken, 'test-secret-key');
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: validUserId }
      });
      expect(mockReq.userId).toBe(validUserId);
      expect(mockReq.user).toBe(mockUser);
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should throw error if no authorization header', async () => {
      mockReq.headers = {};

      await expect(
        authenticateToken(mockReq as Request, mockRes as Response, mockNext)
      ).rejects.toThrow('Access token required');
    });

    it('should throw error if authorization header has no token', async () => {
      mockReq.headers = {
        authorization: 'Bearer'
      };

      await expect(
        authenticateToken(mockReq as Request, mockRes as Response, mockNext)
      ).rejects.toThrow('Access token required');
    });

    it('should throw error if authorization header has wrong format', async () => {
      mockReq.headers = {
        authorization: validToken // Missing "Bearer " prefix
      };

      await expect(
        authenticateToken(mockReq as Request, mockRes as Response, mockNext)
      ).rejects.toThrow('Access token required');
    });

    it('should throw error if JWT_SECRET is not configured', async () => {
      delete process.env.JWT_SECRET;
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      await expect(
        authenticateToken(mockReq as Request, mockRes as Response, mockNext)
      ).rejects.toThrow('JWT_SECRET not configured');
    });

    it('should throw error if token is invalid', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };
      
      (jwt.verify as any).mockImplementation(() => {
        throw new jwt.JsonWebTokenError('Invalid token');
      });

      await expect(
        authenticateToken(mockReq as Request, mockRes as Response, mockNext)
      ).rejects.toThrow('Invalid token');
    });

    it('should throw error if token is expired', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };
      
      (jwt.verify as any).mockImplementation(() => {
        throw new jwt.TokenExpiredError('Token expired', new Date());
      });

      await expect(
        authenticateToken(mockReq as Request, mockRes as Response, mockNext)
      ).rejects.toThrow('Invalid token');
    });

    it('should throw error if user does not exist', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };
      
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        authenticateToken(mockReq as Request, mockRes as Response, mockNext)
      ).rejects.toThrow('Invalid token');
    });

    it('should handle database errors', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };
      
      mockPrisma.user.findUnique.mockRejectedValue(new Error('Database connection failed'));

      await expect(
        authenticateToken(mockReq as Request, mockRes as Response, mockNext)
      ).rejects.toThrow('Database connection failed');
    });

    it('should set userId and user on request object', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      await authenticateToken(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.userId).toBe(validUserId);
      expect(mockReq.user).toEqual(mockUser);
    });
  });

  describe('optionalAuth', () => {
    const validToken = 'valid.jwt.token';
    const validUserId = 'user-123';
    const mockUser = {
      id: validUserId,
      email: 'test@example.com',
      name: 'Test User'
    };

    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      (jwt.verify as any).mockReturnValue({ userId: validUserId });
    });

    it('should authenticate valid token and set user', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      await optionalAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.userId).toBe(validUserId);
      expect(mockReq.user).toBe(mockUser);
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should continue without authentication if no token provided', async () => {
      mockReq.headers = {};

      await optionalAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.userId).toBeUndefined();
      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should continue without authentication if token is invalid', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };
      
      (jwt.verify as any).mockImplementation(() => {
        throw new jwt.JsonWebTokenError('Invalid token');
      });

      await optionalAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.userId).toBeUndefined();
      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should continue without authentication if user not found', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };
      
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await optionalAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.userId).toBeUndefined();
      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should continue without authentication on database error', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };
      
      mockPrisma.user.findUnique.mockRejectedValue(new Error('Database error'));

      await optionalAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.userId).toBeUndefined();
      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should handle malformed authorization header gracefully', async () => {
      mockReq.headers = {
        authorization: 'InvalidFormat'
      };

      await optionalAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.userId).toBeUndefined();
      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalledWith();
    });
  });

  describe('Token Extraction', () => {
    it('should extract token from Bearer authorization header', async () => {
      const token = 'test.jwt.token';
      mockReq.headers = {
        authorization: `Bearer ${token}`
      };
      
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com'
      });
      
      (jwt.verify as any).mockReturnValue({ userId: 'user-123' });

      await authenticateToken(mockReq as Request, mockRes as Response, mockNext);

      expect(jwt.verify).toHaveBeenCalledWith(token, 'test-secret-key');
    });

    it('should handle extra whitespace in authorization header', async () => {
      const token = 'test.jwt.token';
      mockReq.headers = {
        authorization: `  Bearer   ${token}  `
      };
      
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        email: 'test@example.com'
      });
      
      (jwt.verify as any).mockReturnValue({ userId: 'user-123' });

      await authenticateToken(mockReq as Request, mockRes as Response, mockNext);

      expect(jwt.verify).toHaveBeenCalledWith(token, 'test-secret-key');
    });
  });

  describe('Environment Configuration', () => {
    it('should handle missing JWT_SECRET gracefully in optionalAuth', async () => {
      delete process.env.JWT_SECRET;
      
      mockReq.headers = {
        authorization: 'Bearer test.token'
      };

      await optionalAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.userId).toBeUndefined();
      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalledWith();
    });
  });
});