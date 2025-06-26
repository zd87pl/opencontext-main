import { describe, it, expect, beforeEach } from 'vitest';
import { StreamingService } from '../src/streaming.js';
import { Readable } from 'stream';
import { ethers } from 'ethers';

describe('StreamingService', () => {
  let streamingService: StreamingService;
  const testPassportId = 'test-passport-123';
  const testPartnerId = 'satellite';
  const testCostPerByte = '10000000000'; // 10 gwei

  beforeEach(() => {
    streamingService = new StreamingService();
  });

  describe('Session Creation', () => {
    it('should create streaming session with correct parameters', () => {
      const totalSize = 1024 * 1024; // 1MB
      const chunkSize = 256 * 1024; // 256KB

      const session = streamingService.createSession(
        testPassportId,
        testPartnerId,
        totalSize,
        testCostPerByte,
        chunkSize
      );

      expect(session.id).toBeDefined();
      expect(session.passportId).toBe(testPassportId);
      expect(session.partnerId).toBe(testPartnerId);
      expect(session.totalSize).toBe(totalSize);
      expect(session.chunkSize).toBe(chunkSize);
      expect(session.costPerByte).toBe(testCostPerByte);
      expect(session.totalCost).toBe((BigInt(totalSize) * BigInt(testCostPerByte)).toString());
      expect(session.chunks).toEqual([]);
      expect(session.status).toBe('active');
      expect(session.startTime).toBeGreaterThan(0);
      expect(session.endTime).toBeUndefined();
    });

    it('should use default chunk size when not specified', () => {
      const session = streamingService.createSession(
        testPassportId,
        testPartnerId,
        1024,
        testCostPerByte
      );

      expect(session.chunkSize).toBe(1024 * 1024); // Default 1MB
    });

    it('should generate unique session IDs', () => {
      const session1 = streamingService.createSession(testPassportId, testPartnerId, 1024, testCostPerByte);
      const session2 = streamingService.createSession(testPassportId, testPartnerId, 1024, testCostPerByte);

      expect(session1.id).not.toBe(session2.id);
    });

    it('should calculate total cost correctly', () => {
      const totalSize = 2048;
      const session = streamingService.createSession(
        testPassportId,
        testPartnerId,
        totalSize,
        testCostPerByte
      );

      const expectedCost = (BigInt(totalSize) * BigInt(testCostPerByte)).toString();
      expect(session.totalCost).toBe(expectedCost);
    });
  });

  describe('File Streaming and Chunking', () => {
    let sessionId: string;

    beforeEach(() => {
      const session = streamingService.createSession(
        testPassportId,
        testPartnerId,
        1024,
        testCostPerByte,
        256 // 256 byte chunks for testing
      );
      sessionId = session.id;
    });

    it('should chunk data from string input', async () => {
      const testData = 'A'.repeat(1000); // 1000 bytes
      
      const chunks = await streamingService.streamLargeFile(sessionId, testData);
      
      expect(chunks.length).toBe(4); // 256 + 256 + 256 + 232 bytes
      expect(chunks[0].size).toBe(256);
      expect(chunks[1].size).toBe(256);
      expect(chunks[2].size).toBe(256);
      expect(chunks[3].size).toBe(232);
      
      chunks.forEach((chunk, i) => {
        expect(chunk.sequence).toBe(i);
        expect(chunk.id).toBeDefined();
        expect(chunk.checksum).toBeDefined();
        expect(chunk.timestamp).toBeGreaterThan(0);
      });
    });

    it('should chunk data from Buffer input', async () => {
      const testData = Buffer.alloc(500, 'B');
      
      const chunks = await streamingService.streamLargeFile(sessionId, testData);
      
      expect(chunks.length).toBe(2); // 256 + 244 bytes
      expect(chunks[0].size).toBe(256);
      expect(chunks[1].size).toBe(244);
    });

    it('should chunk data from Readable stream', async () => {
      const testData = Buffer.alloc(800, 'C');
      const stream = Readable.from(testData);
      
      const chunks = await streamingService.streamLargeFile(sessionId, stream);
      
      expect(chunks.length).toBe(4); // 256 + 256 + 256 + 32 bytes
      expect(chunks.map(c => c.size).reduce((a, b) => a + b, 0)).toBe(800);
    });

    it('should handle empty data', async () => {
      const chunks = await streamingService.streamLargeFile(sessionId, '');
      expect(chunks.length).toBe(0);
    });

    it('should handle data smaller than chunk size', async () => {
      const testData = 'small data';
      
      const chunks = await streamingService.streamLargeFile(sessionId, testData);
      
      expect(chunks.length).toBe(1);
      expect(chunks[0].size).toBe(testData.length);
      expect(chunks[0].sequence).toBe(0);
    });

    it('should update session status on completion', async () => {
      const testData = 'test data';
      
      await streamingService.streamLargeFile(sessionId, testData);
      
      const session = streamingService.getSession(sessionId);
      expect(session?.status).toBe('completed');
      expect(session?.endTime).toBeDefined();
      expect(session?.endTime).toBeGreaterThan(session!.startTime);
    });

    it('should fail for invalid session ID', async () => {
      await expect(
        streamingService.streamLargeFile('invalid-session', 'test data')
      ).rejects.toThrow('Session not found: invalid-session');
    });
  });

  describe('Chunk Validation', () => {
    it('should validate correct chunks', () => {
      const testData = Buffer.from('test chunk data');
      const chunk = {
        id: 'test-chunk-1',
        sequence: 0,
        data: testData,
        size: testData.length,
        checksum: ethers.keccak256(testData),
        timestamp: Date.now()
      };

      const isValid = streamingService.validateChunk(chunk);
      expect(isValid).toBe(true);
    });

    it('should reject chunks with invalid checksum', () => {
      const testData = Buffer.from('test chunk data');
      const chunk = {
        id: 'test-chunk-1',
        sequence: 0,
        data: testData,
        size: testData.length,
        checksum: '0x1234567890abcdef',
        timestamp: Date.now()
      };

      const isValid = streamingService.validateChunk(chunk);
      expect(isValid).toBe(false);
    });

    it('should reject chunks with mismatched size', () => {
      const testData = Buffer.from('test chunk data');
      const chunk = {
        id: 'test-chunk-1',
        sequence: 0,
        data: testData,
        size: testData.length + 10, // Wrong size
        checksum: ethers.keccak256(testData),
        timestamp: Date.now()
      };

      const isValid = streamingService.validateChunk(chunk);
      expect(isValid).toBe(false);
    });
  });

  describe('Data Reconstruction', () => {
    let chunks: any[];

    beforeEach(async () => {
      const session = streamingService.createSession(
        testPassportId,
        testPartnerId,
        1000,
        testCostPerByte,
        300
      );
      
      const testData = 'A'.repeat(1000);
      chunks = await streamingService.streamLargeFile(session.id, testData);
    });

    it('should reconstruct data from valid chunks', () => {
      const reconstructed = streamingService.reconstructFromChunks(chunks);
      const originalData = 'A'.repeat(1000);
      
      expect(reconstructed.toString()).toBe(originalData);
      expect(reconstructed.length).toBe(1000);
    });

    it('should handle chunks in random order', () => {
      const shuffledChunks = [...chunks].sort(() => Math.random() - 0.5);
      const reconstructed = streamingService.reconstructFromChunks(shuffledChunks);
      
      expect(reconstructed.toString()).toBe('A'.repeat(1000));
    });

    it('should fail with missing chunks', () => {
      const incompleteChunks = chunks.slice(0, -1); // Remove last chunk
      
      expect(() => {
        streamingService.reconstructFromChunks(incompleteChunks);
      }).toThrow(/Missing chunk at sequence/);
    });

    it('should fail with invalid chunks', () => {
      const invalidChunks = [...chunks];
      invalidChunks[1].checksum = '0xinvalid';
      
      expect(() => {
        streamingService.reconstructFromChunks(invalidChunks);
      }).toThrow(/Invalid checksum for chunk/);
    });

    it('should handle single chunk reconstruction', () => {
      const singleChunk = [{
        id: 'test-chunk-1',
        sequence: 0,
        data: Buffer.from('single chunk'),
        size: 12,
        checksum: ethers.keccak256(Buffer.from('single chunk')),
        timestamp: Date.now()
      }];

      const reconstructed = streamingService.reconstructFromChunks(singleChunk);
      expect(reconstructed.toString()).toBe('single chunk');
    });
  });

  describe('Cost Calculation', () => {
    it('should calculate chunk cost correctly', () => {
      const chunk = {
        id: 'test-chunk-1',
        sequence: 0,
        data: Buffer.alloc(500),
        size: 500,
        checksum: ethers.keccak256(Buffer.alloc(500)),
        timestamp: Date.now()
      };

      const cost = streamingService.calculateChunkCost(chunk, testCostPerByte);
      const expectedCost = (BigInt(500) * BigInt(testCostPerByte)).toString();
      
      expect(cost).toBe(expectedCost);
    });

    it('should handle zero-size chunks', () => {
      const chunk = {
        id: 'test-chunk-1',
        sequence: 0,
        data: Buffer.alloc(0),
        size: 0,
        checksum: ethers.keccak256(Buffer.alloc(0)),
        timestamp: Date.now()
      };

      const cost = streamingService.calculateChunkCost(chunk, testCostPerByte);
      expect(cost).toBe('0');
    });
  });

  describe('Session Management', () => {
    it('should retrieve session by ID', () => {
      const session = streamingService.createSession(testPassportId, testPartnerId, 1024, testCostPerByte);
      const retrieved = streamingService.getSession(session.id);
      
      expect(retrieved).toEqual(session);
    });

    it('should return undefined for unknown session ID', () => {
      const retrieved = streamingService.getSession('unknown-session');
      expect(retrieved).toBeUndefined();
    });

    it('should get sessions by passport ID', () => {
      const session1 = streamingService.createSession(testPassportId, 'partner1', 1024, testCostPerByte);
      const session2 = streamingService.createSession(testPassportId, 'partner2', 2048, testCostPerByte);
      const session3 = streamingService.createSession('other-passport', 'partner1', 1024, testCostPerByte);

      const sessions = streamingService.getSessionsByPassport(testPassportId);
      
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.id)).toContain(session1.id);
      expect(sessions.map(s => s.id)).toContain(session2.id);
      expect(sessions.map(s => s.id)).not.toContain(session3.id);
    });

    it('should sort sessions by start time (newest first)', () => {
      const session1 = streamingService.createSession(testPassportId, 'partner1', 1024, testCostPerByte);
      
      // Add small delay to ensure different timestamps
      setTimeout(() => {
        const session2 = streamingService.createSession(testPassportId, 'partner2', 1024, testCostPerByte);
        const sessions = streamingService.getSessionsByPassport(testPassportId);
        
        expect(sessions[0].id).toBe(session2.id); // Newest first
        expect(sessions[1].id).toBe(session1.id);
      }, 10);
    });

    it('should delete session', () => {
      const session = streamingService.createSession(testPassportId, testPartnerId, 1024, testCostPerByte);
      
      const deleted = streamingService.deleteSession(session.id);
      expect(deleted).toBe(true);
      
      const retrieved = streamingService.getSession(session.id);
      expect(retrieved).toBeUndefined();
    });

    it('should return false when deleting non-existent session', () => {
      const deleted = streamingService.deleteSession('non-existent');
      expect(deleted).toBe(false);
    });

    it('should count active sessions', () => {
      const session1 = streamingService.createSession(testPassportId, 'partner1', 1024, testCostPerByte);
      const session2 = streamingService.createSession(testPassportId, 'partner2', 1024, testCostPerByte);
      
      expect(streamingService.getActiveSessionCount()).toBe(2);
      
      // Complete one session
      session1.status = 'completed';
      expect(streamingService.getActiveSessionCount()).toBe(1);
      
      // Fail one session
      session2.status = 'failed';
      expect(streamingService.getActiveSessionCount()).toBe(0);
    });
  });

  describe('Chunking Transform Stream', () => {
    it('should create chunking transform for valid session', () => {
      const session = streamingService.createSession(testPassportId, testPartnerId, 1024, testCostPerByte);
      const transform = streamingService.createChunkingTransform(session.id);
      
      expect(transform).toBeDefined();
      expect(typeof transform.write).toBe('function');
      expect(typeof transform.end).toBe('function');
    });

    it('should fail for invalid session ID', () => {
      expect(() => {
        streamingService.createChunkingTransform('invalid-session');
      }).toThrow('Session not found: invalid-session');
    });
  });
});