import { ethers } from 'ethers';
import { CONTEXT_VAULT_ABI, CONTEXT_VAULT_IPFS_ABI, DEFAULT_STORAGE_QUOTA } from './constants.js';
import { findEventArgs } from './contracts.js';
import { getErrorMessage, isRevertError } from './errors.js';
import { IPFSService, type IPFSConfig } from './ipfs.js';
import { OpenContextError, SDKError, type OpenContextConfig, type ContextData } from './types.js';

/**
 * Wrapper around the on-chain context vault.
 *
 * Without an `ipfsConfig` this targets `ContextVault.sol`, which keeps the
 * encrypted payload itself on-chain. With an `ipfsConfig` it targets
 * `ContextVaultIPFS.sol`, which keeps only the IPFS CID on-chain and the
 * payload on IPFS; `contextVaultAddress` must then point at a
 * ContextVaultIPFS deployment.
 */
export class ContextVault {
  private contract: ethers.Contract;
  private config: OpenContextConfig;
  private ipfs?: IPFSService;

  constructor(config: OpenContextConfig, ipfsConfig?: IPFSConfig) {
    this.config = config;
    this.ipfs = ipfsConfig ? new IPFSService(ipfsConfig) : undefined;
    this.contract = new ethers.Contract(
      config.contextVaultAddress,
      this.ipfs ? CONTEXT_VAULT_IPFS_ABI : CONTEXT_VAULT_ABI,
      config.signer || config.provider
    );
  }

  /**
   * Store an already-encrypted payload on-chain. Returns the new version.
   */
  async storeContext(encryptedData: string): Promise<bigint> {
    this.requireSigner('storing context');

    try {
      const dataBytes = ethers.toUtf8Bytes(encryptedData);
      const tx = await this.contract.storeContext(dataBytes);
      const receipt = await tx.wait();
      const args = findEventArgs(this.contract.interface, receipt, 'ContextStored');
      if (!args) {
        throw new Error('ContextStored event not found');
      }
      return BigInt(args.version);
    } catch (error) {
      throw this.mapStoreError(error, 'Store context failed');
    }
  }

  async getContext(tokenId: bigint, version: bigint): Promise<ContextData> {
    try {
      const [dataBytes, timestamp] = await this.contract.getContext(tokenId, version);

      return {
        encryptedData: ethers.toUtf8String(dataBytes),
        timestamp: BigInt(timestamp),
        version,
      };
    } catch (error) {
      throw this.mapReadError(error, 'Get context failed');
    }
  }

  async getLatestContext(tokenId: bigint): Promise<ContextData | null> {
    try {
      const [dataBytes, timestamp, version] = await this.contract.getLatestContext(tokenId);

      if (isEmptyBytes(dataBytes)) {
        return null;
      }

      return {
        encryptedData: ethers.toUtf8String(dataBytes),
        timestamp: BigInt(timestamp),
        version: BigInt(version),
      };
    } catch (error) {
      throw this.mapReadError(error, 'Get latest context failed');
    }
  }

  async getContextCount(tokenId: bigint): Promise<bigint> {
    try {
      return BigInt(await this.contract.getContextCount(tokenId));
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get context count failed: ${getErrorMessage(error)}`
      );
    }
  }

  async authorizeReader(reader: string): Promise<void> {
    this.requireSigner('authorization');

    try {
      const tx = await this.contract.authorizeReader(reader);
      await tx.wait();
    } catch (error) {
      if (isRevertError(error, 'NoPassport')) {
        throw new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Authorize reader failed: ${getErrorMessage(error)}`
      );
    }
  }

  async revokeReader(reader: string): Promise<void> {
    this.requireSigner('revocation');

    try {
      const tx = await this.contract.revokeReader(reader);
      await tx.wait();
    } catch (error) {
      if (isRevertError(error, 'NoPassport')) {
        throw new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Revoke reader failed: ${getErrorMessage(error)}`
      );
    }
  }

  async deleteContext(version: bigint): Promise<void> {
    this.requireSigner('deletion');

    try {
      const tx = await this.contract.deleteContext(version);
      await tx.wait();
    } catch (error) {
      if (isRevertError(error, 'NoPassport')) {
        throw new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Delete context failed: ${getErrorMessage(error)}`
      );
    }
  }

  async isAuthorizedReader(tokenId: bigint, reader: string): Promise<boolean> {
    try {
      return await this.contract.authorizedReaders(tokenId, reader);
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Check authorization failed: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * Storage quota in bytes. The contract leaves the per-token slot at zero
   * until an owner overrides it, in which case the contract default applies.
   */
  async getStorageQuota(tokenId: bigint): Promise<bigint> {
    try {
      const quota = BigInt(await this.contract.storageQuota(tokenId));
      return quota === 0n ? DEFAULT_STORAGE_QUOTA : quota;
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get storage quota failed: ${getErrorMessage(error)}`
      );
    }
  }

  // IPFS-backed storage (ContextVaultIPFS.sol)

  /**
   * Store a payload on IPFS and record its CID on-chain. Returns the new
   * version. Encrypts first when `encryptionPassword` is given.
   */
  async storeContextIPFS(data: string, encryptionPassword?: string): Promise<bigint> {
    const ipfs = this.requireIPFS();
    this.requireSigner('storing context');

    const metadata = await ipfs.storeContext(data, encryptionPassword);

    try {
      const tx = await this.contract.storeContextIPFS(
        metadata.hash,
        metadata.size,
        metadata.encrypted
      );
      const receipt = await tx.wait();
      const args = findEventArgs(this.contract.interface, receipt, 'ContextStored');
      if (!args) {
        throw new Error('ContextStored event not found');
      }
      return BigInt(args.version);
    } catch (error) {
      throw this.mapStoreError(error, 'Store context on IPFS failed');
    }
  }

  async getContextFromIPFS(
    tokenId: bigint,
    version: bigint,
    encryptionPassword?: string
  ): Promise<string | null> {
    const ipfs = this.requireIPFS();

    let ipfsHash: string;
    let isEncrypted: boolean;
    try {
      [ipfsHash, , , isEncrypted] = await this.contract.getContextMetadata(tokenId, version);
    } catch (error) {
      throw this.mapReadError(error, 'Get context metadata failed');
    }

    if (!ipfsHash) {
      return null;
    }

    return ipfs.getContext(ipfsHash, this.passwordFor(isEncrypted, encryptionPassword));
  }

  async getLatestContextFromIPFS(
    tokenId: bigint,
    encryptionPassword?: string
  ): Promise<{ data: string; version: bigint; timestamp: bigint } | null> {
    const ipfs = this.requireIPFS();

    let ipfsHash: string;
    let timestamp: bigint;
    let version: bigint;
    let isEncrypted: boolean;
    try {
      [ipfsHash, , timestamp, version, isEncrypted] =
        await this.contract.getLatestContextMetadata(tokenId);
    } catch (error) {
      throw this.mapReadError(error, 'Get latest context metadata failed');
    }

    if (!ipfsHash) {
      return null;
    }

    const data = await ipfs.getContext(ipfsHash, this.passwordFor(isEncrypted, encryptionPassword));
    return { data, version: BigInt(version), timestamp: BigInt(timestamp) };
  }

  private passwordFor(isEncrypted: boolean, encryptionPassword?: string): string | undefined {
    if (!isEncrypted) {
      return undefined;
    }
    if (!encryptionPassword) {
      throw new OpenContextError(
        SDKError.ENCRYPTION_FAILED,
        'Context is encrypted but no password was provided'
      );
    }
    return encryptionPassword;
  }

  private requireIPFS(): IPFSService {
    if (!this.ipfs) {
      throw new OpenContextError(
        SDKError.NOT_CONFIGURED,
        'IPFS not configured: pass an ipfsConfig to ContextVault'
      );
    }
    return this.ipfs;
  }

  private requireSigner(action: string): void {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, `Signer required for ${action}`);
    }
  }

  private mapStoreError(error: unknown, prefix: string): OpenContextError {
    if (isRevertError(error, 'NoPassport')) {
      return new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
    }
    if (isRevertError(error, 'QuotaExceeded')) {
      return new OpenContextError(SDKError.QUOTA_EXCEEDED, 'Storage quota exceeded');
    }
    if (isRevertError(error, 'ContextTooLarge')) {
      return new OpenContextError(SDKError.QUOTA_EXCEEDED, 'Context exceeds the maximum size per entry');
    }
    return new OpenContextError(
      SDKError.TRANSACTION_FAILED,
      `${prefix}: ${getErrorMessage(error)}`
    );
  }

  private mapReadError(error: unknown, prefix: string): OpenContextError {
    if (isRevertError(error, 'NotAuthorizedReader')) {
      return new OpenContextError(SDKError.UNAUTHORIZED, 'Not authorized to read context');
    }
    return new OpenContextError(
      SDKError.TRANSACTION_FAILED,
      `${prefix}: ${getErrorMessage(error)}`
    );
  }
}

function isEmptyBytes(data: unknown): boolean {
  if (typeof data === 'string') {
    return data === '0x' || data === '';
  }
  return data instanceof Uint8Array && data.length === 0;
}
