import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextVault } from '../src/vault.js';
import { IPFSService } from '../src/ipfs.js';
import { OpenContextError, SDKError } from '../src/types.js';
import { expectCode } from './helpers.js';

const fakeIpfs = vi.hoisted(() => ({
  storeContext: vi.fn(),
  getContext: vi.fn(),
}));

vi.mock('../src/ipfs.js', () => ({
  IPFSService: vi.fn(() => fakeIpfs),
}));

const HASH = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const IPFS_CONFIG = { url: 'http://127.0.0.1:5001' };

describe('ContextVault with IPFS', () => {
  let vault: ContextVault;
  let mockContract: any;
  let mockConfig: any;

  beforeEach(() => {
    fakeIpfs.storeContext.mockReset();
    fakeIpfs.getContext.mockReset();

    mockContract = {
      storeContextIPFS: vi.fn(),
      getContextMetadata: vi.fn(),
      getLatestContextMetadata: vi.fn(),
      interface: {
        parseLog: vi.fn(),
      },
    };

    mockConfig = {
      passportRegistryAddress: '0x1234567890123456789012345678901234567890',
      contextVaultAddress: '0x1234567890123456789012345678901234567891',
      paymentStreamAddress: '0x1234567890123456789012345678901234567892',
      provider: {},
      signer: {
        getAddress: vi.fn().mockResolvedValue('0x1111111111111111111111111111111111111111'),
      },
    };

    vault = new ContextVault(mockConfig, IPFS_CONFIG);
    (vault as any).contract = mockContract;
  });

  it('selects the ContextVaultIPFS ABI only when IPFS is configured', () => {
    const ipfsVault = new ContextVault(mockConfig, IPFS_CONFIG);
    const plainVault = new ContextVault(mockConfig);
    const ipfsInterface = (ipfsVault as any).contract.interface;
    const plainInterface = (plainVault as any).contract.interface;

    expect(IPFSService).toHaveBeenCalledWith(IPFS_CONFIG);
    expect(ipfsInterface.hasFunction('storeContextIPFS')).toBe(true);
    expect(ipfsInterface.hasFunction('getLatestContextMetadata')).toBe(true);
    expect(ipfsInterface.hasFunction('storeContext')).toBe(false);
    expect(plainInterface.hasFunction('storeContext')).toBe(true);
    expect(plainInterface.hasFunction('storeContextIPFS')).toBe(false);
  });

  describe('storeContextIPFS', () => {
    it('stores on IPFS and records the CID on-chain', async () => {
      fakeIpfs.storeContext.mockResolvedValue({ hash: HASH, size: 42, timestamp: 1, encrypted: true });
      mockContract.storeContextIPFS.mockResolvedValue({
        wait: vi.fn().mockResolvedValue({ logs: [{ data: '0x', topics: [] }] }),
      });
      mockContract.interface.parseLog.mockReturnValue({
        name: 'ContextStored',
        args: { version: 4n },
      });

      await expect(vault.storeContextIPFS('secret', 'pw')).resolves.toBe(4n);

      expect(fakeIpfs.storeContext).toHaveBeenCalledWith('secret', 'pw');
      expect(mockContract.storeContextIPFS).toHaveBeenCalledWith(HASH, 42, true);
    });

    it('requires IPFS to be configured', async () => {
      const plainVault = new ContextVault(mockConfig);

      await expectCode(plainVault.storeContextIPFS('x'), SDKError.NOT_CONFIGURED);
    });

    it('requires a signer', async () => {
      const readOnly = new ContextVault({ ...mockConfig, signer: undefined }, IPFS_CONFIG);

      await expectCode(readOnly.storeContextIPFS('x'), SDKError.NO_SIGNER);
      expect(fakeIpfs.storeContext).not.toHaveBeenCalled();
    });

    it('propagates IPFS failures untouched and skips the transaction', async () => {
      fakeIpfs.storeContext.mockRejectedValue(new OpenContextError(SDKError.IPFS_ERROR, 'node down'));

      const error = await expectCode(vault.storeContextIPFS('x'), SDKError.IPFS_ERROR);

      expect(error.message).toBe('node down');
      expect(mockContract.storeContextIPFS).not.toHaveBeenCalled();
    });

    it.each([
      ['NoPassport', SDKError.NO_PASSPORT],
      ['QuotaExceeded', SDKError.QUOTA_EXCEEDED],
      ['ContextTooLarge', SDKError.QUOTA_EXCEEDED],
    ])('maps %s', async (revertName, code) => {
      fakeIpfs.storeContext.mockResolvedValue({ hash: HASH, size: 1, timestamp: 1, encrypted: false });
      mockContract.storeContextIPFS.mockRejectedValue(new Error(revertName));

      await expectCode(vault.storeContextIPFS('x'), code);
    });

    it('fails when the ContextStored event is missing', async () => {
      fakeIpfs.storeContext.mockResolvedValue({ hash: HASH, size: 1, timestamp: 1, encrypted: false });
      mockContract.storeContextIPFS.mockResolvedValue({
        wait: vi.fn().mockResolvedValue({ logs: [] }),
      });

      const error = await expectCode(vault.storeContextIPFS('x'), SDKError.TRANSACTION_FAILED);
      expect(error.message).toContain('ContextStored event not found');
    });
  });

  describe('getContextFromIPFS', () => {
    it('fetches and decrypts an encrypted entry', async () => {
      mockContract.getContextMetadata.mockResolvedValue([HASH, 42n, 1700n, true]);
      fakeIpfs.getContext.mockResolvedValue('secret');

      await expect(vault.getContextFromIPFS(1n, 0n, 'pw')).resolves.toBe('secret');

      expect(mockContract.getContextMetadata).toHaveBeenCalledWith(1n, 0n);
      expect(fakeIpfs.getContext).toHaveBeenCalledWith(HASH, 'pw');
    });

    it('passes no password for unencrypted entries', async () => {
      mockContract.getContextMetadata.mockResolvedValue([HASH, 42n, 1700n, false]);
      fakeIpfs.getContext.mockResolvedValue('public');

      await expect(vault.getContextFromIPFS(1n, 0n, 'pw')).resolves.toBe('public');

      expect(fakeIpfs.getContext).toHaveBeenCalledWith(HASH, undefined);
    });

    it('refuses to read an encrypted entry without a password', async () => {
      mockContract.getContextMetadata.mockResolvedValue([HASH, 42n, 1700n, true]);

      await expectCode(vault.getContextFromIPFS(1n, 0n), SDKError.ENCRYPTION_FAILED);
      expect(fakeIpfs.getContext).not.toHaveBeenCalled();
    });

    it('returns null for deleted entries', async () => {
      mockContract.getContextMetadata.mockResolvedValue(['', 0n, 0n, false]);

      await expect(vault.getContextFromIPFS(1n, 0n)).resolves.toBeNull();
    });

    it('maps NotAuthorizedReader', async () => {
      mockContract.getContextMetadata.mockRejectedValue(new Error('NotAuthorizedReader'));

      await expectCode(vault.getContextFromIPFS(1n, 0n), SDKError.UNAUTHORIZED);
    });

    it('requires IPFS to be configured', async () => {
      const plainVault = new ContextVault(mockConfig);

      await expectCode(plainVault.getContextFromIPFS(1n, 0n), SDKError.NOT_CONFIGURED);
    });
  });

  describe('getLatestContextFromIPFS', () => {
    it('returns data with version and timestamp', async () => {
      mockContract.getLatestContextMetadata.mockResolvedValue([HASH, 42n, 1700n, 3n, true]);
      fakeIpfs.getContext.mockResolvedValue('secret');

      await expect(vault.getLatestContextFromIPFS(1n, 'pw')).resolves.toEqual({
        data: 'secret',
        version: 3n,
        timestamp: 1700n,
      });
      expect(fakeIpfs.getContext).toHaveBeenCalledWith(HASH, 'pw');
    });

    it('returns null when nothing is stored', async () => {
      mockContract.getLatestContextMetadata.mockResolvedValue(['', 0n, 0n, 0n, false]);

      await expect(vault.getLatestContextFromIPFS(1n)).resolves.toBeNull();
    });

    it('wraps contract failures', async () => {
      mockContract.getLatestContextMetadata.mockRejectedValue(new Error('rpc down'));

      const error = await expectCode(vault.getLatestContextFromIPFS(1n), SDKError.TRANSACTION_FAILED);
      expect(error.message).toBe('Get latest context metadata failed: rpc down');
    });

    it('requires IPFS to be configured', async () => {
      const plainVault = new ContextVault(mockConfig);

      await expectCode(plainVault.getLatestContextFromIPFS(1n), SDKError.NOT_CONFIGURED);
    });
  });
});
