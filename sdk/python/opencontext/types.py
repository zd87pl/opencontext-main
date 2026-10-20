"""Type definitions for OpenContext SDK."""

from dataclasses import dataclass

from eth_typing import ChecksumAddress, HexStr
from web3 import AsyncWeb3


@dataclass
class OpenContextConfig:
    """Configuration for OpenContext client.

    Addresses are EIP-55 checksummed hex strings, which is what web3.py expects;
    :meth:`opencontext.OpenContextClient.create` normalises plain strings for you.
    """

    passport_registry_address: ChecksumAddress
    context_vault_address: ChecksumAddress
    payment_stream_address: ChecksumAddress
    web3: AsyncWeb3
    account: ChecksumAddress | None = None
    private_key: HexStr | None = None


@dataclass
class PassportData:
    """Passport data structure."""

    token_id: int
    owner: ChecksumAddress
    data_hash: HexStr
    exists: bool


@dataclass
class ContextData:
    """Context data structure."""

    encrypted_data: str
    timestamp: int
    version: int


@dataclass
class StreamInfo:
    """Result of ``PaymentStream.getStreamInfo(user, provider)``."""

    #: Flow rate in Super Token wei per second; 0 when there is no stream.
    flow_rate: int
    #: Payout address the flow was opened to (zero address when there is no stream).
    receiver: ChecksumAddress
    active: bool


@dataclass
class Stream:
    """Full ``PaymentStream.streams(user, provider)`` record."""

    receiver: ChecksumAddress
    flow_rate: int
    #: Bytes meters have attributed to this stream.
    bytes_consumed: int
    #: Block timestamp at which the stream was opened; 0 when there is no stream.
    started_at: int
    active: bool


@dataclass
class DataProvider:
    """Data provider information."""

    receiver: ChecksumAddress
    rate_per_byte: int
    total_bytes_served: int
    active: bool
