"""Tests for ContextCrypto module."""

import pytest

from opencontext.crypto import ContextCrypto
from opencontext.errors import OpenContextError


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
        """Test encryption with invalid data type."""
        with pytest.raises(Exception):  # Should raise some exception
            ContextCrypto.encrypt(None, "password")  # type: ignore

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