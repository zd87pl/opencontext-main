import { ethers } from 'ethers';
import crypto from 'crypto';
import { logger } from '../common/logger.js';
import { AppError } from '../common/middleware/error-handler.js';

// Encryption key for managed wallets (in production, use AWS KMS or similar)
const getWalletEncryptionKey = (): Buffer => {
  if (process.env.WALLET_ENCRYPTION_KEY) {
    return Buffer.from(process.env.WALLET_ENCRYPTION_KEY, 'hex');
  }
  
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error('Either WALLET_ENCRYPTION_KEY or SESSION_SECRET must be provided');
  }
  
  return crypto.scryptSync(sessionSecret, 'opencontext-wallet-salt', 32);
};

const WALLET_ENCRYPTION_KEY = getWalletEncryptionKey();

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

/**
 * Encrypts data using AES-256-GCM
 */
function encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, WALLET_ENCRYPTION_KEY, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  };
}

/**
 * Decrypts data using AES-256-GCM
 */
function decrypt(encryptedData: string, iv: string, authTag: string): string {
  const decipher = crypto.createDecipheriv(
    ENCRYPTION_ALGORITHM, 
    WALLET_ENCRYPTION_KEY, 
    Buffer.from(iv, 'hex')
  );
  
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
    // Generate a new random wallet
    const wallet = ethers.Wallet.createRandom();
    
    // Encrypt the private key
    const encryptionResult = encrypt(wallet.privateKey);
    
    // Combine encrypted data with metadata
    const encryptedPrivateKey = JSON.stringify({
      encrypted: encryptionResult.encrypted,
      iv: encryptionResult.iv,
      authTag: encryptionResult.authTag,
      algorithm: ENCRYPTION_ALGORITHM,
      createdAt: new Date().toISOString()
    });
    
    logger.info(`Created managed wallet: ${wallet.address}`);
    
    return {
      address: wallet.address,
      encryptedPrivateKey
    };
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
    // Parse the encrypted data
    const encryptedData = JSON.parse(encryptedPrivateKey);
    
    // Decrypt the private key
    const privateKey = decrypt(
      encryptedData.encrypted,
      encryptedData.iv,
      encryptedData.authTag
    );
    
    // Create wallet instance
    const wallet = new ethers.Wallet(privateKey, provider);
    
    return wallet;
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
 * Deploys user contracts using the factory pattern
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
    const deployerWallet = await getWalletFromEncrypted(encryptedPrivateKey, provider);
    
    // In a real implementation, we would call a factory contract
    // For the PoC, we'll use the existing deployed contracts
    // and just register the user
    
    logger.info(`Registering user contracts for wallet: ${userWalletAddress}`);
    
    // Return existing contract addresses from env
    return {
      passportAddress: process.env.PASSPORT_REGISTRY_ADDRESS!,
      contextVaultAddress: process.env.CONTEXT_VAULT_ADDRESS!,
      paymentStreamAddress: process.env.PAYMENT_STREAM_ADDRESS!
    };
  } catch (error) {
    logger.error('Failed to deploy user contracts:', error);
    throw new AppError(500, 'Failed to deploy contracts');
  }
}

/**
 * Gets wallet balance
 */
export async function getWalletBalance(address: string): Promise<{
  eth: string;
  usdc: string;
}> {
  try {
    const provider = getProvider();
    
    // Get ETH balance
    const ethBalance = await provider.getBalance(address);
    
    // For USDC, we would check the USDC contract
    // For now, return 0
    const usdcBalance = '0';
    
    return {
      eth: ethers.formatEther(ethBalance),
      usdc: usdcBalance
    };
  } catch (error) {
    logger.error('Failed to get wallet balance:', error);
    throw new AppError(500, 'Failed to get balance');
  }
}