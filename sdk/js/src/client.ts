import { ethers } from 'ethers';
import { PassportRegistry } from './passport.js';
import { ContextVault } from './vault.js';
import { PaymentStream } from './payments.js';
import { ContextCrypto } from './crypto.js';
import type { IPFSConfig } from './ipfs.js';
import { OpenContextError, SDKError, type OpenContextConfig, type PassportData } from './types.js';

function hasPrivateKey(signer: ethers.Signer): signer is ethers.Signer & { privateKey: string } {
  return (
    'privateKey' in signer && typeof (signer as { privateKey?: unknown }).privateKey === 'string'
  );
}

/**
 * High-level entry point that ties the passport, vault and payment wrappers
 * together and handles encryption of vault payloads.
 *
 * Payloads are only ever written to the vault encrypted. A local wallet
 * signer yields a deterministic key via {@link ContextCrypto.derivePasswordFromPrivateKey};
 * any other signer (browser wallets, remote signers) must call
 * {@link setEncryptionPassword} or {@link generateEncryptionPassword} first.
 */
export class OpenContextClient {
  public readonly passport: PassportRegistry;
  public readonly vault: ContextVault;
  public readonly payments: PaymentStream;
  private readonly config: OpenContextConfig;
  private encryptionPassword?: string;

  constructor(config: OpenContextConfig, ipfsConfig?: IPFSConfig) {
    this.config = config;
    this.passport = new PassportRegistry(config);
    this.vault = new ContextVault(config, ipfsConfig);
    this.payments = new PaymentStream(config);

    if (config.signer && hasPrivateKey(config.signer)) {
      this.encryptionPassword = ContextCrypto.derivePasswordFromPrivateKey(
        config.signer.privateKey
      );
    }
  }

  /**
   * Return the signer's passport, minting one if none exists. Minting
   * succeeds only when the signer is an authorized minter on the registry.
   */
  async authenticate(): Promise<PassportData> {
    const address = await this.signerAddress();
    const existing = await this.passport.getPassport(address);
    if (existing) {
      return existing;
    }

    const dataHash = ethers.keccak256(ethers.toUtf8Bytes(`opencontext:${address}`));
    const tokenId = await this.passport.mint(address, dataHash);

    return {
      tokenId,
      owner: address,
      dataHash,
      exists: true,
    };
  }

  async getMyPassport(): Promise<PassportData | null> {
    const address = await this.signerAddress();
    return this.passport.getPassport(address);
  }

  async getMyTokenId(): Promise<bigint> {
    const address = await this.signerAddress();
    const tokenId = await this.passport.getTokenId(address);

    if (tokenId === 0n) {
      throw new OpenContextError(SDKError.NO_PASSPORT, 'No passport found');
    }

    return tokenId;
  }

  /**
   * Encrypt `data` and store it in the vault. Returns the new version.
   */
  async storeContext(data: string): Promise<bigint> {
    const encrypted = await ContextCrypto.encrypt(data, this.requireEncryptionPassword());
    return this.vault.storeContext(encrypted);
  }

  async getMyLatestContext(): Promise<string | null> {
    const tokenId = await this.getMyTokenId();
    const context = await this.vault.getLatestContext(tokenId);

    if (!context) {
      return null;
    }

    return ContextCrypto.decrypt(context.encryptedData, this.requireEncryptionPassword());
  }

  async getMyContext(version: bigint): Promise<string> {
    const tokenId = await this.getMyTokenId();
    const context = await this.vault.getContext(tokenId, version);
    return ContextCrypto.decrypt(context.encryptedData, this.requireEncryptionPassword());
  }

  async streamPay(provider: string, bytesPerSecond: bigint): Promise<void> {
    return this.payments.startStream(provider, bytesPerSecond);
  }

  async stopPayment(provider: string): Promise<void> {
    return this.payments.stopStream(provider);
  }

  /**
   * Active flow rates keyed by provider, omitting providers with no stream.
   */
  async getMyStreams(providers: string[]): Promise<Map<string, bigint>> {
    const tokenId = await this.getMyTokenId();
    const streams = new Map<string, bigint>();

    for (const provider of providers) {
      const flowRate = await this.payments.getActiveFlowRate(tokenId, provider);
      if (flowRate > 0n) {
        streams.set(provider, flowRate);
      }
    }

    return streams;
  }

  async becomeProvider(receiver: string, ratePerByte: bigint): Promise<void> {
    return this.payments.registerProvider(receiver, ratePerByte);
  }

  async updateMyProviderRate(newRate: bigint): Promise<void> {
    return this.payments.updateProviderRate(newRate);
  }

  async recordBytesProvided(consumerTokenId: bigint, bytes: bigint): Promise<void> {
    return this.payments.recordConsumption(consumerTokenId, bytes);
  }

  /**
   * Whether the client holds a key for encrypting and decrypting vault data.
   */
  hasEncryptionKey(): boolean {
    return this.encryptionPassword !== undefined;
  }

  /**
   * Use a caller-managed encryption password instead of one derived from the
   * signer's private key.
   */
  setEncryptionPassword(password: string): void {
    if (!password) {
      throw new OpenContextError(SDKError.ENCRYPTION_FAILED, 'Encryption password must not be empty');
    }
    this.encryptionPassword = password;
  }

  /**
   * Generate, install and return a random encryption password. The caller is
   * responsible for persisting it; without it stored data cannot be read.
   */
  generateEncryptionPassword(): string {
    const password = ContextCrypto.generatePassword();
    this.encryptionPassword = password;
    return password;
  }

  static async create(
    providerUrl: string,
    privateKey: string,
    addresses: {
      passportRegistry: string;
      contextVault: string;
      paymentStream: string;
    },
    ipfsConfig?: IPFSConfig
  ): Promise<OpenContextClient> {
    const provider = new ethers.JsonRpcProvider(providerUrl);
    const signer = new ethers.Wallet(privateKey, provider);

    return new OpenContextClient(
      {
        provider,
        signer,
        passportRegistryAddress: addresses.passportRegistry,
        contextVaultAddress: addresses.contextVault,
        paymentStreamAddress: addresses.paymentStream,
      },
      ipfsConfig
    );
  }

  private async signerAddress(): Promise<string> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for this operation');
    }
    return this.config.signer.getAddress();
  }

  private requireEncryptionPassword(): string {
    if (!this.encryptionPassword) {
      throw new OpenContextError(
        SDKError.NOT_CONFIGURED,
        'No encryption key: use a private-key signer, or call setEncryptionPassword() or generateEncryptionPassword()'
      );
    }
    return this.encryptionPassword;
  }
}
