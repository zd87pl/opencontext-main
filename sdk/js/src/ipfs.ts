/**
 * IPFS integration for off-chain context storage.
 *
 * Talks to a Kubo (go-ipfs) node over its HTTP RPC API through
 * `kubo-rpc-client`, the maintained successor of the deprecated
 * `ipfs-http-client`. The default endpoint is a local node at
 * http://127.0.0.1:5001; pass `url` to target a remote node or a pinning
 * service that speaks the Kubo RPC API.
 */

import { create, type KuboRPCClient } from 'kubo-rpc-client';
import { ContextCrypto } from './crypto.js';
import { getErrorMessage } from './errors.js';
import { OpenContextError, SDKError } from './types.js';

export interface IPFSConfig {
  /** Kubo RPC API endpoint. Defaults to `http://127.0.0.1:5001`. */
  url?: string;
  /** Per-request timeout in milliseconds. Defaults to 60 000. */
  timeout?: number;
  /** Pin content when adding it so the node keeps it. Defaults to `true`. */
  pin?: boolean;
}

export interface IPFSMetadata {
  /** CIDv1 of the stored content. */
  hash: string;
  /** Size in bytes as stored (ciphertext size when encrypted). */
  size: number;
  /** Local wall-clock time the content was added, in ms since the epoch. */
  timestamp: number;
  /** Whether the stored content is AES-256-GCM ciphertext. */
  encrypted: boolean;
}

export interface IPFSStats {
  hash: string;
  size: number;
  cumulativeSize: number;
  blocks: number;
  type: 'file' | 'directory';
}

/** Manifest written by {@link IPFSService.storeChunked}. */
export interface ChunkManifest {
  chunks: string[];
  /** Maximum chunk length in UTF-16 code units. */
  chunkSize: number;
  /** UTF-8 byte length of the whole payload. */
  totalSize: number;
  encrypted: boolean;
  timestamp: number;
}

const DEFAULT_URL = 'http://127.0.0.1:5001';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_GATEWAY = 'https://ipfs.io';
const DEFAULT_CHUNK_SIZE = 1024 * 1024;

export class IPFSService {
  private readonly client: KuboRPCClient;
  private readonly config: Required<IPFSConfig>;

  constructor(config: IPFSConfig = {}) {
    this.config = {
      url: config.url ?? DEFAULT_URL,
      timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
      pin: config.pin ?? true,
    };
    this.client = create({ url: this.config.url, timeout: this.config.timeout });
  }

  /**
   * Store a string on IPFS, encrypting it first when a password is given.
   */
  async storeContext(data: string, encryptionPassword?: string): Promise<IPFSMetadata> {
    const encrypted = Boolean(encryptionPassword);
    const payload = encryptionPassword
      ? await ContextCrypto.encrypt(data, encryptionPassword)
      : data;

    return this.rpc('Failed to store context on IPFS', async () => {
      const result = await this.client.add(payload, this.addOptions());
      return {
        hash: result.cid.toString(),
        size: result.size,
        timestamp: Date.now(),
        encrypted,
      };
    });
  }

  /**
   * Fetch content by CID. When a password is given the content must be
   * ciphertext produced by {@link storeContext}; a wrong password throws
   * rather than returning unreadable bytes.
   */
  async getContext(hash: string, encryptionPassword?: string): Promise<string> {
    const data = await this.rpc('Failed to retrieve context from IPFS', async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of this.client.cat(hash, { timeout: this.config.timeout })) {
        chunks.push(chunk);
      }
      return new TextDecoder().decode(Buffer.concat(chunks));
    });

    return encryptionPassword ? ContextCrypto.decrypt(data, encryptionPassword) : data;
  }

  /**
   * Pin content so the node keeps it through garbage collection.
   */
  async pinContent(hash: string): Promise<void> {
    await this.rpc('Failed to pin content', () => this.client.pin.add(hash));
  }

  /**
   * Unpin content so the node may garbage-collect it.
   */
  async unpinContent(hash: string): Promise<void> {
    await this.rpc('Failed to unpin content', () => this.client.pin.rm(hash));
  }

  /**
   * Size and block statistics for stored content.
   */
  async getStats(hash: string): Promise<IPFSStats> {
    return this.rpc('Failed to get content stats', async () => {
      const stats = await this.client.files.stat(`/ipfs/${hash}`);
      return {
        hash,
        size: stats.size,
        cumulativeSize: stats.cumulativeSize,
        blocks: stats.blocks,
        type: stats.type,
      };
    });
  }

  /**
   * CIDs of everything pinned on the node.
   */
  async listPinned(): Promise<string[]> {
    return this.rpc('Failed to list pinned content', async () => {
      const pins: string[] = [];
      for await (const pin of this.client.pin.ls()) {
        pins.push(pin.cid.toString());
      }
      return pins;
    });
  }

  /**
   * Whether the node can resolve the given CID.
   */
  async exists(hash: string): Promise<boolean> {
    try {
      await this.client.files.stat(`/ipfs/${hash}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Public HTTP gateway URL for a CID. `gateway` may be given with or without
   * a trailing `/ipfs` path segment.
   */
  getGatewayUrl(hash: string, gateway: string = DEFAULT_GATEWAY): string {
    const base = gateway.replace(/\/+$/, '').replace(/\/ipfs$/, '');
    return `${base}/ipfs/${hash}`;
  }

  /**
   * Serialise a value as JSON and store it.
   */
  async storeJSON(data: unknown, encryptionPassword?: string): Promise<IPFSMetadata> {
    return this.storeContext(JSON.stringify(data), encryptionPassword);
  }

  /**
   * Fetch and parse JSON content.
   */
  async getJSON<T = unknown>(hash: string, encryptionPassword?: string): Promise<T> {
    const json = await this.getContext(hash, encryptionPassword);
    try {
      return JSON.parse(json) as T;
    } catch (error) {
      throw new OpenContextError(
        SDKError.IPFS_ERROR,
        `Failed to parse JSON data: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * Store large text as fixed-size chunks plus a manifest listing them.
   *
   * Chunk boundaries never split a UTF-16 surrogate pair, so multi-byte
   * characters survive the round trip. `chunkSize` is measured in UTF-16
   * code units. Binary input must be valid UTF-8.
   */
  async storeChunked(
    data: string | Uint8Array,
    chunkSize: number = DEFAULT_CHUNK_SIZE,
    encryptionPassword?: string
  ): Promise<{ manifestHash: string; chunks: string[]; totalSize: number }> {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new OpenContextError(SDKError.IPFS_ERROR, 'chunkSize must be a positive integer');
    }

    const text = typeof data === 'string' ? data : decodeUtf8(data);
    const totalSize = Buffer.byteLength(text, 'utf8');
    const chunks: string[] = [];

    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + chunkSize, text.length);
      // A low surrogate at the boundary belongs to the high surrogate before it.
      if (end < text.length && isLowSurrogate(text.charCodeAt(end))) {
        end += 1;
      }
      const chunk = text.slice(start, end);
      start = end;

      const payload = encryptionPassword
        ? await ContextCrypto.encrypt(chunk, encryptionPassword)
        : chunk;
      const result = await this.rpc('Failed to store chunk', () =>
        this.client.add(payload, this.addOptions())
      );
      chunks.push(result.cid.toString());
    }

    const manifest: ChunkManifest = {
      chunks,
      chunkSize,
      totalSize,
      encrypted: Boolean(encryptionPassword),
      timestamp: Date.now(),
    };
    const manifestResult = await this.rpc('Failed to store chunk manifest', () =>
      this.client.add(JSON.stringify(manifest), this.addOptions())
    );

    return { manifestHash: manifestResult.cid.toString(), chunks, totalSize };
  }

  /**
   * Reassemble content stored by {@link storeChunked}.
   */
  async getChunked(manifestHash: string, encryptionPassword?: string): Promise<string> {
    const manifest = await this.getJSON<Partial<ChunkManifest>>(manifestHash);
    if (
      !Array.isArray(manifest.chunks) ||
      !manifest.chunks.every((cid) => typeof cid === 'string')
    ) {
      throw new OpenContextError(SDKError.IPFS_ERROR, `Invalid chunk manifest at ${manifestHash}`);
    }
    if (manifest.encrypted && !encryptionPassword) {
      throw new OpenContextError(
        SDKError.ENCRYPTION_FAILED,
        'Chunked content is encrypted but no password was provided'
      );
    }

    const parts: string[] = [];
    for (const cid of manifest.chunks) {
      parts.push(await this.getContext(cid, manifest.encrypted ? encryptionPassword : undefined));
    }
    return parts.join('');
  }

  private addOptions() {
    return { pin: this.config.pin, cidVersion: 1 as const, hashAlg: 'sha2-256' };
  }

  private async rpc<T>(action: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof OpenContextError) {
        throw error;
      }
      throw new OpenContextError(SDKError.IPFS_ERROR, `${action}: ${getErrorMessage(error)}`);
    }
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new OpenContextError(SDKError.IPFS_ERROR, 'Binary input must be valid UTF-8 text');
  }
}
