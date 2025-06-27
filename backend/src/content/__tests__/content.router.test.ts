import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { contentRouter } from '../content.router.js';

// Mock dependencies
vi.mock('../encryption.service.js', () => ({
  simulateClientSideEncryption: vi.fn(),
  decryptContent: vi.fn(),
  generatePreview: vi.fn()
}));

vi.mock('../key-escrow.service.js', () => ({
  retrieveContentKeyFromEscrow: vi.fn(),
  grantContentAccess: vi.fn(),
  getUserContentKeys: vi.fn()
}));

vi.mock('../../payments/payment.service.js', () => ({
  checkContentAccess: vi.fn()
}));

vi.mock('../../common/prisma.js', () => ({
  prisma: {
    content: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn()
    }
  }
}));

vi.mock('../../auth/auth.middleware.js', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { id: 'user-123', name: 'Test User' };
    next();
  },
  optionalAuth: (req: any, res: any, next: any) => {
    if (req.headers.authorization) {
      req.user = { id: 'user-123', name: 'Test User' };
    }
    next();
  }
}));

describe('Content Router', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/content', contentRouter);
    
    vi.clearAllMocks();
  });

  describe('POST /api/content/create', () => {
    const { simulateClientSideEncryption } = require('../encryption.service.js');
    const { grantContentAccess } = require('../key-escrow.service.js');
    const { prisma } = require('../../common/prisma.js');

    beforeEach(() => {
      simulateClientSideEncryption.mockReturnValue({
        publicData: {
          id: 'content-123',
          title: 'Test Content',
          author: 'Test User',
          preview: 'This is a preview...',
          price: 9.99,
          encrypted_blob: {
            encryptedData: 'encrypted',
            iv: 'iv',
            authTag: 'tag',
            algorithm: 'aes-256-gcm'
          },
          opencontext_encrypted: true
        },
        contentKeyData: {
          contentKey: 'abc123def456',
          keyId: 'key-789',
          algorithm: 'aes-256-gcm',
          createdAt: new Date().toISOString()
        }
      });

      prisma.content.create.mockResolvedValue({
        id: 'content-123',
        title: 'Test Content',
        description: 'Test description',
        preview: 'This is a preview...',
        price: 9.99,
        platform: 'static',
        createdAt: new Date()
      });

      grantContentAccess.mockResolvedValue(undefined);
    });

    it('should create encrypted content successfully', async () => {
      const contentData = {
        title: 'Test Content',
        description: 'Test description',
        content: 'This is the full content that will be encrypted.',
        platform: 'wordpress',
        platformId: 'wp-123',
        price: 9.99
      };

      const response = await request(app)
        .post('/api/content/create')
        .set('Authorization', 'Bearer test-token')
        .send(contentData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.content).toMatchObject({
        id: 'content-123',
        title: 'Test Content',
        preview: 'This is a preview...',
        price: 9.99,
        encrypted: true
      });

      expect(simulateClientSideEncryption).toHaveBeenCalledWith(
        contentData.content,
        expect.objectContaining({
          title: contentData.title,
          author: 'Test User',
          price: contentData.price,
          userId: 'user-123'
        })
      );

      expect(prisma.content.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-123',
          title: contentData.title,
          description: contentData.description,
          platform: contentData.platform,
          platformId: contentData.platformId,
          price: contentData.price,
          published: true
        })
      });

      expect(grantContentAccess).toHaveBeenCalled();
    });

    it('should require authentication', async () => {
      await request(app)
        .post('/api/content/create')
        .send({
          title: 'Test',
          content: 'Content',
          price: 1
        })
        .expect(401);
    });

    it('should validate required fields', async () => {
      await request(app)
        .post('/api/content/create')
        .set('Authorization', 'Bearer test-token')
        .send({
          title: '', // Invalid: empty title
          content: 'Content',
          price: 1
        })
        .expect(400);
    });

    it('should validate positive price', async () => {
      await request(app)
        .post('/api/content/create')
        .set('Authorization', 'Bearer test-token')
        .send({
          title: 'Test',
          content: 'Content',
          price: -1 // Invalid: negative price
        })
        .expect(400);
    });
  });

  describe('GET /api/content/:contentId', () => {
    const { checkContentAccess } = require('../../payments/payment.service.js');
    const { retrieveContentKeyFromEscrow } = require('../key-escrow.service.js');
    const { decryptContent } = require('../encryption.service.js');
    const { prisma } = require('../../common/prisma.js');

    const mockContent = {
      id: 'content-123',
      title: 'Test Content',
      description: 'Test description',
      preview: 'This is a preview...',
      price: 9.99,
      platform: 'wordpress',
      encryptedContent: JSON.stringify({
        encryptedData: 'encrypted',
        iv: 'iv',
        authTag: 'tag',
        algorithm: 'aes-256-gcm'
      }),
      createdAt: new Date(),
      user: {
        name: 'Content Creator',
        avatar: 'https://example.com/avatar.jpg'
      }
    };

    beforeEach(() => {
      prisma.content.findUnique.mockResolvedValue(mockContent);
    });

    it('should return public content without authentication', async () => {
      const response = await request(app)
        .get('/api/content/content-123')
        .expect(200);

      expect(response.body).toMatchObject({
        id: 'content-123',
        title: 'Test Content',
        preview: 'This is a preview...',
        encrypted: true,
        decrypted: false,
        hasAccess: false
      });
    });

    it('should return decrypted content for authenticated user with access', async () => {
      const decryptedText = 'This is the full decrypted content';
      
      checkContentAccess.mockResolvedValue(true);
      retrieveContentKeyFromEscrow.mockResolvedValue(Buffer.from('content-key'));
      decryptContent.mockReturnValue(decryptedText);

      const response = await request(app)
        .get('/api/content/content-123?decrypt=true')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(response.body).toMatchObject({
        id: 'content-123',
        content: decryptedText,
        decrypted: true,
        hasAccess: true
      });

      expect(checkContentAccess).toHaveBeenCalledWith('user-123', 'content-123');
      expect(retrieveContentKeyFromEscrow).toHaveBeenCalledWith('content-123', 'user-123');
    });

    it('should return encrypted version for user without access', async () => {
      checkContentAccess.mockResolvedValue(false);

      const response = await request(app)
        .get('/api/content/content-123?decrypt=true')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(response.body).toMatchObject({
        decrypted: false,
        hasAccess: false,
        message: 'Purchase required to access full content'
      });
    });

    it('should return 404 for non-existent content', async () => {
      prisma.content.findUnique.mockResolvedValue(null);

      await request(app)
        .get('/api/content/non-existent')
        .expect(404);
    });

    it('should handle decryption errors gracefully', async () => {
      checkContentAccess.mockResolvedValue(true);
      retrieveContentKeyFromEscrow.mockResolvedValue(Buffer.from('key'));
      decryptContent.mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      const response = await request(app)
        .get('/api/content/content-123?decrypt=true')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(response.body.decrypted).toBe(false);
      expect(response.body.hasAccess).toBe(false);
    });
  });

  describe('GET /api/content/my/accessible', () => {
    const { getUserContentKeys } = require('../key-escrow.service.js');
    const { prisma } = require('../../common/prisma.js');

    it('should return user\'s accessible content', async () => {
      const mockContentKeys = [
        {
          contentId: 'content-1',
          createdAt: new Date(),
          expiresAt: null
        },
        {
          contentId: 'content-2',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 1000000)
        }
      ];

      const mockContentList = [
        {
          id: 'content-1',
          title: 'Content 1',
          description: 'Description 1',
          preview: 'Preview 1',
          price: 5.99,
          platform: 'wordpress',
          createdAt: new Date(),
          user: { name: 'Creator 1', avatar: null }
        },
        {
          id: 'content-2',
          title: 'Content 2',
          description: 'Description 2',
          preview: 'Preview 2',
          price: 7.99,
          platform: 'medium',
          createdAt: new Date(),
          user: { name: 'Creator 2', avatar: 'avatar.jpg' }
        }
      ];

      getUserContentKeys.mockResolvedValue(mockContentKeys);
      prisma.content.findMany.mockResolvedValue(mockContentList);

      const response = await request(app)
        .get('/api/content/my/accessible')
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(response.body.content).toHaveLength(2);
      expect(response.body.content[0]).toMatchObject({
        hasAccess: true,
        accessGrantedAt: expect.any(String)
      });
      expect(response.body.total).toBe(2);

      expect(getUserContentKeys).toHaveBeenCalledWith('user-123');
    });

    it('should require authentication', async () => {
      await request(app)
        .get('/api/content/my/accessible')
        .expect(401);
    });
  });

  describe('GET /api/content/user/:userId', () => {
    const { prisma } = require('../../common/prisma.js');

    it('should return user\'s public content', async () => {
      const mockContent = [
        {
          id: 'content-1',
          title: 'Public Content 1',
          description: 'Description 1',
          preview: 'Preview 1',
          price: 3.99,
          platform: 'wordpress',
          createdAt: new Date(),
          user: { name: 'Creator', avatar: null }
        }
      ];

      prisma.content.findMany.mockResolvedValue(mockContent);

      const response = await request(app)
        .get('/api/content/user/creator-123')
        .expect(200);

      expect(response.body.content).toHaveLength(1);
      expect(response.body.content[0]).toMatchObject({
        id: 'content-1',
        title: 'Public Content 1',
        encrypted: true,
        isOwner: false
      });

      expect(prisma.content.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'creator-123',
          published: true
        },
        include: expect.any(Object),
        orderBy: { createdAt: 'desc' }
      });
    });

    it('should mark content as owned for the creator', async () => {
      prisma.content.findMany.mockResolvedValue([]);

      const response = await request(app)
        .get('/api/content/user/user-123') // Same as authenticated user
        .set('Authorization', 'Bearer test-token')
        .expect(200);

      expect(response.body.content).toEqual([]);
    });
  });

  describe('GET /api/content/search', () => {
    const { prisma } = require('../../common/prisma.js');

    it('should search content with query', async () => {
      const mockSearchResults = [
        {
          id: 'content-1',
          title: 'Matching Content',
          description: 'This matches the search',
          preview: 'Preview text...',
          price: 4.99,
          platform: 'wordpress',
          createdAt: new Date(),
          user: { name: 'Creator', avatar: null }
        }
      ];

      prisma.content.findMany.mockResolvedValue(mockSearchResults);

      const response = await request(app)
        .get('/api/content/search?q=matching&platform=wordpress&minPrice=1&maxPrice=10&limit=5')
        .expect(200);

      expect(response.body.results).toHaveLength(1);
      expect(response.body.results[0]).toMatchObject({
        id: 'content-1',
        title: 'Matching Content'
      });
      expect(response.body.query).toBe('matching');
      expect(response.body.filters).toMatchObject({
        platform: 'wordpress',
        minPrice: '1',
        maxPrice: '10'
      });

      expect(prisma.content.findMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          published: true,
          platform: 'wordpress',
          price: {
            gte: 1,
            lte: 10
          },
          OR: expect.arrayContaining([
            { title: { contains: 'matching', mode: 'insensitive' } }
          ])
        }),
        include: expect.any(Object),
        orderBy: { createdAt: 'desc' },
        take: 5
      });
    });

    it('should search without filters', async () => {
      prisma.content.findMany.mockResolvedValue([]);

      const response = await request(app)
        .get('/api/content/search')
        .expect(200);

      expect(response.body.results).toEqual([]);
      expect(response.body.query).toBe('');
      
      expect(prisma.content.findMany).toHaveBeenCalledWith({
        where: {
          published: true
        },
        include: expect.any(Object),
        orderBy: { createdAt: 'desc' },
        take: 20 // Default limit
      });
    });
  });

  describe('GET /api/content/lib/encryption.js', () => {
    it('should serve client-side encryption library', async () => {
      const response = await request(app)
        .get('/api/content/lib/encryption.js')
        .expect(200);

      expect(response.headers['content-type']).toBe('application/javascript; charset=utf-8');
      expect(response.text).toContain('OpenContextEncryption');
      expect(response.text).toContain('window.OpenContextEncryption');
      expect(response.text).toContain('generateContentKey');
      expect(response.text).toContain('encryptContent');
      expect(response.text).toContain('decryptContent');
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      const { prisma } = require('../../common/prisma.js');
      
      prisma.content.findUnique.mockRejectedValue(new Error('Database connection failed'));

      await request(app)
        .get('/api/content/content-123')
        .expect(500);
    });

    it('should handle encryption service errors', async () => {
      const { simulateClientSideEncryption } = require('../encryption.service.js');
      
      simulateClientSideEncryption.mockImplementation(() => {
        throw new Error('Encryption failed');
      });

      await request(app)
        .post('/api/content/create')
        .set('Authorization', 'Bearer test-token')
        .send({
          title: 'Test',
          content: 'Content',
          price: 1
        })
        .expect(500);
    });
  });
});