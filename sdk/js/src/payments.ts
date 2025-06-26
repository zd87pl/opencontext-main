import { ethers } from 'ethers';
import { PAYMENT_STREAM_ABI } from './constants.js';
import { OpenContextError, SDKError, type OpenContextConfig, type StreamInfo, type DataProvider } from './types.js';

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
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for registration');
    }

    try {
      const tx = await this.contract.registerProvider(receiver, ratePerByte);
      await tx.wait();
    } catch (error: any) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Register provider failed: ${error.message}`
      );
    }
  }

  async updateProviderRate(newRate: bigint): Promise<void> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for update');
    }

    try {
      const tx = await this.contract.updateProviderRate(newRate);
      await tx.wait();
    } catch (error: any) {
      if (error.message.includes('ProviderNotActive')) {
        throw new OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, 'Provider not active');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Update rate failed: ${error.message}`
      );
    }
  }

  async startStream(provider: string, bytesPerSecond: bigint): Promise<void> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for streaming');
    }

    try {
      const tx = await this.contract.startStream(provider, bytesPerSecond);
      await tx.wait();
    } catch (error: any) {
      if (error.message.includes('NotPassportHolder')) {
        throw new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
      } else if (error.message.includes('ProviderNotActive')) {
        throw new OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, 'Provider not active');
      } else if (error.message.includes('InvalidFlowRate')) {
        throw new OpenContextError(SDKError.INVALID_FLOW_RATE, 'Invalid flow rate');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Start stream failed: ${error.message}`
      );
    }
  }

  async updateStream(provider: string, newBytesPerSecond: bigint): Promise<void> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for update');
    }

    try {
      const tx = await this.contract.updateStream(provider, newBytesPerSecond);
      await tx.wait();
    } catch (error: any) {
      if (error.message.includes('NotPassportHolder')) {
        throw new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
      } else if (error.message.includes('ProviderNotActive')) {
        throw new OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, 'Provider not active');
      } else if (error.message.includes('InvalidFlowRate')) {
        throw new OpenContextError(SDKError.INVALID_FLOW_RATE, 'Invalid flow rate');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Update stream failed: ${error.message}`
      );
    }
  }

  async stopStream(provider: string): Promise<void> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for stopping');
    }

    try {
      const tx = await this.contract.stopStream(provider);
      await tx.wait();
    } catch (error: any) {
      if (error.message.includes('NotPassportHolder')) {
        throw new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Stop stream failed: ${error.message}`
      );
    }
  }

  async recordConsumption(tokenId: bigint, bytesConsumed: bigint): Promise<void> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for recording');
    }

    try {
      const tx = await this.contract.recordConsumption(tokenId, bytesConsumed);
      await tx.wait();
    } catch (error: any) {
      if (error.message.includes('ProviderNotActive')) {
        throw new OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, 'Provider not active');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Record consumption failed: ${error.message}`
      );
    }
  }

  async getStreamInfo(tokenId: bigint, provider: string): Promise<StreamInfo> {
    try {
      const [flowRate, receiver] = await this.contract.getStreamInfo(tokenId, provider);
      
      return {
        flowRate: BigInt(flowRate),
        receiver,
        active: flowRate > 0,
      };
    } catch (error: any) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get stream info failed: ${error.message}`
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
        ratePerByte,
        totalBytesServed,
        active,
      };
    } catch (error: any) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get provider failed: ${error.message}`
      );
    }
  }

  async getActiveFlowRate(tokenId: bigint, provider: string): Promise<bigint> {
    try {
      const flowRate = await this.contract.activeStreams(tokenId, provider);
      return BigInt(flowRate);
    } catch (error: any) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get flow rate failed: ${error.message}`
      );
    }
  }

  calculateFlowRate(ratePerByte: bigint, bytesPerSecond: bigint): bigint {
    const RATE_PRECISION = 10n ** 18n;
    return (ratePerByte * bytesPerSecond) / RATE_PRECISION;
  }

  calculateMonthlyCost(ratePerByte: bigint, bytesPerSecond: bigint): bigint {
    const secondsPerMonth = 30n * 24n * 60n * 60n;
    const flowRate = this.calculateFlowRate(ratePerByte, bytesPerSecond);
    return flowRate * secondsPerMonth;
  }
}