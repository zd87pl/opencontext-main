"""Main client for OpenContext SDK."""

import base64
from typing import Dict, List, Optional

from eth_typing import Address, HexStr
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
        self.encryption_password: Optional[str] = None
        
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
            data_hash = Web3.keccak(text=f"opencontext:{self.config.account}")
            token_id = await self.passport.mint(self.config.account, data_hash)

            passport = PassportData(
                token_id=token_id,
                owner=self.config.account,
                data_hash=data_hash,
                exists=True,
            )

        return passport

    async def get_my_passport(self) -> Optional[PassportData]:
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

    async def get_my_latest_context(self) -> Optional[str]:
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

    async def stream_pay(self, provider: Address, bytes_per_second: int) -> None:
        """Start payment stream to provider."""
        await self.payments.start_stream(provider, bytes_per_second)

    async def stop_payment(self, provider: Address) -> None:
        """Stop payment stream."""
        await self.payments.stop_stream(provider)

    async def get_my_streams(self, providers: List[Address]) -> Dict[Address, int]:
        """Get active streams for current account."""
        token_id = await self.get_my_token_id()
        streams = {}

        for provider in providers:
            stream_info = await self.payments.get_stream_info(token_id, provider)
            if stream_info.active:
                streams[provider] = stream_info.flow_rate

        return streams

    async def become_provider(self, receiver: Address, rate_per_byte: int) -> None:
        """Register as a data provider."""
        await self.payments.register_provider(receiver, rate_per_byte)

    async def update_my_provider_rate(self, new_rate: int) -> None:
        """Update provider rate."""
        await self.payments.update_provider_rate(new_rate)

    async def record_bytes_provided(self, consumer_token_id: int, bytes_amount: int) -> None:
        """Record bytes provided to consumer."""
        await self.payments.record_consumption(consumer_token_id, bytes_amount)

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
            except Exception:
                # If base64 decode fails, data might be encrypted
                raise OpenContextError(
                    SDKError.TRANSACTION_FAILED,
                    "Cannot decrypt data: no encryption password available"
                )
        
        try:
            return ContextCrypto.decrypt(encrypted_data, self.encryption_password)
        except Exception:
            # Try base64 fallback for backward compatibility
            try:
                return ContextCrypto.decode_base64(encrypted_data)
            except Exception:
                raise OpenContextError(
                    SDKError.TRANSACTION_FAILED,
                    "Failed to decrypt data with available methods"
                )

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
        private_key: HexStr,
        addresses: Dict[str, Address],
    ) -> "OpenContextClient":
        """Create OpenContext client instance."""
        web3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(provider_url))
        account = web3.eth.account.from_key(private_key)

        config = OpenContextConfig(
            web3=web3,
            account=account.address,
            private_key=private_key,
            passport_registry_address=addresses["passport_registry"],
            context_vault_address=addresses["context_vault"],
            payment_stream_address=addresses["payment_stream"],
        )

        return cls(config)