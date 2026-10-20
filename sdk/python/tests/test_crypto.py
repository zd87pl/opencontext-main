"""Tests for ContextCrypto module."""

import base64

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from opencontext.crypto import ContextCrypto
from opencontext.errors import OpenContextError, SDKError

# Known-answer vector produced with Node's crypto module using exactly the recipe in
# sdk/js/src/crypto.ts (scrypt with Node's default N=16384, r=8, p=1; aes-256-gcm with
# a 16-byte IV; base64(salt || iv || tag || ciphertext)). Salt and IV are fixed so the
# output is reproducible:
#
#   const { createCipheriv, scryptSync, createHash } = require('node:crypto');
#   const password = 'opencontext-cross-sdk-vector';
#   const salt = createHash('sha256').update('opencontext-salt').digest();
#   const iv = createHash('sha256').update('opencontext-iv').digest().subarray(0, 16);
#   const key = scryptSync(password, salt, 32);
#   const c = createCipheriv('aes-256-gcm', key, iv);
#   const ct = Buffer.concat([c.update('Hello from the TypeScript SDK \u{1F310}', 'utf8'), c.final()]);
#   console.log(Buffer.concat([salt, iv, c.getAuthTag(), ct]).toString('base64'));
JS_SDK_PASSWORD = "opencontext-cross-sdk-vector"
JS_SDK_PLAINTEXT = "Hello from the TypeScript SDK \U0001f310"
JS_SDK_BLOB = (
    "awY/ttIWyYYx0cj5ysYli+GFqR1JXSz8916CXmOYxoI2Af2POkX8meWtMbCiEUtJAY+0R8w3uF+PPpFvjxsy"
    "sQfZRSt/Uprs7UoGxTA09gu2VaZz91Pr6M0SrTei20zuI1I="
)


class TestContextCrypto:
    """Test ContextCrypto functionality."""

    def test_encrypt_decrypt_success(self):
        """Test successful encryption and decryption."""
        data = "Hello, OpenContext Network!"
        password = "test-password-123"

        encrypted = ContextCrypto.encrypt(data, password)
        assert encrypted
        assert encrypted != data

        decrypted = ContextCrypto.decrypt(encrypted, password)
        assert decrypted == data

    def test_encrypt_produces_different_ciphertext(self):
        """Test that encryption produces different ciphertext for same data."""
        data = "Test data"
        password = "password123"

        encrypted1 = ContextCrypto.encrypt(data, password)
        encrypted2 = ContextCrypto.encrypt(data, password)

        assert encrypted1 != encrypted2

        decrypted1 = ContextCrypto.decrypt(encrypted1, password)
        decrypted2 = ContextCrypto.decrypt(encrypted2, password)

        assert decrypted1 == data
        assert decrypted2 == data

    def test_decrypt_with_wrong_password_fails(self):
        """Test that decryption fails with wrong password."""
        data = "Secret data"
        password = "correct-password"
        wrong_password = "wrong-password"

        encrypted = ContextCrypto.encrypt(data, password)

        with pytest.raises(OpenContextError):
            ContextCrypto.decrypt(encrypted, wrong_password)

    def test_encrypt_decrypt_empty_data(self):
        """Test encryption and decryption of empty data."""
        data = ""
        password = "password123"

        encrypted = ContextCrypto.encrypt(data, password)
        decrypted = ContextCrypto.decrypt(encrypted, password)

        assert decrypted == data

    def test_encrypt_decrypt_large_data(self):
        """Test encryption and decryption of large data."""
        data = "x" * 100000  # 100KB
        password = "password123"

        encrypted = ContextCrypto.encrypt(data, password)
        decrypted = ContextCrypto.decrypt(encrypted, password)

        assert decrypted == data

    def test_encrypt_decrypt_unicode_data(self):
        """Test encryption and decryption of unicode data."""
        data = "🌐 OpenContext Network 日本語 emoji test 🚀"
        password = "password123"

        encrypted = ContextCrypto.encrypt(data, password)
        decrypted = ContextCrypto.decrypt(encrypted, password)

        assert decrypted == data

    def test_generate_password(self):
        """Test password generation."""
        password1 = ContextCrypto.generate_password()
        password2 = ContextCrypto.generate_password()

        assert password1
        assert password2
        assert password1 != password2
        assert len(password1) == 64  # 32 bytes * 2 hex chars

    def test_derive_password_from_private_key(self):
        """Test password derivation from private key."""
        private_key = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

        password1 = ContextCrypto.derive_password_from_private_key(private_key)
        password2 = ContextCrypto.derive_password_from_private_key(private_key)

        assert password1 == password2
        assert password1

    def test_derive_password_different_keys(self):
        """Test that different keys produce different passwords."""
        key1 = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        key2 = "0x1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

        password1 = ContextCrypto.derive_password_from_private_key(key1)
        password2 = ContextCrypto.derive_password_from_private_key(key2)

        assert password1 != password2

    def test_base64_encode_decode(self):
        """Test base64 encoding and decoding."""
        data = "Test data for base64"

        encoded = ContextCrypto.encode_base64(data)
        decoded = ContextCrypto.decode_base64(encoded)

        assert decoded == data

        # Verify it's actually base64
        import base64

        expected = base64.b64encode(data.encode()).decode()
        assert encoded == expected

    def test_encrypt_with_invalid_data_type(self):
        """A non-string payload is reported as an SDK error, not a bare AttributeError."""
        with pytest.raises(OpenContextError, match="Encryption failed"):
            ContextCrypto.encrypt(None, "password")  # type: ignore[arg-type]

    def test_decrypt_with_invalid_data(self):
        """Test decryption with invalid encrypted data."""
        with pytest.raises(OpenContextError):
            ContextCrypto.decrypt("invalid-base64-data", "password")

    def test_decrypt_with_tampered_data(self):
        """Test decryption with tampered encrypted data."""
        data = "Original data"
        password = "password123"

        encrypted = ContextCrypto.encrypt(data, password)

        # Tamper with the encrypted data
        tampered = encrypted[:-5] + "xxxxx"

        with pytest.raises(OpenContextError):
            ContextCrypto.decrypt(tampered, password)

    def test_decrypt_truncated_payload_has_clear_message(self):
        """A blob shorter than the salt/iv/tag header is rejected before any crypto runs."""
        too_short = base64.b64encode(b"\x00" * (ContextCrypto.HEADER_LENGTH - 1)).decode()

        with pytest.raises(OpenContextError) as exc_info:
            ContextCrypto.decrypt(too_short, "password")

        assert "shorter than" in exc_info.value.message

    def test_decrypt_wrong_password_error_is_explicit(self):
        """The GCM tag failure is surfaced as a wrong-password/tamper error, not a raw traceback."""
        encrypted = ContextCrypto.encrypt("data", "right-password")

        with pytest.raises(OpenContextError, match="wrong password or tampered"):
            ContextCrypto.decrypt(encrypted, "wrong-password")

    def test_derive_password_matches_typescript_sdk_hkdf(self):
        """Known answers from Node: hkdfSync('sha256', key, '', 'opencontext/context-encryption/v1', 32)."""
        vectors = {
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef": (
                "6ab580a5dab816c9970ae7081d55f4033931dda37d452934198a801417fe908c"
            ),
            "1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef": (
                "f2e5d46cd99dc05daa25ba90e2e0e167a98f0a6c6278ef991f88a6b9388627e7"
            ),
        }

        for key, expected in vectors.items():
            assert ContextCrypto.derive_password_from_private_key("0x" + key) == expected
            assert ContextCrypto.derive_password_from_private_key(key) == expected

    @pytest.mark.parametrize("bad_key", ["0x1234", "not-hex" * 10, "0x" + "zz" * 32, ""])
    def test_derive_password_rejects_malformed_keys(self, bad_key):
        """Anything but 32 hex bytes is refused up front instead of deriving garbage."""
        with pytest.raises(OpenContextError) as exc_info:
            ContextCrypto.derive_password_from_private_key(bad_key)

        assert exc_info.value.code == SDKError.ENCRYPTION_FAILED

    def test_crypto_failures_use_encryption_failed_code(self):
        """Crypto problems are not transaction failures; they carry their own error code."""
        encrypted = ContextCrypto.encrypt("data", "right-password")

        with pytest.raises(OpenContextError) as exc_info:
            ContextCrypto.decrypt(encrypted, "wrong-password")

        assert exc_info.value.code == SDKError.ENCRYPTION_FAILED


class TestCrossSdkCompatibility:
    """The Python and TypeScript SDKs must produce interchangeable ciphertext."""

    def test_decrypts_ciphertext_produced_by_the_typescript_sdk_recipe(self):
        """Known-answer test against a blob generated by Node's crypto (see module header)."""
        assert ContextCrypto.decrypt(JS_SDK_BLOB, JS_SDK_PASSWORD) == JS_SDK_PLAINTEXT

    def test_kdf_parameters_match_node_scrypt_defaults(self):
        """Node's crypto.scrypt defaults to N=16384, r=8, p=1; the JS SDK relies on them."""
        assert (ContextCrypto.SCRYPT_N, ContextCrypto.SCRYPT_R, ContextCrypto.SCRYPT_P) == (
            16384,
            8,
            1,
        )
        assert ContextCrypto.KEY_LENGTH == 32
        assert ContextCrypto.HEADER_LENGTH == 32 + 16 + 16

    def test_envelope_layout_is_salt_iv_tag_ciphertext(self):
        """Decode the envelope by hand using only the documented layout."""
        data = "layout check"
        password = "pw"

        raw = base64.b64decode(ContextCrypto.encrypt(data, password), validate=True)

        assert len(raw) == 32 + 16 + 16 + len(data.encode("utf-8"))
        salt, iv, tag, ciphertext = raw[:32], raw[32:48], raw[48:64], raw[64:]
        key = Scrypt(salt=salt, length=32, n=2**14, r=8, p=1).derive(password.encode("utf-8"))
        assert AESGCM(key).decrypt(iv, ciphertext + tag, None) == data.encode("utf-8")
