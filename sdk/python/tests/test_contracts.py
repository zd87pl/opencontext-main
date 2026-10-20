"""Tests for the contract wrappers and the ABIs they depend on.

web3 is replaced with MagicMock/AsyncMock so these run offline. They pin down the call
shapes the wrappers make, the conversions applied to raw contract return values, and
that the hand-written ABIs in ``constants.py`` decode real event logs.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from eth_abi import encode
from web3 import Web3

from opencontext.constants import CONTEXT_VAULT_ABI, PASSPORT_REGISTRY_ABI, PAYMENT_STREAM_ABI
from opencontext.errors import OpenContextError, SDKError
from opencontext.passport import PassportRegistry
from opencontext.payments import PaymentStream
from opencontext.types import ContextData, DataProvider, OpenContextConfig, PassportData, StreamInfo
from opencontext.vault import ContextVault

ACCOUNT = "0x1111111111111111111111111111111111111111"
PROVIDER = "0x2222222222222222222222222222222222222222"
CONTRACT = "0x1234567890123456789012345678901234567890"
PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
ZERO_HASH = "0x" + "00" * 32


@pytest.fixture
def web3():
    """An AsyncWeb3 stand-in whose eth methods are awaitable."""
    w3 = MagicMock()
    w3.eth.get_transaction_count = AsyncMock(return_value=7)
    w3.eth.send_raw_transaction = AsyncMock(return_value=b"\x12" * 32)
    w3.eth.send_transaction = AsyncMock(return_value=b"\x34" * 32)
    w3.eth.wait_for_transaction_receipt = AsyncMock(return_value={"logs": []})
    w3.eth.account.sign_transaction.return_value = MagicMock(rawTransaction=b"signed")
    return w3


@pytest.fixture
def config(web3):
    return OpenContextConfig(
        passport_registry_address=CONTRACT,
        context_vault_address=CONTRACT,
        payment_stream_address=CONTRACT,
        web3=web3,
        account=ACCOUNT,
        private_key=PRIVATE_KEY,
    )


def _log(signature: str, indexed: list[int], data_types: list[str], data_values: list[int]):
    """Build a LogReceipt-shaped dict the way a node would emit it for ``signature``."""
    topics = [Web3.keccak(text=signature)] + [value.to_bytes(32, "big") for value in indexed]
    return {
        "address": CONTRACT,
        "blockHash": b"\x00" * 32,
        "blockNumber": 1,
        "logIndex": 0,
        "transactionHash": b"\x00" * 32,
        "transactionIndex": 0,
        "topics": topics,
        "data": encode(data_types, data_values),
    }


class TestAbis:
    """The ABIs are hand-written; make sure they describe what the Solidity emits."""

    def test_abis_load_as_web3_contracts(self):
        w3 = Web3()  # no provider needed to construct contract objects
        registry = w3.eth.contract(address=CONTRACT, abi=PASSPORT_REGISTRY_ABI)
        vault = w3.eth.contract(address=CONTRACT, abi=CONTEXT_VAULT_ABI)
        payments = w3.eth.contract(address=CONTRACT, abi=PAYMENT_STREAM_ABI)

        for contract, names in (
            (registry, ["mint", "revoke", "updateDataHash", "getTokenId", "hasPassport"]),
            (vault, ["storeContext", "getContext", "getLatestContext", "deleteContext"]),
            (payments, ["registerProvider", "startStream", "stopStream", "getStreamInfo"]),
        ):
            for name in names:
                assert contract.get_function_by_name(name).abi["name"] == name

    def test_context_stored_event_decodes_a_real_log(self):
        """store_context() reads the version off ContextStored; the ABI must decode it."""
        vault = Web3().eth.contract(address=CONTRACT, abi=CONTEXT_VAULT_ABI)
        log = _log("ContextStored(uint256,uint256,uint256)", [9], ["uint256", "uint256"], [3, 128])

        event = vault.events.ContextStored().process_log(log)

        assert event["event"] == "ContextStored"
        assert dict(event["args"]) == {"tokenId": 9, "version": 3, "dataSize": 128}

    def test_passport_minted_event_decodes_a_real_log(self):
        registry = Web3().eth.contract(address=CONTRACT, abi=PASSPORT_REGISTRY_ABI)
        log = _log("PassportMinted(address,uint256)", [int(ACCOUNT, 16), 42], [], [])

        event = registry.events.PassportMinted().process_log(log)

        assert dict(event["args"]) == {"to": ACCOUNT, "tokenId": 42}


class TestPassportRegistry:
    async def test_get_passport_normalises_raw_contract_values(self, config):
        registry = PassportRegistry(config)
        functions = registry.contract.functions
        functions.getTokenId.return_value.call = AsyncMock(return_value=5)
        # Nodes may return lower-case addresses and bytes32 as raw bytes.
        functions.ownerOf.return_value.call = AsyncMock(
            return_value="0xd8da6bf26964af9d7eed9e03e53415d37aa96045"
        )
        functions.tokenIdToDataHash.return_value.call = AsyncMock(return_value=b"\xab" * 32)

        passport = await registry.get_passport(ACCOUNT)

        assert passport == PassportData(
            token_id=5,
            owner="0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
            data_hash="0x" + "ab" * 32,
            exists=True,
        )

    async def test_get_passport_returns_none_without_token(self, config):
        registry = PassportRegistry(config)
        registry.contract.functions.getTokenId.return_value.call = AsyncMock(return_value=0)

        assert await registry.get_passport(ACCOUNT) is None

    async def test_has_passport_and_token_id_return_plain_types(self, config):
        registry = PassportRegistry(config)
        registry.contract.functions.hasPassport.return_value.call = AsyncMock(return_value=True)
        registry.contract.functions.getTokenId.return_value.call = AsyncMock(return_value=3)

        assert await registry.has_passport(ACCOUNT) is True
        assert await registry.get_token_id(ACCOUNT) == 3

    async def test_mint_signs_locally_and_reads_token_id_from_event(self, config, web3):
        registry = PassportRegistry(config)
        tx = {"from": ACCOUNT, "nonce": 7}
        registry.contract.functions.mint.return_value.build_transaction = AsyncMock(return_value=tx)
        web3.eth.wait_for_transaction_receipt.return_value = {"logs": [{"topics": []}]}
        registry.contract.events.PassportMinted.return_value.process_log.return_value = {
            "args": {"tokenId": 42}
        }

        token_id = await registry.mint(ACCOUNT, ZERO_HASH)

        assert token_id == 42
        registry.contract.functions.mint.assert_called_once_with(ACCOUNT, ZERO_HASH)
        web3.eth.account.sign_transaction.assert_called_once_with(tx, PRIVATE_KEY)
        web3.eth.send_raw_transaction.assert_awaited_once_with(b"signed")
        web3.eth.send_transaction.assert_not_awaited()

    async def test_mint_without_private_key_uses_node_signing(self, config, web3):
        config.private_key = None
        registry = PassportRegistry(config)
        registry.contract.functions.mint.return_value.build_transaction = AsyncMock(return_value={})
        web3.eth.wait_for_transaction_receipt.return_value = {"logs": [{"topics": []}]}
        registry.contract.events.PassportMinted.return_value.process_log.return_value = {
            "args": {"tokenId": 1}
        }

        assert await registry.mint(ACCOUNT, ZERO_HASH) == 1
        web3.eth.send_transaction.assert_awaited_once()
        web3.eth.send_raw_transaction.assert_not_awaited()

    async def test_mint_without_event_in_receipt_raises(self, config, web3):
        registry = PassportRegistry(config)
        registry.contract.functions.mint.return_value.build_transaction = AsyncMock(return_value={})
        web3.eth.wait_for_transaction_receipt.return_value = {"logs": []}

        with pytest.raises(OpenContextError) as exc_info:
            await registry.mint(ACCOUNT, ZERO_HASH)

        assert exc_info.value.code == SDKError.TRANSACTION_FAILED
        assert "PassportMinted" in exc_info.value.message

    async def test_mint_requires_account(self, config):
        config.account = None

        with pytest.raises(OpenContextError) as exc_info:
            await PassportRegistry(config).mint(ACCOUNT, ZERO_HASH)

        assert exc_info.value.code == SDKError.NO_ACCOUNT


class TestContextVault:
    async def test_store_context_sends_utf8_bytes_and_returns_event_version(self, config, web3):
        vault = ContextVault(config)
        vault.contract.functions.storeContext.return_value.build_transaction = AsyncMock(
            return_value={}
        )
        web3.eth.wait_for_transaction_receipt.return_value = {"logs": [{"topics": []}]}
        vault.contract.events.ContextStored.return_value.process_log.return_value = {
            "args": {"version": 3}
        }

        assert await vault.store_context("ciphertext-blob") == 3
        vault.contract.functions.storeContext.assert_called_once_with(b"ciphertext-blob")

    @pytest.mark.parametrize(
        ("revert", "code"),
        [
            ("execution reverted: NoPassport()", SDKError.NO_PASSPORT),
            ("execution reverted: QuotaExceeded()", SDKError.QUOTA_EXCEEDED),
            ("connection refused", SDKError.TRANSACTION_FAILED),
        ],
    )
    async def test_store_context_maps_contract_errors(self, config, revert, code):
        vault = ContextVault(config)
        vault.contract.functions.storeContext.return_value.build_transaction = AsyncMock(
            side_effect=Exception(revert)
        )

        with pytest.raises(OpenContextError) as exc_info:
            await vault.store_context("x")

        assert exc_info.value.code == code

    async def test_get_latest_context_empty_is_none(self, config):
        vault = ContextVault(config)
        vault.contract.functions.getLatestContext.return_value.call = AsyncMock(
            return_value=(b"", 0, 0)
        )

        assert await vault.get_latest_context(1) is None

    async def test_get_latest_context_decodes_tuple(self, config):
        vault = ContextVault(config)
        vault.contract.functions.getLatestContext.return_value.call = AsyncMock(
            return_value=(b"blob", 1700000000, 2)
        )

        assert await vault.get_latest_context(1) == ContextData(
            encrypted_data="blob", timestamp=1700000000, version=2
        )

    async def test_get_context_unauthorized_reader(self, config):
        vault = ContextVault(config)
        vault.contract.functions.getContext.return_value.call = AsyncMock(
            side_effect=Exception("execution reverted: NotAuthorizedReader()")
        )

        with pytest.raises(OpenContextError) as exc_info:
            await vault.get_context(1, 0)

        assert exc_info.value.code == SDKError.UNAUTHORIZED

    async def test_get_context_count(self, config):
        vault = ContextVault(config)
        vault.contract.functions.getContextCount.return_value.call = AsyncMock(return_value=4)

        assert await vault.get_context_count(1) == 4


class TestPaymentStream:
    async def test_get_stream_info_active_when_flowing(self, config):
        payments = PaymentStream(config)
        payments.contract.functions.getStreamInfo.return_value.call = AsyncMock(
            return_value=(1500, PROVIDER)
        )

        assert await payments.get_stream_info(1, PROVIDER) == StreamInfo(
            flow_rate=1500, receiver=PROVIDER, active=True
        )

    async def test_get_stream_info_inactive_at_zero_flow(self, config):
        payments = PaymentStream(config)
        payments.contract.functions.getStreamInfo.return_value.call = AsyncMock(
            return_value=(0, PROVIDER)
        )

        assert (await payments.get_stream_info(1, PROVIDER)).active is False

    async def test_get_provider_inactive_is_none(self, config):
        payments = PaymentStream(config)
        payments.contract.functions.dataProviders.return_value.call = AsyncMock(
            return_value=(PROVIDER, 10**15, 0, False)
        )

        assert await payments.get_provider(PROVIDER) is None

    async def test_get_provider_active(self, config):
        payments = PaymentStream(config)
        payments.contract.functions.dataProviders.return_value.call = AsyncMock(
            return_value=(PROVIDER, 10**15, 2048, True)
        )

        assert await payments.get_provider(PROVIDER) == DataProvider(
            receiver=PROVIDER, rate_per_byte=10**15, total_bytes_served=2048, active=True
        )

    @pytest.mark.parametrize(
        ("revert", "code"),
        [
            ("execution reverted: NotPassportHolder()", SDKError.NO_PASSPORT),
            ("execution reverted: ProviderNotActive()", SDKError.PROVIDER_NOT_ACTIVE),
            ("execution reverted: InvalidFlowRate()", SDKError.INVALID_FLOW_RATE),
            ("timeout", SDKError.TRANSACTION_FAILED),
        ],
    )
    async def test_start_stream_maps_contract_errors(self, config, revert, code):
        payments = PaymentStream(config)
        payments.contract.functions.startStream.return_value.build_transaction = AsyncMock(
            side_effect=Exception(revert)
        )

        with pytest.raises(OpenContextError) as exc_info:
            await payments.start_stream(PROVIDER, 1000)

        assert exc_info.value.code == code

    def test_flow_rate_math_matches_contract(self):
        """PaymentStream.sol: flowRate = ratePerByte * bytesPerSecond / RATE_PRECISION (1e18)."""
        assert PaymentStream.calculate_flow_rate(10**15, 1000) == 1
        assert PaymentStream.calculate_flow_rate(1, 1) == 0  # rounds down like the contract
        assert PaymentStream.calculate_monthly_cost(10**15, 1000) == 30 * 24 * 60 * 60
