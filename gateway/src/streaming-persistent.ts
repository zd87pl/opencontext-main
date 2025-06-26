/**
 * Persistent streaming service using storage adapter
 */

import { StreamingSession, ChunkRecord } from './types.js';
import { StorageAdapter, createStorageAdapter, StorageConfig } from './storage.js';
import { ethers } from 'ethers';

export class PersistentStreamingService {
  private storage: StorageAdapter;

  constructor(storageConfig?: StorageConfig) {
    this.storage = createStorageAdapter(storageConfig);
  }

  async createSession(
    passportId: string,
    partnerId: string,
    totalSize: number,
    costPerByte: string,
    chunkSize: number = 1024 * 1024 // 1MB default
  ): Promise<StreamingSession> {
    const session: StreamingSession = {
      id: this.generateSessionId(),
      passportId,
      partnerId,
      totalSize,
      costPerByte,
      chunkSize,
      downloadedBytes: 0,
      totalCost: '0',
      status: 'active',
      createdAt: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000), // 24 hours
      chunks: []
    };

    // Store session with TTL
    const sessionKey = `streaming:session:${session.id}`;
    await this.storage.set(sessionKey, JSON.stringify(session), 24 * 60 * 60); // 24 hours

    // Add to passport index
    const passportKey = `streaming:passport:${passportId}`;
    await this.storage.hset(passportKey, session.id, session.createdAt.toString());
    await this.storage.expire(passportKey, 7 * 24 * 60 * 60); // 7 days

    // Add to partner index
    const partnerKey = `streaming:partner:${partnerId}`;
    await this.storage.hset(partnerKey, session.id, session.createdAt.toString());
    await this.storage.expire(partnerKey, 7 * 24 * 60 * 60); // 7 days

    return session;
  }

  async getSession(sessionId: string): Promise<StreamingSession | null> {
    const sessionKey = `streaming:session:${sessionId}`;
    const data = await this.storage.get(sessionKey);
    
    if (!data) return null;
    
    const session: StreamingSession = JSON.parse(data);
    
    // Check if expired
    if (Date.now() > session.expiresAt) {
      await this.deleteSession(sessionId);
      return null;
    }
    
    return session;
  }

  async processChunk(
    sessionId: string,
    chunkIndex: number,
    chunkData: Buffer,
    metadata?: Record<string, any>
  ): Promise<{ success: boolean; cost: string; totalCost: string }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found or expired');
    }

    if (session.status !== 'active') {
      throw new Error(`Session is ${session.status}`);
    }

    const chunkSize = chunkData.length;
    const chunkCost = (BigInt(session.costPerByte) * BigInt(chunkSize)).toString();

    const chunk: ChunkRecord = {
      index: chunkIndex,
      size: chunkSize,
      cost: chunkCost,
      processedAt: Date.now(),
      metadata
    };

    // Update session
    session.chunks.push(chunk);
    session.downloadedBytes += chunkSize;
    session.totalCost = (BigInt(session.totalCost) + BigInt(chunkCost)).toString();

    // Mark as completed if all bytes downloaded
    if (session.downloadedBytes >= session.totalSize) {
      session.status = 'completed';
      session.completedAt = Date.now();
    }

    // Store updated session
    const sessionKey = `streaming:session:${session.id}`;
    await this.storage.set(sessionKey, JSON.stringify(session), 24 * 60 * 60);

    // Store chunk data separately for potential replay/verification
    const chunkKey = `streaming:chunk:${sessionId}:${chunkIndex}`;
    await this.storage.set(chunkKey, chunkData.toString('base64'), 60 * 60); // 1 hour TTL

    return {
      success: true,
      cost: chunkCost,
      totalCost: session.totalCost
    };
  }

  async getSessionsByPassport(passportId: string, limit: number = 50): Promise<StreamingSession[]> {
    const passportKey = `streaming:passport:${passportId}`;
    const sessionIds = await this.storage.hgetall(passportKey);
    
    const sessions: StreamingSession[] = [];
    const sortedEntries = Object.entries(sessionIds)
      .sort(([, a], [, b]) => parseInt(b) - parseInt(a))
      .slice(0, limit);

    for (const [sessionId] of sortedEntries) {
      const session = await this.getSession(sessionId);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  async getSessionsByPartner(partnerId: string, limit: number = 50): Promise<StreamingSession[]> {
    const partnerKey = `streaming:partner:${partnerId}`;
    const sessionIds = await this.storage.hgetall(partnerKey);
    
    const sessions: StreamingSession[] = [];
    const sortedEntries = Object.entries(sessionIds)
      .sort(([, a], [, b]) => parseInt(b) - parseInt(a))
      .slice(0, limit);

    for (const [sessionId] of sortedEntries) {
      const session = await this.getSession(sessionId);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  async pauseSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session || session.status !== 'active') {
      return false;
    }

    session.status = 'paused';
    session.pausedAt = Date.now();

    const sessionKey = `streaming:session:${session.id}`;
    await this.storage.set(sessionKey, JSON.stringify(session), 24 * 60 * 60);

    return true;
  }

  async resumeSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session || session.status !== 'paused') {
      return false;
    }

    session.status = 'active';
    session.resumedAt = Date.now();

    const sessionKey = `streaming:session:${session.id}`;
    await this.storage.set(sessionKey, JSON.stringify(session), 24 * 60 * 60);

    return true;
  }

  async cancelSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return false;
    }

    session.status = 'cancelled';
    session.cancelledAt = Date.now();

    const sessionKey = `streaming:session:${session.id}`;
    await this.storage.set(sessionKey, JSON.stringify(session), 24 * 60 * 60);

    return true;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return false;
    }

    // Delete session
    const sessionKey = `streaming:session:${sessionId}`;
    await this.storage.del(sessionKey);

    // Remove from indexes
    const passportKey = `streaming:passport:${session.passportId}`;
    await this.storage.hdel(passportKey, sessionId);

    const partnerKey = `streaming:partner:${session.partnerId}`;
    await this.storage.hdel(partnerKey, sessionId);

    // Delete chunk data
    for (let i = 0; i < session.chunks.length; i++) {
      const chunkKey = `streaming:chunk:${sessionId}:${i}`;
      await this.storage.del(chunkKey);
    }

    return true;
  }

  async getStreamingStats(
    passportId?: string,
    partnerId?: string,
    days: number = 30
  ): Promise<{
    totalSessions: number;
    activeSessions: number;
    completedSessions: number;
    totalBytes: string;
    totalCost: string;
    averageSessionSize: string;
  }> {
    let totalSessions = 0;
    let activeSessions = 0;
    let completedSessions = 0;
    let totalBytes = BigInt(0);
    let totalCost = BigInt(0);

    const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);

    if (passportId) {
      const sessions = await this.getSessionsByPassport(passportId, 1000);
      for (const session of sessions) {
        if (session.createdAt >= cutoffTime) {
          totalSessions++;
          if (session.status === 'active') activeSessions++;
          if (session.status === 'completed') completedSessions++;
          totalBytes += BigInt(session.downloadedBytes);
          totalCost += BigInt(session.totalCost);
        }
      }
    } else if (partnerId) {
      const sessions = await this.getSessionsByPartner(partnerId, 1000);
      for (const session of sessions) {
        if (session.createdAt >= cutoffTime) {
          totalSessions++;
          if (session.status === 'active') activeSessions++;
          if (session.status === 'completed') completedSessions++;
          totalBytes += BigInt(session.downloadedBytes);
          totalCost += BigInt(session.totalCost);
        }
      }
    } else {
      // Get all sessions - this is expensive, consider pagination in production
      for await (const sessionKey of this.storage.scan('streaming:session:*')) {
        const data = await this.storage.get(sessionKey);
        if (data) {
          const session: StreamingSession = JSON.parse(data);
          if (session.createdAt >= cutoffTime) {
            totalSessions++;
            if (session.status === 'active') activeSessions++;
            if (session.status === 'completed') completedSessions++;
            totalBytes += BigInt(session.downloadedBytes);
            totalCost += BigInt(session.totalCost);
          }
        }
      }
    }

    const averageSessionSize = totalSessions > 0 
      ? (totalBytes / BigInt(totalSessions)).toString()
      : '0';

    return {
      totalSessions,
      activeSessions,
      completedSessions,
      totalBytes: totalBytes.toString(),
      totalCost: totalCost.toString(),
      averageSessionSize
    };
  }

  async cleanupExpiredSessions(): Promise<number> {
    let cleanedCount = 0;
    const now = Date.now();

    for await (const sessionKey of this.storage.scan('streaming:session:*')) {
      const data = await this.storage.get(sessionKey);
      if (data) {
        const session: StreamingSession = JSON.parse(data);
        if (now > session.expiresAt) {
          await this.deleteSession(session.id);
          cleanedCount++;
        }
      }
    }

    return cleanedCount;
  }

  private generateSessionId(): string {
    return `stream_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async cleanup(): Promise<void> {
    await this.storage.close();
  }
}