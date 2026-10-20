import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt } from 'node:crypto';
import { getErrorMessage } from './errors.js';
import { OpenContextError, SDKError } from './types.js';

function scryptAsync(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Symmetric encryption for context payloads.
 *
 * Wire format (base64): `salt(32) || iv(16) || gcmTag(16) || ciphertext`.
 * The AES-256-GCM key is derived from the password with scrypt (Node's
 * defaults: N=2^14, r=8, p=1) and a fresh random salt per message, so equal
 * plaintexts never share a ciphertext.
 */
export class ContextCrypto {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly KEY_LENGTH = 32;
  private static readonly IV_LENGTH = 16;
  private static readonly TAG_LENGTH = 16;
  private static readonly SALT_LENGTH = 32;
  private static readonly HKDF_INFO = 'opencontext/context-encryption/v1';

  /**
   * Encrypt a UTF-8 string with a password-derived key.
   */
  static async encrypt(data: string, password: string): Promise<string> {
    try {
      const salt = randomBytes(this.SALT_LENGTH);
      const iv = randomBytes(this.IV_LENGTH);
      const key = await scryptAsync(password, salt, this.KEY_LENGTH);

      const cipher = createCipheriv(this.ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();

      return Buffer.concat([salt, iv, tag, ciphertext]).toString('base64');
    } catch (error) {
      throw new OpenContextError(
        SDKError.ENCRYPTION_FAILED,
        `Encryption failed: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * Decrypt a payload produced by {@link encrypt}. A wrong password or a
   * tampered payload fails GCM authentication and throws.
   */
  static async decrypt(encryptedData: string, password: string): Promise<string> {
    try {
      const data = Buffer.from(encryptedData, 'base64');
      const headerLength = this.SALT_LENGTH + this.IV_LENGTH + this.TAG_LENGTH;
      if (data.length < headerLength) {
        throw new Error('ciphertext is too short');
      }

      const salt = data.subarray(0, this.SALT_LENGTH);
      const iv = data.subarray(this.SALT_LENGTH, this.SALT_LENGTH + this.IV_LENGTH);
      const tag = data.subarray(this.SALT_LENGTH + this.IV_LENGTH, headerLength);
      const ciphertext = data.subarray(headerLength);

      const key = await scryptAsync(password, salt, this.KEY_LENGTH);

      const decipher = createDecipheriv(this.ALGORITHM, key, iv);
      decipher.setAuthTag(tag);

      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error) {
      throw new OpenContextError(
        SDKError.ENCRYPTION_FAILED,
        `Decryption failed: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * Generate a random 256-bit password, hex encoded.
   */
  static generatePassword(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Derive a stable encryption password from a wallet private key.
   *
   * Uses HKDF-SHA256 with a domain-separation label so the signing key is
   * never used directly as an encryption password, and so a future format
   * can rotate the label without touching the wallet.
   */
  static derivePasswordFromPrivateKey(privateKey: string): string {
    const hex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new OpenContextError(
        SDKError.ENCRYPTION_FAILED,
        'Private key must be a 32-byte hex string'
      );
    }

    const derived = hkdfSync(
      'sha256',
      Buffer.from(hex, 'hex'),
      Buffer.alloc(0),
      this.HKDF_INFO,
      this.KEY_LENGTH
    );
    return Buffer.from(derived).toString('hex');
  }

  /**
   * Plain base64 encoding. This is an encoding, not encryption.
   */
  static encodeBase64(data: string): string {
    return Buffer.from(data, 'utf8').toString('base64');
  }

  /**
   * Plain base64 decoding. This is an encoding, not encryption.
   */
  static decodeBase64(data: string): string {
    return Buffer.from(data, 'base64').toString('utf8');
  }
}
