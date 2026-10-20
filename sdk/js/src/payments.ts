import { ethers } from 'ethers';
import { PAYMENT_STREAM_ABI } from './constants.js';
import { getErrorMessage, isRevertError } from './errors.js';
import {
  OpenContextError,
  SDKError,
  type OpenContextConfig,
  type StreamInfo,
  type DataProvider,
} from './types.js';

/** Fixed-point scale used by `PaymentStream.sol` for `ratePerByte`. */
const RATE_PRECISION = 10n ** 18n;
const SECONDS_PER_MONTH = 30n * 24n * 60n * 60n;

/**
 * Wrapper around `PaymentStream.sol`, the Superfluid-backed streaming payment
 * contract.
 */
export class PaymentStream {
  private contract: ethers.Contract;
  private config: OpenContextConfig;

  constructor(config: OpenContextConfig) {
    this.config = config;
    this.contract = new ethers.Contract(
      config.paymentStreamAddress,
      PAYMENT_STREAM_ABI,
      config.signer || config.provider
    );
  }

  async registerProvider(receiver: string, ratePerByte: bigint): Promise<void> {
    this.requireSigner('registration');

    try {
      const tx = await this.contract.registerProvider(receiver, ratePerByte);
      await tx.wait();
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Register provider failed: ${getErrorMessage(error)}`
      );
    }
  }

  async updateProviderRate(newRate: bigint): Promise<void> {
    this.requireSigner('update');

    try {
      const tx = await this.contract.updateProviderRate(newRate);
      await tx.wait();
    } catch (error) {
      if (isRevertError(error, 'ProviderNotActive')) {
        throw new OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, 'Provider not active');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Update rate failed: ${getErrorMessage(error)}`
      );
    }
  }

  async startStream(provider: string, bytesPerSecond: bigint): Promise<void> {
    this.requireSigner('streaming');

    try {
      const tx = await this.contract.startStream(provider, bytesPerSecond);
      await tx.wait();
    } catch (error) {
      throw this.mapStreamError(error, 'Start stream failed');
    }
  }

  async updateStream(provider: string, newBytesPerSecond: bigint): Promise<void> {
    this.requireSigner('update');

    try {
      const tx = await this.contract.updateStream(provider, newBytesPerSecond);
      await tx.wait();
    } catch (error) {
      throw this.mapStreamError(error, 'Update stream failed');
    }
  }

  async stopStream(provider: string): Promise<void> {
    this.requireSigner('stopping');

    try {
      const tx = await this.contract.stopStream(provider);
      await tx.wait();
    } catch (error) {
      if (isRevertError(error, 'NotPassportHolder')) {
        throw new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Stop stream failed: ${getErrorMessage(error)}`
      );
    }
  }

  async recordConsumption(tokenId: bigint, bytesConsumed: bigint): Promise<void> {
    this.requireSigner('recording');

    try {
      const tx = await this.contract.recordConsumption(tokenId, bytesConsumed);
      await tx.wait();
    } catch (error) {
      if (isRevertError(error, 'ProviderNotActive')) {
        throw new OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, 'Provider not active');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Record consumption failed: ${getErrorMessage(error)}`
      );
    }
  }

  async getStreamInfo(tokenId: bigint, provider: string): Promise<StreamInfo> {
    try {
      const [rawFlowRate, receiver] = await this.contract.getStreamInfo(tokenId, provider);
      const flowRate = BigInt(rawFlowRate);

      return {
        flowRate,
        receiver,
        active: flowRate > 0n,
      };
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get stream info failed: ${getErrorMessage(error)}`
      );
    }
  }

  async getProvider(address: string): Promise<DataProvider | null> {
    try {
      const [receiver, ratePerByte, totalBytesServed, active] =
        await this.contract.dataProviders(address);

      if (!active) {
        return null;
      }

      return {
        receiver,
        ratePerByte: BigInt(ratePerByte),
        totalBytesServed: BigInt(totalBytesServed),
        active: true,
      };
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get provider failed: ${getErrorMessage(error)}`
      );
    }
  }

  async getActiveFlowRate(tokenId: bigint, provider: string): Promise<bigint> {
    try {
      const flowRate = await this.contract.activeStreams(tokenId, provider);
      return BigInt(flowRate);
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get flow rate failed: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * Flow rate (token units per second) for a provider rate and throughput,
   * using the same integer arithmetic as the contract.
   */
  calculateFlowRate(ratePerByte: bigint, bytesPerSecond: bigint): bigint {
    return (ratePerByte * bytesPerSecond) / RATE_PRECISION;
  }

  /**
   * Cost of a stream over a 30-day month at the given throughput.
   */
  calculateMonthlyCost(ratePerByte: bigint, bytesPerSecond: bigint): bigint {
    return this.calculateFlowRate(ratePerByte, bytesPerSecond) * SECONDS_PER_MONTH;
  }

  private requireSigner(action: string): void {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, `Signer required for ${action}`);
    }
  }

  private mapStreamError(error: unknown, prefix: string): OpenContextError {
    if (isRevertError(error, 'NotPassportHolder')) {
      return new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
    }
    if (isRevertError(error, 'ProviderNotActive')) {
      return new OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, 'Provider not active');
    }
    if (isRevertError(error, 'InvalidFlowRate')) {
      return new OpenContextError(SDKError.INVALID_FLOW_RATE, 'Invalid flow rate');
    }
    return new OpenContextError(
      SDKError.TRANSACTION_FAILED,
      `${prefix}: ${getErrorMessage(error)}`
    );
  }
}
