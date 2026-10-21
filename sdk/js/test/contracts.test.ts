import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { findEventArgs } from '../src/contracts.js';
import { PASSPORT_REGISTRY_ABI } from '../src/constants.js';

const iface = new ethers.Interface(PASSPORT_REGISTRY_ABI);
const TO = '0x1111111111111111111111111111111111111111';

describe('findEventArgs', () => {
  it('decodes the named event from a real receipt log', () => {
    const minted = iface.encodeEventLog('PassportMinted', [TO, 7n]);
    const revoked = iface.encodeEventLog('PassportRevoked', [7n, TO]);

    const args = findEventArgs(iface, { logs: [revoked, minted] }, 'PassportMinted');

    expect(args?.tokenId).toBe(7n);
    expect(args?.to).toBe(TO);
  });

  it('returns undefined without a receipt or a matching log', () => {
    const revoked = iface.encodeEventLog('PassportRevoked', [7n, TO]);

    expect(findEventArgs(iface, null, 'PassportMinted')).toBeUndefined();
    expect(findEventArgs(iface, { logs: [] }, 'PassportMinted')).toBeUndefined();
    expect(findEventArgs(iface, { logs: [revoked] }, 'PassportMinted')).toBeUndefined();
  });

  it('skips logs the interface cannot decode', () => {
    const throwing = {
      parseLog: () => {
        throw new Error('malformed log');
      },
    } as unknown as ethers.Interface;

    expect(
      findEventArgs(throwing, { logs: [{ topics: [], data: '0x' }] }, 'PassportMinted')
    ).toBeUndefined();
  });
});
