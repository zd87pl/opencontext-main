import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
import { OpenContextClient } from '../src/client.js';
import { SDKError } from '../src/types.js';

describe('OpenContextClient', () => {
  let client: OpenContextClient;
  let mockProvider: any;
  let mockSigner: any;

  beforeEach(() => {
    mockProvider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 300 }),
    };
    
    mockSigner = {
      getAddress: vi.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
      provider: mockProvider,
    };

    client = new OpenContextClient({
      provider: mockProvider,
      signer: mockSigner,
      passportRegistryAddress: '0x0000000000000000000000000000000000000001',
      contextVaultAddress: '0x0000000000000000000000000000000000000002',
      paymentStreamAddress: '0x0000000000000000000000000000000000000003',
    });
  });

  describe('authenticate', () => {
    it('should throw error if no signer', async () => {
      const clientNoSigner = new OpenContextClient({
        provider: mockProvider,
        passportRegistryAddress: '0x0000000000000000000000000000000000000001',
        contextVaultAddress: '0x0000000000000000000000000000000000000002',
        paymentStreamAddress: '0x0000000000000000000000000000000000000003',
      });

      await expect(clientNoSigner.authenticate()).rejects.toThrow('Signer required');
    });
  });

  describe('create', () => {
    it('should create client instance', async () => {
      const newClient = await OpenContextClient.create(
        'https://sepolia.era.zksync.dev',
        '0x0000000000000000000000000000000000000000000000000000000000000001',
        {
          passportRegistry: '0x0000000000000000000000000000000000000001',
          contextVault: '0x0000000000000000000000000000000000000002',
          paymentStream: '0x0000000000000000000000000000000000000003',
        }
      );

      expect(newClient).toBeInstanceOf(OpenContextClient);
      expect(newClient.passport).toBeDefined();
      expect(newClient.vault).toBeDefined();
      expect(newClient.payments).toBeDefined();
    });
  });
});