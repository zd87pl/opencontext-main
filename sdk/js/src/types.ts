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

/** Result of `PaymentStream.getStreamInfo(user, provider)`. */
export interface StreamInfo {
  /** Flow rate in Super Token wei per second; 0 when there is no stream. */
  flowRate: bigint;
  /** Payout address the flow was opened to (zero address when there is no stream). */
  receiver: string;
  active: boolean;
}

/** Full `PaymentStream.streams(user, provider)` record. */
export interface Stream extends StreamInfo {
  /** Bytes meters have attributed to this stream. */
  bytesConsumed: bigint;
  /** Block timestamp at which the stream was opened; 0 when there is no stream. */
  startedAt: bigint;
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
  /** The (user, provider) pair has no open stream. */
  STREAM_NOT_ACTIVE = 'STREAM_NOT_ACTIVE',
  /** The (user, provider) pair already has an open stream. */
  STREAM_ALREADY_ACTIVE = 'STREAM_ALREADY_ACTIVE',
  /**
   * Superfluid refused to open, update or close the flow because the user has
   * not granted `PaymentStream` flow-operator permission on the Super Token, or
   * the granted flow-rate allowance is too small. See {@link PaymentStream}.
   */
  FLOW_OPERATOR_PERMISSION = 'FLOW_OPERATOR_PERMISSION',
  /** Superfluid rejected the flow operation for another reason (named in the message). */
  STREAM_OPERATION_FAILED = 'STREAM_OPERATION_FAILED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  /** A feature was used before its prerequisite (IPFS node, encryption key) was configured. */
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  /** Encryption or decryption failed, including wrong-password and tampered-payload cases. */
  ENCRYPTION_FAILED = 'ENCRYPTION_FAILED',
  /** The IPFS node returned an error or unusable data. */
  IPFS_ERROR = 'IPFS_ERROR',
}

export class OpenContextError extends Error {
  constructor(
    public readonly code: SDKError,
    message: string
  ) {
    super(message);
    this.name = 'OpenContextError';
  }
}
