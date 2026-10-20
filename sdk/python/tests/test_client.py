"""Tests for OpenContextClient module."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from web3 import Web3

from opencontext.client import OpenContextClient
from opencontext.crypto import ContextCrypto
from opencontext.errors import OpenContextError, SDKError
from opencontext.types import ContextData, OpenContextConfig, PassportData, StreamInfo


@pytest.fixture
def mock_config():
    """Create a mock configuration."""
    return OpenContextConfig(
        passport_registry_address="0x1234567890123456789012345678901234567890",
        context_vault_address="0x1234567890123456789012345678901234567891",
        payment_stream_address="0x1234567890123456789012345678901234567892",
        web3=MagicMock(),
        account="0x1111111111111111111111111111111111111111",
        private_key="0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    )


@pytest.fixture
def mock_client(mock_config):
    """Create a mock client with mocked dependencies."""
    with patch("opencontext.client.PassportRegistry") as mock_passport, patch(
        "opencontext.client.ContextVault"
    ) as mock_vault, patch("opencontext.client.PaymentStream") as mock_payments:
        client = OpenContextClient(mock_config)
        client.passport = mock_passport.return_value
        client.vault = mock_vault.return_value
        client.payments = mock_payments.return_value

        return client


class TestOpenContextClient:
    """Test OpenContextClient functionality."""

    def test_client_initialization(self, mock_config):
        """Test client initialization."""
        client = OpenContextClient(mock_config)

        assert client.config == mock_config
        assert client.passport is not None
        assert client.vault is not None
        assert client.payments is not None
        # The fixture key's HKDF-derived password, as computed by Node for the JS SDK.
        assert (
            client.encryption_password
            == "6ab580a5dab816c9970ae7081d55f4033931dda37d452934198a801417fe908c"
        )

    def test_client_initialization_without_private_key(self):
        """Test client initialization without private key."""
        config_without_key = OpenContextConfig(
            passport_registry_address="0x1234567890123456789012345678901234567890",
            context_vault_address="0x1234567890123456789012345678901234567891",
            payment_stream_address="0x1234567890123456789012345678901234567892",
            web3=MagicMock(),
            account="0x1111111111111111111111111111111111111111",
        )

        client = OpenContextClient(config_without_key)
        assert client.encryption_password is None

    @pytest.mark.asyncio
    async def test_authenticate_existing_passport(self, mock_client):
        """Test authentication with existing passport."""
        expected_passport = PassportData(
            token_id=1,
            owner="0x1111111111111111111111111111111111111111",
            data_hash="0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            exists=True,
        )

        mock_client.passport.get_passport = AsyncMock(return_value=expected_passport)

        result = await mock_client.authenticate()

        assert result == expected_passport
        mock_client.passport.get_passport.assert_called_once_with(mock_client.config.account)

    @pytest.mark.asyncio
    async def test_authenticate_create_new_passport(self, mock_client):
        """Test authentication creating new passport."""
        mock_client.passport.get_passport = AsyncMock(return_value=None)
        mock_client.passport.mint = AsyncMock(return_value=1)

        result = await mock_client.authenticate()

        # keccak is pure, so assert the real 0x-hex hash instead of mocking Web3 away.
        expected_hash = Web3.to_hex(Web3.keccak(text=f"opencontext:{mock_client.config.account}"))
        assert result.token_id == 1
        assert result.owner == mock_client.config.account
        assert result.data_hash == expected_hash
        assert result.exists is True
        mock_client.passport.mint.assert_awaited_once_with(
            mock_client.config.account, expected_hash
        )

    @pytest.mark.asyncio
    async def test_authenticate_no_account(self):
        """Test authentication without account."""
        config_no_account = OpenContextConfig(
            passport_registry_address="0x1234567890123456789012345678901234567890",
            context_vault_address="0x1234567890123456789012345678901234567891",
            payment_stream_address="0x1234567890123456789012345678901234567892",
            web3=MagicMock(),
        )

        client = OpenContextClient(config_no_account)

        with pytest.raises(OpenContextError) as exc_info:
            await client.authenticate()

        assert exc_info.value.code == SDKError.NO_ACCOUNT

    @pytest.mark.asyncio
    async def test_get_my_passport(self, mock_client):
        """Test getting current user's passport."""
        expected_passport = PassportData(
            token_id=1,
            owner="0x1111111111111111111111111111111111111111",
            data_hash="0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            exists=True,
        )

        mock_client.passport.get_passport = AsyncMock(return_value=expected_passport)

        result = await mock_client.get_my_passport()

        assert result == expected_passport

    @pytest.mark.asyncio
    async def test_get_my_token_id(self, mock_client):
        """Test getting current user's token ID."""
        token_id = 5

        mock_client.passport.get_token_id = AsyncMock(return_value=token_id)

        result = await mock_client.get_my_token_id()

        assert result == token_id

    @pytest.mark.asyncio
    async def test_get_my_token_id_no_passport(self, mock_client):
        """Test getting token ID when no passport exists."""
        mock_client.passport.get_token_id = AsyncMock(return_value=0)

        with pytest.raises(OpenContextError) as exc_info:
            await mock_client.get_my_token_id()

        assert exc_info.value.code == SDKError.NO_PASSPORT

    @pytest.mark.asyncio
    async def test_store_context(self, mock_client):
        """Test storing context data."""
        test_data = "Test context data"
        version = 1

        mock_client.vault.store_context = AsyncMock(return_value=version)

        result = await mock_client.store_context(test_data)

        assert result == version
        mock_client.vault.store_context.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_my_latest_context(self, mock_client):
        """Test getting latest context."""
        test_data = "Test context data"
        token_id = 1

        mock_client.passport.get_token_id = AsyncMock(return_value=token_id)
        mock_client.vault.get_latest_context = AsyncMock(
            return_value=MagicMock(encrypted_data="encrypted_data")
        )

        with patch.object(mock_client, "_decrypt_data", return_value=test_data):
            result = await mock_client.get_my_latest_context()

            assert result == test_data

    @pytest.mark.asyncio
    async def test_get_my_latest_context_none(self, mock_client):
        """Test getting latest context when none exists."""
        token_id = 1

        mock_client.passport.get_token_id = AsyncMock(return_value=token_id)
        mock_client.vault.get_latest_context = AsyncMock(return_value=None)

        result = await mock_client.get_my_latest_context()

        assert result is None

    @pytest.mark.asyncio
    async def test_stream_pay(self, mock_client):
        """Test starting payment stream."""
        provider = "0x2222222222222222222222222222222222222222"
        bytes_per_second = 1000

        mock_client.payments.start_stream = AsyncMock()

        await mock_client.stream_pay(provider, bytes_per_second)

        mock_client.payments.start_stream.assert_called_once_with(provider, bytes_per_second)

    @pytest.mark.asyncio
    async def test_stop_payment(self, mock_client):
        """Test stopping payment stream."""
        provider = "0x2222222222222222222222222222222222222222"

        mock_client.payments.stop_stream = AsyncMock()

        await mock_client.stop_payment(provider)

        mock_client.payments.stop_stream.assert_called_once_with(provider)

    @pytest.mark.asyncio
    async def test_get_my_streams_is_keyed_by_account(self, mock_client):
        """Streams are keyed by wallet address (PaymentStream.sol c4f2afd), not token id."""
        provider_a = "0x2222222222222222222222222222222222222222"
        provider_b = "0x3333333333333333333333333333333333333333"

        async def stream_info(_user, provider):
            active = provider == provider_a
            return StreamInfo(flow_rate=10 if active else 0, receiver=provider, active=active)

        mock_client.payments.get_stream_info = AsyncMock(side_effect=stream_info)
        mock_client.passport.get_token_id = AsyncMock()

        assert await mock_client.get_my_streams([provider_a, provider_b]) == {provider_a: 10}

        mock_client.payments.get_stream_info.assert_any_await(
            mock_client.config.account, provider_a
        )
        mock_client.payments.get_stream_info.assert_any_await(
            mock_client.config.account, provider_b
        )
        mock_client.passport.get_token_id.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_get_my_streams_no_account(self):
        config_no_account = OpenContextConfig(
            passport_registry_address="0x1234567890123456789012345678901234567890",
            context_vault_address="0x1234567890123456789012345678901234567891",
            payment_stream_address="0x1234567890123456789012345678901234567892",
            web3=MagicMock(),
        )

        with pytest.raises(OpenContextError) as exc_info:
            await OpenContextClient(config_no_account).get_my_streams([])

        assert exc_info.value.code == SDKError.NO_ACCOUNT

    @pytest.mark.asyncio
    async def test_record_consumption(self, mock_client):
        """Replaces record_bytes_provided(consumer_token_id, bytes): metering is per
        (user, provider) and done by an enabled meter, not the provider."""
        user = "0x2222222222222222222222222222222222222222"
        provider = "0x3333333333333333333333333333333333333333"

        mock_client.payments.record_consumption = AsyncMock()

        await mock_client.record_consumption(user, provider, 4096)

        mock_client.payments.record_consumption.assert_awaited_once_with(user, provider, 4096)

    @pytest.mark.asyncio
    async def test_become_provider(self, mock_client):
        """Test becoming a data provider."""
        receiver = "0x3333333333333333333333333333333333333333"
        rate_per_byte = 1000000000000000

        mock_client.payments.register_provider = AsyncMock()

        await mock_client.become_provider(receiver, rate_per_byte)

        mock_client.payments.register_provider.assert_called_once_with(receiver, rate_per_byte)

    def test_set_encryption_password(self, mock_client):
        """Test setting custom encryption password."""
        new_password = "custom-password-123"

        mock_client.set_encryption_password(new_password)

        assert mock_client.encryption_password == new_password

    def test_generate_encryption_password(self, mock_client):
        """Test generating new encryption password."""
        with patch("opencontext.client.ContextCrypto.generate_password") as mock_generate:
            mock_generate.return_value = "generated-password"

            result = mock_client.generate_encryption_password()

            assert result == "generated-password"
            assert mock_client.encryption_password == "generated-password"

    @pytest.mark.asyncio
    async def test_encrypt_data_with_password(self, mock_client):
        """Test data encryption with password."""
        test_data = "Test data"

        with patch("opencontext.client.ContextCrypto.encrypt") as mock_encrypt:
            mock_encrypt.return_value = "encrypted_data"

            result = await mock_client._encrypt_data(test_data)

            assert result == "encrypted_data"
            mock_encrypt.assert_called_once_with(test_data, mock_client.encryption_password)

    @pytest.mark.asyncio
    async def test_encrypt_data_without_password(self, mock_client):
        """Test data encryption without password (base64 fallback)."""
        mock_client.encryption_password = None
        test_data = "Test data"

        with patch("opencontext.client.ContextCrypto.encode_base64") as mock_encode:
            mock_encode.return_value = "base64_data"

            result = await mock_client._encrypt_data(test_data)

            assert result == "base64_data"
            mock_encode.assert_called_once_with(test_data)

    @pytest.mark.asyncio
    async def test_decrypt_data_with_password(self, mock_client):
        """Test data decryption with password."""
        encrypted_data = "encrypted_data"

        with patch("opencontext.client.ContextCrypto.decrypt") as mock_decrypt:
            mock_decrypt.return_value = "decrypted_data"

            result = await mock_client._decrypt_data(encrypted_data)

            assert result == "decrypted_data"
            mock_decrypt.assert_called_once_with(encrypted_data, mock_client.encryption_password)

    @pytest.mark.asyncio
    async def test_decrypt_data_fallback_to_base64(self, mock_client):
        """Test data decryption with fallback to base64."""
        encrypted_data = "base64_data"

        with patch("opencontext.client.ContextCrypto.decrypt") as mock_decrypt, patch(
            "opencontext.client.ContextCrypto.decode_base64"
        ) as mock_decode:
            mock_decrypt.side_effect = Exception("Decryption failed")
            mock_decode.return_value = "decoded_data"

            result = await mock_client._decrypt_data(encrypted_data)

            assert result == "decoded_data"

    @pytest.mark.asyncio
    async def test_create_client(self):
        """Test creating client with create method."""
        provider_url = "https://sepolia.era.zksync.dev"
        private_key = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        addresses = {
            "passport_registry": "0x1234567890123456789012345678901234567890",
            "context_vault": "0x1234567890123456789012345678901234567891",
            "payment_stream": "0x1234567890123456789012345678901234567892",
        }

        with patch("opencontext.client.AsyncWeb3") as mock_web3_class:
            mock_web3 = MagicMock()
            mock_account = MagicMock()
            mock_account.address = "0x1111111111111111111111111111111111111111"

            mock_web3_class.return_value = mock_web3
            mock_web3.eth.account.from_key.return_value = mock_account

            client = await OpenContextClient.create(provider_url, private_key, addresses)

            assert isinstance(client, OpenContextClient)
            assert client.config.account == mock_account.address
            assert client.config.private_key == private_key

    @pytest.mark.asyncio
    async def test_create_client_checksums_addresses(self):
        """Lower-case addresses are normalised to EIP-55 form; malformed ones fail fast."""
        private_key = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        lower = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045"
        checksummed = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
        addresses = {"passport_registry": lower, "context_vault": lower, "payment_stream": lower}

        with patch("opencontext.client.AsyncWeb3"):
            client = await OpenContextClient.create("http://localhost:8545", private_key, addresses)
            assert client.config.passport_registry_address == checksummed
            assert client.config.context_vault_address == checksummed
            assert client.config.payment_stream_address == checksummed

            with pytest.raises(ValueError):
                await OpenContextClient.create(
                    "http://localhost:8545", private_key, {**addresses, "context_vault": "0x123"}
                )

    @pytest.mark.asyncio
    async def test_store_and_read_back_uses_real_encryption(self, mock_client):
        """End to end through the client: what reaches the vault is ciphertext, not plaintext."""
        plaintext = '{"preferences": {"theme": "dark"}}'
        stored: list[str] = []

        async def capture(blob: str) -> int:
            stored.append(blob)
            return 1

        mock_client.vault.store_context = AsyncMock(side_effect=capture)
        mock_client.passport.get_token_id = AsyncMock(return_value=1)

        version = await mock_client.store_context(plaintext)

        assert version == 1
        assert len(stored) == 1
        assert plaintext not in stored[0]
        # Only the key-derived password opens it.
        assert ContextCrypto.decrypt(stored[0], mock_client.encryption_password) == plaintext
        with pytest.raises(OpenContextError):
            ContextCrypto.decrypt(stored[0], "some-other-password")

        mock_client.vault.get_latest_context = AsyncMock(
            return_value=ContextData(encrypted_data=stored[0], timestamp=1, version=1)
        )
        assert await mock_client.get_my_latest_context() == plaintext
