"""Main client for OpenContext SDK."""

from collections.abc import Mapping

from eth_typing import ChecksumAddress, HexStr
from web3 import AsyncWeb3, Web3

from .crypto import ContextCrypto
from .errors import OpenContextError, SDKError
from .passport import PassportRegistry
from .payments import PaymentStream
from .types import OpenContextConfig, PassportData
from .vault import ContextVault


class OpenContextClient:
    """Main OpenContext client."""

    def __init__(self, config: OpenContextConfig) -> None:
        """Initialize OpenContext client."""
        self.config = config
        self.passport = PassportRegistry(config)
        self.vault = ContextVault(config)
        self.payments = PaymentStream(config)
        self.encryption_password: str | None = None

        # Initialize encryption password from private key if available
        if config.private_key:
            self.encryption_password = ContextCrypto.derive_password_from_private_key(
                config.private_key
            )

    async def authenticate(self) -> PassportData:
        """Authenticate and get or create passport."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for authentication")

        passport = await self.passport.get_passport(self.config.account)

        if not passport:
            data_hash = Web3.to_hex(Web3.keccak(text=f"opencontext:{self.config.account}"))
            token_id = await self.passport.mint(self.config.account, data_hash)

            passport = PassportData(
                token_id=token_id,
                owner=self.config.account,
                data_hash=data_hash,
                exists=True,
            )

        return passport

    async def get_my_passport(self) -> PassportData | None:
        """Get current account's passport."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required")

        return await self.passport.get_passport(self.config.account)

    async def get_my_token_id(self) -> int:
        """Get current account's token ID."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required")

        token_id = await self.passport.get_token_id(self.config.account)

        if token_id == 0:
            raise OpenContextError(SDKError.NO_PASSPORT, "No passport found")

        return token_id

    async def store_context(self, data: str) -> int:
        """Store encrypted context data."""
        encrypted_data = await self._encrypt_data(data)
        return await self.vault.store_context(encrypted_data)

    async def get_my_latest_context(self) -> str | None:
        """Get the latest stored context."""
        token_id = await self.get_my_token_id()
        context = await self.vault.get_latest_context(token_id)

        if not context:
            return None

        return await self._decrypt_data(context.encrypted_data)

    async def get_my_context(self, version: int) -> str:
        """Get specific version of context."""
        token_id = await self.get_my_token_id()
        context = await self.vault.get_context(token_id, version)
        return await self._decrypt_data(context.encrypted_data)

    async def stream_pay(self, provider: ChecksumAddress, bytes_per_second: int) -> None:
        """Start a USDCx stream from the account to ``provider``.

        The account must hold a passport and have granted the PaymentStream contract
        flow-operator permission beforehand; see :mod:`opencontext.payments`.
        """
        await self.payments.start_stream(provider, bytes_per_second)

    async def stop_payment(self, provider: ChecksumAddress) -> None:
        """Stop payment stream."""
        await self.payments.stop_stream(provider)

    async def get_my_streams(self, providers: list[ChecksumAddress]) -> dict[ChecksumAddress, int]:
        """Active flow rates keyed by provider for the current account.

        Streams are keyed by wallet address, so no passport lookup is involved.
        """
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required")

        streams: dict[ChecksumAddress, int] = {}

        for provider in providers:
            stream_info = await self.payments.get_stream_info(self.config.account, provider)
            if stream_info.active:
                streams[provider] = stream_info.flow_rate

        return streams

    async def become_provider(self, receiver: ChecksumAddress, rate_per_byte: int) -> None:
        """Register as a data provider."""
        await self.payments.register_provider(receiver, rate_per_byte)

    async def update_my_provider_rate(self, new_rate: int) -> None:
        """Update provider rate."""
        await self.payments.update_provider_rate(new_rate)

    async def record_consumption(
        self, user: ChecksumAddress, provider: ChecksumAddress, bytes_amount: int
    ) -> None:
        """Attribute ``bytes_amount`` served by ``provider`` to ``user``'s stream.

        The account must be a meter enabled by the contract owner (the metering gateway,
        typically); providers cannot report their own usage.
        """
        await self.payments.record_consumption(user, provider, bytes_amount)

    async def _encrypt_data(self, data: str) -> str:
        """Encrypt data using AES-256-GCM or base64 fallback."""
        if not self.encryption_password:
            # Fallback to base64 for testing/development
            return ContextCrypto.encode_base64(data)

        return ContextCrypto.encrypt(data, self.encryption_password)

    async def _decrypt_data(self, encrypted_data: str) -> str:
        """Decrypt data using AES-256-GCM or base64 fallback."""
        if not self.encryption_password:
            # Fallback to base64 for testing/development
            try:
                return ContextCrypto.decode_base64(encrypted_data)
            except Exception as exc:
                # If base64 decode fails, data might be encrypted
                raise OpenContextError(
                    SDKError.ENCRYPTION_FAILED,
                    "Cannot decrypt data: no encryption password available",
                ) from exc

        try:
            return ContextCrypto.decrypt(encrypted_data, self.encryption_password)
        except Exception:
            # Try base64 fallback for data stored before a password was configured
            try:
                return ContextCrypto.decode_base64(encrypted_data)
            except Exception as exc:
                raise OpenContextError(
                    SDKError.ENCRYPTION_FAILED,
                    "Failed to decrypt data with available methods",
                ) from exc

    def set_encryption_password(self, password: str) -> None:
        """Set a custom encryption password (for advanced use cases)."""
        self.encryption_password = password

    def generate_encryption_password(self) -> str:
        """Generate a new random encryption password."""
        password = ContextCrypto.generate_password()
        self.encryption_password = password
        return password

    @classmethod
    async def create(
        cls,
        provider_url: str,
        private_key: str,
        addresses: Mapping[str, str],
    ) -> "OpenContextClient":
        """Create a client from an RPC URL, a hex private key and contract addresses.

        ``addresses`` must contain ``passport_registry``, ``context_vault`` and
        ``payment_stream``. Each is normalised to its EIP-55 checksum form, so a
        malformed address raises ``ValueError`` here rather than on first use.
        """
        web3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(provider_url))
        account = web3.eth.account.from_key(private_key)

        config = OpenContextConfig(
            web3=web3,
            account=account.address,
            private_key=HexStr(private_key),
            passport_registry_address=Web3.to_checksum_address(addresses["passport_registry"]),
            context_vault_address=Web3.to_checksum_address(addresses["context_vault"]),
            payment_stream_address=Web3.to_checksum_address(addresses["payment_stream"]),
        )

        return cls(config)
