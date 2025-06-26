import { ethers } from 'ethers';
import { PASSPORT_REGISTRY_ABI } from './constants.js';
import { OpenContextError, SDKError, type OpenContextConfig, type PassportData } from './types.js';

export class PassportRegistry {
  private contract: ethers.Contract;
  private config: OpenContextConfig;

  constructor(config: OpenContextConfig) {
    this.config = config;
    this.contract = new ethers.Contract(
      config.passportRegistryAddress,
      PASSPORT_REGISTRY_ABI,
      config.signer || config.provider
    );
  }

  async mint(to: string, dataHash: string): Promise<bigint> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for minting');
    }

    try {
      const tx = await this.contract.mint(to, dataHash);
      const receipt = await tx.wait();
      
      const event = receipt.logs
        .map((log: any) => this.contract.interface.parseLog(log))
        .find((parsed: any) => parsed?.name === 'PassportMinted');
      
      if (!event) {
        throw new Error('PassportMinted event not found');
      }
      
      return event.args.tokenId;
    } catch (error: any) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Mint failed: ${error.message}`
      );
    }
  }

  async revoke(tokenId: bigint): Promise<void> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for revoking');
    }

    try {
      const tx = await this.contract.revoke(tokenId);
      await tx.wait();
    } catch (error: any) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Revoke failed: ${error.message}`
      );
    }
  }

  async updateDataHash(tokenId: bigint, newDataHash: string): Promise<void> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for updating');
    }

    try {
      const tx = await this.contract.updateDataHash(tokenId, newDataHash);
      await tx.wait();
    } catch (error: any) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Update failed: ${error.message}`
      );
    }
  }

  async getPassport(address: string): Promise<PassportData | null> {
    try {
      const tokenId = await this.contract.getTokenId(address);
      
      if (tokenId === 0n) {
        return null;
      }

      const [owner, dataHash] = await Promise.all([
        this.contract.ownerOf(tokenId),
        this.contract.tokenIdToDataHash(tokenId),
      ]);

      return {
        tokenId,
        owner,
        dataHash,
        exists: true,
      };
    } catch (error: any) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get passport failed: ${error.message}`
      );
    }
  }

  async hasPassport(address: string): Promise<boolean> {
    try {
      return await this.contract.hasPassport(address);
    } catch (error: any) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Check passport failed: ${error.message}`
      );
    }
  }

  async getTokenId(address: string): Promise<bigint> {
    try {
      return await this.contract.getTokenId(address);
    } catch (error: any) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get token ID failed: ${error.message}`
      );
    }
  }
}