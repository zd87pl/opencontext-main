/**
 * Persistent storage layer using Redis
 */

import { createClient, RedisClientType } from 'redis';
import { EventEmitter } from 'events';

export interface StorageConfig {
  redis?: {
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    db?: number;
  };
  keyPrefix?: string;
  ttl?: number; // Default TTL in seconds
}

export interface StorageAdapter extends EventEmitter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  keys(pattern: string): Promise<string[]>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, field: string): Promise<void>;
  incr(key: string): Promise<number>;
  expire(key: string, ttl: number): Promise<void>;
  scan(pattern: string, count?: number): AsyncGenerator<string>;
  close(): Promise<void>;
}

/**
 * Redis storage adapter
 */
export class RedisStorage extends EventEmitter implements StorageAdapter {
  private client: RedisClientType;
  private config: StorageConfig;
  private connected: boolean = false;

  constructor(config: StorageConfig = {}) {
    super();
    this.config = config;
    
    // Create Redis client
    this.client = createClient({
      url: config.redis?.url || `redis://${config.redis?.host || 'localhost'}:${config.redis?.port || 6379}`,
      password: config.redis?.password,
      database: config.redis?.db || 0,
    });

    // Handle connection events
    this.client.on('error', (err) => {
      console.error('Redis Client Error:', err);
      this.emit('error', err);
    });

    this.client.on('connect', () => {
      console.log('Redis Client Connected');
      this.connected = true;
      this.emit('connect');
    });

    this.client.on('ready', () => {
      console.log('Redis Client Ready');
      this.emit('ready');
    });
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
    }
  }

  private getKey(key: string): string {
    return this.config.keyPrefix ? `${this.config.keyPrefix}:${key}` : key;
  }

  async get(key: string): Promise<string | null> {
    await this.connect();
    return this.client.get(this.getKey(key));
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    await this.connect();
    const finalTtl = ttl || this.config.ttl;
    
    if (finalTtl) {
      await this.client.set(this.getKey(key), value, { EX: finalTtl });
    } else {
      await this.client.set(this.getKey(key), value);
    }
  }

  async del(key: string): Promise<void> {
    await this.connect();
    await this.client.del(this.getKey(key));
  }

  async exists(key: string): Promise<boolean> {
    await this.connect();
    const result = await this.client.exists(this.getKey(key));
    return result > 0;
  }

  async keys(pattern: string): Promise<string[]> {
    await this.connect();
    const fullPattern = this.getKey(pattern);
    return this.client.keys(fullPattern);
  }

  async hget(key: string, field: string): Promise<string | null> {
    await this.connect();
    return this.client.hGet(this.getKey(key), field);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.connect();
    await this.client.hSet(this.getKey(key), field, value);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    await this.connect();
    return this.client.hGetAll(this.getKey(key));
  }

  async hdel(key: string, field: string): Promise<void> {
    await this.connect();
    await this.client.hDel(this.getKey(key), field);
  }

  async incr(key: string): Promise<number> {
    await this.connect();
    return this.client.incr(this.getKey(key));
  }

  async expire(key: string, ttl: number): Promise<void> {
    await this.connect();
    await this.client.expire(this.getKey(key), ttl);
  }

  async *scan(pattern: string, count: number = 100): AsyncGenerator<string> {
    await this.connect();
    const fullPattern = this.getKey(pattern);
    
    for await (const key of this.client.scanIterator({
      MATCH: fullPattern,
      COUNT: count,
    })) {
      yield key;
    }
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
      this.connected = false;
    }
  }
}

/**
 * In-memory storage adapter (for testing/development)
 */
export class MemoryStorage extends EventEmitter implements StorageAdapter {
  private data: Map<string, string> = new Map();
  private hashes: Map<string, Map<string, string>> = new Map();
  private ttls: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    super();
    setImmediate(() => {
      this.emit('connect');
      this.emit('ready');
    });
  }

  async get(key: string): Promise<string | null> {
    return this.data.get(key) || null;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    this.data.set(key, value);
    
    // Clear existing TTL
    const existingTtl = this.ttls.get(key);
    if (existingTtl) {
      clearTimeout(existingTtl);
      this.ttls.delete(key);
    }
    
    // Set new TTL
    if (ttl) {
      const timeout = setTimeout(() => {
        this.data.delete(key);
        this.ttls.delete(key);
      }, ttl * 1000);
      this.ttls.set(key, timeout);
    }
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
    const ttl = this.ttls.get(key);
    if (ttl) {
      clearTimeout(ttl);
      this.ttls.delete(key);
    }
  }

  async exists(key: string): Promise<boolean> {
    return this.data.has(key);
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(pattern.replace('*', '.*'));
    return Array.from(this.data.keys()).filter(key => regex.test(key));
  }

  async hget(key: string, field: string): Promise<string | null> {
    const hash = this.hashes.get(key);
    return hash ? hash.get(field) || null : null;
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    hash.set(field, value);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    
    const result: Record<string, string> = {};
    hash.forEach((value, field) => {
      result[field] = value;
    });
    return result;
  }

  async hdel(key: string, field: string): Promise<void> {
    const hash = this.hashes.get(key);
    if (hash) {
      hash.delete(field);
      if (hash.size === 0) {
        this.hashes.delete(key);
      }
    }
  }

  async incr(key: string): Promise<number> {
    const current = parseInt(await this.get(key) || '0', 10);
    const next = current + 1;
    await this.set(key, next.toString());
    return next;
  }

  async expire(key: string, ttl: number): Promise<void> {
    const value = this.data.get(key);
    if (value !== undefined) {
      await this.set(key, value, ttl);
    }
  }

  async *scan(pattern: string, count: number = 100): AsyncGenerator<string> {
    const keys = await this.keys(pattern);
    for (const key of keys) {
      yield key;
    }
  }

  async close(): Promise<void> {
    // Clear all timeouts
    this.ttls.forEach(timeout => clearTimeout(timeout));
    this.ttls.clear();
    this.data.clear();
    this.hashes.clear();
  }
}

/**
 * Create storage adapter based on configuration
 */
export function createStorageAdapter(config?: StorageConfig): StorageAdapter {
  if (config?.redis) {
    return new RedisStorage(config);
  }
  
  // Default to in-memory storage for development
  console.warn('Using in-memory storage. Configure Redis for production use.');
  return new MemoryStorage();
}