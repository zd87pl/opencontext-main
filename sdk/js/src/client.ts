import { ethers } from 'ethers';
import { PassportRegistry } from './passport.js';
import { ContextVault } from './vault.js';
import { PaymentStream } from './payments.js';
import { ContextCrypto } from './crypto.js';
import { OpenContextError, SDKError, type OpenContextConfig, type PassportData } from './types.js';

export class OpenContextClient {
  public passport: PassportRegistry;
  public vault: ContextVault;
  public payments: PaymentStream;
  private config: OpenContextConfig;
  private encryptionPassword?: string;

  constructor(config: OpenContextConfig) {
    this.config = config;
    this.passport = new PassportRegistry(config);
    this.vault = new ContextVault(config);
    this.payments = new PaymentStream(config);
    
    // Initialize encryption password from signer if available
    if (config.signer && 'privateKey' in config.signer) {
      this.encryptionPassword = ContextCrypto.derivePasswordFromPrivateKey(
        (config.signer as any).privateKey
      );
    }
  }

  async authenticate(): Promise<PassportData> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required for authentication');
    }

    const address = await this.config.signer.getAddress();
    let passport = await this.passport.getPassport(address);

    if (!passport) {
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(`opencontext:${address}`));
      const tokenId = await this.passport.mint(address, dataHash);
      
      passport = {
        tokenId,
        owner: address,
        dataHash,
        exists: true,
      };
    }

    return passport;
  }

  async getMyPassport(): Promise<PassportData | null> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required');
    }

    const address = await this.config.signer.getAddress();
    return this.passport.getPassport(address);
  }

  async getMyTokenId(): Promise<bigint> {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, 'Signer required');
    }

    const address = await this.config.signer.getAddress();
    const tokenId = await this.passport.getTokenId(address);
    
    if (tokenId === 0n) {
      throw new OpenContextError(SDKError.NO_PASSPORT, 'No passport found');
    }
    
    return tokenId;
  }

  async storeContext(data: string): Promise<bigint> {
    const encryptedData = await this.encryptData(data);
    return this.vault.storeContext(encryptedData);
  }

  async getMyLatestContext(): Promise<string | null> {
    const tokenId = await this.getMyTokenId();
    const context = await this.vault.getLatestContext(tokenId);
    
    if (!context) {
      return null;
    }
    
    return this.decryptData(context.encryptedData);
  }

  async getMyContext(version: bigint): Promise<string> {
    const tokenId = await this.getMyTokenId();
    const context = await this.vault.getContext(tokenId, version);
    return this.decryptData(context.encryptedData);
  }

  async streamPay(provider: string, bytesPerSecond: bigint): Promise<void> {
    return this.payments.startStream(provider, bytesPerSecond);
  }

  async stopPayment(provider: string): Promise<void> {
    return this.payments.stopStream(provider);
  }

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

  private async encryptData(data: string): Promise<string> {
    if (!this.encryptionPassword) {
      // Fallback to base64 for testing/development
      return ContextCrypto.encodeBase64(data);
    }
    
    return ContextCrypto.encrypt(data, this.encryptionPassword);
  }

  private async decryptData(encryptedData: string): Promise<string> {
    if (!this.encryptionPassword) {
      // Fallback to base64 for testing/development
      try {
        return ContextCrypto.decodeBase64(encryptedData);
      } catch {
        // If base64 decode fails, data might be encrypted
        throw new OpenContextError(
          SDKError.TRANSACTION_FAILED,
          'Cannot decrypt data: no encryption password available'
        );
      }
    }
    
    try {
      return await ContextCrypto.decrypt(encryptedData, this.encryptionPassword);
    } catch {
      // Try base64 fallback for backward compatibility
      try {
        return ContextCrypto.decodeBase64(encryptedData);
      } catch {
        throw new OpenContextError(
          SDKError.TRANSACTION_FAILED,
          'Failed to decrypt data with available methods'
        );
      }
    }
  }

  /**
   * Set a custom encryption password (for advanced use cases)
   */
  setEncryptionPassword(password: string): void {
    this.encryptionPassword = password;
  }

  /**
   * Generate a new random encryption password
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
    }
  ): Promise<OpenContextClient> {
    const provider = new ethers.JsonRpcProvider(providerUrl);
    const signer = new ethers.Wallet(privateKey, provider);
    
    return new OpenContextClient({
      provider,
      signer,
      passportRegistryAddress: addresses.passportRegistry,
      contextVaultAddress: addresses.contextVault,
      paymentStreamAddress: addresses.paymentStream,
    });
  }
}