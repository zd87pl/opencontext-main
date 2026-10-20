"""Tests for the contract wrappers and the ABIs they depend on.

web3 is replaced with MagicMock/AsyncMock so these run offline. They pin down the call
shapes the wrappers make, the conversions applied to raw contract return values, and
that the hand-written ABIs in ``constants.py`` decode real event logs.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from eth_abi import encode
from web3 import Web3
from web3.exceptions import ContractCustomError

from opencontext.constants import CONTEXT_VAULT_ABI, PASSPORT_REGISTRY_ABI, PAYMENT_STREAM_ABI
from opencontext.errors import OpenContextError, SDKError
from opencontext.passport import PassportRegistry
from opencontext.payments import PaymentStream
from opencontext.types import (
    ContextData,
    DataProvider,
    OpenContextConfig,
    PassportData,
    Stream,
    StreamInfo,
)
from opencontext.vault import ContextVault
from tests.compiled_abi import COMPILED_ABI

ACCOUNT = "0x1111111111111111111111111111111111111111"
PROVIDER = "0x2222222222222222222222222222222222222222"
RECEIVER = "0x3333333333333333333333333333333333333333"
MIXED_CASE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
CONTRACT = "0x1234567890123456789012345678901234567890"
PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
ZERO_HASH = "0x" + "00" * 32


def _minimal(entry: dict) -> str:
    """``entry`` in ethers' ``minimal`` fragment format, which ``compiled_abi.py`` is written in."""
    kind = entry["type"]
    if kind == "event":
        params = ",".join(
            f"{p['type']} indexed" if p.get("indexed") else p["type"] for p in entry["inputs"]
        )
        return f"event {entry['name']}({params})"
    params = ",".join(p["type"] for p in entry["inputs"])
    if kind == "error":
        return f"error {entry['name']}({params})"
    text = f"function {entry['name']}({params})"
    mutability = entry.get("stateMutability", "nonpayable")
    if mutability != "nonpayable":
        text += f" {mutability}"
    if entry.get("outputs"):
        text += " returns ({})".format(",".join(o["type"] for o in entry["outputs"]))
    return text


def _custom_error(signature: str, *encoded_args: bytes) -> ContractCustomError:
    """What web3 raises for a custom revert: only the ABI-encoded data, no reason string."""
    data = Web3.to_hex(Web3.keccak(text=signature)[:4] + b"".join(encoded_args))
    return ContractCustomError(data, data=data)


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
            (
                payments,
                [
                    "registerProvider",
                    "startStream",
                    "stopStream",
                    "getStreamInfo",
                    "streams",
                    "recordConsumption",
                    "setMeter",
                ],
            ),
        ):
            for name in names:
                assert contract.get_function_by_name(name).abi["name"] == name

    def test_minimal_format_matches_the_snapshot_convention(self):
        streams = next(e for e in PAYMENT_STREAM_ABI if e["name"] == "streams")
        started = next(e for e in PAYMENT_STREAM_ABI if e["name"] == "StreamStarted")
        failed = next(e for e in PAYMENT_STREAM_ABI if e["name"] == "StreamOperationFailed")

        assert (
            _minimal(streams)
            == "function streams(address,address) view returns (address,int96,uint256,uint256)"
        )
        assert (
            _minimal(started)
            == "event StreamStarted(address indexed,address indexed,address,int96)"
        )
        assert _minimal(failed) == "error StreamOperationFailed(bytes)"

    @pytest.mark.parametrize(
        ("abi", "contract"),
        [
            (PASSPORT_REGISTRY_ABI, "PassportRegistry"),
            (CONTEXT_VAULT_ABI, "ContextVault"),
            (PAYMENT_STREAM_ABI, "PaymentStream"),
        ],
    )
    def test_abis_are_subsets_of_the_compiled_contracts(self, abi, contract):
        """Every hand-written fragment must exist in `forge inspect` output with the same
        inputs, outputs, mutability and indexed event args (see tests/compiled_abi.py)."""
        missing = [
            _minimal(entry) for entry in abi if _minimal(entry) not in COMPILED_ABI[contract]
        ]

        assert missing == []

    def test_payment_stream_abi_declares_every_custom_error(self):
        """Reverts are matched by selector, so each contract error needs an ABI entry."""
        declared = {_minimal(entry) for entry in PAYMENT_STREAM_ABI if entry["type"] == "error"}
        compiled = {f for f in COMPILED_ABI["PaymentStream"] if f.startswith("error ")}

        assert declared == compiled

    def test_payment_stream_abi_keys_streams_by_user_and_provider(self):
        """PaymentStream.sol c4f2afd: (user, provider) addresses replaced the passport token id."""
        by_name = {entry["name"]: entry for entry in PAYMENT_STREAM_ABI}

        assert [i["type"] for i in by_name["recordConsumption"]["inputs"]] == [
            "address",
            "address",
            "uint256",
        ]
        assert [i["type"] for i in by_name["getStreamInfo"]["inputs"]] == ["address", "address"]
        assert "activeStreams" not in by_name

    def test_stream_started_event_decodes_a_real_log(self):
        payments = Web3().eth.contract(address=CONTRACT, abi=PAYMENT_STREAM_ABI)
        log = _log(
            "StreamStarted(address,address,address,int96)",
            [int(ACCOUNT, 16), int(PROVIDER, 16)],
            ["address", "int96"],
            [RECEIVER, 1500],
        )

        event = payments.events.StreamStarted().process_log(log)

        assert dict(event["args"]) == {
            "user": ACCOUNT,
            "provider": PROVIDER,
            "receiver": RECEIVER,
            "flowRate": 1500,
        }

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
    # Streams are keyed by (user, provider) wallet addresses since PaymentStream.sol
    # c4f2afd; these lookups used to take the passport token id as the first argument.
    async def test_get_stream_info_active_when_flowing(self, config):
        payments = PaymentStream(config)
        payments.contract.functions.getStreamInfo.return_value.call = AsyncMock(
            return_value=(1500, PROVIDER)
        )

        assert await payments.get_stream_info(ACCOUNT, PROVIDER) == StreamInfo(
            flow_rate=1500, receiver=PROVIDER, active=True
        )
        payments.contract.functions.getStreamInfo.assert_called_once_with(ACCOUNT, PROVIDER)

    async def test_get_stream_info_inactive_at_zero_flow(self, config):
        payments = PaymentStream(config)
        payments.contract.functions.getStreamInfo.return_value.call = AsyncMock(
            return_value=(0, PROVIDER)
        )

        assert (await payments.get_stream_info(ACCOUNT, PROVIDER)).active is False

    async def test_get_stream_decodes_the_streams_struct(self, config):
        payments = PaymentStream(config)
        payments.contract.functions.streams.return_value.call = AsyncMock(
            return_value=(MIXED_CASE.lower(), 1500, 4096, 1700000000)
        )

        assert await payments.get_stream(ACCOUNT, PROVIDER) == Stream(
            receiver=MIXED_CASE,  # checksummed like the other address reads
            flow_rate=1500,
            bytes_consumed=4096,
            started_at=1700000000,
            active=True,
        )
        payments.contract.functions.streams.assert_called_once_with(ACCOUNT, PROVIDER)

    async def test_get_stream_empty_record_is_inactive(self, config):
        payments = PaymentStream(config)
        payments.contract.functions.streams.return_value.call = AsyncMock(
            return_value=("0x" + "00" * 20, 0, 0, 0)
        )

        stream = await payments.get_stream(ACCOUNT, PROVIDER)

        assert stream.active is False
        assert stream.flow_rate == 0

    async def test_record_consumption_sends_user_provider_bytes(self, config, web3):
        """recordConsumption(user, provider, bytes) replaced recordConsumption(tokenId, bytes)."""
        payments = PaymentStream(config)
        tx = {"from": ACCOUNT, "nonce": 7}
        functions = payments.contract.functions
        functions.recordConsumption.return_value.build_transaction = AsyncMock(return_value=tx)

        await payments.record_consumption(ACCOUNT, PROVIDER, 4096)

        functions.recordConsumption.assert_called_once_with(ACCOUNT, PROVIDER, 4096)
        web3.eth.account.sign_transaction.assert_called_once_with(tx, PRIVATE_KEY)
        web3.eth.send_raw_transaction.assert_awaited_once_with(b"signed")

    @pytest.mark.parametrize(
        ("revert", "code"),
        [
            # Metering is a role now: the contract checks the caller, not the provider record.
            ("execution reverted: NotMeter()", SDKError.UNAUTHORIZED),
            ("execution reverted: SelfMetering()", SDKError.UNAUTHORIZED),
            ("execution reverted: StreamNotActive()", SDKError.STREAM_NOT_ACTIVE),
            ("timeout", SDKError.TRANSACTION_FAILED),
        ],
    )
    async def test_record_consumption_maps_contract_errors(self, config, revert, code):
        payments = PaymentStream(config)
        payments.contract.functions.recordConsumption.return_value.build_transaction = AsyncMock(
            side_effect=Exception(revert)
        )

        with pytest.raises(OpenContextError) as exc_info:
            await payments.record_consumption(ACCOUNT, PROVIDER, 4096)

        assert exc_info.value.code == code

    async def test_set_meter_and_is_meter(self, config, web3):
        payments = PaymentStream(config)
        functions = payments.contract.functions
        functions.setMeter.return_value.build_transaction = AsyncMock(return_value={})
        functions.meters.return_value.call = AsyncMock(return_value=True)

        await payments.set_meter(PROVIDER, True)

        functions.setMeter.assert_called_once_with(PROVIDER, True)
        web3.eth.send_raw_transaction.assert_awaited_once()
        assert await payments.is_meter(PROVIDER) is True
        functions.meters.assert_called_once_with(PROVIDER)

    async def test_deregister_provider_maps_provider_not_active(self, config):
        payments = PaymentStream(config)
        payments.contract.functions.deregisterProvider.return_value.build_transaction = AsyncMock(
            side_effect=Exception("execution reverted: ProviderNotActive()")
        )

        with pytest.raises(OpenContextError) as exc_info:
            await payments.deregister_provider()

        assert exc_info.value.code == SDKError.PROVIDER_NOT_ACTIVE

    async def test_stream_calls_require_account(self, config):
        config.account = None
        payments = PaymentStream(config)

        for call in (
            payments.start_stream(PROVIDER, 1000),
            payments.update_stream(PROVIDER, 1000),
            payments.stop_stream(PROVIDER),
            payments.record_consumption(ACCOUNT, PROVIDER, 1),
            payments.set_meter(PROVIDER, True),
            payments.deregister_provider(),
        ):
            with pytest.raises(OpenContextError) as exc_info:
                await call
            assert exc_info.value.code == SDKError.NO_ACCOUNT

    # Pre-c4f2afd stopStream required a passport; it no longer does, and a missing
    # stream reverts StreamNotActive instead.
    async def test_stop_stream_maps_stream_not_active(self, config):
        payments = PaymentStream(config)
        payments.contract.functions.stopStream.return_value.build_transaction = AsyncMock(
            side_effect=_custom_error("StreamNotActive()")
        )

        with pytest.raises(OpenContextError) as exc_info:
            await payments.stop_stream(PROVIDER)

        assert exc_info.value.code == SDKError.STREAM_NOT_ACTIVE

    async def test_update_stream_maps_stream_not_active(self, config):
        payments = PaymentStream(config)
        payments.contract.functions.updateStream.return_value.build_transaction = AsyncMock(
            side_effect=Exception("execution reverted: StreamNotActive()")
        )

        with pytest.raises(OpenContextError) as exc_info:
            await payments.update_stream(PROVIDER, 2000)

        assert exc_info.value.code == SDKError.STREAM_NOT_ACTIVE

    async def test_start_stream_maps_custom_errors_by_selector(self, config):
        """web3 raises ContractCustomError with only the revert data; no name to grep for."""
        payments = PaymentStream(config)
        payments.contract.functions.startStream.return_value.build_transaction = AsyncMock(
            side_effect=_custom_error("StreamAlreadyActive()")
        )

        with pytest.raises(OpenContextError) as exc_info:
            await payments.start_stream(PROVIDER, 1000)

        assert exc_info.value.code == SDKError.STREAM_ALREADY_ACTIVE

    @pytest.mark.parametrize(
        ("cfa_error", "code"),
        [
            ("CFA_ACL_OPERATOR_NO_CREATE_PERMISSIONS", SDKError.FLOW_OPERATOR_PERMISSION),
            ("CFA_ACL_FLOW_RATE_ALLOWANCE_EXCEEDED", SDKError.FLOW_OPERATOR_PERMISSION),
            ("CFA_FLOW_ALREADY_EXISTS", SDKError.STREAM_OPERATION_FAILED),
            ("CFA_INSUFFICIENT_BALANCE", SDKError.STREAM_OPERATION_FAILED),
        ],
    )
    async def test_start_stream_unwraps_the_superfluid_reason(self, config, cfa_error, code):
        """StreamOperationFailed(bytes reason) carries the CFA error selector the host reverted with."""
        payments = PaymentStream(config)
        reason = Web3.keccak(text=f"{cfa_error}()")[:4]
        payments.contract.functions.startStream.return_value.build_transaction = AsyncMock(
            side_effect=_custom_error("StreamOperationFailed(bytes)", encode(["bytes"], [reason]))
        )

        with pytest.raises(OpenContextError) as exc_info:
            await payments.start_stream(PROVIDER, 1000)

        assert exc_info.value.code == code
        assert cfa_error in exc_info.value.message
        if code is SDKError.FLOW_OPERATOR_PERMISSION:
            assert "grantPermissions" in exc_info.value.message

    async def test_start_stream_reports_an_unknown_superfluid_reason_raw(self, config):
        payments = PaymentStream(config)
        payments.contract.functions.startStream.return_value.build_transaction = AsyncMock(
            side_effect=_custom_error(
                "StreamOperationFailed(bytes)", encode(["bytes"], [b"\xde\xad\xbe\xef"])
            )
        )

        with pytest.raises(OpenContextError) as exc_info:
            await payments.start_stream(PROVIDER, 1000)

        assert exc_info.value.code == SDKError.STREAM_OPERATION_FAILED
        assert "0xdeadbeef" in exc_info.value.message

    async def test_start_stream_maps_stream_operation_failed_by_name(self, config):
        payments = PaymentStream(config)
        payments.contract.functions.startStream.return_value.build_transaction = AsyncMock(
            side_effect=Exception("execution reverted: StreamOperationFailed(0x)")
        )

        with pytest.raises(OpenContextError) as exc_info:
            await payments.start_stream(PROVIDER, 1000)

        assert exc_info.value.code == SDKError.STREAM_OPERATION_FAILED

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
            ("execution reverted: StreamAlreadyActive()", SDKError.STREAM_ALREADY_ACTIVE),
            ("execution reverted: InvalidFlowRate()", SDKError.INVALID_FLOW_RATE),
            ("execution reverted: FlowRateOverflow()", SDKError.INVALID_FLOW_RATE),
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
