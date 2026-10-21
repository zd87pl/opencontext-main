import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextVault } from '../src/vault.js';
import { OpenContextError, SDKError } from '../src/types.js';
import { expectCode } from './helpers.js';

describe('ContextVault', () => {
  let contextVault: ContextVault;
  let mockContract: any;
  let mockConfig: any;

  beforeEach(() => {
    mockContract = {
      storeContext: vi.fn(),
      getContext: vi.fn(),
      getLatestContext: vi.fn(),
      getContextCount: vi.fn(),
      authorizeReader: vi.fn(),
      revokeReader: vi.fn(),
      deleteContext: vi.fn(),
      authorizedReaders: vi.fn(),
      storageQuota: vi.fn(),
      interface: {
        parseLog: vi.fn()
      }
    };

    mockConfig = {
      passportRegistryAddress: '0x1234567890123456789012345678901234567890',
      contextVaultAddress: '0x1234567890123456789012345678901234567891',
      paymentStreamAddress: '0x1234567890123456789012345678901234567892',
      provider: {},
      signer: {
        getAddress: vi.fn().mockResolvedValue('0x1111111111111111111111111111111111111111')
      }
    };

    contextVault = new ContextVault(mockConfig);
    (contextVault as any).contract = mockContract;
  });

  describe('storeContext', () => {
    it('should store context successfully', async () => {
      const testData = 'Test context data';
      const version = 0n;

      mockContract.storeContext.mockResolvedValue({
        wait: vi.fn().mockResolvedValue({
          logs: [{
            data: '0x',
            topics: []
          }]
        })
      });

      mockContract.interface.parseLog.mockReturnValue({
        name: 'ContextStored',
        args: { version }
      });

      const result = await contextVault.storeContext(testData);

      expect(result).toBe(version);
      expect(mockContract.storeContext).toHaveBeenCalledWith(new TextEncoder().encode(testData));
    });

    it('should throw error when no signer available', async () => {
      const contextVaultNoSigner = new ContextVault({
        ...mockConfig,
        signer: undefined
      });

      await expect(
        contextVaultNoSigner.storeContext('test data')
      ).rejects.toThrow(OpenContextError);
    });

    it('should handle NoPassport error', async () => {
      mockContract.storeContext.mockRejectedValue(new Error('NoPassport'));

      await expect(
        contextVault.storeContext('test data')
      ).rejects.toThrow('No passport found for address');
    });

    it('should handle QuotaExceeded error', async () => {
      mockContract.storeContext.mockRejectedValue(new Error('QuotaExceeded'));

      await expect(
        contextVault.storeContext('test data')
      ).rejects.toThrow('Storage quota exceeded');
    });
  });

  describe('getContext', () => {
    it('should retrieve context successfully', async () => {
      const tokenId = 1n;
      const version = 0n;
      const testData = 'Test context data';
      const timestamp = BigInt(Date.now());

      mockContract.getContext.mockResolvedValue([
        Buffer.from(testData),
        timestamp
      ]);

      const result = await contextVault.getContext(tokenId, version);

      expect(result).toEqual({
        encryptedData: testData,
        timestamp,
        version
      });
    });

    it('should handle NotAuthorizedReader error', async () => {
      mockContract.getContext.mockRejectedValue(new Error('NotAuthorizedReader'));

      await expect(
        contextVault.getContext(1n, 0n)
      ).rejects.toThrow('Not authorized to read context');
    });
  });

  describe('getLatestContext', () => {
    it('should retrieve latest context successfully', async () => {
      const tokenId = 1n;
      const testData = 'Test context data';
      const timestamp = BigInt(Date.now());
      const version = 2n;

      mockContract.getLatestContext.mockResolvedValue([
        Buffer.from(testData),
        timestamp,
        version
      ]);

      const result = await contextVault.getLatestContext(tokenId);

      expect(result).toEqual({
        encryptedData: testData,
        timestamp,
        version
      });
    });

    it('should return null when no context exists', async () => {
      const tokenId = 1n;

      mockContract.getLatestContext.mockResolvedValue(['0x', 0n, 0n]);

      const result = await contextVault.getLatestContext(tokenId);

      expect(result).toBeNull();
    });
  });

  describe('getContextCount', () => {
    it('should return context count', async () => {
      const tokenId = 1n;
      const count = 5n;

      mockContract.getContextCount.mockResolvedValue(count);

      const result = await contextVault.getContextCount(tokenId);

      expect(result).toBe(count);
    });
  });

  describe('authorizeReader', () => {
    it('should authorize reader successfully', async () => {
      const reader = '0x2222222222222222222222222222222222222222';

      mockContract.authorizeReader.mockResolvedValue({
        wait: vi.fn().mockResolvedValue({})
      });

      await contextVault.authorizeReader(reader);

      expect(mockContract.authorizeReader).toHaveBeenCalledWith(reader);
    });

    it('should handle NoPassport error', async () => {
      mockContract.authorizeReader.mockRejectedValue(new Error('NoPassport'));

      await expect(
        contextVault.authorizeReader('0x2222222222222222222222222222222222222222')
      ).rejects.toThrow('No passport found for address');
    });
  });

  describe('revokeReader', () => {
    it('should revoke reader successfully', async () => {
      const reader = '0x2222222222222222222222222222222222222222';

      mockContract.revokeReader.mockResolvedValue({
        wait: vi.fn().mockResolvedValue({})
      });

      await contextVault.revokeReader(reader);

      expect(mockContract.revokeReader).toHaveBeenCalledWith(reader);
    });
  });

  describe('deleteContext', () => {
    it('should delete context successfully', async () => {
      const version = 1n;

      mockContract.deleteContext.mockResolvedValue({
        wait: vi.fn().mockResolvedValue({})
      });

      await contextVault.deleteContext(version);

      expect(mockContract.deleteContext).toHaveBeenCalledWith(version);
    });
  });

  describe('isAuthorizedReader', () => {
    it('should check authorization status', async () => {
      const tokenId = 1n;
      const reader = '0x2222222222222222222222222222222222222222';

      mockContract.authorizedReaders.mockResolvedValue(true);

      const result = await contextVault.isAuthorizedReader(tokenId, reader);

      expect(result).toBe(true);
      expect(mockContract.authorizedReaders).toHaveBeenCalledWith(tokenId, reader);
    });
  });

  describe('getStorageQuota', () => {
    it('should return custom quota when set', async () => {
      const tokenId = 1n;
      const quota = 50n * 1024n * 1024n; // 50MB

      mockContract.storageQuota.mockResolvedValue(quota);

      const result = await contextVault.getStorageQuota(tokenId);

      expect(result).toBe(quota);
    });

    it('should return default quota when not set', async () => {
      const tokenId = 1n;
      const defaultQuota = 10n * 1024n * 1024n; // 10MB

      mockContract.storageQuota.mockResolvedValue(0n);

      const result = await contextVault.getStorageQuota(tokenId);

      expect(result).toBe(defaultQuota);
    });

    it('wraps call failures', async () => {
      mockContract.storageQuota.mockRejectedValue(new Error('rpc down'));

      await expectCode(contextVault.getStorageQuota(1n), SDKError.TRANSACTION_FAILED);
    });
  });

  describe('error mapping', () => {
    const readOnly = () => new ContextVault({ ...mockConfig, signer: undefined });

    it('fails storeContext when the ContextStored event is missing', async () => {
      mockContract.storeContext.mockResolvedValue({
        wait: vi.fn().mockResolvedValue({ logs: [] }),
      });

      const error = await expectCode(contextVault.storeContext('data'), SDKError.TRANSACTION_FAILED);
      expect(error.message).toContain('ContextStored event not found');
    });

    it('maps ContextTooLarge on storeContext', async () => {
      mockContract.storeContext.mockRejectedValue(new Error('ContextTooLarge'));

      await expectCode(contextVault.storeContext('data'), SDKError.QUOTA_EXCEEDED);
    });

    it('maps NotAuthorizedReader and other failures on reads', async () => {
      mockContract.getLatestContext.mockRejectedValue(new Error('NotAuthorizedReader'));
      await expectCode(contextVault.getLatestContext(1n), SDKError.UNAUTHORIZED);

      mockContract.getLatestContext.mockRejectedValue(new Error('rpc down'));
      await expectCode(contextVault.getLatestContext(1n), SDKError.TRANSACTION_FAILED);

      mockContract.getContext.mockRejectedValue(new Error('rpc down'));
      await expectCode(contextVault.getContext(1n, 0n), SDKError.TRANSACTION_FAILED);

      mockContract.getContextCount.mockRejectedValue(new Error('rpc down'));
      await expectCode(contextVault.getContextCount(1n), SDKError.TRANSACTION_FAILED);

      mockContract.authorizedReaders.mockRejectedValue(new Error('rpc down'));
      await expectCode(contextVault.isAuthorizedReader(1n, '0x22'), SDKError.TRANSACTION_FAILED);
    });

    it('maps NoPassport on reader and deletion calls', async () => {
      mockContract.revokeReader.mockRejectedValue(new Error('NoPassport'));
      await expectCode(contextVault.revokeReader('0x22'), SDKError.NO_PASSPORT);

      mockContract.deleteContext.mockRejectedValue(new Error('NoPassport'));
      await expectCode(contextVault.deleteContext(1n), SDKError.NO_PASSPORT);

      mockContract.authorizeReader.mockRejectedValue(new Error('rpc down'));
      await expectCode(contextVault.authorizeReader('0x22'), SDKError.TRANSACTION_FAILED);

      mockContract.revokeReader.mockRejectedValue(new Error('rpc down'));
      await expectCode(contextVault.revokeReader('0x22'), SDKError.TRANSACTION_FAILED);

      mockContract.deleteContext.mockRejectedValue(new Error('rpc down'));
      await expectCode(contextVault.deleteContext(1n), SDKError.TRANSACTION_FAILED);
    });

    it('requires a signer for every write', async () => {
      await expectCode(readOnly().authorizeReader('0x22'), SDKError.NO_SIGNER);
      await expectCode(readOnly().revokeReader('0x22'), SDKError.NO_SIGNER);
      await expectCode(readOnly().deleteContext(1n), SDKError.NO_SIGNER);
    });
  });
});