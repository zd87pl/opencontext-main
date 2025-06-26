import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PassportRegistry } from '../src/passport.js';
import { OpenContextError, SDKError } from '../src/types.js';

describe('PassportRegistry', () => {
  let passportRegistry: PassportRegistry;
  let mockContract: any;
  let mockConfig: any;

  beforeEach(() => {
    mockContract = {
      mint: vi.fn(),
      revoke: vi.fn(),
      updateDataHash: vi.fn(),
      getTokenId: vi.fn(),
      hasPassport: vi.fn(),
      ownerOf: vi.fn(),
      tokenIdToDataHash: vi.fn(),
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

    // Mock ethers Contract constructor
    vi.doMock('ethers', () => ({
      ethers: {
        Contract: vi.fn().mockImplementation(() => mockContract)
      }
    }));

    passportRegistry = new PassportRegistry(mockConfig);
    (passportRegistry as any).contract = mockContract;
  });

  describe('mint', () => {
    it('should mint a passport successfully', async () => {
      const to = '0x1111111111111111111111111111111111111111';
      const dataHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const tokenId = 1n;

      mockContract.mint.mockResolvedValue({
        wait: vi.fn().mockResolvedValue({
          logs: [{
            data: '0x',
            topics: []
          }]
        })
      });

      mockContract.interface.parseLog.mockReturnValue({
        name: 'PassportMinted',
        args: { tokenId }
      });

      const result = await passportRegistry.mint(to, dataHash);
      
      expect(result).toBe(tokenId);
      expect(mockContract.mint).toHaveBeenCalledWith(to, dataHash);
    });

    it('should throw error when no signer available', async () => {
      const passportRegistryNoSigner = new PassportRegistry({
        ...mockConfig,
        signer: undefined
      });

      await expect(
        passportRegistryNoSigner.mint('0x1111111111111111111111111111111111111111', '0x1234')
      ).rejects.toThrow(OpenContextError);
    });

    it('should throw error when transaction fails', async () => {
      mockContract.mint.mockRejectedValue(new Error('Transaction failed'));

      await expect(
        passportRegistry.mint('0x1111111111111111111111111111111111111111', '0x1234')
      ).rejects.toThrow(OpenContextError);
    });

    it('should throw error when PassportMinted event not found', async () => {
      mockContract.mint.mockResolvedValue({
        wait: vi.fn().mockResolvedValue({
          logs: []
        })
      });

      mockContract.interface.parseLog.mockReturnValue(null);

      await expect(
        passportRegistry.mint('0x1111111111111111111111111111111111111111', '0x1234')
      ).rejects.toThrow(OpenContextError);
    });
  });

  describe('revoke', () => {
    it('should revoke a passport successfully', async () => {
      const tokenId = 1n;

      mockContract.revoke.mockResolvedValue({
        wait: vi.fn().mockResolvedValue({})
      });

      await passportRegistry.revoke(tokenId);
      
      expect(mockContract.revoke).toHaveBeenCalledWith(tokenId);
    });

    it('should throw error when no signer available', async () => {
      const passportRegistryNoSigner = new PassportRegistry({
        ...mockConfig,
        signer: undefined
      });

      await expect(
        passportRegistryNoSigner.revoke(1n)
      ).rejects.toThrow(OpenContextError);
    });
  });

  describe('updateDataHash', () => {
    it('should update data hash successfully', async () => {
      const tokenId = 1n;
      const newDataHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

      mockContract.updateDataHash.mockResolvedValue({
        wait: vi.fn().mockResolvedValue({})
      });

      await passportRegistry.updateDataHash(tokenId, newDataHash);
      
      expect(mockContract.updateDataHash).toHaveBeenCalledWith(tokenId, newDataHash);
    });
  });

  describe('getPassport', () => {
    it('should return passport data when exists', async () => {
      const address = '0x1111111111111111111111111111111111111111';
      const tokenId = 1n;
      const owner = address;
      const dataHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

      mockContract.getTokenId.mockResolvedValue(tokenId);
      mockContract.ownerOf.mockResolvedValue(owner);
      mockContract.tokenIdToDataHash.mockResolvedValue(dataHash);

      const result = await passportRegistry.getPassport(address);

      expect(result).toEqual({
        tokenId,
        owner,
        dataHash,
        exists: true
      });
    });

    it('should return null when passport does not exist', async () => {
      const address = '0x1111111111111111111111111111111111111111';
      
      mockContract.getTokenId.mockResolvedValue(0n);

      const result = await passportRegistry.getPassport(address);

      expect(result).toBeNull();
    });

    it('should throw error when contract call fails', async () => {
      const address = '0x1111111111111111111111111111111111111111';
      
      mockContract.getTokenId.mockRejectedValue(new Error('Contract error'));

      await expect(
        passportRegistry.getPassport(address)
      ).rejects.toThrow(OpenContextError);
    });
  });

  describe('hasPassport', () => {
    it('should return true when passport exists', async () => {
      const address = '0x1111111111111111111111111111111111111111';
      
      mockContract.hasPassport.mockResolvedValue(true);

      const result = await passportRegistry.hasPassport(address);

      expect(result).toBe(true);
    });

    it('should return false when passport does not exist', async () => {
      const address = '0x1111111111111111111111111111111111111111';
      
      mockContract.hasPassport.mockResolvedValue(false);

      const result = await passportRegistry.hasPassport(address);

      expect(result).toBe(false);
    });
  });

  describe('getTokenId', () => {
    it('should return token ID', async () => {
      const address = '0x1111111111111111111111111111111111111111';
      const tokenId = 1n;
      
      mockContract.getTokenId.mockResolvedValue(tokenId);

      const result = await passportRegistry.getTokenId(address);

      expect(result).toBe(tokenId);
    });

    it('should return 0 when no passport exists', async () => {
      const address = '0x1111111111111111111111111111111111111111';
      
      mockContract.getTokenId.mockResolvedValue(0n);

      const result = await passportRegistry.getTokenId(address);

      expect(result).toBe(0n);
    });
  });
});