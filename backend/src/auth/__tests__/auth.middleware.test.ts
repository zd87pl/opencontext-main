import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, authenticateToken, optionalAuth } from '../auth.middleware.js';
import { AppError } from '../../common/middleware/error-handler.js';
import { fakeUser } from '../../__tests__/fixtures.js';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn()
    }
  }
}));

vi.mock('../../common/prisma.js', () => ({
  prisma: mockPrisma
}));

// Stub only verify(); the middleware relies on `instanceof jwt.JsonWebTokenError`,
// so the real error classes must stay in place.
vi.mock('jsonwebtoken', async (importOriginal) => {
  // jsonwebtoken is CommonJS: at runtime vitest exposes module.exports as `default`.
  type JwtModule = typeof import('jsonwebtoken');
  const actual = await importOriginal<JwtModule & { default: JwtModule }>();
  return {
    ...actual,
    default: { ...actual.default, verify: vi.fn() }
  };
});

const verify = vi.mocked(jwt.verify);

interface MockRequest {
  headers: Record<string, string>;
  isAuthenticated: Mock<[], boolean>;
  userId?: string;
  user?: Express.User;
}

const asRequest = (req: MockRequest): Request => req as unknown as Request;

/**
 * Express 4 does not catch rejected promises from async middleware, so auth
 * failures are reported through `next(err)` and the request must not hang.
 */
function expectNextCalledWithError(next: Mock<[unknown?], void>, statusCode: number, message: string): void {
  expect(next).toHaveBeenCalledTimes(1);
  const [error] = next.mock.calls[0];
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ statusCode, message });
}

describe('Auth Middleware', () => {
  let mockReq: MockRequest;
  let mockRes: Response;
  let mockNext: Mock<[unknown?], void>;

  beforeEach(() => {
    mockReq = {
      headers: {},
      isAuthenticated: vi.fn()
    };
    mockRes = {} as Response;
    mockNext = vi.fn();

    vi.clearAllMocks();

    // Set JWT_SECRET environment variable
    process.env.JWT_SECRET = 'test-secret-key';
  });

  describe('requireAuth', () => {
    it('should call next() if user is authenticated', () => {
      mockReq.isAuthenticated.mockReturnValue(true);

      requireAuth(asRequest(mockReq), mockRes, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should throw AppError if user is not authenticated', () => {
      mockReq.isAuthenticated.mockReturnValue(false);

      expect(() => {
        requireAuth(asRequest(mockReq), mockRes, mockNext);
      }).toThrow('Authentication required');
    });
  });

  describe('authenticateToken', () => {
    const validToken = 'valid.jwt.token';
    const validUserId = 'user-123';
    const mockUser = fakeUser({ id: validUserId });

    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      verify.mockImplementation(() => ({ userId: validUserId }));
    });

    it('should authenticate valid token successfully', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      await authenticateToken(asRequest(mockReq), mockRes, mockNext as NextFunction);

      expect(verify).toHaveBeenCalledWith(validToken, 'test-secret-key');
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: validUserId }
      });
      expect(mockReq.userId).toBe(validUserId);
      expect(mockReq.user).toBe(mockUser);
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should report an error if no authorization header', async () => {
      mockReq.headers = {};

      await authenticateToken(asRequest(mockReq), mockRes, mockNext);

      expectNextCalledWithError(mockNext, 401, 'Access token required');
    });

    it('should report an error if authorization header has no token', async () => {
      mockReq.headers = {
        authorization: 'Bearer'
      };

      await authenticateToken(asRequest(mockReq), mockRes, mockNext);

      expectNextCalledWithError(mockNext, 401, 'Access token required');
    });

    it('should report an error if authorization header has wrong format', async () => {
      mockReq.headers = {
        authorization: validToken // Missing "Bearer " prefix
      };

      await authenticateToken(asRequest(mockReq), mockRes, mockNext);

      expectNextCalledWithError(mockNext, 401, 'Access token required');
    });

    it('should report an error if JWT_SECRET is not configured', async () => {
      delete process.env.JWT_SECRET;
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      await authenticateToken(asRequest(mockReq), mockRes, mockNext);

      expectNextCalledWithError(mockNext, 500, 'JWT_SECRET not configured');
    });

    it('should report an error if token is invalid', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      verify.mockImplementation(() => {
        throw new jwt.JsonWebTokenError('Invalid token');
      });

      await authenticateToken(asRequest(mockReq), mockRes, mockNext);

      expectNextCalledWithError(mockNext, 401, 'Invalid token');
    });

    it('should report an error if token is expired', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      verify.mockImplementation(() => {
        throw new jwt.TokenExpiredError('Token expired', new Date());
      });

      await authenticateToken(asRequest(mockReq), mockRes, mockNext);

      expectNextCalledWithError(mockNext, 401, 'Invalid token');
    });

    it('should report an error if user does not exist', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      mockPrisma.user.findUnique.mockResolvedValue(null);

      await authenticateToken(asRequest(mockReq), mockRes, mockNext);

      expectNextCalledWithError(mockNext, 401, 'Invalid token');
    });

    it('should pass database errors to next()', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      mockPrisma.user.findUnique.mockRejectedValue(new Error('Database connection failed'));

      await authenticateToken(asRequest(mockReq), mockRes, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
      const [error] = mockNext.mock.calls[0];
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Database connection failed');
    });

    it('should set userId and user on request object', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      await authenticateToken(asRequest(mockReq), mockRes, mockNext);

      expect(mockReq.userId).toBe(validUserId);
      expect(mockReq.user).toEqual(mockUser);
    });
  });

  describe('optionalAuth', () => {
    const validToken = 'valid.jwt.token';
    const validUserId = 'user-123';
    const mockUser = fakeUser({ id: validUserId });

    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      verify.mockImplementation(() => ({ userId: validUserId }));
    });

    it('should authenticate valid token and set user', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      await optionalAuth(asRequest(mockReq), mockRes, mockNext);

      expect(mockReq.userId).toBe(validUserId);
      expect(mockReq.user).toBe(mockUser);
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should continue without authentication if no token provided', async () => {
      mockReq.headers = {};

      await optionalAuth(asRequest(mockReq), mockRes, mockNext);

      expect(mockReq.userId).toBeUndefined();
      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should continue without authentication if token is invalid', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      verify.mockImplementation(() => {
        throw new jwt.JsonWebTokenError('Invalid token');
      });

      await optionalAuth(asRequest(mockReq), mockRes, mockNext);

      expect(mockReq.userId).toBeUndefined();
      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should continue without authentication if user not found', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      mockPrisma.user.findUnique.mockResolvedValue(null);

      await optionalAuth(asRequest(mockReq), mockRes, mockNext);

      expect(mockReq.userId).toBeUndefined();
      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should continue without authentication on database error', async () => {
      mockReq.headers = {
        authorization: `Bearer ${validToken}`
      };

      mockPrisma.user.findUnique.mockRejectedValue(new Error('Database error'));

      await optionalAuth(asRequest(mockReq), mockRes, mockNext);

      expect(mockReq.userId).toBeUndefined();
      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalledWith();
    });

    it('should handle malformed authorization header gracefully', async () => {
      mockReq.headers = {
        authorization: 'InvalidFormat'
      };

      await optionalAuth(asRequest(mockReq), mockRes, mockNext);

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

      mockPrisma.user.findUnique.mockResolvedValue(fakeUser());
      verify.mockImplementation(() => ({ userId: 'user-123' }));

      await authenticateToken(asRequest(mockReq), mockRes, mockNext);

      expect(verify).toHaveBeenCalledWith(token, 'test-secret-key');
    });

    it('should handle extra whitespace in authorization header', async () => {
      const token = 'test.jwt.token';
      mockReq.headers = {
        authorization: `  Bearer   ${token}  `
      };

      mockPrisma.user.findUnique.mockResolvedValue(fakeUser());
      verify.mockImplementation(() => ({ userId: 'user-123' }));

      await authenticateToken(asRequest(mockReq), mockRes, mockNext);

      expect(verify).toHaveBeenCalledWith(token, 'test-secret-key');
    });
  });

  describe('Environment Configuration', () => {
    it('should handle missing JWT_SECRET gracefully in optionalAuth', async () => {
      delete process.env.JWT_SECRET;

      mockReq.headers = {
        authorization: 'Bearer test.token'
      };

      await optionalAuth(asRequest(mockReq), mockRes, mockNext);

      expect(mockReq.userId).toBeUndefined();
      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalledWith();
    });
  });
});
