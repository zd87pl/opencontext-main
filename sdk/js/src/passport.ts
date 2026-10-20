import { ethers } from 'ethers';
import { PASSPORT_REGISTRY_ABI } from './constants.js';
import { findEventArgs } from './contracts.js';
import { getErrorMessage, isRevertError } from './errors.js';
import { OpenContextError, SDKError, type OpenContextConfig, type PassportData } from './types.js';

/**
 * Wrapper around `PassportRegistry.sol`, the soulbound identity token.
 */
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

  /**
   * Mint a passport for `to`. The signer must be an authorized minter.
   */
  async mint(to: string, dataHash: string): Promise<bigint> {
    this.requireSigner('minting');

    try {
      const tx = await this.contract.mint(to, dataHash);
      const receipt = await tx.wait();
      const args = findEventArgs(this.contract.interface, receipt, 'PassportMinted');
      if (!args) {
        throw new Error('PassportMinted event not found');
      }
      return BigInt(args.tokenId);
    } catch (error) {
      if (isRevertError(error, 'AlreadyMinted')) {
        throw new OpenContextError(SDKError.TRANSACTION_FAILED, 'Address already has a passport');
      }
      if (isRevertError(error, 'NotAuthorized')) {
        throw new OpenContextError(SDKError.UNAUTHORIZED, 'Signer is not an authorized minter');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Mint failed: ${getErrorMessage(error)}`
      );
    }
  }

  async revoke(tokenId: bigint): Promise<void> {
    this.requireSigner('revoking');

    try {
      const tx = await this.contract.revoke(tokenId);
      await tx.wait();
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Revoke failed: ${getErrorMessage(error)}`
      );
    }
  }

  async updateDataHash(tokenId: bigint, newDataHash: string): Promise<void> {
    this.requireSigner('updating');

    try {
      const tx = await this.contract.updateDataHash(tokenId, newDataHash);
      await tx.wait();
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Update failed: ${getErrorMessage(error)}`
      );
    }
  }

  async getPassport(address: string): Promise<PassportData | null> {
    try {
      const tokenId = BigInt(await this.contract.getTokenId(address));

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
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get passport failed: ${getErrorMessage(error)}`
      );
    }
  }

  async hasPassport(address: string): Promise<boolean> {
    try {
      return await this.contract.hasPassport(address);
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Check passport failed: ${getErrorMessage(error)}`
      );
    }
  }

  async getTokenId(address: string): Promise<bigint> {
    try {
      return BigInt(await this.contract.getTokenId(address));
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get token ID failed: ${getErrorMessage(error)}`
      );
    }
  }

  private requireSigner(action: string): void {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, `Signer required for ${action}`);
    }
  }
}
