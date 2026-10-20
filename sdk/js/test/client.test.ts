import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
import { OpenContextClient } from '../src/client.js';
import { ContextCrypto } from '../src/crypto.js';
import { OpenContextError, SDKError } from '../src/types.js';
import { expectCode } from './helpers.js';

const ADDRESS = '0x1234567890123456789012345678901234567890';
const PRIVATE_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';
const CONTRACTS = {
  passportRegistryAddress: '0x0000000000000000000000000000000000000001',
  contextVaultAddress: '0x0000000000000000000000000000000000000002',
  paymentStreamAddress: '0x0000000000000000000000000000000000000003',
};

describe('OpenContextClient', () => {
  let client: OpenContextClient;
  let mockProvider: any;
  let mockSigner: any;

  beforeEach(() => {
    mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 300 }),
    };

    mockSigner = {
      getAddress: vi.fn().mockResolvedValue(ADDRESS),
      provider: mockProvider,
    };

    client = new OpenContextClient({
      provider: mockProvider,
      signer: mockSigner,
      ...CONTRACTS,
    });
  });

  describe('authenticate', () => {
    it('should throw error if no signer', async () => {
      const clientNoSigner = new OpenContextClient({
        provider: mockProvider,
        ...CONTRACTS,
      });

      await expect(clientNoSigner.authenticate()).rejects.toThrow('Signer required');
    });

    it('returns the existing passport without minting', async () => {
      const passport = { tokenId: 7n, owner: ADDRESS, dataHash: '0xabc', exists: true };
      vi.spyOn(client.passport, 'getPassport').mockResolvedValue(passport);
      const mint = vi.spyOn(client.passport, 'mint');

      await expect(client.authenticate()).resolves.toEqual(passport);
      expect(mint).not.toHaveBeenCalled();
    });

    it('mints a passport when none exists', async () => {
      vi.spyOn(client.passport, 'getPassport').mockResolvedValue(null);
      const mint = vi.spyOn(client.passport, 'mint').mockResolvedValue(3n);

      const result = await client.authenticate();

      const expectedHash = ethers.keccak256(ethers.toUtf8Bytes(`opencontext:${ADDRESS}`));
      expect(mint).toHaveBeenCalledWith(ADDRESS, expectedHash);
      expect(result).toEqual({ tokenId: 3n, owner: ADDRESS, dataHash: expectedHash, exists: true });
    });
  });

  describe('passport lookups', () => {
    it('getMyPassport delegates to the registry', async () => {
      const passport = { tokenId: 1n, owner: ADDRESS, dataHash: '0xabc', exists: true };
      vi.spyOn(client.passport, 'getPassport').mockResolvedValue(passport);

      await expect(client.getMyPassport()).resolves.toEqual(passport);
    });

    it('getMyTokenId rejects when the signer has no passport', async () => {
      vi.spyOn(client.passport, 'getTokenId').mockResolvedValue(0n);

      await expectCode(client.getMyTokenId(), SDKError.NO_PASSPORT);
    });

    it('getMyTokenId rejects without a signer', async () => {
      const clientNoSigner = new OpenContextClient({ provider: mockProvider, ...CONTRACTS });

      await expectCode(clientNoSigner.getMyTokenId(), SDKError.NO_SIGNER);
    });
  });

  describe('encryption', () => {
    it('has no key for a signer without a private key', () => {
      expect(client.hasEncryptionKey()).toBe(false);
    });

    it('refuses to store anything when no key is configured', async () => {
      const store = vi.spyOn(client.vault, 'storeContext');

      await expectCode(client.storeContext('hello'), SDKError.NOT_CONFIGURED);
      expect(store).not.toHaveBeenCalled();
    });

    it('derives a key from a private-key signer', () => {
      const withWallet = new OpenContextClient({
        provider: mockProvider,
        signer: new ethers.Wallet(PRIVATE_KEY),
        ...CONTRACTS,
      });

      expect(withWallet.hasEncryptionKey()).toBe(true);
    });

    it('encrypts before storing and decrypts after reading', async () => {
      client.setEncryptionPassword('pw');
      const store = vi.spyOn(client.vault, 'storeContext').mockResolvedValue(1n);

      await expect(client.storeContext('hello')).resolves.toBe(1n);

      const stored = store.mock.calls[0][0];
      expect(stored).not.toContain('hello');
      await expect(ContextCrypto.decrypt(stored, 'pw')).resolves.toBe('hello');

      vi.spyOn(client.passport, 'getTokenId').mockResolvedValue(1n);
      vi.spyOn(client.vault, 'getLatestContext').mockResolvedValue({
        encryptedData: stored,
        timestamp: 1n,
        version: 1n,
      });
      vi.spyOn(client.vault, 'getContext').mockResolvedValue({
        encryptedData: stored,
        timestamp: 1n,
        version: 1n,
      });

      await expect(client.getMyLatestContext()).resolves.toBe('hello');
      await expect(client.getMyContext(1n)).resolves.toBe('hello');
    });

    it('returns null when nothing has been stored', async () => {
      client.setEncryptionPassword('pw');
      vi.spyOn(client.passport, 'getTokenId').mockResolvedValue(1n);
      vi.spyOn(client.vault, 'getLatestContext').mockResolvedValue(null);

      await expect(client.getMyLatestContext()).resolves.toBeNull();
    });

    it('fails to read data encrypted under a different key', async () => {
      const stored = await ContextCrypto.encrypt('hello', 'someone-else');
      client.setEncryptionPassword('pw');
      vi.spyOn(client.passport, 'getTokenId').mockResolvedValue(1n);
      vi.spyOn(client.vault, 'getLatestContext').mockResolvedValue({
        encryptedData: stored,
        timestamp: 1n,
        version: 1n,
      });

      await expectCode(client.getMyLatestContext(), SDKError.ENCRYPTION_FAILED);
    });

    it('generateEncryptionPassword installs a fresh 256-bit key', () => {
      const password = client.generateEncryptionPassword();

      expect(password).toMatch(/^[0-9a-f]{64}$/);
      expect(client.hasEncryptionKey()).toBe(true);
    });

    it('rejects an empty password', () => {
      expect(() => client.setEncryptionPassword('')).toThrow(OpenContextError);
    });
  });

  describe('payments', () => {
    it('getMyStreams keeps only active streams', async () => {
      vi.spyOn(client.passport, 'getTokenId').mockResolvedValue(1n);
      vi.spyOn(client.payments, 'getActiveFlowRate').mockImplementation(
        async (_tokenId, provider) => (provider === 'a' ? 10n : 0n)
      );

      await expect(client.getMyStreams(['a', 'b'])).resolves.toEqual(new Map([['a', 10n]]));
    });

    it('forwards streaming and provider calls', async () => {
      const start = vi.spyOn(client.payments, 'startStream').mockResolvedValue();
      const stop = vi.spyOn(client.payments, 'stopStream').mockResolvedValue();
      const register = vi.spyOn(client.payments, 'registerProvider').mockResolvedValue();
      const rate = vi.spyOn(client.payments, 'updateProviderRate').mockResolvedValue();
      const record = vi.spyOn(client.payments, 'recordConsumption').mockResolvedValue();

      await client.streamPay('p', 1n);
      await client.stopPayment('p');
      await client.becomeProvider('r', 2n);
      await client.updateMyProviderRate(3n);
      await client.recordBytesProvided(4n, 5n);

      expect(start).toHaveBeenCalledWith('p', 1n);
      expect(stop).toHaveBeenCalledWith('p');
      expect(register).toHaveBeenCalledWith('r', 2n);
      expect(rate).toHaveBeenCalledWith(3n);
      expect(record).toHaveBeenCalledWith(4n, 5n);
    });
  });

  describe('create', () => {
    it('should create client instance', async () => {
      const newClient = await OpenContextClient.create(
        'https://sepolia.era.zksync.dev',
        PRIVATE_KEY,
        {
          passportRegistry: CONTRACTS.passportRegistryAddress,
          contextVault: CONTRACTS.contextVaultAddress,
          paymentStream: CONTRACTS.paymentStreamAddress,
        }
      );

      expect(newClient).toBeInstanceOf(OpenContextClient);
      expect(newClient.passport).toBeDefined();
      expect(newClient.vault).toBeDefined();
      expect(newClient.payments).toBeDefined();
      expect(newClient.hasEncryptionKey()).toBe(true);
    });
  });
});
