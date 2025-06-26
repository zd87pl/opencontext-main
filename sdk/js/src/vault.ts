import { ethers } from 'ethers';
import { CONTEXT_VAULT_ABI } from './constants.js';
import { OpenContextError, SDKError, type OpenContextConfig, type ContextData } from './types.js';

export class ContextVault {
  private contract: ethers.Contract;
  private config: OpenContextConfig;

  constructor(config: OpenContextConfig) {
    this.config = config;
    this.contract = new ethers.Contract(
      config.contextVaultAddress,
      CONTEXT_VAULT_ABI,
      config.signer || config.provider
    );
  }

  async storeContext(encryptedData: string): Promise<bigint> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for storing context');
    }

    try {
      const dataBytes = ethers.toUtf8Bytes(encryptedData);
      const tx = await this.contract.storeContext(dataBytes);
      const receipt = await tx.wait();
      
      const event = receipt.logs
        .map((log: any) => this.contract.interface.parseLog(log))
        .find((parsed: any) => parsed?.name === 'ContextStored');
      
      if (!event) {
        throw new Error('ContextStored event not found');
      }
      
      return event.args.version;
    } catch (error: any) {
      if (error.message.includes('NoPassport')) {
        throw new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
      } else if (error.message.includes('QuotaExceeded')) {
        throw new OpenContextError(SDKError.QUOTA_EXCEEDED, 'Storage quota exceeded');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Store context failed: ${error.message}`
      );
    }
  }

  async getContext(tokenId: bigint, version: bigint): Promise<ContextData> {
    try {
      const [dataBytes, timestamp] = await this.contract.getContext(tokenId, version);
      
      return {
        encryptedData: ethers.toUtf8String(dataBytes),
        timestamp,
        version,
      };
    } catch (error: any) {
      if (error.message.includes('NotAuthorizedReader')) {
        throw new OpenContextError(SDKError.UNAUTHORIZED, 'Not authorized to read context');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get context failed: ${error.message}`
      );
    }
  }

  async getLatestContext(tokenId: bigint): Promise<ContextData | null> {
    try {
      const [dataBytes, timestamp, version] = await this.contract.getLatestContext(tokenId);
      
      if (dataBytes === '0x') {
        return null;
      }
      
      return {
        encryptedData: ethers.toUtf8String(dataBytes),
        timestamp,
        version,
      };
    } catch (error: any) {
      if (error.message.includes('NotAuthorizedReader')) {
        throw new OpenContextError(SDKError.UNAUTHORIZED, 'Not authorized to read context');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get latest context failed: ${error.message}`
      );
    }
  }

  async getContextCount(tokenId: bigint): Promise<bigint> {
    try {
      return await this.contract.getContextCount(tokenId);
    } catch (error: any) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get context count failed: ${error.message}`
      );
    }
  }

  async authorizeReader(reader: string): Promise<void> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for authorization');
    }

    try {
      const tx = await this.contract.authorizeReader(reader);
      await tx.wait();
    } catch (error: any) {
      if (error.message.includes('NoPassport')) {
        throw new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Authorize reader failed: ${error.message}`
      );
    }
  }

  async revokeReader(reader: string): Promise<void> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for revocation');
    }

    try {
      const tx = await this.contract.revokeReader(reader);
      await tx.wait();
    } catch (error: any) {
      if (error.message.includes('NoPassport')) {
        throw new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Revoke reader failed: ${error.message}`
      );
    }
  }

  async deleteContext(version: bigint): Promise<void> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for deletion');
    }

    try {
      const tx = await this.contract.deleteContext(version);
      await tx.wait();
    } catch (error: any) {
      if (error.message.includes('NoPassport')) {
        throw new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Delete context failed: ${error.message}`
      );
    }
  }

  async isAuthorizedReader(tokenId: bigint, reader: string): Promise<boolean> {
    try {
      return await this.contract.authorizedReaders(tokenId, reader);
    } catch (error: any) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Check authorization failed: ${error.message}`
      );
    }
  }

  async getStorageQuota(tokenId: bigint): Promise<bigint> {
    try {
      const quota = await this.contract.storageQuota(tokenId);
      return quota === 0n ? 10n * 1024n * 1024n : quota; // Default 10MB
    } catch (error: any) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get storage quota failed: ${error.message}`
      );
    }
  }
}