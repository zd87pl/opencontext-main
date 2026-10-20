"""Constants and ABIs for OpenContext SDK."""

PASSPORT_REGISTRY_ABI = [
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

CONTEXT_VAULT_ABI = [
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

PAYMENT_STREAM_ABI = [
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
            {"name": "tokenId", "type": "uint256"},
            {"name": "bytesConsumed", "type": "uint256"},
        ],
        "outputs": [],
        "stateMutability": "nonpayable",
    },
    {
        "name": "getStreamInfo",
        "type": "function",
        "inputs": [
            {"name": "tokenId", "type": "uint256"},
            {"name": "provider", "type": "address"},
        ],
        "outputs": [
            {"name": "flowRate", "type": "int96"},
            {"name": "receiver", "type": "address"},
        ],
        "stateMutability": "view",
    },
    {
        "name": "dataProviders",
        "type": "function",
        "inputs": [{"name": "", "type": "address"}],
        "outputs": [
            {"name": "receiver", "type": "address"},
            {"name": "ratePerByte", "type": "uint256"},
            {"name": "totalBytesServed", "type": "uint256"},
            {"name": "active", "type": "bool"},
        ],
        "stateMutability": "view",
    },
]

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
