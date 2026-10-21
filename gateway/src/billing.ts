/**
 * Superfluid constant-flow billing.
 *
 * The gateway never holds user keys, so it cannot open or close flows itself. Instead it:
 *  1. builds the unsigned `CFAv1Forwarder` calldata a client signs from its own wallet,
 *  2. verifies on-chain (via `getFlowrate`) that the flow exists before registering a stream,
 *  3. tracks which passport/partner pairs have an active stream and what they have accrued.
 *
 * Talks to the chain with ethers v6 directly; the official `@superfluid-finance/sdk-core` is
 * pinned to ethers v5 and is not used.
 */

import { ethers } from 'ethers';
import type { PaymentStreamSession } from './types.js';
import { MemoryStorage, type StorageAdapter } from './storage.js';
import { ConflictError, NotFoundError, ValidationError } from './validation.js';

/** CFAv1Forwarder is deployed at the same address on every Superfluid network. */
export const CFA_V1_FORWARDER_ADDRESS = '0xcfA132E353cB4E398080B9700609bb008eceB125';
/** Super USDC (USDCx) on Base mainnet. */
export const BASE_USDCX_ADDRESS = '0xD04383398dD2426297da660F9CCA3d439AF9ce1b';
export const BASE_CHAIN_ID = 8453;

export const CFA_V1_FORWARDER_ABI = [
  'function createFlow(address token, address sender, address receiver, int96 flowrate, bytes userData) returns (bool)',
  'function updateFlow(address token, address sender, address receiver, int96 flowrate, bytes userData) returns (bool)',
  'function deleteFlow(address token, address sender, address receiver, bytes userData) returns (bool)',
  'function getFlowrate(address token, address sender, address receiver) view returns (int96 flowrate)',
  'function getFlowInfo(address token, address sender, address receiver) view returns (uint256 lastUpdated, int96 flowrate, uint256 deposit, uint256 owedDeposit)',
  'function getAccountFlowrate(address token, address account) view returns (int96 flowrate)',
] as const;

/** Largest value an int96 can hold. */
const MAX_INT96 = (1n << 95n) - 1n;

/** Reads flow state from the chain; swapped for a fake in tests. */
export interface FlowReader {
  getFlowrate(token: string, sender: string, receiver: string): Promise<bigint>;
}

export interface BillingOptions {
  provider?: ethers.Provider;
  /** Used to build a JSON-RPC provider when `provider` and `flowReader` are absent. */
  rpcUrl?: string;
  chainId?: number;
  superToken?: string;
  forwarder?: string;
  flowReader?: FlowReader;
  storage?: StorageAdapter;
}

/** A transaction for the client to sign and broadcast. */
export interface UnsignedTransaction {
  to: string;
  data: string;
  value: string;
  chainId: number;
}

export class StreamNotActiveOnChainError extends ConflictError {
  constructor(
    public readonly onChainFlowRate: bigint,
    requested: bigint
  ) {
    super(
      `On-chain flow rate ${onChainFlowRate} is below the requested ${requested} wei/s; ` +
        'create or update the flow from the sender wallet first'
    );
  }
}

function checksum(address: string, field: string): string {
  try {
    return ethers.getAddress(address);
  } catch {
    throw new ValidationError(`Invalid address for ${field}`, [
      { field, message: 'Invalid Ethereum address', code: 'invalid_address' },
    ]);
  }
}

function toFlowRate(value: bigint | string): bigint {
  let rate: bigint;
  try {
    rate = BigInt(value);
  } catch {
    throw new ValidationError('flowRate must be an integer wei-per-second amount', [
      { field: 'flowRate', message: 'Not an integer', code: 'invalid_type' },
    ]);
  }
  if (rate <= 0n || rate > MAX_INT96) {
    throw new ValidationError('flowRate must be between 1 and 2^95-1 wei per second', [
      { field: 'flowRate', message: 'Out of range', code: 'out_of_range' },
    ]);
  }
  return rate;
}

export class BillingService {
  readonly chainId: number;
  readonly superToken: string;
  readonly forwarder: string;
  private readonly iface = new ethers.Interface(CFA_V1_FORWARDER_ABI);
  private readonly storage: StorageAdapter;
  private readonly options: BillingOptions;
  private flowReader: FlowReader | null;

  constructor(options: BillingOptions = {}) {
    this.options = options;
    this.chainId = options.chainId ?? BASE_CHAIN_ID;
    this.superToken = checksum(options.superToken ?? BASE_USDCX_ADDRESS, 'superToken');
    this.forwarder = checksum(options.forwarder ?? CFA_V1_FORWARDER_ADDRESS, 'forwarder');
    this.storage = options.storage ?? new MemoryStorage();
    this.flowReader = options.flowReader ?? null;
  }

  /** Lazily connect so that constructing the service never touches the network. */
  private reader(): FlowReader {
    if (!this.flowReader) {
      const provider =
        this.options.provider ??
        new ethers.JsonRpcProvider(this.options.rpcUrl ?? 'https://mainnet.base.org', this.chainId, {
          staticNetwork: true,
        });
      const contract = new ethers.Contract(this.forwarder, CFA_V1_FORWARDER_ABI, provider);
      this.flowReader = {
        getFlowrate: async (token, sender, receiver) =>
          BigInt(await contract.getFlowrate(token, sender, receiver)),
      };
    }
    return this.flowReader;
  }

  // ---- unsigned transactions --------------------------------------------------------------

  buildCreateFlowTx(sender: string, receiver: string, flowRate: bigint | string): UnsignedTransaction {
    return this.encode('createFlow', [
      this.superToken,
      checksum(sender, 'sender'),
      checksum(receiver, 'receiver'),
      toFlowRate(flowRate),
      '0x',
    ]);
  }

  buildUpdateFlowTx(sender: string, receiver: string, flowRate: bigint | string): UnsignedTransaction {
    return this.encode('updateFlow', [
      this.superToken,
      checksum(sender, 'sender'),
      checksum(receiver, 'receiver'),
      toFlowRate(flowRate),
      '0x',
    ]);
  }

  buildDeleteFlowTx(sender: string, receiver: string): UnsignedTransaction {
    return this.encode('deleteFlow', [
      this.superToken,
      checksum(sender, 'sender'),
      checksum(receiver, 'receiver'),
      '0x',
    ]);
  }

  private encode(fn: string, args: unknown[]): UnsignedTransaction {
    return {
      to: this.forwarder,
      data: this.iface.encodeFunctionData(fn, args),
      value: '0',
      chainId: this.chainId,
    };
  }

  // ---- chain reads ------------------------------------------------------------------------

  /** Current wei/s flowing from `sender` to `receiver` in the configured Super Token. */
  async getFlowRate(sender: string, receiver: string): Promise<bigint> {
    return this.reader().getFlowrate(
      this.superToken,
      checksum(sender, 'sender'),
      checksum(receiver, 'receiver')
    );
  }

  // ---- stream registry --------------------------------------------------------------------

  private key(passportId: string, partnerId: string): string {
    return `billing:stream:${passportId}:${partnerId}`;
  }

  async getStream(passportId: string, partnerId: string): Promise<PaymentStreamSession | undefined> {
    const raw = await this.storage.get(this.key(passportId, partnerId));
    return raw ? (JSON.parse(raw) as PaymentStreamSession) : undefined;
  }

  private async saveStream(session: PaymentStreamSession): Promise<void> {
    await this.storage.set(this.key(session.passportId, session.partnerId), JSON.stringify(session));
    await this.storage.hset(`billing:streams:${session.passportId}`, session.partnerId, '1');
    await this.storage.hset('billing:streams', `${session.passportId}:${session.partnerId}`, '1');
  }

  /**
   * Register a stream after verifying that the sender really is streaming at least `flowRate`
   * wei/s to the receiver on-chain.
   */
  async startStream(
    passportId: string,
    partnerId: string,
    sender: string,
    receiver: string,
    flowRate: bigint | string
  ): Promise<PaymentStreamSession> {
    const requested = toFlowRate(flowRate);
    const senderAddress = checksum(sender, 'sender');
    const receiverAddress = checksum(receiver, 'receiver');

    const existing = await this.getStream(passportId, partnerId);
    if (existing?.active) {
      throw new ConflictError('Stream already active for this passport/partner');
    }

    const onChain = await this.getFlowRate(senderAddress, receiverAddress);
    if (onChain < requested) {
      throw new StreamNotActiveOnChainError(onChain, requested);
    }

    const session: PaymentStreamSession = {
      passportId,
      partnerId,
      sender: senderAddress,
      receiver: receiverAddress,
      token: this.superToken,
      flowRate: requested.toString(),
      startTime: Date.now(),
      active: true,
    };
    await this.saveStream(session);
    return session;
  }

  /**
   * Deregister a stream. The on-chain flow is the sender's to delete (see `buildDeleteFlowTx`);
   * the current on-chain rate is returned so callers can tell whether it is still running.
   */
  async stopStream(
    passportId: string,
    partnerId: string
  ): Promise<{ session: PaymentStreamSession; onChainFlowRate: bigint }> {
    const session = await this.getStream(passportId, partnerId);
    if (!session || !session.active) {
      throw new NotFoundError('No active stream found');
    }

    session.active = false;
    session.stopTime = Date.now();
    await this.saveStream(session);

    const onChainFlowRate = await this.getFlowRate(session.sender, session.receiver).catch(() => -1n);
    return { session, onChainFlowRate };
  }

  /** Active streams, oldest first, optionally for one passport. */
  async getActiveStreams(passportId?: string): Promise<PaymentStreamSession[]> {
    const entries = passportId
      ? Object.keys(await this.storage.hgetall(`billing:streams:${passportId}`)).map(
          (partnerId) => [passportId, partnerId] as const
        )
      : Object.keys(await this.storage.hgetall('billing:streams')).map((entry) => {
          const separator = entry.lastIndexOf(':');
          return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
        });

    const streams: PaymentStreamSession[] = [];
    for (const [passport, partner] of entries) {
      const session = await this.getStream(passport, partner);
      if (session?.active) streams.push(session);
    }
    return streams.sort((a, b) => a.startTime - b.startTime);
  }

  /** Wei accrued by a stream so far (or until it was stopped). */
  calculateAccruedCost(session: PaymentStreamSession, now = Date.now()): string {
    const end = session.active ? now : (session.stopTime ?? now);
    const elapsedSeconds = Math.max(0, Math.floor((end - session.startTime) / 1000));
    return (BigInt(session.flowRate) * BigInt(elapsedSeconds)).toString();
  }

  async close(): Promise<void> {
    await this.storage.close();
  }
}
