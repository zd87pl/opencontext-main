"""Payment Stream module for OpenContext SDK."""

from typing import Optional

from eth_typing import Address

from .constants import PAYMENT_STREAM_ABI
from .errors import OpenContextError, SDKError
from .types import DataProvider, OpenContextConfig, StreamInfo


class PaymentStream:
    """Payment Stream contract interface."""

    def __init__(self, config: OpenContextConfig) -> None:
        """Initialize PaymentStream with config."""
        self.config = config
        self.contract = config.web3.eth.contract(
            address=config.payment_stream_address,
            abi=PAYMENT_STREAM_ABI,
        )

    async def register_provider(self, receiver: Address, rate_per_byte: int) -> None:
        """Register as a data provider."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for registration")

        try:
            tx = await self.contract.functions.registerProvider(
                receiver, rate_per_byte
            ).build_transaction(
                {
                    "from": self.config.account,
                    "nonce": await self.config.web3.eth.get_transaction_count(
                        self.config.account
                    ),
                }
            )

            if self.config.private_key:
                signed_tx = self.config.web3.eth.account.sign_transaction(
                    tx, self.config.private_key
                )
                tx_hash = await self.config.web3.eth.send_raw_transaction(
                    signed_tx.rawTransaction
                )
            else:
                tx_hash = await self.config.web3.eth.send_transaction(tx)

            await self.config.web3.eth.wait_for_transaction_receipt(tx_hash)

        except Exception as e:
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Register provider failed: {str(e)}"
            )

    async def update_provider_rate(self, new_rate: int) -> None:
        """Update provider rate."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for update")

        try:
            tx = await self.contract.functions.updateProviderRate(new_rate).build_transaction(
                {
                    "from": self.config.account,
                    "nonce": await self.config.web3.eth.get_transaction_count(
                        self.config.account
                    ),
                }
            )

            if self.config.private_key:
                signed_tx = self.config.web3.eth.account.sign_transaction(
                    tx, self.config.private_key
                )
                tx_hash = await self.config.web3.eth.send_raw_transaction(
                    signed_tx.rawTransaction
                )
            else:
                tx_hash = await self.config.web3.eth.send_transaction(tx)

            await self.config.web3.eth.wait_for_transaction_receipt(tx_hash)

        except Exception as e:
            error_msg = str(e)
            if "ProviderNotActive" in error_msg:
                raise OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, "Provider not active")
            raise OpenContextError(SDKError.TRANSACTION_FAILED, f"Update rate failed: {error_msg}")

    async def start_stream(self, provider: Address, bytes_per_second: int) -> None:
        """Start a payment stream to a provider."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for streaming")

        try:
            tx = await self.contract.functions.startStream(
                provider, bytes_per_second
            ).build_transaction(
                {
                    "from": self.config.account,
                    "nonce": await self.config.web3.eth.get_transaction_count(
                        self.config.account
                    ),
                }
            )

            if self.config.private_key:
                signed_tx = self.config.web3.eth.account.sign_transaction(
                    tx, self.config.private_key
                )
                tx_hash = await self.config.web3.eth.send_raw_transaction(
                    signed_tx.rawTransaction
                )
            else:
                tx_hash = await self.config.web3.eth.send_transaction(tx)

            await self.config.web3.eth.wait_for_transaction_receipt(tx_hash)

        except Exception as e:
            error_msg = str(e)
            if "NotPassportHolder" in error_msg:
                raise OpenContextError(SDKError.NO_PASSPORT, "No passport found for address")
            elif "ProviderNotActive" in error_msg:
                raise OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, "Provider not active")
            elif "InvalidFlowRate" in error_msg:
                raise OpenContextError(SDKError.INVALID_FLOW_RATE, "Invalid flow rate")
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Start stream failed: {error_msg}"
            )

    async def update_stream(self, provider: Address, new_bytes_per_second: int) -> None:
        """Update an existing stream."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for update")

        try:
            tx = await self.contract.functions.updateStream(
                provider, new_bytes_per_second
            ).build_transaction(
                {
                    "from": self.config.account,
                    "nonce": await self.config.web3.eth.get_transaction_count(
                        self.config.account
                    ),
                }
            )

            if self.config.private_key:
                signed_tx = self.config.web3.eth.account.sign_transaction(
                    tx, self.config.private_key
                )
                tx_hash = await self.config.web3.eth.send_raw_transaction(
                    signed_tx.rawTransaction
                )
            else:
                tx_hash = await self.config.web3.eth.send_transaction(tx)

            await self.config.web3.eth.wait_for_transaction_receipt(tx_hash)

        except Exception as e:
            error_msg = str(e)
            if "NotPassportHolder" in error_msg:
                raise OpenContextError(SDKError.NO_PASSPORT, "No passport found for address")
            elif "ProviderNotActive" in error_msg:
                raise OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, "Provider not active")
            elif "InvalidFlowRate" in error_msg:
                raise OpenContextError(SDKError.INVALID_FLOW_RATE, "Invalid flow rate")
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Update stream failed: {error_msg}"
            )

    async def stop_stream(self, provider: Address) -> None:
        """Stop a payment stream."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for stopping")

        try:
            tx = await self.contract.functions.stopStream(provider).build_transaction(
                {
                    "from": self.config.account,
                    "nonce": await self.config.web3.eth.get_transaction_count(
                        self.config.account
                    ),
                }
            )

            if self.config.private_key:
                signed_tx = self.config.web3.eth.account.sign_transaction(
                    tx, self.config.private_key
                )
                tx_hash = await self.config.web3.eth.send_raw_transaction(
                    signed_tx.rawTransaction
                )
            else:
                tx_hash = await self.config.web3.eth.send_transaction(tx)

            await self.config.web3.eth.wait_for_transaction_receipt(tx_hash)

        except Exception as e:
            error_msg = str(e)
            if "NotPassportHolder" in error_msg:
                raise OpenContextError(SDKError.NO_PASSPORT, "No passport found for address")
            raise OpenContextError(SDKError.TRANSACTION_FAILED, f"Stop stream failed: {error_msg}")

    async def record_consumption(self, token_id: int, bytes_consumed: int) -> None:
        """Record bytes consumed (called by providers)."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for recording")

        try:
            tx = await self.contract.functions.recordConsumption(
                token_id, bytes_consumed
            ).build_transaction(
                {
                    "from": self.config.account,
                    "nonce": await self.config.web3.eth.get_transaction_count(
                        self.config.account
                    ),
                }
            )

            if self.config.private_key:
                signed_tx = self.config.web3.eth.account.sign_transaction(
                    tx, self.config.private_key
                )
                tx_hash = await self.config.web3.eth.send_raw_transaction(
                    signed_tx.rawTransaction
                )
            else:
                tx_hash = await self.config.web3.eth.send_transaction(tx)

            await self.config.web3.eth.wait_for_transaction_receipt(tx_hash)

        except Exception as e:
            error_msg = str(e)
            if "ProviderNotActive" in error_msg:
                raise OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, "Provider not active")
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Record consumption failed: {error_msg}"
            )

    async def get_stream_info(self, token_id: int, provider: Address) -> StreamInfo:
        """Get stream information."""
        try:
            flow_rate, receiver = await self.contract.functions.getStreamInfo(
                token_id, provider
            ).call()

            return StreamInfo(
                flow_rate=flow_rate,
                receiver=receiver,
                active=flow_rate > 0,
            )

        except Exception as e:
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Get stream info failed: {str(e)}"
            )

    async def get_provider(self, address: Address) -> Optional[DataProvider]:
        """Get provider information."""
        try:
            receiver, rate_per_byte, total_bytes_served, active = (
                await self.contract.functions.dataProviders(address).call()
            )

            if not active:
                return None

            return DataProvider(
                receiver=receiver,
                rate_per_byte=rate_per_byte,
                total_bytes_served=total_bytes_served,
                active=active,
            )

        except Exception as e:
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Get provider failed: {str(e)}"
            )

    @staticmethod
    def calculate_flow_rate(rate_per_byte: int, bytes_per_second: int) -> int:
        """Calculate flow rate from bytes per second."""
        rate_precision = 10**18
        return (rate_per_byte * bytes_per_second) // rate_precision

    @staticmethod
    def calculate_monthly_cost(rate_per_byte: int, bytes_per_second: int) -> int:
        """Calculate monthly cost for streaming."""
        seconds_per_month = 30 * 24 * 60 * 60
        flow_rate = PaymentStream.calculate_flow_rate(rate_per_byte, bytes_per_second)
        return flow_rate * seconds_per_month