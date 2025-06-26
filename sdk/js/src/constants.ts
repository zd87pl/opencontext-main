export const PASSPORT_REGISTRY_ABI = [
  "function mint(address to, bytes32 dataHash) external returns (uint256)",
  "function revoke(uint256 tokenId) external",
  "function updateDataHash(uint256 tokenId, bytes32 newDataHash) external",
  "function getTokenId(address owner) external view returns (uint256)",
  "function hasPassport(address owner) external view returns (bool)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function tokenIdToDataHash(uint256) external view returns (bytes32)",
  "function authorizedMinters(address) external view returns (bool)",
  "function authorizeMinter(address minter) external",
  "function revokeMinter(address minter) external",
  "event PassportMinted(address indexed to, uint256 indexed tokenId)",
  "event PassportRevoked(uint256 indexed tokenId, address indexed previousOwner)",
  "event DataHashUpdated(uint256 indexed tokenId, bytes32 indexed dataHash)",
];

export const CONTEXT_VAULT_ABI = [
  "function storeContext(bytes calldata encryptedData) external returns (uint256)",
  "function getContext(uint256 tokenId, uint256 version) external view returns (bytes memory, uint256)",
  "function getLatestContext(uint256 tokenId) external view returns (bytes memory, uint256, uint256)",
  "function getContextCount(uint256 tokenId) external view returns (uint256)",
  "function authorizeReader(address reader) external",
  "function revokeReader(address reader) external",
  "function deleteContext(uint256 version) external",
  "function authorizedReaders(uint256, address) external view returns (bool)",
  "function storageQuota(uint256) external view returns (uint256)",
  "event ContextStored(uint256 indexed tokenId, uint256 version, uint256 dataSize)",
  "event ReaderAuthorized(uint256 indexed tokenId, address indexed reader)",
  "event ReaderRevoked(uint256 indexed tokenId, address indexed reader)",
];

export const PAYMENT_STREAM_ABI = [
  "function registerProvider(address receiver, uint256 ratePerByte) external",
  "function updateProviderRate(uint256 newRate) external",
  "function startStream(address provider, uint256 bytesPerSecond) external",
  "function updateStream(address provider, uint256 newBytesPerSecond) external",
  "function stopStream(address provider) external",
  "function recordConsumption(uint256 tokenId, uint256 bytesConsumed) external",
  "function getStreamInfo(uint256 tokenId, address provider) external view returns (int96 flowRate, address receiver)",
  "function dataProviders(address) external view returns (address receiver, uint256 ratePerByte, uint256 totalBytesServed, bool active)",
  "function activeStreams(uint256, address) external view returns (int96)",
  "event StreamStarted(uint256 indexed tokenId, address indexed provider, int96 flowRate)",
  "event StreamStopped(uint256 indexed tokenId, address indexed provider)",
  "event BytesConsumed(uint256 indexed tokenId, address indexed provider, uint256 bytes)",
];

export const NETWORKS = {
  zkSyncSepolia: {
    chainId: 300,
    name: "zkSync Sepolia Testnet",
    rpcUrl: "https://sepolia.era.zksync.dev",
  },
  baseSepolia: {
    chainId: 84532,
    name: "Base Sepolia",
    rpcUrl: "https://sepolia.base.org",
  },
} as const;