"""Passport Registry module for OpenContext SDK."""

from typing import Optional

from eth_typing import Address, HexStr
from web3 import Web3

from .constants import PASSPORT_REGISTRY_ABI
from .errors import OpenContextError, SDKError
from .types import OpenContextConfig, PassportData


class PassportRegistry:
    """Passport Registry contract interface."""

    def __init__(self, config: OpenContextConfig) -> None:
        """Initialize PassportRegistry with config."""
        self.config = config
        self.contract = config.web3.eth.contract(
            address=config.passport_registry_address,
            abi=PASSPORT_REGISTRY_ABI,
        )

    async def mint(self, to: Address, data_hash: HexStr) -> int:
        """Mint a new passport."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for minting")

        try:
            tx = await self.contract.functions.mint(to, data_hash).build_transaction(
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

            receipt = await self.config.web3.eth.wait_for_transaction_receipt(tx_hash)

            for log in receipt["logs"]:
                try:
                    parsed = self.contract.events.PassportMinted().process_log(log)
                    return int(parsed["args"]["tokenId"])
                except Exception:
                    continue

            raise Exception("PassportMinted event not found")

        except Exception as e:
            raise OpenContextError(SDKError.TRANSACTION_FAILED, f"Mint failed: {str(e)}")

    async def revoke(self, token_id: int) -> None:
        """Revoke a passport."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for revoking")

        try:
            tx = await self.contract.functions.revoke(token_id).build_transaction(
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
            raise OpenContextError(SDKError.TRANSACTION_FAILED, f"Revoke failed: {str(e)}")

    async def update_data_hash(self, token_id: int, new_data_hash: HexStr) -> None:
        """Update passport data hash."""
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, "Account required for updating")

        try:
            tx = await self.contract.functions.updateDataHash(
                token_id, new_data_hash
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
            raise OpenContextError(SDKError.TRANSACTION_FAILED, f"Update failed: {str(e)}")

    async def get_passport(self, address: Address) -> Optional[PassportData]:
        """Get passport data for an address."""
        try:
            token_id = await self.contract.functions.getTokenId(address).call()

            if token_id == 0:
                return None

            owner = await self.contract.functions.ownerOf(token_id).call()
            data_hash = await self.contract.functions.tokenIdToDataHash(token_id).call()

            return PassportData(
                token_id=token_id,
                owner=owner,
                data_hash=data_hash,
                exists=True,
            )

        except Exception as e:
            raise OpenContextError(SDKError.TRANSACTION_FAILED, f"Get passport failed: {str(e)}")

    async def has_passport(self, address: Address) -> bool:
        """Check if address has a passport."""
        try:
            return await self.contract.functions.hasPassport(address).call()
        except Exception as e:
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Check passport failed: {str(e)}"
            )

    async def get_token_id(self, address: Address) -> int:
        """Get token ID for an address."""
        try:
            return await self.contract.functions.getTokenId(address).call()
        except Exception as e:
            raise OpenContextError(SDKError.TRANSACTION_FAILED, f"Get token ID failed: {str(e)}")