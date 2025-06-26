"""Type definitions for OpenContext SDK."""

from dataclasses import dataclass
from typing import Optional

from eth_typing import Address, HexStr
from web3 import AsyncWeb3
from web3.contract import AsyncContract


@dataclass
class OpenContextConfig:
    """Configuration for OpenContext client."""

    passport_registry_address: Address
    context_vault_address: Address
    payment_stream_address: Address
    web3: AsyncWeb3
    account: Optional[Address] = None
    private_key: Optional[HexStr] = None


@dataclass
class PassportData:
    """Passport data structure."""

    token_id: int
    owner: Address
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
    """Payment stream information."""

    flow_rate: int
    receiver: Address
    active: bool


@dataclass
class DataProvider:
    """Data provider information."""

    receiver: Address
    rate_per_byte: int
    total_bytes_served: int
    active: bool