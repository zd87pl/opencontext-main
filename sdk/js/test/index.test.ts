import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import * as sdk from '../src/index.js';

describe('package entry point', () => {
  it('exports the public API', () => {
    expect(sdk.OpenContextClient).toBeTypeOf('function');
    expect(sdk.PassportRegistry).toBeTypeOf('function');
    expect(sdk.ContextVault).toBeTypeOf('function');
    expect(sdk.PaymentStream).toBeTypeOf('function');
    expect(sdk.ContextCrypto).toBeTypeOf('function');
    expect(sdk.IPFSService).toBeTypeOf('function');
    expect(sdk.OpenContextError).toBeTypeOf('function');
    expect(sdk.SDKError.NO_SIGNER).toBe('NO_SIGNER');
    expect(sdk.NETWORKS.zkSyncSepolia.chainId).toBe(300);
    expect(sdk.DEFAULT_STORAGE_QUOTA).toBe(10n * 1024n * 1024n);
  });

  it('ships ABIs that ethers parses in full', () => {
    const abis = [
      sdk.PASSPORT_REGISTRY_ABI,
      sdk.CONTEXT_VAULT_ABI,
      sdk.CONTEXT_VAULT_IPFS_ABI,
      sdk.PAYMENT_STREAM_ABI,
    ];
    for (const abi of abis) {
      // ethers drops fragments it cannot parse with a console warning; the
      // count check turns that into a failure.
      const iface = new ethers.Interface(abi);
      expect(iface.fragments).toHaveLength(abi.length);
    }
  });

  it('free functions delegate to the client', async () => {
    const client = {
      authenticate: vi.fn().mockResolvedValue('passport'),
      storeContext: vi.fn().mockResolvedValue(1n),
      getMyLatestContext: vi.fn().mockResolvedValue('ctx'),
      streamPay: vi.fn().mockResolvedValue(undefined),
    } as unknown as sdk.OpenContextClient;

    await expect(sdk.authenticate(client)).resolves.toBe('passport');
    await expect(sdk.storeContext(client, 'data')).resolves.toBe(1n);
    await expect(sdk.getLatestContext(client)).resolves.toBe('ctx');
    await expect(sdk.streamPay(client, 'provider', 2n)).resolves.toBeUndefined();

    expect(client.storeContext).toHaveBeenCalledWith('data');
    expect(client.streamPay).toHaveBeenCalledWith('provider', 2n);
  });
});
