"""Error definitions for OpenContext SDK."""

from collections.abc import Iterable, Mapping
from enum import Enum
from typing import Any

from eth_utils.abi import collapse_if_tuple
from web3 import Web3


class SDKError(str, Enum):
    """SDK error codes."""

    NO_ACCOUNT = "NO_ACCOUNT"
    NO_PASSPORT = "NO_PASSPORT"
    INVALID_ADDRESS = "INVALID_ADDRESS"
    TRANSACTION_FAILED = "TRANSACTION_FAILED"
    INVALID_FLOW_RATE = "INVALID_FLOW_RATE"
    PROVIDER_NOT_ACTIVE = "PROVIDER_NOT_ACTIVE"
    #: The (user, provider) pair has no open stream.
    STREAM_NOT_ACTIVE = "STREAM_NOT_ACTIVE"
    #: The (user, provider) pair already has an open stream.
    STREAM_ALREADY_ACTIVE = "STREAM_ALREADY_ACTIVE"
    #: Superfluid refused the flow operation because the user has not granted
    #: ``PaymentStream`` flow-operator permission (or enough allowance) on the Super Token.
    FLOW_OPERATOR_PERMISSION = "FLOW_OPERATOR_PERMISSION"
    #: Superfluid rejected the flow operation for another reason, named in the message.
    STREAM_OPERATION_FAILED = "STREAM_OPERATION_FAILED"
    UNAUTHORIZED = "UNAUTHORIZED"
    QUOTA_EXCEEDED = "QUOTA_EXCEEDED"
    ENCRYPTION_FAILED = "ENCRYPTION_FAILED"


class OpenContextError(Exception):
    """OpenContext SDK error."""

    def __init__(self, code: SDKError, message: str) -> None:
        """Initialize error with code and message."""
        super().__init__(message)
        self.code = code
        self.message = message


def error_selectors(abi: Iterable[Mapping[str, Any]]) -> dict[str, str]:
    """Map each custom error in ``abi`` to its 0x-prefixed 4-byte selector."""
    selectors: dict[str, str] = {}
    for entry in abi:
        if entry.get("type") != "error":
            continue
        signature = "{}({})".format(
            entry["name"], ",".join(collapse_if_tuple(dict(arg)) for arg in entry["inputs"])
        )
        selectors[str(entry["name"])] = Web3.to_hex(Web3.keccak(text=signature)[:4])
    return selectors


def revert_data(error: BaseException) -> str:
    """Lower-cased hex revert data carried by a web3 ``ContractCustomError``, or ``""``."""
    data = getattr(error, "data", None)
    return data.lower() if isinstance(data, str) else ""


def is_revert(error: BaseException, name: str, selectors: Mapping[str, str]) -> bool:
    """Whether ``error`` is the custom Solidity error ``name``.

    Nodes that return a revert *reason* mention the error by name; web3's
    ``ContractCustomError`` carries only the ABI-encoded revert data, which is
    matched by selector instead.
    """
    if name in str(error):
        return True
    selector = selectors.get(name)
    if selector is None:
        return False
    return revert_data(error).startswith(selector) or selector in str(error).lower()
