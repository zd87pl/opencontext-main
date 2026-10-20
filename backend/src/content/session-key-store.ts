import { createClient } from 'redis';
import { logger } from '../common/logger.js';

/**
 * Storage for per-user session keys (the keys that wrap escrowed content keys).
 *
 * With REDIS_URL set, records live in Redis with a TTL so every instance sees
 * the same key. Without it (local development, unit tests) they live in process
 * memory, which is fine for a single instance only.
 */
export interface StoredSessionKey {
  userId: string;
  /** 32 random bytes, hex encoded. */
  sessionKey: string;
  createdAt: string;
  expiresAt: string;
}

declare global {
  // The in-memory fallback lives on globalThis so it survives module re-evaluation
  // under `tsx watch` and so tests can reset it between cases.
  // eslint-disable-next-line no-var
  var sessionKeys: Map<string, StoredSessionKey> | undefined;
}

export const SESSION_KEY_TTL_SECONDS = 24 * 60 * 60;

type RedisClient = ReturnType<typeof createClient>;

const redisKey = (userId: string): string => `session:key:${userId}`;

function memoryStore(): Map<string, StoredSessionKey> {
  if (!globalThis.sessionKeys) {
    globalThis.sessionKeys = new Map();
  }
  return globalThis.sessionKeys;
}

// undefined = connection not attempted yet, null = Redis not configured or unreachable.
let redisClient: RedisClient | null | undefined;
let redisConnecting: Promise<RedisClient | null> | null = null;

async function getRedis(): Promise<RedisClient | null> {
  if (redisClient !== undefined) return redisClient;

  const url = process.env.REDIS_URL;
  if (!url) {
    redisClient = null;
    return null;
  }

  if (!redisConnecting) {
    redisConnecting = (async () => {
      const client = createClient({
        url,
        socket: {
          connectTimeout: 2000,
          // Give up quickly on an unreachable server instead of retrying forever;
          // callers fall back to memory and every later call stays fast.
          reconnectStrategy: (retries) => (retries >= 3 ? false : 250)
        }
      });
      client.on('error', (err) => logger.warn('Session key store Redis error:', err));

      try {
        await client.connect();
        redisClient = client;
        logger.info('Session key store using Redis');
      } catch (error) {
        logger.warn('Session key store: Redis unreachable, falling back to process memory', error);
        redisClient = null;
      }
      return redisClient;
    })();
  }

  return redisConnecting;
}

function isExpired(record: StoredSessionKey): boolean {
  return new Date(record.expiresAt).getTime() <= Date.now();
}

/** Returns the stored record, or null when there is none or it has expired. */
export async function loadSessionKey(userId: string): Promise<StoredSessionKey | null> {
  const redis = await getRedis();
  let record: StoredSessionKey | undefined;

  if (redis) {
    try {
      const raw = await redis.get(redisKey(userId));
      if (raw) record = JSON.parse(raw) as StoredSessionKey;
    } catch (error) {
      logger.warn('Failed to read session key from Redis, checking memory fallback', error);
    }
  }

  record ??= memoryStore().get(userId);
  if (!record) return null;

  if (isExpired(record)) {
    await deleteSessionKey(userId);
    return null;
  }

  return record;
}

/**
 * Stores `record` unless a live record already exists, and returns whichever
 * record is now authoritative. Two instances racing to create a key for the
 * same user therefore agree on one key instead of overwriting each other.
 */
export async function saveSessionKeyIfAbsent(record: StoredSessionKey): Promise<StoredSessionKey> {
  const redis = await getRedis();

  if (redis) {
    try {
      const stored = await redis.set(redisKey(record.userId), JSON.stringify(record), {
        NX: true,
        EX: SESSION_KEY_TTL_SECONDS
      });
      if (stored === 'OK') return record;

      const existing = await redis.get(redisKey(record.userId));
      if (existing) return JSON.parse(existing) as StoredSessionKey;
      return record;
    } catch (error) {
      logger.warn('Failed to store session key in Redis, using memory fallback', error);
    }
  }

  const store = memoryStore();
  const existing = store.get(record.userId);
  if (existing && !isExpired(existing)) return existing;

  store.set(record.userId, record);
  return record;
}

/**
 * Forgets a user's session key. The in-memory copy is removed synchronously,
 * before the first await, so callers that do not await still see it gone.
 */
export async function deleteSessionKey(userId: string): Promise<void> {
  globalThis.sessionKeys?.delete(userId);

  const redis = await getRedis();
  if (redis) {
    try {
      await redis.del(redisKey(userId));
    } catch (error) {
      logger.warn('Failed to delete session key from Redis', error);
    }
  }
}
