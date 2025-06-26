import { Readable, Transform } from 'stream';
import { ethers } from 'ethers';

export interface StreamChunk {
  id: string;
  sequence: number;
  data: Buffer;
  size: number;
  checksum: string;
  timestamp: number;
}

export interface StreamSession {
  id: string;
  passportId: string;
  partnerId: string;
  totalSize: number;
  chunkSize: number;
  chunks: StreamChunk[];
  costPerByte: string;
  totalCost: string;
  startTime: number;
  endTime?: number;
  status: 'active' | 'completed' | 'failed';
}

export class StreamingService {
  private sessions: Map<string, StreamSession> = new Map();
  private readonly defaultChunkSize = 1024 * 1024; // 1MB chunks

  createSession(
    passportId: string,
    partnerId: string,
    totalSize: number,
    costPerByte: string,
    chunkSize?: number
  ): StreamSession {
    const sessionId = ethers.hexlify(ethers.randomBytes(16));
    const actualChunkSize = chunkSize || this.defaultChunkSize;
    
    const session: StreamSession = {
      id: sessionId,
      passportId,
      partnerId,
      totalSize,
      chunkSize: actualChunkSize,
      chunks: [],
      costPerByte,
      totalCost: (BigInt(totalSize) * BigInt(costPerByte)).toString(),
      startTime: Date.now(),
      status: 'active'
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  createChunkingTransform(sessionId: string): Transform {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    let buffer = Buffer.alloc(0);
    let sequence = 0;

    return new Transform({
      transform(chunk: Buffer, encoding, callback) {
        buffer = Buffer.concat([buffer, chunk]);

        while (buffer.length >= session.chunkSize) {
          const chunkData = buffer.subarray(0, session.chunkSize);
          buffer = buffer.subarray(session.chunkSize);

          const streamChunk: StreamChunk = {
            id: ethers.hexlify(ethers.randomBytes(8)),
            sequence: sequence++,
            data: chunkData,
            size: chunkData.length,
            checksum: ethers.keccak256(chunkData),
            timestamp: Date.now()
          };

          session.chunks.push(streamChunk);
          this.push(JSON.stringify(streamChunk) + '\n');
        }

        callback();
      },

      flush(callback) {
        if (buffer.length > 0) {
          const streamChunk: StreamChunk = {
            id: ethers.hexlify(ethers.randomBytes(8)),
            sequence: sequence++,
            data: buffer,
            size: buffer.length,
            checksum: ethers.keccak256(buffer),
            timestamp: Date.now()
          };

          session.chunks.push(streamChunk);
          this.push(JSON.stringify(streamChunk) + '\n');
        }

        session.status = 'completed';
        session.endTime = Date.now();
        callback();
      }
    });
  }

  async streamLargeFile(
    sessionId: string,
    dataSource: Readable | Buffer | string
  ): Promise<StreamChunk[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return new Promise((resolve, reject) => {
      let sourceStream: Readable;

      if (Buffer.isBuffer(dataSource)) {
        sourceStream = Readable.from(dataSource);
      } else if (typeof dataSource === 'string') {
        sourceStream = Readable.from(Buffer.from(dataSource));
      } else {
        sourceStream = dataSource;
      }

      const chunkingTransform = this.createChunkingTransform(sessionId);
      const chunks: StreamChunk[] = [];

      chunkingTransform.on('data', (chunk) => {
        try {
          const parsedChunk = JSON.parse(chunk.toString().trim());
          chunks.push(parsedChunk);
        } catch (error) {
          console.error('Error parsing chunk:', error);
        }
      });

      chunkingTransform.on('end', () => {
        resolve(chunks);
      });

      chunkingTransform.on('error', (error) => {
        session.status = 'failed';
        reject(error);
      });

      sourceStream.pipe(chunkingTransform);
    });
  }

  getSession(sessionId: string): StreamSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionsByPassport(passportId: string): StreamSession[] {
    return Array.from(this.sessions.values())
      .filter(session => session.passportId === passportId)
      .sort((a, b) => b.startTime - a.startTime);
  }

  calculateChunkCost(chunk: StreamChunk, costPerByte: string): string {
    return (BigInt(chunk.size) * BigInt(costPerByte)).toString();
  }

  validateChunk(chunk: StreamChunk): boolean {
    const calculatedChecksum = ethers.keccak256(chunk.data);
    return calculatedChecksum === chunk.checksum;
  }

  reconstructFromChunks(chunks: StreamChunk[]): Buffer {
    const sortedChunks = chunks.sort((a, b) => a.sequence - b.sequence);
    
    for (let i = 0; i < sortedChunks.length; i++) {
      if (sortedChunks[i].sequence !== i) {
        throw new Error(`Missing chunk at sequence ${i}`);
      }
      
      if (!this.validateChunk(sortedChunks[i])) {
        throw new Error(`Invalid checksum for chunk ${i}`);
      }
    }

    return Buffer.concat(sortedChunks.map(chunk => chunk.data));
  }

  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  getActiveSessionCount(): number {
    return Array.from(this.sessions.values())
      .filter(session => session.status === 'active').length;
  }
}