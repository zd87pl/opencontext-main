import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { OpenContextError, SDKError } from './types.js';

const scryptAsync = promisify(scrypt);

/**
 * Cryptographic utilities for OpenContext SDK
 */
export class ContextCrypto {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly KEY_LENGTH = 32;
  private static readonly IV_LENGTH = 16;
  private static readonly TAG_LENGTH = 16;
  private static readonly SALT_LENGTH = 32;

  /**
   * Encrypt data using AES-256-GCM with a password-derived key
   */
  static async encrypt(data: string, password: string): Promise<string> {
    try {
      const salt = randomBytes(this.SALT_LENGTH);
      const iv = randomBytes(this.IV_LENGTH);
      
      // Derive key using scrypt
      const key = (await scryptAsync(password, salt, this.KEY_LENGTH)) as Buffer;
      
      const cipher = createCipheriv(this.ALGORITHM, key, iv);
      
      let encrypted = cipher.update(data, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      const tag = cipher.getAuthTag();
      
      // Combine salt + iv + tag + encrypted data
      const result = Buffer.concat([
        salt,
        iv,
        tag,
        Buffer.from(encrypted, 'hex')
      ]);
      
      return result.toString('base64');
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Decrypt data using AES-256-GCM with a password-derived key
   */
  static async decrypt(encryptedData: string, password: string): Promise<string> {
    try {
      const data = Buffer.from(encryptedData, 'base64');
      
      // Extract components
      const salt = data.subarray(0, this.SALT_LENGTH);
      const iv = data.subarray(this.SALT_LENGTH, this.SALT_LENGTH + this.IV_LENGTH);
      const tag = data.subarray(
        this.SALT_LENGTH + this.IV_LENGTH,
        this.SALT_LENGTH + this.IV_LENGTH + this.TAG_LENGTH
      );
      const encrypted = data.subarray(this.SALT_LENGTH + this.IV_LENGTH + this.TAG_LENGTH);
      
      // Derive key using scrypt
      const key = (await scryptAsync(password, salt, this.KEY_LENGTH)) as Buffer;
      
      const decipher = createDecipheriv(this.ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      
      let decrypted = decipher.update(encrypted, undefined, 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Generate a secure random password for encryption
   */
  static generatePassword(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Derive an encryption password from a private key
   */
  static derivePasswordFromPrivateKey(privateKey: string): string {
    // Use the private key as entropy for password derivation
    // In production, this should use HKDF or similar KDF
    const keyBuffer = Buffer.from(privateKey.replace('0x', ''), 'hex');
    return keyBuffer.toString('hex');
  }

  /**
   * Simple base64 encoding (for backward compatibility or testing)
   */
  static encodeBase64(data: string): string {
    return Buffer.from(data, 'utf8').toString('base64');
  }

  /**
   * Simple base64 decoding (for backward compatibility or testing)
   */
  static decodeBase64(data: string): string {
    return Buffer.from(data, 'base64').toString('utf8');
  }
}