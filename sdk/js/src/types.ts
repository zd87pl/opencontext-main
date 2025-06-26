import type { ethers } from 'ethers';

export interface OpenContextConfig {
  passportRegistryAddress: string;
  contextVaultAddress: string;
  paymentStreamAddress: string;
  superfluidHost?: string;
  usdcxAddress?: string;
  provider: ethers.Provider;
  signer?: ethers.Signer;
}

export interface PassportData {
  tokenId: bigint;
  owner: string;
  dataHash: string;
  exists: boolean;
}

export interface ContextData {
  encryptedData: string;
  timestamp: bigint;
  version: bigint;
}

export interface StreamInfo {
  flowRate: bigint;
  receiver: string;
  active: boolean;
}

export interface DataProvider {
  receiver: string;
  ratePerByte: bigint;
  totalBytesServed: bigint;
  active: boolean;
}

export enum SDKError {
  NO_SIGNER = 'NO_SIGNER',
  NO_PASSPORT = 'NO_PASSPORT',
  INVALID_ADDRESS = 'INVALID_ADDRESS',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  INVALID_FLOW_RATE = 'INVALID_FLOW_RATE',
  PROVIDER_NOT_ACTIVE = 'PROVIDER_NOT_ACTIVE',
  UNAUTHORIZED = 'UNAUTHORIZED',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
}

export class OpenContextError extends Error {
  constructor(public code: SDKError, message: string) {
    super(message);
    this.name = 'OpenContextError';
  }
}