"""Payment Stream module for OpenContext SDK.

``PaymentStream.sol`` never holds funds. A stream is a Superfluid constant flow sent from
the *user's own wallet* to the provider's payout address; the contract opens, re-prices and
closes that flow as a Superfluid **flow operator** on the user's behalf. Streams are keyed
by ``(user, provider)`` wallet addresses.

Flow-operator permission (required before ``start_stream``)
    The user must first authorise the ``PaymentStream`` contract address as a flow operator
    with create/update/delete permission on the Super Token it streams (``usdcx()``). The
    usual way is Superfluid's ``CFAv1Forwarder``
    (:data:`opencontext.constants.CFA_V1_FORWARDER_ADDRESS`, the same on every network)::

        forwarder = web3.eth.contract(address=CFA_V1_FORWARDER_ADDRESS, abi=GRANT_ABI)
        await forwarder.functions.grantPermissions(usdcx, payment_stream).transact(...)

    where ``GRANT_ABI`` declares ``grantPermissions(address token, address flowOperator)
    returns (bool)``. ``grantPermissions`` gives full control with an unlimited flow-rate
    allowance; ``updateFlowOperatorPermissions(token, operator, 7, allowance)`` caps it and
    ``revokePermissions`` withdraws it. Without the grant ``start_stream`` raises
    :class:`OpenContextError` with :attr:`SDKError.FLOW_OPERATOR_PERMISSION`. This SDK does
    not bundle the forwarder ABI.

Metering
    ``record_consumption`` may only be called by addresses the contract owner enabled through
    ``set_meter`` (the metering gateway), never by a provider for its own record. Reads reflect
    the last state written through the contract, not the live Superfluid flow.
"""

from typing import Final

from eth_abi.abi import decode
from eth_typing import ChecksumAddress
from web3 import Web3
from web3.contract.async_contract import AsyncContractFunction

from .constants import PAYMENT_STREAM_ABI
from .errors import OpenContextError, SDKError, error_selectors, is_revert, revert_data
from .types import DataProvider, OpenContextConfig, Stream, StreamInfo

#: Fixed-point scale used by ``PaymentStream.sol`` for ``ratePerByte``.
RATE_PRECISION: Final = 10**18
SECONDS_PER_MONTH: Final = 30 * 24 * 60 * 60

_ERROR_SELECTORS: Final = error_selectors(PAYMENT_STREAM_ABI)
_STREAM_OPERATION_FAILED: Final = _ERROR_SELECTORS["StreamOperationFailed"]

# Superfluid CFA errors that StreamOperationFailed(bytes reason) can wrap, by 4-byte
# selector (IConstantFlowAgreementV1.sol). Anything else is reported as raw hex.
_CFA_ERRORS: Final[dict[str, str]] = {
    Web3.to_hex(Web3.keccak(text=f"{name}()")[:4]): name
    for name in (
        "CFA_ACL_OPERATOR_NO_CREATE_PERMISSIONS",
        "CFA_ACL_OPERATOR_NO_UPDATE_PERMISSIONS",
        "CFA_ACL_OPERATOR_NO_DELETE_PERMISSIONS",
        "CFA_ACL_FLOW_RATE_ALLOWANCE_EXCEEDED",
        "CFA_ACL_NO_SENDER_FLOW_OPERATOR",
        "CFA_FLOW_ALREADY_EXISTS",
        "CFA_FLOW_DOES_NOT_EXIST",
        "CFA_INSUFFICIENT_BALANCE",
        "CFA_INVALID_FLOW_RATE",
        "CFA_FLOW_RATE_TOO_BIG",
        "CFA_DEPOSIT_TOO_BIG",
        "CFA_NO_SELF_FLOW",
    )
}
# The ones that mean the user has not (sufficiently) authorised the contract as operator.
_CFA_PERMISSION_ERRORS: Final = frozenset(
    {
        "CFA_ACL_OPERATOR_NO_CREATE_PERMISSIONS",
        "CFA_ACL_OPERATOR_NO_UPDATE_PERMISSIONS",
        "CFA_ACL_OPERATOR_NO_DELETE_PERMISSIONS",
        "CFA_ACL_FLOW_RATE_ALLOWANCE_EXCEEDED",
        "CFA_ACL_NO_SENDER_FLOW_OPERATOR",
    }
)

# Contract reverts shared by the stream and metering calls, in match order, with the
# SDK code and message each maps to. StreamOperationFailed is handled separately.
_STREAM_REVERTS: Final[tuple[tuple[str, SDKError, str], ...]] = (
    ("NotPassportHolder", SDKError.NO_PASSPORT, "No passport found for address"),
    ("ProviderNotActive", SDKError.PROVIDER_NOT_ACTIVE, "Provider not active"),
    (
        "StreamAlreadyActive",
        SDKError.STREAM_ALREADY_ACTIVE,
        "A stream to this provider is already open",
    ),
    ("StreamNotActive", SDKError.STREAM_NOT_ACTIVE, "No open stream to this provider"),
    (
        "InvalidFlowRate",
        SDKError.INVALID_FLOW_RATE,
        "Flow rate rounds to zero: raise bytes_per_second or the provider rate",
    ),
    (
        "FlowRateOverflow",
        SDKError.INVALID_FLOW_RATE,
        "Flow rate exceeds the int96 range Superfluid supports",
    ),
    ("NotMeter", SDKError.UNAUTHORIZED, "Account is not an enabled meter"),
    (
        "SelfMetering",
        SDKError.UNAUTHORIZED,
        "A meter cannot record consumption for its own provider record",
    ),
)


class PaymentStream:
    """Payment Stream contract interface. See the module docstring for the permission step."""

    def __init__(self, config: OpenContextConfig) -> None:
        """Initialize PaymentStream with config."""
        self.config = config
        self.contract = config.web3.eth.contract(
            address=config.payment_stream_address,
            abi=PAYMENT_STREAM_ABI,
        )

    # ------------------------------------------------------------------
    # Providers and meters
    # ------------------------------------------------------------------

    async def register_provider(self, receiver: ChecksumAddress, rate_per_byte: int) -> None:
        """Register the account as a data provider paid at ``receiver``, or update it.

        ``rate_per_byte`` is in Super Token wei per byte scaled by ``RATE_PRECISION``.
        """
        account = self._require_account("registration")

        try:
            await self._send(
                self.contract.functions.registerProvider(receiver, rate_per_byte), account
            )
        except Exception as e:
            if self._reverted(e, "InvalidProvider"):
                raise OpenContextError(
                    SDKError.INVALID_ADDRESS, "Receiver must not be the zero address"
                ) from e
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Register provider failed: {e!s}"
            ) from e

    async def update_provider_rate(self, new_rate: int) -> None:
        """Change the account's price per byte. Live streams keep their rate until updated."""
        account = self._require_account("update")

        try:
            await self._send(self.contract.functions.updateProviderRate(new_rate), account)
        except Exception as e:
            if self._reverted(e, "ProviderNotActive"):
                raise OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, "Provider not active") from e
            raise OpenContextError(SDKError.TRANSACTION_FAILED, f"Update rate failed: {e!s}") from e

    async def deregister_provider(self) -> None:
        """Deactivate the account's provider record; live streams can still be stopped."""
        account = self._require_account("deregistration")

        try:
            await self._send(self.contract.functions.deregisterProvider(), account)
        except Exception as e:
            if self._reverted(e, "ProviderNotActive"):
                raise OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, "Provider not active") from e
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Deregister provider failed: {e!s}"
            ) from e

    async def set_meter(self, meter: ChecksumAddress, allowed: bool) -> None:
        """Enable or disable ``meter`` for :meth:`record_consumption`. Owner only."""
        account = self._require_account("meter update")

        try:
            await self._send(self.contract.functions.setMeter(meter, allowed), account)
        except Exception as e:
            if self._reverted(e, "InvalidProvider"):
                raise OpenContextError(
                    SDKError.INVALID_ADDRESS, "Meter must not be the zero address"
                ) from e
            raise OpenContextError(SDKError.TRANSACTION_FAILED, f"Set meter failed: {e!s}") from e

    async def is_meter(self, address: ChecksumAddress) -> bool:
        """Whether ``address`` may call :meth:`record_consumption`."""
        try:
            return bool(await self.contract.functions.meters(address).call())
        except Exception as e:
            raise OpenContextError(SDKError.TRANSACTION_FAILED, f"Check meter failed: {e!s}") from e

    # ------------------------------------------------------------------
    # Streams
    # ------------------------------------------------------------------

    async def start_stream(self, provider: ChecksumAddress, bytes_per_second: int) -> None:
        """Open a stream from the account to ``provider`` at its current rate.

        The account needs a passport and must have granted the contract flow-operator
        permission first (module docstring).
        """
        account = self._require_account("streaming")

        try:
            await self._send(
                self.contract.functions.startStream(provider, bytes_per_second), account
            )
        except Exception as e:
            raise self._stream_error(e, "Start stream failed") from e

    async def update_stream(self, provider: ChecksumAddress, new_bytes_per_second: int) -> None:
        """Re-price the account's stream to ``provider`` for a new expected throughput."""
        account = self._require_account("update")

        try:
            await self._send(
                self.contract.functions.updateStream(provider, new_bytes_per_second), account
            )
        except Exception as e:
            raise self._stream_error(e, "Update stream failed") from e

    async def stop_stream(self, provider: ChecksumAddress) -> None:
        """Close the account's stream to ``provider``.

        Allowed while the contract is paused and without a passport. If the flow was
        already removed in Superfluid, only the contract's record is cleared.
        """
        account = self._require_account("stopping")

        try:
            await self._send(self.contract.functions.stopStream(provider), account)
        except Exception as e:
            raise self._stream_error(e, "Stop stream failed") from e

    async def record_consumption(
        self, user: ChecksumAddress, provider: ChecksumAddress, bytes_consumed: int
    ) -> None:
        """Attribute ``bytes_consumed`` served by ``provider`` to ``user``'s open stream.

        The account must be an enabled meter (:meth:`set_meter`) and may not be
        ``provider`` itself.
        """
        account = self._require_account("recording")

        try:
            await self._send(
                self.contract.functions.recordConsumption(user, provider, bytes_consumed), account
            )
        except Exception as e:
            raise self._stream_error(e, "Record consumption failed") from e

    async def get_stream_info(self, user: ChecksumAddress, provider: ChecksumAddress) -> StreamInfo:
        """Flow rate and receiver last written for the ``(user, provider)`` stream."""
        try:
            flow_rate, receiver = await self.contract.functions.getStreamInfo(user, provider).call()

            return StreamInfo(
                flow_rate=int(flow_rate),
                receiver=Web3.to_checksum_address(receiver),
                active=int(flow_rate) > 0,
            )

        except Exception as e:
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Get stream info failed: {e!s}"
            ) from e

    async def get_stream(self, user: ChecksumAddress, provider: ChecksumAddress) -> Stream:
        """The full ``(user, provider)`` stream record, with metered bytes and start time."""
        try:
            (
                receiver,
                flow_rate,
                bytes_consumed,
                started_at,
            ) = await self.contract.functions.streams(user, provider).call()

            return Stream(
                receiver=Web3.to_checksum_address(receiver),
                flow_rate=int(flow_rate),
                bytes_consumed=int(bytes_consumed),
                started_at=int(started_at),
                active=int(flow_rate) > 0,
            )

        except Exception as e:
            raise OpenContextError(SDKError.TRANSACTION_FAILED, f"Get stream failed: {e!s}") from e

    async def get_provider(self, address: ChecksumAddress) -> DataProvider | None:
        """Get provider information, or ``None`` if not registered or inactive."""
        try:
            (
                receiver,
                rate_per_byte,
                total_bytes_served,
                active,
            ) = await self.contract.functions.dataProviders(address).call()

            if not active:
                return None

            return DataProvider(
                receiver=Web3.to_checksum_address(receiver),
                rate_per_byte=int(rate_per_byte),
                total_bytes_served=int(total_bytes_served),
                active=bool(active),
            )

        except Exception as e:
            raise OpenContextError(
                SDKError.TRANSACTION_FAILED, f"Get provider failed: {e!s}"
            ) from e

    @staticmethod
    def calculate_flow_rate(rate_per_byte: int, bytes_per_second: int) -> int:
        """Flow rate (wei per second) with the contract's integer arithmetic.

        The contract reverts with ``FlowRateOverflow`` above ``int96`` max instead of
        truncating.
        """
        return (rate_per_byte * bytes_per_second) // RATE_PRECISION

    @staticmethod
    def calculate_monthly_cost(rate_per_byte: int, bytes_per_second: int) -> int:
        """Cost of a stream over a 30-day month at the given throughput."""
        flow_rate = PaymentStream.calculate_flow_rate(rate_per_byte, bytes_per_second)
        return flow_rate * SECONDS_PER_MONTH

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _require_account(self, action: str) -> ChecksumAddress:
        if not self.config.account:
            raise OpenContextError(SDKError.NO_ACCOUNT, f"Account required for {action}")
        return self.config.account

    async def _send(self, call: AsyncContractFunction, account: ChecksumAddress) -> None:
        """Build, sign (locally when a private key is configured), send and await ``call``."""
        web3 = self.config.web3
        tx = await call.build_transaction(
            {"from": account, "nonce": await web3.eth.get_transaction_count(account)}
        )

        if self.config.private_key:
            signed_tx = web3.eth.account.sign_transaction(tx, self.config.private_key)
            tx_hash = await web3.eth.send_raw_transaction(signed_tx.rawTransaction)
        else:
            tx_hash = await web3.eth.send_transaction(tx)

        await web3.eth.wait_for_transaction_receipt(tx_hash)

    @staticmethod
    def _reverted(error: BaseException, name: str) -> bool:
        return is_revert(error, name, _ERROR_SELECTORS)

    def _stream_error(self, error: BaseException, prefix: str) -> OpenContextError:
        """Map the contract's stream and metering reverts to SDK codes.

        Every stream operation shares this so a given revert always maps to the same code.
        """
        for name, code, message in _STREAM_REVERTS:
            if self._reverted(error, name):
                return OpenContextError(code, message)
        if self._reverted(error, "StreamOperationFailed"):
            return self._superfluid_error(error, prefix)
        return OpenContextError(SDKError.TRANSACTION_FAILED, f"{prefix}: {error!s}")

    def _superfluid_error(self, error: BaseException, prefix: str) -> OpenContextError:
        """Unwrap ``StreamOperationFailed(bytes reason)`` into the CFA error it carries."""
        cfa_error = self._cfa_reason(error)
        if cfa_error in _CFA_PERMISSION_ERRORS:
            return OpenContextError(
                SDKError.FLOW_OPERATOR_PERMISSION,
                f"{prefix}: {cfa_error}. Grant the PaymentStream contract flow-operator "
                "permission on the Super Token (CFAv1Forwarder.grantPermissions) with a "
                "sufficient allowance first",
            )
        return OpenContextError(
            SDKError.STREAM_OPERATION_FAILED,
            f"{prefix}: Superfluid rejected the flow operation ({cfa_error or error!s})",
        )

    @staticmethod
    def _cfa_reason(error: BaseException) -> str | None:
        """CFA error name wrapped by the revert data, its raw hex if unknown, or ``None``."""
        data = revert_data(error)
        if not data.startswith(_STREAM_OPERATION_FAILED):
            return None
        try:
            (reason,) = decode(["bytes"], bytes.fromhex(data[10:]))
        except Exception:
            return None
        reason_hex = Web3.to_hex(reason)
        return _CFA_ERRORS.get(reason_hex[:10], reason_hex)
