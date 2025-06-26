/**
 * IPFS integration for decentralized context storage
 */

import { create, IPFSHTTPClient } from 'ipfs-http-client';
import { ContextCrypto } from './crypto.js';
import { OpenContextError, SDKError } from './types.js';

export interface IPFSConfig {
  url?: string;
  timeout?: number;
  pin?: boolean;
}

export interface IPFSMetadata {
  hash: string;
  size: number;
  timestamp: number;
  encrypted: boolean;
}

export class IPFSService {
  private client: IPFSHTTPClient;
  private config: IPFSConfig;

  constructor(config: IPFSConfig = {}) {
    this.config = {
      url: config.url || 'https://ipfs.infura.io:5001',
      timeout: config.timeout || 60000,
      pin: config.pin ?? true,
      ...config
    };

    this.client = create({
      url: this.config.url,
      timeout: this.config.timeout
    });
  }

  /**
   * Store encrypted context data on IPFS
   */
  async storeContext(data: string, encryptionPassword?: string): Promise<IPFSMetadata> {
    try {
      let processedData = data;
      let encrypted = false;

      // Encrypt if password provided
      if (encryptionPassword) {
        processedData = await ContextCrypto.encrypt(data, encryptionPassword);
        encrypted = true;
      }

      // Add to IPFS
      const result = await this.client.add(processedData, {
        pin: this.config.pin,
        cidVersion: 1, // Use CIDv1 for better forward compatibility
        hashAlg: 'sha2-256'
      });

      return {
        hash: result.cid.toString(),
        size: result.size,
        timestamp: Date.now(),
        encrypted
      };
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Failed to store context on IPFS: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Retrieve context data from IPFS
   */
  async getContext(hash: string, encryptionPassword?: string): Promise<string> {
    try {
      const chunks: Uint8Array[] = [];
      
      // Get data from IPFS
      for await (const chunk of this.client.cat(hash, {
        timeout: this.config.timeout
      })) {
        chunks.push(chunk);
      }

      // Combine chunks
      const data = new TextDecoder().decode(Buffer.concat(chunks));

      // Decrypt if password provided
      if (encryptionPassword) {
        try {
          return await ContextCrypto.decrypt(data, encryptionPassword);
        } catch {
          // If decryption fails, data might not be encrypted
          return data;
        }
      }

      return data;
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Failed to retrieve context from IPFS: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Pin content to ensure it stays available
   */
  async pinContent(hash: string): Promise<void> {
    try {
      await this.client.pin.add(hash);
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Failed to pin content: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Unpin content to allow garbage collection
   */
  async unpinContent(hash: string): Promise<void> {
    try {
      await this.client.pin.rm(hash);
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Failed to unpin content: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get content stats
   */
  async getStats(hash: string): Promise<{
    hash: string;
    size: number;
    cumulativeSize: number;
    blocks: number;
    type: string;
  }> {
    try {
      const stats = await this.client.object.stat(hash);
      return {
        hash,
        size: stats.DataSize,
        cumulativeSize: stats.CumulativeSize,
        blocks: stats.NumLinks,
        type: 'dag-pb'
      };
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Failed to get content stats: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * List pinned content
   */
  async listPinned(): Promise<string[]> {
    try {
      const pins: string[] = [];
      for await (const pin of this.client.pin.ls()) {
        pins.push(pin.cid.toString());
      }
      return pins;
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Failed to list pinned content: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Check if content exists and is accessible
   */
  async exists(hash: string): Promise<boolean> {
    try {
      await this.client.object.stat(hash);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a direct gateway URL for content
   */
  getGatewayUrl(hash: string, gateway?: string): string {
    const gatewayUrl = gateway || 'https://ipfs.io/ipfs/';
    return `${gatewayUrl.replace(/\/$/, '')}/ipfs/${hash}`;
  }

  /**
   * Store JSON data with automatic serialization
   */
  async storeJSON(data: any, encryptionPassword?: string): Promise<IPFSMetadata> {
    const jsonString = JSON.stringify(data, null, 2);
    return this.storeContext(jsonString, encryptionPassword);
  }

  /**
   * Retrieve and parse JSON data
   */
  async getJSON<T = any>(hash: string, encryptionPassword?: string): Promise<T> {
    const jsonString = await this.getContext(hash, encryptionPassword);
    try {
      return JSON.parse(jsonString);
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Failed to parse JSON data: ${error instanceof Error ? error.message : 'Invalid JSON'}`
      );
    }
  }

  /**
   * Store large files in chunks with manifest
   */
  async storeChunked(
    data: string | Uint8Array, 
    chunkSize: number = 1024 * 1024, // 1MB chunks
    encryptionPassword?: string
  ): Promise<{
    manifestHash: string;
    chunks: string[];
    totalSize: number;
  }> {
    try {
      const buffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const chunks: string[] = [];
      
      // Split into chunks and store each
      for (let i = 0; i < buffer.length; i += chunkSize) {
        const chunk = buffer.slice(i, i + chunkSize);
        let chunkData = new TextDecoder().decode(chunk);
        
        if (encryptionPassword) {
          chunkData = await ContextCrypto.encrypt(chunkData, encryptionPassword);
        }
        
        const result = await this.client.add(chunkData, {
          pin: this.config.pin,
          cidVersion: 1
        });
        
        chunks.push(result.cid.toString());
      }
      
      // Create manifest
      const manifest = {
        chunks,
        chunkSize,
        totalSize: buffer.length,
        encrypted: !!encryptionPassword,
        timestamp: Date.now()
      };
      
      const manifestResult = await this.client.add(JSON.stringify(manifest), {
        pin: this.config.pin,
        cidVersion: 1
      });
      
      return {
        manifestHash: manifestResult.cid.toString(),
        chunks,
        totalSize: buffer.length
      };
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Failed to store chunked data: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Retrieve chunked data using manifest
   */
  async getChunked(manifestHash: string, encryptionPassword?: string): Promise<string> {
    try {
      // Get manifest
      const manifest = await this.getJSON<{
        chunks: string[];
        chunkSize: number;
        totalSize: number;
        encrypted: boolean;
        timestamp: number;
      }>(manifestHash);
      
      // Retrieve all chunks
      const chunkData: string[] = [];
      for (const chunkHash of manifest.chunks) {
        const chunk = await this.getContext(chunkHash, manifest.encrypted ? encryptionPassword : undefined);
        chunkData.push(chunk);
      }
      
      return chunkData.join('');
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Failed to retrieve chunked data: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}