import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryStorage,
  RedisStorage,
  createStorageAdapter,
  globToRegExp,
  type StorageAdapter,
} from '../src/storage.js';

// A minimal in-memory stand-in for the `redis` client so RedisStorage's key handling can be
// tested without a server. Hoisted so the module mock below can reference it.
const { fakeRedis } = vi.hoisted(() => {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const glob = (pattern: string) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

  const fakeRedis = {
    strings,
    hashes,
    listeners,
    connectCalls: 0,
    reset() {
      strings.clear();
      hashes.clear();
      listeners.clear();
      this.connectCalls = 0;
      this.quit.mockClear();
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return fakeRedis;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    async connect() {
      fakeRedis.connectCalls++;
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    quit: vi.fn(async () => undefined),
    async get(key: string) {
      return strings.get(key) ?? null;
    },
    async set(key: string, value: string) {
      strings.set(key, value);
    },
    async del(key: string) {
      strings.delete(key);
      hashes.delete(key);
    },
    async exists(key: string) {
      return strings.has(key) || hashes.has(key) ? 1 : 0;
    },
    async hGet(key: string, field: string) {
      return hashes.get(key)?.get(field);
    },
    async hSet(key: string, field: string, value: string) {
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key)!.set(field, value);
    },
    async hGetAll(key: string) {
      return Object.fromEntries(hashes.get(key) ?? []);
    },
    async hDel(key: string, field: string) {
      hashes.get(key)?.delete(field);
    },
    async incr(key: string) {
      const next = Number(strings.get(key) ?? '0') + 1;
      strings.set(key, String(next));
      return next;
    },
    async expire() {
      return true;
    },
    async sendCommand(args: string[]) {
      const [command, key, field, delta] = args;
      if (command !== 'HINCRBY') throw new Error(`unsupported ${command}`);
      if (!hashes.has(key)) hashes.set(key, new Map());
      const next = BigInt(hashes.get(key)!.get(field) ?? '0') + BigInt(delta);
      hashes.get(key)!.set(field, next.toString());
      return next.toString();
    },
    scanIterator({ MATCH }: { MATCH: string }) {
      const regex = glob(MATCH);
      return (async function* () {
        for (const key of [...strings.keys(), ...hashes.keys()]) {
          if (regex.test(key)) yield key;
        }
      })();
    },
  };
  return { fakeRedis };
});

vi.mock('redis', () => ({ createClient: () => fakeRedis }));

function adapterContract(name: string, make: () => StorageAdapter) {
  describe(`${name} contract`, () => {
    let storage: StorageAdapter;

    beforeEach(() => {
      storage = make();
    });

    it('stores and deletes strings', async () => {
      expect(await storage.get('a')).toBeNull();
      await storage.set('a', '1');
      expect(await storage.get('a')).toBe('1');
      expect(await storage.exists('a')).toBe(true);
      await storage.del('a');
      expect(await storage.get('a')).toBeNull();
      expect(await storage.exists('a')).toBe(false);
    });

    it('stores hashes', async () => {
      await storage.hset('h', 'x', '1');
      await storage.hset('h', 'y', '2');
      expect(await storage.hget('h', 'x')).toBe('1');
      expect(await storage.hget('h', 'missing')).toBeNull();
      expect(await storage.hgetall('h')).toEqual({ x: '1', y: '2' });
      await storage.hdel('h', 'x');
      expect(await storage.hgetall('h')).toEqual({ y: '2' });
      expect(await storage.hgetall('nothing')).toEqual({});
    });

    it('increments atomically with big integers', async () => {
      expect(await storage.hincrby('totals', 'cost', 10n ** 20n)).toBe(10n ** 20n);
      expect(await storage.hincrby('totals', 'cost', 5n)).toBe(10n ** 20n + 5n);
      await Promise.all(Array.from({ length: 50 }, () => storage.hincrby('totals', 'n', 1n)));
      expect(await storage.hget('totals', 'n')).toBe('50');
      expect(await storage.incr('counter')).toBe(1);
      expect(await storage.incr('counter')).toBe(2);
    });

    it('matches keys by glob', async () => {
      await storage.set('daily:2026-01-01:p1:github', '1');
      await storage.set('daily:2026-01-01:p2:newswire', '1');
      await storage.set('daily:2026-01-02:p1:github', '1');
      await storage.set('dailyx2026-01-01:p1:github', '1'); // "." must not act as a wildcard
      await storage.hset('daily:2026-01-01:p3:compute', 'bytes', '1');

      const keys = await storage.keys('daily:2026-01-01:*');
      expect(keys.sort()).toEqual([
        'daily:2026-01-01:p1:github',
        'daily:2026-01-01:p2:newswire',
        'daily:2026-01-01:p3:compute',
      ]);
      expect(await storage.keys('daily:*:p1:*')).toHaveLength(2);

      const scanned: string[] = [];
      for await (const key of storage.scan('daily:2026-01-02:*')) scanned.push(key);
      expect(scanned).toEqual(['daily:2026-01-02:p1:github']);
    });
  });
}

describe('globToRegExp', () => {
  it('escapes regex metacharacters and expands * only', () => {
    expect(globToRegExp('a.b:*').test('a.b:1')).toBe(true);
    expect(globToRegExp('a.b:*').test('axb:1')).toBe(false);
    expect(globToRegExp('*:x').test('anything:x')).toBe(true);
    expect(globToRegExp('(x)').test('(x)')).toBe(true);
    expect(globToRegExp('abc').test('abcd')).toBe(false);
  });
});

describe('MemoryStorage', () => {
  adapterContract('MemoryStorage', () => new MemoryStorage());

  it('expires strings and hashes lazily without timers', async () => {
    let now = 1_000_000;
    const storage = new MemoryStorage({ now: () => now });

    await storage.set('s', 'v', 30 * 24 * 60 * 60); // 30 days: beyond setTimeout's 24.8-day limit
    await storage.hset('h', 'f', 'v');
    await storage.expire('h', 10);
    await storage.expire('absent', 10);

    now += 11 * 1000;
    expect(await storage.get('s')).toBe('v');
    expect(await storage.hget('h', 'f')).toBeNull();
    expect(await storage.keys('*')).toEqual(['s']);

    now += 31 * 24 * 60 * 60 * 1000;
    expect(await storage.get('s')).toBeNull();
    expect(await storage.exists('s')).toBe(false);
  });

  it('clears a TTL when a key is overwritten without one', async () => {
    let now = 0;
    const storage = new MemoryStorage({ now: () => now });
    await storage.set('k', '1', 1);
    await storage.set('k', '2');
    now += 5000;
    expect(await storage.get('k')).toBe('2');
  });

  it('emits connect and ready, and close() wipes everything', async () => {
    const storage = new MemoryStorage();
    const ready = new Promise((resolve) => storage.once('ready', resolve));
    await ready;
    await storage.set('a', '1');
    await storage.hset('h', 'f', '1');
    await storage.close();
    expect(await storage.get('a')).toBeNull();
    expect(await storage.hgetall('h')).toEqual({});
  });
});

describe('RedisStorage', () => {
  beforeEach(() => {
    fakeRedis.reset();
  });

  adapterContract('RedisStorage', () => new RedisStorage({ keyPrefix: 'test' }));

  it('prefixes keys and strips the prefix from scanned keys', async () => {
    const storage = new RedisStorage({ keyPrefix: 'opencontext' });
    await storage.set('streaming:session:1', '{}');
    await storage.hset('metering:index:p1', 'r1', '1');

    expect([...fakeRedis.strings.keys()]).toEqual(['opencontext:streaming:session:1']);
    expect([...fakeRedis.hashes.keys()]).toEqual(['opencontext:metering:index:p1']);

    const scanned: string[] = [];
    for await (const key of storage.scan('streaming:*')) scanned.push(key);
    expect(scanned).toEqual(['streaming:session:1']);
    // A scanned key fed back through the adapter must resolve to the same record.
    expect(await storage.get(scanned[0])).toBe('{}');
    expect(await storage.keys('metering:*')).toEqual(['metering:index:p1']);
  });

  it('works without a prefix', async () => {
    const storage = new RedisStorage();
    await storage.set('plain', '1');
    expect([...fakeRedis.strings.keys()]).toEqual(['plain']);
    expect(await storage.keys('pl*')).toEqual(['plain']);
  });

  it('connects once even when first calls race, and quits on close', async () => {
    const storage = new RedisStorage();
    expect(fakeRedis.connectCalls).toBe(0);
    await Promise.all([storage.get('a'), storage.get('b'), storage.set('c', '1')]);
    expect(fakeRedis.connectCalls).toBe(1);
    await storage.get('d');
    expect(fakeRedis.connectCalls).toBe(1);

    await storage.close();
    expect(fakeRedis.quit).toHaveBeenCalledTimes(1);
    await storage.close();
    expect(fakeRedis.quit).toHaveBeenCalledTimes(1);
  });

  it('does not quit a client that never connected', async () => {
    const storage = new RedisStorage();
    await storage.close();
    expect(fakeRedis.quit).not.toHaveBeenCalled();
  });

  it('re-emits client errors', async () => {
    const storage = new RedisStorage();
    const seen: Error[] = [];
    storage.on('error', (error: Error) => seen.push(error));
    fakeRedis.emit('error', new Error('ECONNREFUSED'));
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe('ECONNREFUSED');
  });

  it('uses HINCRBY for atomic increments', async () => {
    const storage = new RedisStorage({ keyPrefix: 'p' });
    expect(await storage.hincrby('h', 'f', 7n)).toBe(7n);
    expect(await storage.hincrby('h', 'f', -2n)).toBe(5n);
    expect(fakeRedis.hashes.get('p:h')?.get('f')).toBe('5');
  });

  it('reports its kind', () => {
    expect(new RedisStorage().kind).toBe('redis');
    expect(new MemoryStorage().kind).toBe('memory');
  });
});

describe('createStorageAdapter', () => {
  it('picks Redis only when configured', () => {
    expect(createStorageAdapter()).toBeInstanceOf(MemoryStorage);
    expect(createStorageAdapter({ keyPrefix: 'x' })).toBeInstanceOf(MemoryStorage);
    expect(createStorageAdapter({ redis: { url: 'redis://localhost:6379' } })).toBeInstanceOf(RedisStorage);
  });
});
