"""Constants and ABIs for OpenContext SDK."""

from typing import Any

PASSPORT_REGISTRY_ABI: list[dict[str, Any]] = [
    {
        "name": "mint",
        "type": "function",
        "inputs": [
            {"name": "to", "type": "address"},
            {"name": "dataHash", "type": "bytes32"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "nonpayable",
    },
    {
        "name": "revoke",
        "type": "function",
        "inputs": [{"name": "tokenId", "type": "uint256"}],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "updateDataHash",
        "type": "function",
        "inputs": [
            {"name": "tokenId", "type": "uint256"},
            {"name": "newDataHash", "type": "bytes32"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "getTokenId",
        "type": "function",
        "inputs": [{"name": "owner", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    },
    {
        "name": "hasPassport",
        "type": "function",
        "inputs": [{"name": "owner", "type": "address"}],
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "view",
    },
    {
        "name": "ownerOf",
        "type": "function",
        "inputs": [{"name": "tokenId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "address"}],
        "stateMutability": "view",
    },
    {
        "name": "tokenIdToDataHash",
        "type": "function",
        "inputs": [{"name": "", "type": "uint256"}],
        "outputs": [{"name": "", "type": "bytes32"}],
        "stateMutability": "view",
    },
    {
        "name": "PassportMinted",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "to", "type": "address", "indexed": True},
            {"name": "tokenId", "type": "uint256", "indexed": True},
        ],
    },
    {
        "name": "PassportRevoked",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "tokenId", "type": "uint256", "indexed": True},
            {"name": "previousOwner", "type": "address", "indexed": True},
        ],
    },
]

CONTEXT_VAULT_ABI: list[dict[str, Any]] = [
    {
        "name": "storeContext",
        "type": "function",
        "inputs": [{"name": "encryptedData", "type": "bytes"}],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "nonpayable",
    },
    {
        "name": "getContext",
        "type": "function",
        "inputs": [
            {"name": "tokenId", "type": "uint256"},
            {"name": "version", "type": "uint256"},
        ],
        "outputs": [
            {"name": "", "type": "bytes"},
            {"name": "", "type": "uint256"},
        ],
        "stateMutability": "view",
    },
    {
        "name": "getLatestContext",
        "type": "function",
        "inputs": [{"name": "tokenId", "type": "uint256"}],
        "outputs": [
            {"name": "", "type": "bytes"},
            {"name": "", "type": "uint256"},
            {"name": "", "type": "uint256"},
        ],
        "stateMutability": "view",
    },
    {
        "name": "getContextCount",
        "type": "function",
        "inputs": [{"name": "tokenId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    },
    {
        "name": "authorizeReader",
        "type": "function",
        "inputs": [{"name": "reader", "type": "address"}],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "revokeReader",
        "type": "function",
        "inputs": [{"name": "reader", "type": "address"}],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "deleteContext",
        "type": "function",
        "inputs": [{"name": "version", "type": "uint256"}],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    # ContextVault.store_context() reads the stored version off this event, so the
    # SDK cannot report a successful store without it in the ABI.
    {
        "name": "ContextStored",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "tokenId", "type": "uint256", "indexed": True},
            {"name": "version", "type": "uint256", "indexed": False},
            {"name": "dataSize", "type": "uint256", "indexed": False},
        ],
    },
    {
        "name": "ContextDeleted",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "tokenId", "type": "uint256", "indexed": True},
            {"name": "version", "type": "uint256", "indexed": False},
        ],
    },
    {
        "name": "ReaderAuthorized",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "tokenId", "type": "uint256", "indexed": True},
            {"name": "reader", "type": "address", "indexed": True},
        ],
    },
    {
        "name": "ReaderRevoked",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "tokenId", "type": "uint256", "indexed": True},
            {"name": "reader", "type": "address", "indexed": True},
        ],
    },
]

# PaymentStream.sol: streams are keyed by (user, provider) wallet addresses and
# recordConsumption is restricted to meters enabled through setMeter. The error
# entries let the SDK recognise custom reverts by selector (see errors.is_revert).
PAYMENT_STREAM_ABI: list[dict[str, Any]] = [
    {
        "name": "registerProvider",
        "type": "function",
        "inputs": [
            {"name": "receiver", "type": "address"},
            {"name": "ratePerByte", "type": "uint256"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "updateProviderRate",
        "type": "function",
        "inputs": [{"name": "newRate", "type": "uint256"}],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "deregisterProvider",
        "type": "function",
        "inputs": [],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "setMeter",
        "type": "function",
        "inputs": [
            {"name": "meter", "type": "address"},
            {"name": "allowed", "type": "bool"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "startStream",
        "type": "function",
        "inputs": [
            {"name": "provider", "type": "address"},
            {"name": "bytesPerSecond", "type": "uint256"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "updateStream",
        "type": "function",
        "inputs": [
            {"name": "provider", "type": "address"},
            {"name": "newBytesPerSecond", "type": "uint256"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "stopStream",
        "type": "function",
        "inputs": [{"name": "provider", "type": "address"}],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "recordConsumption",
        "type": "function",
        "inputs": [
            {"name": "user", "type": "address"},
            {"name": "provider", "type": "address"},
            {"name": "bytesConsumed", "type": "uint256"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "calculateFlowRate",
        "type": "function",
        "inputs": [
            {"name": "ratePerByte", "type": "uint256"},
            {"name": "bytesPerSecond", "type": "uint256"},
        ],
        "outputs": [{"name": "flowRate", "type": "int96"}],
        "stateMutability": "pure",
    },
    {
        "name": "getStreamInfo",
        "type": "function",
        "inputs": [
            {"name": "user", "type": "address"},
            {"name": "provider", "type": "address"},
        ],
        "outputs": [
            {"name": "flowRate", "type": "int96"},
            {"name": "receiver", "type": "address"},
        ],
        "stateMutability": "view",
    },
    {
        "name": "streams",
        "type": "function",
        "inputs": [
            {"name": "user", "type": "address"},
            {"name": "provider", "type": "address"},
        ],
        "outputs": [
            {"name": "receiver", "type": "address"},
            {"name": "flowRate", "type": "int96"},
            {"name": "bytesConsumed", "type": "uint256"},
            {"name": "startedAt", "type": "uint256"},
        ],
        "stateMutability": "view",
    },
    {
        "name": "dataProviders",
        "type": "function",
        "inputs": [{"name": "provider", "type": "address"}],
        "outputs": [
            {"name": "receiver", "type": "address"},
            {"name": "ratePerByte", "type": "uint256"},
            {"name": "totalBytesServed", "type": "uint256"},
            {"name": "active", "type": "bool"},
        ],
        "stateMutability": "view",
    },
    {
        "name": "meters",
        "type": "function",
        "inputs": [{"name": "meter", "type": "address"}],
        "outputs": [{"name": "allowed", "type": "bool"}],
        "stateMutability": "view",
    },
    {
        "name": "usdcx",
        "type": "function",
        "inputs": [],
        "outputs": [{"name": "", "type": "address"}],
        "stateMutability": "view",
    },
    {
        "name": "ProviderRegistered",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "provider", "type": "address", "indexed": True},
            {"name": "receiver", "type": "address", "indexed": False},
            {"name": "ratePerByte", "type": "uint256", "indexed": False},
        ],
    },
    {
        "name": "ProviderUpdated",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "provider", "type": "address", "indexed": True},
            {"name": "newRate", "type": "uint256", "indexed": False},
        ],
    },
    {
        "name": "ProviderDeregistered",
        "type": "event",
        "anonymous": False,
        "inputs": [{"name": "provider", "type": "address", "indexed": True}],
    },
    {
        "name": "MeterUpdated",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "meter", "type": "address", "indexed": True},
            {"name": "allowed", "type": "bool", "indexed": False},
        ],
    },
    {
        "name": "StreamStarted",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "user", "type": "address", "indexed": True},
            {"name": "provider", "type": "address", "indexed": True},
            {"name": "receiver", "type": "address", "indexed": False},
            {"name": "flowRate", "type": "int96", "indexed": False},
        ],
    },
    {
        "name": "StreamUpdated",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "user", "type": "address", "indexed": True},
            {"name": "provider", "type": "address", "indexed": True},
            {"name": "newFlowRate", "type": "int96", "indexed": False},
        ],
    },
    {
        "name": "StreamStopped",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "user", "type": "address", "indexed": True},
            {"name": "provider", "type": "address", "indexed": True},
        ],
    },
    {
        "name": "BytesConsumed",
        "type": "event",
        "anonymous": False,
        "inputs": [
            {"name": "user", "type": "address", "indexed": True},
            {"name": "provider", "type": "address", "indexed": True},
            {"name": "bytesConsumed", "type": "uint256", "indexed": False},
        ],
    },
    {"name": "NotPassportHolder", "type": "error", "inputs": []},
    {"name": "ProviderNotActive", "type": "error", "inputs": []},
    {"name": "InvalidProvider", "type": "error", "inputs": []},
    {"name": "InvalidFlowRate", "type": "error", "inputs": []},
    {"name": "FlowRateOverflow", "type": "error", "inputs": []},
    {"name": "StreamAlreadyActive", "type": "error", "inputs": []},
    {"name": "StreamNotActive", "type": "error", "inputs": []},
    {"name": "NotMeter", "type": "error", "inputs": []},
    {"name": "SelfMetering", "type": "error", "inputs": []},
    # `reason` is the Superfluid host's revert data, usually a 4-byte CFA error selector.
    {
        "name": "StreamOperationFailed",
        "type": "error",
        "inputs": [{"name": "reason", "type": "bytes"}],
    },
]

#: Superfluid's CFAv1Forwarder, deployed at the same address on every Superfluid
#: network. Users grant ``PaymentStream`` flow-operator permission through it before
#: opening a stream; see :mod:`opencontext.payments`.
CFA_V1_FORWARDER_ADDRESS = "0xcfA132E353cB4E398080B9700609bb008eceB125"

NETWORKS = {
    "zkSyncSepolia": {
        "chainId": 300,
        "name": "zkSync Sepolia Testnet",
        "rpcUrl": "https://sepolia.era.zksync.dev",
    },
    "baseSepolia": {
        "chainId": 84532,
        "name": "Base Sepolia",
        "rpcUrl": "https://sepolia.base.org",
    },
}
