"""Context Vault module for OpenContext SDK."""


from eth_typing import ChecksumAddress

from .constants import CONTEXT_VAULT_ABI
from .errors import OpenContextError, SDKError
from .types import ContextData, OpenContextConfig


class ContextVault:
    """Context Vault contract interface."""

    def __init__(self, config: OpenContextConfig) -> None:
        """Initialize ContextVault with config."""
        self.config = config
        self.contract = config.web3.eth.contract(
            address=config.context_vault_address,
            abi=CONTEXT_VAULT_ABI,
        )

    async def store_context(self, encrypted_data: str) -> int:
        """Store encrypted context data."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for storing context")

        try:
            data_bytes = encrypted_data.encode("utf-8")
            tx = await self.contract.functions.storeContext(data_bytes).build_transaction(
                {
                    "from": self.config.account,
                    "nonce": await self.config.web3.eth.get_transaction_count(self.config.account),
                }
            )

            if self.config.private_key:
                signed_tx = self.config.web3.eth.account.sign_transaction(
                    tx, self.config.private_key
                )
                tx_hash = await self.config.web3.eth.send_raw_transaction(signed_tx.rawTransaction)
            else:
                tx_hash = await self.config.web3.eth.send_transaction(tx)

            receipt = await self.config.web3.eth.wait_for_transaction_receipt(tx_hash)

            for log in receipt["logs"]:
                try:
                    parsed = self.contract.events.ContextStored().process_log(log)
                    return int(parsed["args"]["version"])
                except Exception:
                    continue

            raise Exception("ContextStored event not found")

        except Exception as e:
            error_msg = str(e)
            if "NoPassport" in error_msg:
                raise OpenContextError(SDKError.NO_PASSPORT, "No passport found for address") from e
            if "QuotaExceeded" in error_msg:
                raise OpenContextError(SDKError.QUOTA_EXCEEDED, "Storage quota exceeded") from e
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Store context failed: {error_msg}"
            ) from e

    async def get_context(self, token_id: int, version: int) -> ContextData:
        """Get context data by version."""
        try:
            data_bytes, timestamp = await self.contract.functions.getContext(
                token_id, version
            ).call()

            return ContextData(
                encrypted_data=data_bytes.decode("utf-8"),
                timestamp=int(timestamp),
                version=version,
            )

        except Exception as e:
            error_msg = str(e)
            if "NotAuthorizedReader" in error_msg:
                raise OpenContextError(
                    SDKError.UNAUTHORIZED, "Not authorized to read context"
                ) from e
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Get context failed: {error_msg}"
            ) from e

    async def get_latest_context(self, token_id: int) -> ContextData | None:
        """Get the latest context data."""
        try:
            data_bytes, timestamp, version = await self.contract.functions.getLatestContext(
                token_id
            ).call()

            if not data_bytes:
                return None

            return ContextData(
                encrypted_data=data_bytes.decode("utf-8"),
                timestamp=int(timestamp),
                version=int(version),
            )

        except Exception as e:
            error_msg = str(e)
            if "NotAuthorizedReader" in error_msg:
                raise OpenContextError(
                    SDKError.UNAUTHORIZED, "Not authorized to read context"
                ) from e
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Get latest context failed: {error_msg}"
            ) from e

    async def get_context_count(self, token_id: int) -> int:
        """Get context count for a token."""
        try:
            return int(await self.contract.functions.getContextCount(token_id).call())
        except Exception as e:
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Get context count failed: {e!s}"
            ) from e

    async def authorize_reader(self, reader: ChecksumAddress) -> None:
        """Authorize a reader for your context."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for authorization")

        try:
            tx = await self.contract.functions.authorizeReader(reader).build_transaction(
                {
                    "from": self.config.account,
                    "nonce": await self.config.web3.eth.get_transaction_count(self.config.account),
                }
            )

            if self.config.private_key:
                signed_tx = self.config.web3.eth.account.sign_transaction(
                    tx, self.config.private_key
                )
                tx_hash = await self.config.web3.eth.send_raw_transaction(signed_tx.rawTransaction)
            else:
                tx_hash = await self.config.web3.eth.send_transaction(tx)

            await self.config.web3.eth.wait_for_transaction_receipt(tx_hash)

        except Exception as e:
            error_msg = str(e)
            if "NoPassport" in error_msg:
                raise OpenContextError(SDKError.NO_PASSPORT, "No passport found for address") from e
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Authorize reader failed: {error_msg}"
            ) from e

    async def revoke_reader(self, reader: ChecksumAddress) -> None:
        """Revoke reader authorization."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for revocation")

        try:
            tx = await self.contract.functions.revokeReader(reader).build_transaction(
                {
                    "from": self.config.account,
                    "nonce": await self.config.web3.eth.get_transaction_count(self.config.account),
                }
            )

            if self.config.private_key:
                signed_tx = self.config.web3.eth.account.sign_transaction(
                    tx, self.config.private_key
                )
                tx_hash = await self.config.web3.eth.send_raw_transaction(signed_tx.rawTransaction)
            else:
                tx_hash = await self.config.web3.eth.send_transaction(tx)

            await self.config.web3.eth.wait_for_transaction_receipt(tx_hash)

        except Exception as e:
            error_msg = str(e)
            if "NoPassport" in error_msg:
                raise OpenContextError(SDKError.NO_PASSPORT, "No passport found for address") from e
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Revoke reader failed: {error_msg}"
            ) from e

    async def delete_context(self, version: int) -> None:
        """Delete a specific context version."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for deletion")

        try:
            tx = await self.contract.functions.deleteContext(version).build_transaction(
                {
                    "from": self.config.account,
                    "nonce": await self.config.web3.eth.get_transaction_count(self.config.account),
                }
            )

            if self.config.private_key:
                signed_tx = self.config.web3.eth.account.sign_transaction(
                    tx, self.config.private_key
                )
                tx_hash = await self.config.web3.eth.send_raw_transaction(signed_tx.rawTransaction)
            else:
                tx_hash = await self.config.web3.eth.send_transaction(tx)

            await self.config.web3.eth.wait_for_transaction_receipt(tx_hash)

        except Exception as e:
            error_msg = str(e)
            if "NoPassport" in error_msg:
                raise OpenContextError(SDKError.NO_PASSPORT, "No passport found for address") from e
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Delete context failed: {error_msg}"
            ) from e
