import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  CONTEXT_VAULT_ABI,
  CONTEXT_VAULT_IPFS_ABI,
  PASSPORT_REGISTRY_ABI,
  PAYMENT_STREAM_ABI,
} from '../src/constants.js';
import { COMPILED_ABI } from './compiled-abi.js';

/**
 * The SDK ABIs are hand-written subsets of the contracts. Each fragment must
 * exist in the compiled contract with the same inputs, outputs, mutability and
 * indexed event arguments, or calls would be sent to selectors that do not
 * exist and return data would be mis-decoded. Regenerate the snapshot with
 * `node scripts/compiled-abi.mjs` after changing a contract.
 */
describe.each([
  ['PASSPORT_REGISTRY_ABI', PASSPORT_REGISTRY_ABI, 'PassportRegistry'],
  ['CONTEXT_VAULT_ABI', CONTEXT_VAULT_ABI, 'ContextVault'],
  ['CONTEXT_VAULT_IPFS_ABI', CONTEXT_VAULT_IPFS_ABI, 'ContextVaultIPFS'],
  ['PAYMENT_STREAM_ABI', PAYMENT_STREAM_ABI, 'PaymentStream'],
])('%s', (_name, abi, contract) => {
  const compiled = new Set(COMPILED_ABI[contract]);

  it('only contains fragments the compiled contract has', () => {
    const iface = new ethers.Interface(abi);
    const missing = iface.fragments
      .map((fragment) => fragment.format('minimal'))
      .filter((fragment) => !compiled.has(fragment));

    expect(missing).toEqual([]);
  });

  it('declares every custom error, so reverts decode by name', () => {
    const iface = new ethers.Interface(abi);
    const declared = new Set<string>();
    iface.forEachError((fragment) => declared.add(fragment.format('minimal')));

    const compiledErrors = [...compiled].filter((fragment) => fragment.startsWith('error '));
    expect([...declared].sort()).toEqual(compiledErrors.sort());
  });
});

describe('PAYMENT_STREAM_ABI', () => {
  it('keys streams by (user, provider) and meters consumption per user', () => {
    const iface = new ethers.Interface(PAYMENT_STREAM_ABI);

    expect(iface.getFunction('recordConsumption')?.format('minimal')).toBe(
      'function recordConsumption(address,address,uint256)'
    );
    expect(iface.getFunction('getStreamInfo')?.format('minimal')).toBe(
      'function getStreamInfo(address,address) view returns (int96,address)'
    );
    expect(iface.getFunction('streams')?.format('minimal')).toBe(
      'function streams(address,address) view returns (address,int96,uint256,uint256)'
    );
    // Removed in c4f2afd in favour of `streams`.
    expect(iface.hasFunction('activeStreams(uint256,address)')).toBe(false);
  });
});
