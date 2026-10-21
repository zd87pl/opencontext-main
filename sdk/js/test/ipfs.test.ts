import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'kubo-rpc-client';
import { IPFSService } from '../src/ipfs.js';
import { ContextCrypto } from '../src/crypto.js';
import { OpenContextError, SDKError } from '../src/types.js';
import { expectCode } from './helpers.js';

/**
 * In-memory stand-in for a Kubo node: content-addressed blocks, a pin set,
 * and `cat` that streams each block in two pieces so byte concatenation is
 * exercised.
 */
const fake = vi.hoisted(() => {
  const encoder = new TextEncoder();
  const store = new Map<string, Uint8Array>();
  const pins = new Set<string>();

  // FNV-1a over the bytes, so identical content yields an identical CID.
  const cidOf = (bytes: Uint8Array): string => {
    let h = 0x811c9dc5;
    for (const b of bytes) {
      h ^= b;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `bafyfake${h.toString(16).padStart(8, '0')}x${bytes.length}`;
  };
  const toBytes = (content: unknown): Uint8Array =>
    content instanceof Uint8Array ? content : encoder.encode(String(content));
  const cid = (value: string) => ({ toString: () => value });

  const client = {
    add: vi.fn(async (content: unknown, options?: { pin?: boolean }) => {
      const bytes = toBytes(content);
      const value = cidOf(bytes);
      store.set(value, bytes);
      if (options?.pin !== false) {
        pins.add(value);
      }
      return { cid: cid(value), size: bytes.length, path: value };
    }),
    cat: vi.fn(async function* (value: string) {
      const bytes = store.get(value);
      if (!bytes) {
        throw new Error(`block not found: ${value}`);
      }
      const mid = Math.floor(bytes.length / 2);
      yield bytes.subarray(0, mid);
      yield bytes.subarray(mid);
    }),
    pin: {
      add: vi.fn(async (value: string) => {
        pins.add(value);
        return cid(value);
      }),
      rm: vi.fn(async (value: string) => {
        pins.delete(value);
        return cid(value);
      }),
      ls: vi.fn(async function* () {
        for (const value of pins) {
          yield { cid: cid(value), type: 'recursive' };
        }
      }),
    },
    files: {
      stat: vi.fn(async (path: string) => {
        const value = path.replace(/^\/ipfs\//, '');
        const bytes = store.get(value);
        if (!bytes) {
          throw new Error('file does not exist');
        }
        return {
          cid: cid(value),
          size: bytes.length,
          cumulativeSize: bytes.length + 8,
          blocks: 1,
          type: 'file' as const,
        };
      }),
    },
  };

  return {
    client,
    store,
    pins,
    reset: () => {
      store.clear();
      pins.clear();
    },
  };
});

vi.mock('kubo-rpc-client', () => ({ create: vi.fn(() => fake.client) }));

describe('IPFSService', () => {
  const password = 'correct horse battery staple';
  let ipfs: IPFSService;

  beforeEach(() => {
    fake.reset();
    vi.mocked(create).mockClear();
    ipfs = new IPFSService();
  });

  describe('constructor', () => {
    it('targets a local Kubo node by default', () => {
      expect(create).toHaveBeenCalledWith({ url: 'http://127.0.0.1:5001', timeout: 60_000 });
    });

    it('passes a custom endpoint and timeout through', () => {
      new IPFSService({ url: 'http://ipfs.example:5001', timeout: 5 });

      expect(create).toHaveBeenLastCalledWith({ url: 'http://ipfs.example:5001', timeout: 5 });
    });
  });

  describe('storeContext / getContext', () => {
    it('round-trips text, including multi-byte characters', async () => {
      const text = 'héllo wörld 🌐 日本語';

      const meta = await ipfs.storeContext(text);

      expect(meta.encrypted).toBe(false);
      expect(meta.size).toBe(Buffer.byteLength(text, 'utf8'));
      expect(meta.hash).toMatch(/^bafy/);
      expect(meta.timestamp).toBeGreaterThan(0);
      await expect(ipfs.getContext(meta.hash)).resolves.toBe(text);
    });

    it('pins by default and honours pin: false', async () => {
      const pinned = await ipfs.storeContext('a');
      expect(fake.pins.has(pinned.hash)).toBe(true);

      const unpinned = await new IPFSService({ pin: false }).storeContext('b');
      expect(fake.pins.has(unpinned.hash)).toBe(false);
    });

    it('encrypts when a password is given', async () => {
      const meta = await ipfs.storeContext('secret', password);

      expect(meta.encrypted).toBe(true);
      const stored = new TextDecoder().decode(fake.store.get(meta.hash));
      expect(stored).not.toContain('secret');
      await expect(ContextCrypto.decrypt(stored, password)).resolves.toBe('secret');
      await expect(ipfs.getContext(meta.hash, password)).resolves.toBe('secret');
    });

    it('rejects a wrong password instead of returning ciphertext', async () => {
      const meta = await ipfs.storeContext('secret', password);

      await expectCode(ipfs.getContext(meta.hash, 'wrong'), SDKError.ENCRYPTION_FAILED);
    });

    it('wraps node errors as IPFS_ERROR', async () => {
      fake.client.add.mockRejectedValueOnce(new Error('connection refused'));

      const error = await expectCode(ipfs.storeContext('x'), SDKError.IPFS_ERROR);
      expect(error).toBeInstanceOf(OpenContextError);
      expect(error.message).toBe('Failed to store context on IPFS: connection refused');

      await expectCode(ipfs.getContext('bafymissing'), SDKError.IPFS_ERROR);
    });
  });

  describe('pins and stats', () => {
    it('pins, lists and unpins content', async () => {
      const { hash } = await new IPFSService({ pin: false }).storeContext('data');

      await expect(ipfs.listPinned()).resolves.toEqual([]);
      await ipfs.pinContent(hash);
      await expect(ipfs.listPinned()).resolves.toEqual([hash]);
      await ipfs.unpinContent(hash);
      await expect(ipfs.listPinned()).resolves.toEqual([]);
    });

    it('reports stats and existence', async () => {
      const { hash } = await ipfs.storeContext('four');

      await expect(ipfs.getStats(hash)).resolves.toEqual({
        hash,
        size: 4,
        cumulativeSize: 12,
        blocks: 1,
        type: 'file',
      });
      await expect(ipfs.exists(hash)).resolves.toBe(true);
      await expect(ipfs.exists('bafymissing')).resolves.toBe(false);
      await expectCode(ipfs.getStats('bafymissing'), SDKError.IPFS_ERROR);
    });

    it('wraps pin failures', async () => {
      fake.client.pin.add.mockRejectedValueOnce(new Error('nope'));
      await expectCode(ipfs.pinContent('x'), SDKError.IPFS_ERROR);

      fake.client.pin.rm.mockRejectedValueOnce(new Error('nope'));
      await expectCode(ipfs.unpinContent('x'), SDKError.IPFS_ERROR);

      // Fails part-way through iteration, after one entry was already yielded.
      fake.client.pin.ls.mockImplementationOnce(async function* () {
        yield { cid: { toString: () => 'bafyone' }, type: 'recursive' };
        throw new Error('nope');
      });
      await expectCode(ipfs.listPinned(), SDKError.IPFS_ERROR);
    });
  });

  describe('getGatewayUrl', () => {
    it('builds URLs for the default and custom gateways', () => {
      expect(ipfs.getGatewayUrl('bafyabc')).toBe('https://ipfs.io/ipfs/bafyabc');
      expect(ipfs.getGatewayUrl('bafyabc', 'https://dweb.link/')).toBe(
        'https://dweb.link/ipfs/bafyabc'
      );
      expect(ipfs.getGatewayUrl('bafyabc', 'https://dweb.link/ipfs/')).toBe(
        'https://dweb.link/ipfs/bafyabc'
      );
    });
  });

  describe('JSON helpers', () => {
    it('round-trips JSON, optionally encrypted', async () => {
      const value = { a: 1, nested: { list: [1, 2, 3] }, text: 'ünïcode' };

      const plain = await ipfs.storeJSON(value);
      await expect(ipfs.getJSON(plain.hash)).resolves.toEqual(value);

      const secret = await ipfs.storeJSON(value, password);
      expect(secret.encrypted).toBe(true);
      await expect(ipfs.getJSON(secret.hash, password)).resolves.toEqual(value);
    });

    it('rejects content that is not JSON', async () => {
      const { hash } = await ipfs.storeContext('not json');

      await expectCode(ipfs.getJSON(hash), SDKError.IPFS_ERROR);
    });
  });

  describe('chunked storage', () => {
    const text = 'abc😀def🌐ghi'.repeat(20);

    it('splits without breaking surrogate pairs and reassembles', async () => {
      const result = await ipfs.storeChunked(text, 4);

      expect(result.totalSize).toBe(Buffer.byteLength(text, 'utf8'));
      expect(result.chunks.length).toBeGreaterThan(1);
      for (const cid of result.chunks) {
        // A split surrogate pair would have been encoded as U+FFFD.
        await expect(ipfs.getContext(cid)).resolves.not.toContain('�');
      }
      await expect(ipfs.getChunked(result.manifestHash)).resolves.toBe(text);
    });

    it('round-trips encrypted chunks and refuses to read them without a password', async () => {
      const result = await ipfs.storeChunked(text, 100, password);

      await expect(ipfs.getChunked(result.manifestHash, password)).resolves.toBe(text);
      await expectCode(ipfs.getChunked(result.manifestHash), SDKError.ENCRYPTION_FAILED);
    });

    it('accepts UTF-8 bytes and rejects invalid UTF-8', async () => {
      const bytes = new TextEncoder().encode(text);

      const result = await ipfs.storeChunked(bytes, 64);

      expect(result.totalSize).toBe(bytes.length);
      await expect(ipfs.getChunked(result.manifestHash)).resolves.toBe(text);
      await expectCode(ipfs.storeChunked(new Uint8Array([0xff, 0xfe]), 64), SDKError.IPFS_ERROR);
    });

    it('handles empty input', async () => {
      const result = await ipfs.storeChunked('');

      expect(result.chunks).toEqual([]);
      expect(result.totalSize).toBe(0);
      await expect(ipfs.getChunked(result.manifestHash)).resolves.toBe('');
    });

    it('validates chunkSize and manifests', async () => {
      await expectCode(ipfs.storeChunked('x', 0), SDKError.IPFS_ERROR);
      await expectCode(ipfs.storeChunked('x', 1.5), SDKError.IPFS_ERROR);

      const { hash } = await ipfs.storeJSON({ chunks: 'not a list' });
      await expectCode(ipfs.getChunked(hash), SDKError.IPFS_ERROR);
    });
  });
});
