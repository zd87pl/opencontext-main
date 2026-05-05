"""Cryptographic utilities for OpenContext SDK."""

import base64
import os
from typing import Tuple

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from .errors import OpenContextError, SDKError


class ContextCrypto:
    """Cryptographic utilities for OpenContext SDK."""

    ALGORITHM = algorithms.AES
    KEY_LENGTH = 32  # 256 bits
    IV_LENGTH = 16  # 128 bits
    TAG_LENGTH = 16  # 128 bits
    SALT_LENGTH = 32  # 256 bits

    # Scrypt params intentionally match the JS SDK (N=2^14) for cross-SDK compatibility.
    # Do NOT increase N without updating the JS SDK to match.
    _SCRYPT_N = 2**14
    _SCRYPT_R = 8
    _SCRYPT_P = 1

    @classmethod
    def encrypt(cls, data: str, password: str) -> str:
        """Encrypt data using AES-256-GCM with a password-derived key."""
        try:
            # Generate random salt and IV
            salt = os.urandom(cls.SALT_LENGTH)
            iv = os.urandom(cls.IV_LENGTH)

            # Derive key using Scrypt (params must stay in sync with JS SDK)
            kdf = Scrypt(
                algorithm=hashes.SHA256(),
                length=cls.KEY_LENGTH,
                salt=salt,
                n=cls._SCRYPT_N,
                r=cls._SCRYPT_R,
                p=cls._SCRYPT_P,
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

            # Derive key using Scrypt (params must stay in sync with JS SDK)
            kdf = Scrypt(
                algorithm=hashes.SHA256(),
                length=cls.KEY_LENGTH,
                salt=salt,
                n=cls._SCRYPT_N,
                r=cls._SCRYPT_R,
                p=cls._SCRYPT_P,
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
        """Derive an encryption password from a private key using HKDF.

        Uses a domain-separated context so the derived key is distinct from the signing key.
        Output matches the JS SDK's hkdfSync derivation.
        """
        key_bytes = bytes.fromhex(private_key.replace("0x", ""))
        hkdf = HKDF(
            algorithm=hashes.SHA256(),
            length=cls.KEY_LENGTH,
            salt=bytes(32),  # zero salt — IKM has high entropy
            info=b"opencontext-vault-encryption-v1",
        )
        return hkdf.derive(key_bytes).hex()

    @classmethod
    def encode_base64(cls, data: str) -> str:
        """Simple base64 encoding (for backward compatibility or testing)."""
        return base64.b64encode(data.encode()).decode()

    @classmethod
    def decode_base64(cls, data: str) -> str:
        """Simple base64 decoding (for backward compatibility or testing)."""
        return base64.b64decode(data.encode()).decode()