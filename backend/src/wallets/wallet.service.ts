import { ethers } from 'ethers';
import crypto from 'crypto';
import { logger } from '../common/logger.js';
import { AppError } from '../common/middleware/error-handler.js';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

// Key for managed-wallet private keys. WALLET_ENCRYPTION_KEY should be 32
// random bytes (hex); without it the key is derived from SESSION_SECRET, which
// ties wallet recovery to the session secret. Use a KMS in production.
let walletEncryptionKey: Buffer | null = null;

function getWalletEncryptionKey(): Buffer {
  if (walletEncryptionKey) return walletEncryptionKey;

  if (process.env.WALLET_ENCRYPTION_KEY) {
    const key = Buffer.from(process.env.WALLET_ENCRYPTION_KEY, 'hex');
    if (key.length !== 32) {
      throw new Error('WALLET_ENCRYPTION_KEY must be 32 bytes, hex encoded');
    }
    walletEncryptionKey = key;
    return key;
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error('Either WALLET_ENCRYPTION_KEY or SESSION_SECRET must be provided');
  }

  walletEncryptionKey = crypto.scryptSync(sessionSecret, 'opencontext-wallet-salt', 32);
  return walletEncryptionKey;
}

function encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, getWalletEncryptionKey(), iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex')
  };
}

function decrypt(encryptedData: string, iv: string, authTag: string): string {
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, getWalletEncryptionKey(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Creates a new managed wallet for a user
 */
export async function createManagedWallet(): Promise<{
  address: string;
  encryptedPrivateKey: string;
}> {
  try {
    const wallet = ethers.Wallet.createRandom();
    const encryptionResult = encrypt(wallet.privateKey);

    const encryptedPrivateKey = JSON.stringify({
      encrypted: encryptionResult.encrypted,
      iv: encryptionResult.iv,
      authTag: encryptionResult.authTag,
      algorithm: ENCRYPTION_ALGORITHM,
      createdAt: new Date().toISOString()
    });

    logger.info(`Created managed wallet: ${wallet.address}`);

    return { address: wallet.address, encryptedPrivateKey };
  } catch (error) {
    logger.error('Failed to create managed wallet:', error);
    throw new AppError(500, 'Failed to create wallet');
  }
}

/**
 * Gets a wallet instance from encrypted private key
 */
export async function getWalletFromEncrypted(
  encryptedPrivateKey: string,
  provider?: ethers.Provider
): Promise<ethers.Wallet> {
  try {
    const encryptedData = JSON.parse(encryptedPrivateKey);
    const privateKey = decrypt(encryptedData.encrypted, encryptedData.iv, encryptedData.authTag);

    return new ethers.Wallet(privateKey, provider);
  } catch (error) {
    logger.error('Failed to decrypt wallet:', error);
    throw new AppError(500, 'Failed to access wallet');
  }
}

/**
 * Gets the provider for blockchain interactions
 */
export function getProvider(): ethers.Provider {
  const rpcUrl = process.env.BLOCKCHAIN_RPC_URL;
  if (!rpcUrl) {
    throw new AppError(500, 'Blockchain RPC URL not configured');
  }

  return new ethers.JsonRpcProvider(rpcUrl);
}

/**
 * Returns the contract addresses a user's wallet should talk to.
 *
 * Nothing is deployed per user yet: this verifies the wallet decrypts and hands
 * back the shared contract addresses from the environment.
 */
export async function deployUserContracts(
  userWalletAddress: string,
  encryptedPrivateKey: string
): Promise<{
  passportAddress: string;
  contextVaultAddress: string;
  paymentStreamAddress: string;
}> {
  try {
    const provider = getProvider();
    await getWalletFromEncrypted(encryptedPrivateKey, provider);

    const passportAddress = process.env.PASSPORT_REGISTRY_ADDRESS;
    const contextVaultAddress = process.env.CONTEXT_VAULT_ADDRESS;
    const paymentStreamAddress = process.env.PAYMENT_STREAM_ADDRESS;
    if (!passportAddress || !contextVaultAddress || !paymentStreamAddress) {
      throw new Error('Contract addresses are not configured');
    }

    logger.info(`Registering user contracts for wallet: ${userWalletAddress}`);

    return { passportAddress, contextVaultAddress, paymentStreamAddress };
  } catch (error) {
    logger.error('Failed to deploy user contracts:', error);
    throw new AppError(500, 'Failed to deploy contracts');
  }
}

/**
 * Gets wallet balance. USDC is not read yet and always reports "0".
 */
export async function getWalletBalance(address: string): Promise<{
  eth: string;
  usdc: string;
}> {
  try {
    const provider = getProvider();
    const ethBalance = await provider.getBalance(address);

    return {
      eth: ethers.formatEther(ethBalance),
      usdc: '0'
    };
  } catch (error) {
    logger.error('Failed to get wallet balance:', error);
    throw new AppError(500, 'Failed to get balance');
  }
}
