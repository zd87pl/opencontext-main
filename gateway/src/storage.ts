/**
 * Key/value storage behind the metering, streaming and billing services.
 *
 * Two adapters share one interface: `MemoryStorage` (default, single process, data lost on restart)
 * and `RedisStorage` (set `REDIS_URL`; required when running several workers).
 */

import { EventEmitter } from 'node:events';
import { createClient, type RedisClientType } from 'redis';

export interface StorageConfig {
  redis?: {
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    db?: number;
  };
  keyPrefix?: string;
  /** Default TTL in seconds applied by `set` when the caller passes none. */
  ttl?: number;
}

export interface StorageAdapter extends EventEmitter {
  readonly kind: 'memory' | 'redis';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  keys(pattern: string): Promise<string[]>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, field: string): Promise<void>;
  /**
   * Atomically add `delta` to an integer hash field and return the new value. Used for running
   * totals so that concurrent requests never lose updates (a read-modify-write would).
   */
  hincrby(key: string, field: string, delta: bigint): Promise<bigint>;
  incr(key: string): Promise<number>;
  expire(key: string, ttl: number): Promise<void>;
  scan(pattern: string, count?: number): AsyncGenerator<string>;
  close(): Promise<void>;
}

/** Convert a glob with `*` wildcards into an anchored RegExp, escaping everything else. */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Redis-backed storage. Connects lazily on first use.
 */
export class RedisStorage extends EventEmitter implements StorageAdapter {
  readonly kind = 'redis' as const;
  private readonly client: RedisClientType;
  private readonly config: StorageConfig;
  private connecting: Promise<void> | null = null;
  private connected = false;

  constructor(config: StorageConfig = {}) {
    super();
    this.config = config;

    this.client = createClient({
      url:
        config.redis?.url ??
        `redis://${config.redis?.host ?? 'localhost'}:${config.redis?.port ?? 6379}`,
      password: config.redis?.password,
      database: config.redis?.db ?? 0,
    });

    this.client.on('error', (err: Error) => {
      this.emit('error', err);
    });
    this.client.on('connect', () => this.emit('connect'));
    this.client.on('ready', () => this.emit('ready'));
  }

  /** Memoised so that concurrent first calls share one connection attempt. */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.connecting) {
      this.connecting = this.client
        .connect()
        .then(() => {
          this.connected = true;
        })
        .catch((err: unknown) => {
          this.connecting = null;
          throw err;
        });
    }
    await this.connecting;
  }

  private key(key: string): string {
    return this.config.keyPrefix ? `${this.config.keyPrefix}:${key}` : key;
  }

  private stripPrefix(fullKey: string): string {
    const prefix = this.config.keyPrefix ? `${this.config.keyPrefix}:` : '';
    return prefix && fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
  }

  async get(key: string): Promise<string | null> {
    await this.connect();
    return this.client.get(this.key(key));
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    await this.connect();
    const finalTtl = ttl ?? this.config.ttl;
    if (finalTtl) {
      await this.client.set(this.key(key), value, { EX: finalTtl });
    } else {
      await this.client.set(this.key(key), value);
    }
  }

  async del(key: string): Promise<void> {
    await this.connect();
    await this.client.del(this.key(key));
  }

  async exists(key: string): Promise<boolean> {
    await this.connect();
    return (await this.client.exists(this.key(key))) > 0;
  }

  async keys(pattern: string): Promise<string[]> {
    const found: string[] = [];
    for await (const key of this.scan(pattern)) found.push(key);
    return found;
  }

  async hget(key: string, field: string): Promise<string | null> {
    await this.connect();
    const value = await this.client.hGet(this.key(key), field);
    return value ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.connect();
    await this.client.hSet(this.key(key), field, value);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    await this.connect();
    return this.client.hGetAll(this.key(key));
  }

  async hdel(key: string, field: string): Promise<void> {
    await this.connect();
    await this.client.hDel(this.key(key), field);
  }

  /**
   * Uses HINCRBY, which is atomic server-side but limited to signed 64-bit integers
   * (about 9.2e18 wei, i.e. 9.2 units of an 18-decimal token per counter). Redis rejects an
   * increment that would overflow rather than wrapping, so the failure is loud.
   */
  async hincrby(key: string, field: string, delta: bigint): Promise<bigint> {
    await this.connect();
    const reply = await this.client.sendCommand<number | string>([
      'HINCRBY',
      this.key(key),
      field,
      delta.toString(),
    ]);
    return BigInt(reply);
  }

  async incr(key: string): Promise<number> {
    await this.connect();
    return this.client.incr(this.key(key));
  }

  async expire(key: string, ttl: number): Promise<void> {
    await this.connect();
    await this.client.expire(this.key(key), ttl);
  }

  async *scan(pattern: string, count = 100): AsyncGenerator<string> {
    await this.connect();
    for await (const fullKey of this.client.scanIterator({ MATCH: this.key(pattern), COUNT: count })) {
      yield this.stripPrefix(fullKey);
    }
  }

  async close(): Promise<void> {
    if (this.connecting) {
      await this.connecting.catch(() => undefined);
    }
    if (this.connected) {
      this.connected = false;
      this.connecting = null;
      await this.client.quit();
    }
  }
}

/**
 * In-process storage. Expiry is tracked as timestamps and enforced lazily on access, so no timers
 * are scheduled (Node's `setTimeout` cannot represent delays beyond ~24.8 days and would fire
 * immediately for a 30-day TTL).
 */
export class MemoryStorage extends EventEmitter implements StorageAdapter {
  readonly kind = 'memory' as const;
  private readonly strings = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly expiries = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    super();
    this.now = options.now ?? Date.now;
    queueMicrotask(() => {
      this.emit('connect');
      this.emit('ready');
    });
  }

  private evictIfExpired(key: string): void {
    const expiresAt = this.expiries.get(key);
    if (expiresAt !== undefined && expiresAt <= this.now()) {
      this.strings.delete(key);
      this.hashes.delete(key);
      this.expiries.delete(key);
    }
  }

  private liveKeys(): string[] {
    const all = new Set([...this.strings.keys(), ...this.hashes.keys()]);
    const live: string[] = [];
    for (const key of all) {
      this.evictIfExpired(key);
      if (this.strings.has(key) || this.hashes.has(key)) live.push(key);
    }
    return live;
  }

  async get(key: string): Promise<string | null> {
    this.evictIfExpired(key);
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    this.strings.set(key, value);
    if (ttl) {
      this.expiries.set(key, this.now() + ttl * 1000);
    } else {
      this.expiries.delete(key);
    }
  }

  async del(key: string): Promise<void> {
    this.strings.delete(key);
    this.hashes.delete(key);
    this.expiries.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    this.evictIfExpired(key);
    return this.strings.has(key) || this.hashes.has(key);
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = globToRegExp(pattern);
    return this.liveKeys().filter((key) => regex.test(key));
  }

  private hash(key: string, create: false): Map<string, string> | undefined;
  private hash(key: string, create: true): Map<string, string>;
  private hash(key: string, create: boolean): Map<string, string> | undefined {
    this.evictIfExpired(key);
    let hash = this.hashes.get(key);
    if (!hash && create) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    return hash;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hash(key, false)?.get(field) ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    this.hash(key, true).set(field, value);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hash(key, false) ?? []);
  }

  async hdel(key: string, field: string): Promise<void> {
    const hash = this.hash(key, false);
    if (!hash) return;
    hash.delete(field);
    if (hash.size === 0) this.hashes.delete(key);
  }

  async hincrby(key: string, field: string, delta: bigint): Promise<bigint> {
    const hash = this.hash(key, true);
    const next = BigInt(hash.get(field) ?? '0') + delta;
    hash.set(field, next.toString());
    return next;
  }

  async incr(key: string): Promise<number> {
    this.evictIfExpired(key);
    const next = Number.parseInt(this.strings.get(key) ?? '0', 10) + 1;
    this.strings.set(key, next.toString());
    return next;
  }

  async expire(key: string, ttl: number): Promise<void> {
    this.evictIfExpired(key);
    if (this.strings.has(key) || this.hashes.has(key)) {
      this.expiries.set(key, this.now() + ttl * 1000);
    }
  }

  async *scan(pattern: string): AsyncGenerator<string> {
    for (const key of await this.keys(pattern)) yield key;
  }

  async close(): Promise<void> {
    this.strings.clear();
    this.hashes.clear();
    this.expiries.clear();
  }
}

/**
 * Build the storage adapter for a configuration: Redis when `config.redis` is present, otherwise
 * in-memory. The caller decides what "unconfigured" means (the server uses `REDIS_URL`).
 */
export function createStorageAdapter(config?: StorageConfig): StorageAdapter {
  if (config?.redis) {
    return new RedisStorage(config);
  }
  return new MemoryStorage();
}
