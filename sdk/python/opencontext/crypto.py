"""Symmetric encryption for context payloads.

Wire format (base64-encoded)::

    salt (32 bytes) || iv (16 bytes) || GCM tag (16 bytes) || ciphertext

The AES-256 key is derived from the password with scrypt using ``N=2**14, r=8, p=1``.
Those are the defaults of Node's ``crypto.scrypt``, so ciphertext produced here is
byte-compatible with ``sdk/js/src/crypto.ts`` (and vice versa) given the same password.

When the password comes from a wallet key, ``derive_password_from_private_key`` applies
HKDF-SHA256 with the label ``opencontext/context-encryption/v1`` -- again the recipe the
TypeScript SDK uses -- so both SDKs derive the same password for the same wallet.
"""

import base64
import binascii
import re
import secrets

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from .errors import OpenContextError, SDKError


class ContextCrypto:
    """AES-256-GCM encryption with a scrypt password-derived key."""

    KEY_LENGTH = 32  # AES-256
    IV_LENGTH = 16  # Matches the JS SDK (GCM accepts any IV length >= 8 bytes)
    TAG_LENGTH = 16  # 128-bit authentication tag
    SALT_LENGTH = 32

    # Node's crypto.scrypt defaults; changing these breaks cross-SDK compatibility.
    SCRYPT_N = 2**14
    SCRYPT_R = 8
    SCRYPT_P = 1

    # Domain-separation label for wallet-key-derived passwords; shared with the JS SDK.
    HKDF_INFO = b"opencontext/context-encryption/v1"

    HEADER_LENGTH = SALT_LENGTH + IV_LENGTH + TAG_LENGTH

    @classmethod
    def _derive_key(cls, password: str, salt: bytes) -> bytes:
        """Derive the AES key for ``password`` under ``salt``.

        :class:`Scrypt` takes no hash-algorithm argument: scrypt's PBKDF2 stage is fixed
        to HMAC-SHA256 by the spec.
        """
        kdf = Scrypt(
            salt=salt,
            length=cls.KEY_LENGTH,
            n=cls.SCRYPT_N,
            r=cls.SCRYPT_R,
            p=cls.SCRYPT_P,
        )
        return kdf.derive(password.encode("utf-8"))

    @classmethod
    def encrypt(cls, data: str, password: str) -> str:
        """Encrypt ``data`` and return the base64 envelope described in the module docstring."""
        try:
            salt = secrets.token_bytes(cls.SALT_LENGTH)
            iv = secrets.token_bytes(cls.IV_LENGTH)
            key = cls._derive_key(password, salt)
            # AESGCM returns ciphertext || tag; the wire format puts the tag before the ciphertext.
            sealed = AESGCM(key).encrypt(iv, data.encode("utf-8"), None)
        except Exception as exc:
            raise OpenContextError(SDKError.ENCRYPTION_FAILED, f"Encryption failed: {exc}") from exc

        ciphertext = sealed[: -cls.TAG_LENGTH]
        tag = sealed[-cls.TAG_LENGTH :]
        return base64.b64encode(salt + iv + tag + ciphertext).decode("ascii")

    @classmethod
    def decrypt(cls, encrypted_data: str, password: str) -> str:
        """Decrypt an envelope produced by :meth:`encrypt` (or the JS SDK) with ``password``."""
        try:
            raw = base64.b64decode(encrypted_data, validate=True)
        except (binascii.Error, ValueError, TypeError) as exc:
            raise OpenContextError(
                SDKError.ENCRYPTION_FAILED,
                f"Decryption failed: payload is not valid base64 ({exc})",
            ) from exc

        if len(raw) < cls.HEADER_LENGTH:
            raise OpenContextError(
                SDKError.ENCRYPTION_FAILED,
                f"Decryption failed: payload is {len(raw)} bytes, "
                f"shorter than the {cls.HEADER_LENGTH}-byte salt/iv/tag header",
            )

        salt = raw[: cls.SALT_LENGTH]
        iv = raw[cls.SALT_LENGTH : cls.SALT_LENGTH + cls.IV_LENGTH]
        tag = raw[cls.SALT_LENGTH + cls.IV_LENGTH : cls.HEADER_LENGTH]
        ciphertext = raw[cls.HEADER_LENGTH :]

        try:
            key = cls._derive_key(password, salt)
            plaintext = AESGCM(key).decrypt(iv, ciphertext + tag, None)
        except InvalidTag as exc:
            # GCM cannot distinguish a wrong key from a modified ciphertext.
            raise OpenContextError(
                SDKError.ENCRYPTION_FAILED,
                "Decryption failed: wrong password or tampered data",
            ) from exc
        except Exception as exc:
            raise OpenContextError(SDKError.ENCRYPTION_FAILED, f"Decryption failed: {exc}") from exc

        try:
            return plaintext.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise OpenContextError(
                SDKError.ENCRYPTION_FAILED, "Decryption failed: plaintext is not valid UTF-8"
            ) from exc

    @classmethod
    def generate_password(cls) -> str:
        """Generate a random 256-bit password, hex-encoded (64 characters)."""
        return secrets.token_hex(32)

    @classmethod
    def derive_password_from_private_key(cls, private_key: str) -> str:
        """Derive a deterministic encryption password from a 32-byte hex private key.

        HKDF-SHA256 (empty salt, info :attr:`HKDF_INFO`) separates the encryption
        password from the signing key, so the wallet key is never used directly and the
        label can be rotated for a future format. ``private_key`` may carry a ``0x``
        prefix. Matches ``derivePasswordFromPrivateKey`` in the TypeScript SDK.
        """
        hex_key = private_key.removeprefix("0x")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", hex_key):
            raise OpenContextError(
                SDKError.ENCRYPTION_FAILED, "Private key must be a 32-byte hex string"
            )

        hkdf = HKDF(algorithm=hashes.SHA256(), length=cls.KEY_LENGTH, salt=None, info=cls.HKDF_INFO)
        return hkdf.derive(bytes.fromhex(hex_key)).hex()

    @classmethod
    def encode_base64(cls, data: str) -> str:
        """Plain base64 of ``data`` (used when no encryption password is configured)."""
        return base64.b64encode(data.encode("utf-8")).decode("ascii")

    @classmethod
    def decode_base64(cls, data: str) -> str:
        """Inverse of :meth:`encode_base64`."""
        return base64.b64decode(data.encode("ascii")).decode("utf-8")
