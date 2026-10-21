import type { ethers } from 'ethers';

interface ReceiptLike {
  logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string }>;
}

/**
 * Decoded arguments of the first `eventName` log in a receipt, or undefined.
 *
 * Logs emitted by other contracts in the same transaction either do not match
 * the interface (parseLog returns null) or fail to decode; both are skipped.
 */
export function findEventArgs(
  iface: ethers.Interface,
  receipt: ReceiptLike | null | undefined,
  eventName: string
): ethers.Result | undefined {
  if (!receipt) {
    return undefined;
  }
  for (const log of receipt.logs) {
    let parsed: ethers.LogDescription | null;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed?.name === eventName) {
      return parsed.args;
    }
  }
  return undefined;
}
