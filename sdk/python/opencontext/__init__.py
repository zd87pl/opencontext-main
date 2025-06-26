"""OpenContext Network Python SDK."""

from .client import OpenContextClient
from .errors import OpenContextError, SDKError
from .passport import PassportRegistry
from .payments import PaymentStream
from .types import ContextData, DataProvider, PassportData, StreamInfo
from .vault import ContextVault

__version__ = "0.1.0"

__all__ = [
    "OpenContextClient",
    "OpenContextError",
    "SDKError",
    "PassportRegistry",
    "PaymentStream",
    "ContextVault",
    "ContextData",
    "DataProvider",
    "PassportData",
    "StreamInfo",
]

async def authenticate(client: OpenContextClient) -> PassportData:
    """Authenticate and get or create passport."""
    return await client.authenticate()


async def store_context(client: OpenContextClient, data: str) -> int:
    """Store encrypted context data."""
    return await client.store_context(data)


async def get_latest_context(client: OpenContextClient) -> str | None:
    """Get the latest stored context."""
    return await client.get_my_latest_context()


async def stream_pay(client: OpenContextClient, provider: str, bytes_per_second: int) -> None:
    """Start a payment stream to a provider."""
    await client.stream_pay(provider, bytes_per_second)