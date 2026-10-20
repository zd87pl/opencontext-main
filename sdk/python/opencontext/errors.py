"""Error definitions for OpenContext SDK."""

from enum import Enum


class SDKError(str, Enum):
    """SDK error codes."""

    NO_ACCOUNT = "NO_ACCOUNT"
    NO_PASSPORT = "NO_PASSPORT"
    INVALID_ADDRESS = "INVALID_ADDRESS"
    TRANSACTION_FAILED = "TRANSACTION_FAILED"
    INVALID_FLOW_RATE = "INVALID_FLOW_RATE"
    PROVIDER_NOT_ACTIVE = "PROVIDER_NOT_ACTIVE"
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
