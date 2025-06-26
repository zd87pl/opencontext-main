"""Cryptographic utilities for OpenContext SDK."""

import base64
import hashlib
import os
from typing import Tuple

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from .errors import OpenContextError, SDKError


class ContextCrypto:
    """Cryptographic utilities for OpenContext SDK."""

    ALGORITHM = algorithms.AES
    KEY_LENGTH = 32  # 256 bits
    IV_LENGTH = 16  # 128 bits  
    TAG_LENGTH = 16  # 128 bits
    SALT_LENGTH = 32  # 256 bits

    @classmethod
    def encrypt(cls, data: str, password: str) -> str:
        """Encrypt data using AES-256-GCM with a password-derived key."""
        try:
            # Generate random salt and IV
            salt = os.urandom(cls.SALT_LENGTH)
            iv = os.urandom(cls.IV_LENGTH)

            # Derive key using Scrypt
            kdf = Scrypt(
                algorithm=hashes.SHA256(),
                length=cls.KEY_LENGTH,
                salt=salt,
                n=2**14,
                r=8,
                p=1,
            )
            key = kdf.derive(password.encode())

            # Encrypt data
            cipher = Cipher(cls.ALGORITHM(key), modes.GCM(iv))
            encryptor = cipher.encryptor()
            ciphertext = encryptor.update(data.encode()) + encryptor.finalize()

            # Combine salt + iv + tag + ciphertext
            result = salt + iv + encryptor.tag + ciphertext

            return base64.b64encode(result).decode()

        except Exception as e:
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Encryption failed: {str(e)}"
            )

    @classmethod
    def decrypt(cls, encrypted_data: str, password: str) -> str:
        """Decrypt data using AES-256-GCM with a password-derived key."""
        try:
            # Decode base64
            data = base64.b64decode(encrypted_data.encode())

            # Extract components
            salt = data[: cls.SALT_LENGTH]
            iv = data[cls.SALT_LENGTH : cls.SALT_LENGTH + cls.IV_LENGTH]
            tag = data[
                cls.SALT_LENGTH
                + cls.IV_LENGTH : cls.SALT_LENGTH
                + cls.IV_LENGTH
                + cls.TAG_LENGTH
            ]
            ciphertext = data[cls.SALT_LENGTH + cls.IV_LENGTH + cls.TAG_LENGTH :]

            # Derive key using Scrypt
            kdf = Scrypt(
                algorithm=hashes.SHA256(),
                length=cls.KEY_LENGTH,
                salt=salt,
                n=2**14,
                r=8,
                p=1,
            )
            key = kdf.derive(password.encode())

            # Decrypt data
            cipher = Cipher(cls.ALGORITHM(key), modes.GCM(iv, tag))
            decryptor = cipher.decryptor()
            plaintext = decryptor.update(ciphertext) + decryptor.finalize()

            return plaintext.decode()

        except Exception as e:
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Decryption failed: {str(e)}"
            )

    @classmethod
    def generate_password(cls) -> str:
        """Generate a secure random password for encryption."""
        return os.urandom(32).hex()

    @classmethod
    def derive_password_from_private_key(cls, private_key: str) -> str:
        """Derive an encryption password from a private key."""
        # Remove '0x' prefix if present
        key_hex = private_key.replace("0x", "")
        key_bytes = bytes.fromhex(key_hex)

        # Use SHA-256 hash of private key as password
        # In production, this should use HKDF or similar KDF
        return hashlib.sha256(key_bytes).hexdigest()

    @classmethod
    def encode_base64(cls, data: str) -> str:
        """Simple base64 encoding (for backward compatibility or testing)."""
        return base64.b64encode(data.encode()).decode()

    @classmethod
    def decode_base64(cls, data: str) -> str:
        """Simple base64 decoding (for backward compatibility or testing)."""
        return base64.b64decode(data.encode()).decode()