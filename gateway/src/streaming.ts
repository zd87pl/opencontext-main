/**
 * Chunked, per-byte-metered large-file transfers.
 *
 * A session is a quote (`totalSize * costPerByte`) plus a ledger of processed chunks. Data flows
 * through `createChunkingTransform`, which splits an input stream into fixed-size chunks, records
 * each one (size, cost, keccak256 checksum) against the session and emits it downstream. Chunk
 * payloads are retained briefly so a client can re-fetch a chunk that failed in transit.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ethers } from 'ethers';
import type { ChunkRecord, StreamingSession } from './types.js';
import { MemoryStorage, type StorageAdapter } from './storage.js';

/** A chunk as it travels through the transform / over the wire. */
export interface StreamChunk {
  id: string;
  sequence: number;
  data: Buffer;
  size: number;
  /** keccak256 of `data`. */
  checksum: string;
  timestamp: number;
  /** True for the terminal chunk of a stream, so receivers can detect a truncated transfer. */
  last: boolean;
}

export interface StreamingOptions {
  storage?: StorageAdapter;
  defaultChunkSize?: number;
  /** Session retention in seconds. */
  sessionTtlSeconds?: number;
  /** Retention of chunk payloads in seconds. */
  chunkTtlSeconds?: number;
}

export interface StreamingStats {
  totalSessions: number;
  activeSessions: number;
  completedSessions: number;
  totalBytes: string;
  totalCost: string;
  averageSessionSize: string;
}

const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_CHUNK_TTL_SECONDS = 60 * 60;

export class StreamingService {
  private readonly storage: StorageAdapter;
  private readonly defaultChunkSize: number;
  private readonly sessionTtl: number;
  private readonly chunkTtl: number;

  constructor(options: StreamingOptions = {}) {
    this.storage = options.storage ?? new MemoryStorage();
    this.defaultChunkSize = options.defaultChunkSize ?? DEFAULT_CHUNK_SIZE;
    this.sessionTtl = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    this.chunkTtl = options.chunkTtlSeconds ?? DEFAULT_CHUNK_TTL_SECONDS;
  }

  async createSession(
    passportId: string,
    partnerId: string,
    totalSize: number,
    costPerByte: string,
    chunkSize?: number
  ): Promise<StreamingSession> {
    if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
      throw new RangeError(`totalSize must be a non-negative integer, got ${totalSize}`);
    }
    const actualChunkSize = chunkSize ?? this.defaultChunkSize;
    if (!Number.isSafeInteger(actualChunkSize) || actualChunkSize <= 0) {
      throw new RangeError(`chunkSize must be a positive integer, got ${actualChunkSize}`);
    }
    const perByte = BigInt(costPerByte);
    if (perByte < 0n) {
      throw new RangeError('costPerByte must not be negative');
    }

    const now = Date.now();
    const session: StreamingSession = {
      id: `stream_${randomUUID()}`,
      passportId,
      partnerId,
      totalSize,
      chunkSize: actualChunkSize,
      costPerByte,
      totalCost: (BigInt(totalSize) * perByte).toString(),
      accruedCost: '0',
      downloadedBytes: 0,
      status: 'active',
      startTime: now,
      expiresAt: now + this.sessionTtl * 1000,
      chunks: [],
    };

    await this.saveSession(session);
    await this.storage.hset(`streaming:passport:${passportId}`, session.id, now.toString());
    await this.storage.hset(`streaming:partner:${partnerId}`, session.id, now.toString());
    return session;
  }

  private async saveSession(session: StreamingSession): Promise<void> {
    const ttl = Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000));
    await this.storage.set(`streaming:session:${session.id}`, JSON.stringify(session), ttl);
  }

  async getSession(sessionId: string): Promise<StreamingSession | undefined> {
    const raw = await this.storage.get(`streaming:session:${sessionId}`);
    if (!raw) return undefined;
    const session = JSON.parse(raw) as StreamingSession;
    if (Date.now() > session.expiresAt) {
      await this.deleteSession(sessionId);
      return undefined;
    }
    return session;
  }

  private async requireSession(sessionId: string): Promise<StreamingSession> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  /**
   * Record one chunk against an active session: charge it, append the ledger entry, retain the
   * payload for a short time, and complete the session once the declared size has been served.
   */
  async processChunk(
    sessionId: string,
    index: number,
    data: Buffer
  ): Promise<{ cost: string; accruedCost: string; session: StreamingSession }> {
    const session = await this.requireSession(sessionId);
    if (session.status !== 'active') {
      throw new Error(`Session is ${session.status}`);
    }

    const cost = (BigInt(session.costPerByte) * BigInt(data.length)).toString();
    const record: ChunkRecord = {
      index,
      size: data.length,
      cost,
      checksum: ethers.keccak256(data),
      processedAt: Date.now(),
    };

    session.chunks.push(record);
    session.downloadedBytes += data.length;
    session.accruedCost = (BigInt(session.accruedCost) + BigInt(cost)).toString();

    await this.saveSession(session);
    await this.storage.set(
      `streaming:chunk:${sessionId}:${index}`,
      data.toString('base64'),
      this.chunkTtl
    );

    return { cost, accruedCost: session.accruedCost, session };
  }

  /** Retained payload of a processed chunk, if it has not expired yet. */
  async getChunkData(sessionId: string, index: number): Promise<Buffer | undefined> {
    const raw = await this.storage.get(`streaming:chunk:${sessionId}:${index}`);
    return raw ? Buffer.from(raw, 'base64') : undefined;
  }

  /**
   * A Transform that splits bytes into `session.chunkSize` pieces, records each against the
   * session and emits `StreamChunk` objects. The final piece is held back until the input ends so
   * it can be flagged `last`.
   */
  async createChunkingTransform(sessionId: string): Promise<Transform> {
    const session = await this.requireSession(sessionId);
    const chunkSize = session.chunkSize;
    let buffer = Buffer.alloc(0);
    let sequence = 0;

    const emit = async (transform: Transform, data: Buffer, last: boolean): Promise<void> => {
      const index = sequence++;
      await this.processChunk(sessionId, index, data);
      const chunk: StreamChunk = {
        id: ethers.hexlify(randomBytes(8)),
        sequence: index,
        data,
        size: data.length,
        checksum: ethers.keccak256(data),
        timestamp: Date.now(),
        last,
      };
      transform.push(chunk);
    };

    const markFailed = async (error: unknown): Promise<void> => {
      await this.failSession(sessionId, error instanceof Error ? error.message : String(error)).catch(
        () => undefined
      );
    };
    const complete = async (): Promise<void> => {
      await this.completeSession(sessionId);
    };

    const transform = new Transform({
      readableObjectMode: true,
      transform(chunk: Buffer, _encoding, callback) {
        buffer = Buffer.concat([buffer, chunk]);
        const run = async () => {
          while (buffer.length > chunkSize) {
            const piece = buffer.subarray(0, chunkSize);
            buffer = buffer.subarray(chunkSize);
            await emit(this, piece, false);
          }
        };
        run().then(
          () => callback(),
          (error: unknown) => markFailed(error).then(() => callback(error as Error))
        );
      },
      flush(callback) {
        const run = async () => {
          if (buffer.length > 0) {
            const piece = buffer;
            buffer = Buffer.alloc(0);
            await emit(this, piece, true);
          }
          await complete();
        };
        run().then(
          () => callback(),
          (error: unknown) => markFailed(error).then(() => callback(error as Error))
        );
      },
    });

    // A failing source destroys the transform without running its callbacks (e.g. via pipeline).
    transform.on('error', (error) => void markFailed(error));
    return transform;
  }

  /** Pipe a Buffer, string or Readable through the chunking transform and collect the chunks. */
  async streamLargeFile(
    sessionId: string,
    dataSource: Readable | Buffer | string
  ): Promise<StreamChunk[]> {
    const transform = await this.createChunkingTransform(sessionId);
    const source: Readable = Buffer.isBuffer(dataSource)
      ? Readable.from(dataSource)
      : typeof dataSource === 'string'
        ? Readable.from(Buffer.from(dataSource))
        : dataSource;

    const chunks: StreamChunk[] = [];
    const collector = new Writable({
      objectMode: true,
      write(chunk: StreamChunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });

    try {
      await pipeline(source, transform, collector);
    } catch (error) {
      // Ensure the failure is persisted before the caller observes the rejection.
      await this.failSession(sessionId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    return chunks;
  }

  /** Serialise `StreamChunk` objects as newline-delimited JSON with base64 payloads. */
  static toNdjson(): Transform {
    return new Transform({
      writableObjectMode: true,
      transform(chunk: StreamChunk, _encoding, callback) {
        callback(null, JSON.stringify({ ...chunk, data: chunk.data.toString('base64') }) + '\n');
      },
    });
  }

  async getSessionsByPassport(passportId: string, limit = 50): Promise<StreamingSession[]> {
    return this.loadIndexed(`streaming:passport:${passportId}`, limit);
  }

  async getSessionsByPartner(partnerId: string, limit = 50): Promise<StreamingSession[]> {
    return this.loadIndexed(`streaming:partner:${partnerId}`, limit);
  }

  /** Newest first; index entries whose session has expired are pruned on the way. */
  private async loadIndexed(indexKey: string, limit: number): Promise<StreamingSession[]> {
    const entries = Object.entries(await this.storage.hgetall(indexKey)).sort(
      ([, a], [, b]) => Number(b) - Number(a)
    );
    const sessions: StreamingSession[] = [];
    for (const [sessionId] of entries) {
      const session = await this.getSession(sessionId);
      if (session) {
        sessions.push(session);
      } else {
        await this.storage.hdel(indexKey, sessionId);
      }
      if (sessions.length >= limit) break;
    }
    return sessions.sort((a, b) => b.startTime - a.startTime);
  }

  private async transition(
    sessionId: string,
    from: StreamingSession['status'][],
    apply: (session: StreamingSession, now: number) => void
  ): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session || !from.includes(session.status)) return false;
    apply(session, Date.now());
    await this.saveSession(session);
    return true;
  }

  async pauseSession(sessionId: string): Promise<boolean> {
    return this.transition(sessionId, ['active'], (s, now) => {
      s.status = 'paused';
      s.pausedAt = now;
    });
  }

  async resumeSession(sessionId: string): Promise<boolean> {
    return this.transition(sessionId, ['paused'], (s, now) => {
      s.status = 'active';
      s.resumedAt = now;
    });
  }

  async completeSession(sessionId: string): Promise<boolean> {
    return this.transition(sessionId, ['active', 'paused'], (s, now) => {
      s.status = 'completed';
      s.endTime = now;
    });
  }

  async cancelSession(sessionId: string): Promise<boolean> {
    return this.transition(sessionId, ['active', 'paused'], (s, now) => {
      s.status = 'cancelled';
      s.cancelledAt = now;
      s.endTime = now;
    });
  }

  async failSession(sessionId: string, error: string): Promise<boolean> {
    return this.transition(sessionId, ['active', 'paused'], (s, now) => {
      s.status = 'failed';
      s.error = error;
      s.endTime = now;
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const raw = await this.storage.get(`streaming:session:${sessionId}`);
    if (!raw) return false;
    const session = JSON.parse(raw) as StreamingSession;

    await this.storage.del(`streaming:session:${sessionId}`);
    await this.storage.hdel(`streaming:passport:${session.passportId}`, sessionId);
    await this.storage.hdel(`streaming:partner:${session.partnerId}`, sessionId);
    for (const chunk of session.chunks) {
      await this.storage.del(`streaming:chunk:${sessionId}:${chunk.index}`);
    }
    return true;
  }

  private async *allSessions(): AsyncGenerator<StreamingSession> {
    for await (const key of this.storage.scan('streaming:session:*')) {
      const raw = await this.storage.get(key);
      if (raw) yield JSON.parse(raw) as StreamingSession;
    }
  }

  async getActiveSessionCount(): Promise<number> {
    let count = 0;
    for await (const session of this.allSessions()) {
      if (session.status === 'active' && Date.now() <= session.expiresAt) count++;
    }
    return count;
  }

  async getStreamingStats(passportId?: string, partnerId?: string, days = 30): Promise<StreamingStats> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let sessions: StreamingSession[];
    if (passportId) {
      sessions = await this.getSessionsByPassport(passportId, Number.MAX_SAFE_INTEGER);
    } else if (partnerId) {
      sessions = await this.getSessionsByPartner(partnerId, Number.MAX_SAFE_INTEGER);
    } else {
      sessions = [];
      for await (const session of this.allSessions()) sessions.push(session);
    }

    let totalSessions = 0;
    let activeSessions = 0;
    let completedSessions = 0;
    let totalBytes = 0n;
    let totalCost = 0n;
    for (const session of sessions) {
      if (session.startTime < cutoff) continue;
      totalSessions++;
      if (session.status === 'active') activeSessions++;
      if (session.status === 'completed') completedSessions++;
      totalBytes += BigInt(session.downloadedBytes);
      totalCost += BigInt(session.accruedCost);
    }

    return {
      totalSessions,
      activeSessions,
      completedSessions,
      totalBytes: totalBytes.toString(),
      totalCost: totalCost.toString(),
      averageSessionSize: totalSessions > 0 ? (totalBytes / BigInt(totalSessions)).toString() : '0',
    };
  }

  async cleanupExpiredSessions(): Promise<number> {
    let cleaned = 0;
    const now = Date.now();
    for await (const session of this.allSessions()) {
      if (now > session.expiresAt && (await this.deleteSession(session.id))) cleaned++;
    }
    return cleaned;
  }

  calculateChunkCost(chunk: Pick<StreamChunk, 'size'>, costPerByte: string): string {
    return (BigInt(chunk.size) * BigInt(costPerByte)).toString();
  }

  /** A chunk is valid when its declared size matches its payload and the checksum verifies. */
  validateChunk(chunk: StreamChunk): boolean {
    if (!Buffer.isBuffer(chunk.data) || chunk.data.length !== chunk.size) {
      return false;
    }
    return ethers.keccak256(chunk.data) === chunk.checksum;
  }

  /**
   * Reassemble a complete chunk set. Throws when a sequence number is missing, when the terminal
   * (`last`) chunk is absent (a truncated transfer) or when a checksum does not verify.
   */
  reconstructFromChunks(chunks: StreamChunk[]): Buffer {
    if (chunks.length === 0) return Buffer.alloc(0);
    const sorted = [...chunks].sort((a, b) => a.sequence - b.sequence);

    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].sequence !== i) {
        throw new Error(`Missing chunk at sequence ${i}`);
      }
      if (sorted[i].last && i !== sorted.length - 1) {
        throw new Error(`Unexpected terminal chunk at sequence ${i}`);
      }
    }
    if (!sorted[sorted.length - 1].last) {
      throw new Error(`Missing chunk at sequence ${sorted.length} (stream is truncated)`);
    }
    for (let i = 0; i < sorted.length; i++) {
      if (!this.validateChunk(sorted[i])) {
        throw new Error(`Invalid checksum for chunk ${i}`);
      }
    }

    return Buffer.concat(sorted.map((chunk) => chunk.data));
  }

  async close(): Promise<void> {
    await this.storage.close();
  }
}
