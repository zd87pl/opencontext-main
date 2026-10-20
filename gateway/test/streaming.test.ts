import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { ethers } from 'ethers';
import { StreamingService, type StreamChunk } from '../src/streaming.js';
import { MemoryStorage } from '../src/storage.js';

function makeChunk(data: Buffer, overrides: Partial<StreamChunk> = {}): StreamChunk {
  return {
    id: 'test-chunk-1',
    sequence: 0,
    data,
    size: data.length,
    checksum: ethers.keccak256(data),
    timestamp: Date.now(),
    last: true,
    ...overrides,
  };
}

describe('StreamingService', () => {
  let streamingService: StreamingService;
  const testPassportId = 'test-passport-123';
  const testPartnerId = 'satellite';
  const testCostPerByte = '10000000000'; // 10 gwei

  beforeEach(() => {
    streamingService = new StreamingService();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await streamingService.close();
  });

  describe('Session Creation', () => {
    it('should create streaming session with correct parameters', async () => {
      const totalSize = 1024 * 1024; // 1MB
      const chunkSize = 256 * 1024; // 256KB

      const session = await streamingService.createSession(
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
      expect(session.accruedCost).toBe('0');
      expect(session.chunks).toEqual([]);
      expect(session.status).toBe('active');
      expect(session.startTime).toBeGreaterThan(0);
      expect(session.expiresAt).toBeGreaterThan(session.startTime);
      expect(session.endTime).toBeUndefined();
    });

    it('should use default chunk size when not specified', async () => {
      const session = await streamingService.createSession(
        testPassportId,
        testPartnerId,
        1024,
        testCostPerByte
      );

      expect(session.chunkSize).toBe(1024 * 1024); // Default 1MB
    });

    it('should generate unique session IDs', async () => {
      const session1 = await streamingService.createSession(testPassportId, testPartnerId, 1024, testCostPerByte);
      const session2 = await streamingService.createSession(testPassportId, testPartnerId, 1024, testCostPerByte);

      expect(session1.id).not.toBe(session2.id);
    });

    it('should calculate total cost correctly', async () => {
      const totalSize = 2048;
      const session = await streamingService.createSession(
        testPassportId,
        testPartnerId,
        totalSize,
        testCostPerByte
      );

      const expectedCost = (BigInt(totalSize) * BigInt(testCostPerByte)).toString();
      expect(session.totalCost).toBe(expectedCost);
    });

    it('should reject invalid sizes and prices', async () => {
      await expect(
        streamingService.createSession(testPassportId, testPartnerId, -1, testCostPerByte)
      ).rejects.toThrow(RangeError);
      await expect(
        streamingService.createSession(testPassportId, testPartnerId, 1024, testCostPerByte, 0)
      ).rejects.toThrow(RangeError);
      await expect(
        streamingService.createSession(testPassportId, testPartnerId, 1024, 'ten')
      ).rejects.toThrow();
    });
  });

  describe('File Streaming and Chunking', () => {
    let sessionId: string;

    beforeEach(async () => {
      const session = await streamingService.createSession(
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
        expect(chunk.checksum).toBe(ethers.keccak256(chunk.data));
        expect(chunk.timestamp).toBeGreaterThan(0);
        expect(chunk.last).toBe(i === chunks.length - 1);
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
      expect(chunks.map((c) => c.size).reduce((a, b) => a + b, 0)).toBe(800);
    });

    it('should chunk a stream that arrives in many small writes', async () => {
      const pieces = Array.from({ length: 50 }, () => Buffer.alloc(20, 'D')); // 1000 bytes
      const chunks = await streamingService.streamLargeFile(sessionId, Readable.from(pieces));

      expect(chunks.map((c) => c.size)).toEqual([256, 256, 256, 232]);
      expect(streamingService.reconstructFromChunks(chunks).equals(Buffer.alloc(1000, 'D'))).toBe(true);
    });

    it('should emit a single terminal chunk when the data fits exactly one chunk', async () => {
      const chunks = await streamingService.streamLargeFile(sessionId, Buffer.alloc(256, 'E'));
      expect(chunks).toHaveLength(1);
      expect(chunks[0].last).toBe(true);
    });

    it('should handle empty data', async () => {
      const chunks = await streamingService.streamLargeFile(sessionId, '');
      expect(chunks.length).toBe(0);
      expect((await streamingService.getSession(sessionId))?.status).toBe('completed');
    });

    it('should handle data smaller than chunk size', async () => {
      const testData = 'small data';

      const chunks = await streamingService.streamLargeFile(sessionId, testData);

      expect(chunks.length).toBe(1);
      expect(chunks[0].size).toBe(testData.length);
      expect(chunks[0].sequence).toBe(0);
    });

    it('should update session status and ledger on completion', async () => {
      const testData = 'test data';

      await streamingService.streamLargeFile(sessionId, testData);

      const session = await streamingService.getSession(sessionId);
      expect(session?.status).toBe('completed');
      expect(session?.endTime).toBeDefined();
      // Chunking a few bytes can finish within the millisecond the session was created in.
      expect(session?.endTime).toBeGreaterThanOrEqual(session!.startTime);
      expect(session?.downloadedBytes).toBe(testData.length);
      expect(session?.chunks).toHaveLength(1);
      expect(session?.accruedCost).toBe((BigInt(testData.length) * BigInt(testCostPerByte)).toString());
    });

    it('should retain chunk payloads for replay', async () => {
      await streamingService.streamLargeFile(sessionId, Buffer.alloc(300, 'F'));
      const replay = await streamingService.getChunkData(sessionId, 1);
      expect(replay?.equals(Buffer.alloc(44, 'F'))).toBe(true);
      expect(await streamingService.getChunkData(sessionId, 7)).toBeUndefined();
    });

    it('should mark the session failed when the source errors', async () => {
      const broken = new Readable({
        read() {
          this.push(Buffer.alloc(300, 'G'));
          this.destroy(new Error('disk read failed'));
        },
      });

      await expect(streamingService.streamLargeFile(sessionId, broken)).rejects.toThrow('disk read failed');
      const session = await streamingService.getSession(sessionId);
      expect(session?.status).toBe('failed');
      expect(session?.error).toBe('disk read failed');
    });

    it('should fail for invalid session ID', async () => {
      await expect(
        streamingService.streamLargeFile('invalid-session', 'test data')
      ).rejects.toThrow('Session not found: invalid-session');
    });

    it('should serialise chunks as NDJSON with base64 payloads', async () => {
      const chunks = await streamingService.streamLargeFile(sessionId, 'wire format');
      const lines: string[] = [];
      const ndjson = StreamingService.toNdjson();
      ndjson.on('data', (line: Buffer) => lines.push(line.toString()));
      for (const chunk of chunks) ndjson.write(chunk);
      ndjson.end();
      await new Promise((resolve) => ndjson.on('end', resolve));

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]) as { data: string; last: boolean; size: number };
      expect(Buffer.from(parsed.data, 'base64').toString()).toBe('wire format');
      expect(parsed.last).toBe(true);
      expect(parsed.size).toBe(11);
    });
  });

  describe('Chunk Validation', () => {
    it('should validate correct chunks', () => {
      const chunk = makeChunk(Buffer.from('test chunk data'));
      expect(streamingService.validateChunk(chunk)).toBe(true);
    });

    it('should reject chunks with invalid checksum', () => {
      const chunk = makeChunk(Buffer.from('test chunk data'), { checksum: '0x1234567890abcdef' });
      expect(streamingService.validateChunk(chunk)).toBe(false);
    });

    it('should reject chunks with mismatched size', () => {
      const data = Buffer.from('test chunk data');
      const chunk = makeChunk(data, { size: data.length + 10 });
      expect(streamingService.validateChunk(chunk)).toBe(false);
    });
  });

  describe('Data Reconstruction', () => {
    let chunks: StreamChunk[];

    beforeEach(async () => {
      const session = await streamingService.createSession(
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
      const shuffledChunks = [...chunks].reverse();
      const reconstructed = streamingService.reconstructFromChunks(shuffledChunks);

      expect(reconstructed.toString()).toBe('A'.repeat(1000));
      // The input order is left untouched.
      expect(shuffledChunks[0].sequence).toBe(chunks.length - 1);
    });

    it('should fail with missing chunks', () => {
      const incompleteChunks = chunks.slice(0, -1); // Remove last chunk

      expect(() => {
        streamingService.reconstructFromChunks(incompleteChunks);
      }).toThrow(/Missing chunk at sequence/);
    });

    it('should fail with a missing middle chunk', () => {
      const incompleteChunks = chunks.filter((chunk) => chunk.sequence !== 1);

      expect(() => {
        streamingService.reconstructFromChunks(incompleteChunks);
      }).toThrow('Missing chunk at sequence 1');
    });

    it('should fail with invalid chunks', () => {
      const invalidChunks = chunks.map((chunk) => ({ ...chunk }));
      invalidChunks[1].checksum = '0xinvalid';

      expect(() => {
        streamingService.reconstructFromChunks(invalidChunks);
      }).toThrow(/Invalid checksum for chunk/);
    });

    it('should handle single chunk reconstruction', () => {
      const singleChunk = [makeChunk(Buffer.from('single chunk'))];

      const reconstructed = streamingService.reconstructFromChunks(singleChunk);
      expect(reconstructed.toString()).toBe('single chunk');
    });

    it('should return an empty buffer for no chunks', () => {
      expect(streamingService.reconstructFromChunks([]).length).toBe(0);
    });
  });

  describe('Cost Calculation', () => {
    it('should calculate chunk cost correctly', () => {
      const chunk = makeChunk(Buffer.alloc(500));

      const cost = streamingService.calculateChunkCost(chunk, testCostPerByte);
      const expectedCost = (BigInt(500) * BigInt(testCostPerByte)).toString();

      expect(cost).toBe(expectedCost);
    });

    it('should handle zero-size chunks', () => {
      const chunk = makeChunk(Buffer.alloc(0));

      const cost = streamingService.calculateChunkCost(chunk, testCostPerByte);
      expect(cost).toBe('0');
    });
  });

  describe('Session Management', () => {
    it('should retrieve session by ID', async () => {
      const session = await streamingService.createSession(testPassportId, testPartnerId, 1024, testCostPerByte);
      const retrieved = await streamingService.getSession(session.id);

      expect(retrieved).toEqual(session);
    });

    it('should return undefined for unknown session ID', async () => {
      const retrieved = await streamingService.getSession('unknown-session');
      expect(retrieved).toBeUndefined();
    });

    it('should get sessions by passport ID', async () => {
      const session1 = await streamingService.createSession(testPassportId, 'partner1', 1024, testCostPerByte);
      const session2 = await streamingService.createSession(testPassportId, 'partner2', 2048, testCostPerByte);
      const session3 = await streamingService.createSession('other-passport', 'partner1', 1024, testCostPerByte);

      const sessions = await streamingService.getSessionsByPassport(testPassportId);

      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.id)).toContain(session1.id);
      expect(sessions.map((s) => s.id)).toContain(session2.id);
      expect(sessions.map((s) => s.id)).not.toContain(session3.id);

      const byPartner = await streamingService.getSessionsByPartner('partner1');
      expect(byPartner.map((s) => s.id).sort()).toEqual([session1.id, session3.id].sort());
    });

    it('should sort sessions by start time (newest first)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const session1 = await streamingService.createSession(testPassportId, 'partner1', 1024, testCostPerByte);

      vi.setSystemTime(Date.now() + 10);
      const session2 = await streamingService.createSession(testPassportId, 'partner2', 1024, testCostPerByte);

      const sessions = await streamingService.getSessionsByPassport(testPassportId);
      expect(sessions[0].id).toBe(session2.id); // Newest first
      expect(sessions[1].id).toBe(session1.id);
    });

    it('should delete session', async () => {
      const session = await streamingService.createSession(testPassportId, testPartnerId, 1024, testCostPerByte);

      const deleted = await streamingService.deleteSession(session.id);
      expect(deleted).toBe(true);

      const retrieved = await streamingService.getSession(session.id);
      expect(retrieved).toBeUndefined();
      expect(await streamingService.getSessionsByPassport(testPassportId)).toHaveLength(0);
    });

    it('should return false when deleting non-existent session', async () => {
      const deleted = await streamingService.deleteSession('non-existent');
      expect(deleted).toBe(false);
    });

    it('should count active sessions', async () => {
      const session1 = await streamingService.createSession(testPassportId, 'partner1', 1024, testCostPerByte);
      const session2 = await streamingService.createSession(testPassportId, 'partner2', 1024, testCostPerByte);

      expect(await streamingService.getActiveSessionCount()).toBe(2);

      // Complete one session
      expect(await streamingService.completeSession(session1.id)).toBe(true);
      expect(await streamingService.getActiveSessionCount()).toBe(1);

      // Fail one session
      expect(await streamingService.failSession(session2.id, 'boom')).toBe(true);
      expect(await streamingService.getActiveSessionCount()).toBe(0);
    });

    it('should pause, resume and cancel sessions', async () => {
      const session = await streamingService.createSession(testPassportId, testPartnerId, 1024, testCostPerByte);

      expect(await streamingService.resumeSession(session.id)).toBe(false); // not paused
      expect(await streamingService.pauseSession(session.id)).toBe(true);
      expect((await streamingService.getSession(session.id))?.status).toBe('paused');
      await expect(streamingService.processChunk(session.id, 0, Buffer.from('x'))).rejects.toThrow(
        'Session is paused'
      );
      expect(await streamingService.resumeSession(session.id)).toBe(true);
      expect(await streamingService.cancelSession(session.id)).toBe(true);
      expect((await streamingService.getSession(session.id))?.status).toBe('cancelled');
      expect(await streamingService.cancelSession(session.id)).toBe(false);
      expect(await streamingService.pauseSession('missing')).toBe(false);
    });

    it('should expire sessions after their TTL', async () => {
      let now = Date.now();
      const storage = new MemoryStorage({ now: () => now });
      const service = new StreamingService({ storage, sessionTtlSeconds: 60 });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);

      const session = await service.createSession(testPassportId, testPartnerId, 1024, testCostPerByte);
      expect(await service.getSession(session.id)).toBeDefined();

      now += 61 * 1000;
      vi.setSystemTime(now);
      expect(await service.getSession(session.id)).toBeUndefined();
      expect(await service.cleanupExpiredSessions()).toBe(0);
      await service.close();
    });

    it('should summarise streaming activity', async () => {
      const session = await streamingService.createSession(testPassportId, testPartnerId, 100, testCostPerByte, 50);
      await streamingService.streamLargeFile(session.id, Buffer.alloc(100, 'H'));
      await streamingService.createSession(testPassportId, 'partner2', 100, testCostPerByte);

      const stats = await streamingService.getStreamingStats(testPassportId);
      expect(stats.totalSessions).toBe(2);
      expect(stats.activeSessions).toBe(1);
      expect(stats.completedSessions).toBe(1);
      expect(stats.totalBytes).toBe('100');
      expect(stats.totalCost).toBe((100n * BigInt(testCostPerByte)).toString());
      expect(stats.averageSessionSize).toBe('50');

      const global = await streamingService.getStreamingStats();
      expect(global.totalSessions).toBe(2);
      const partner2 = await streamingService.getStreamingStats(undefined, 'partner2');
      expect(partner2.totalSessions).toBe(1);
    });
  });

  describe('Chunking Transform Stream', () => {
    it('should create chunking transform for valid session', async () => {
      const session = await streamingService.createSession(testPassportId, testPartnerId, 1024, testCostPerByte);
      const transform = await streamingService.createChunkingTransform(session.id);

      expect(transform).toBeDefined();
      expect(typeof transform.write).toBe('function');
      expect(typeof transform.end).toBe('function');
    });

    it('should fail for invalid session ID', async () => {
      await expect(streamingService.createChunkingTransform('invalid-session')).rejects.toThrow(
        'Session not found: invalid-session'
      );
    });
  });
});
