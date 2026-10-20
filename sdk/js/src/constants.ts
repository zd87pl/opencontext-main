/**
 * Human-readable ABI fragments for the OpenContext contracts. The custom
 * error fragments let ethers decode reverts so the SDK can map them to
 * {@link SDKError} codes.
 */

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
  "event MinterAuthorized(address indexed minter)",
  "event MinterRevoked(address indexed minter)",
  "error AlreadyMinted()",
  "error NotAuthorized()",
  "error TokenDoesNotExist()",
  "error TransfersDisabled()",
  "error ZeroAddress()",
];

/** ABI of `ContextVault.sol`, which stores the encrypted payload on-chain. */
export const CONTEXT_VAULT_ABI = [
  "function storeContext(bytes calldata encryptedData) external returns (uint256)",
  "function getContext(uint256 tokenId, uint256 version) external view returns (bytes memory, uint256)",
  "function getLatestContext(uint256 tokenId) external view returns (bytes memory, uint256, uint256)",
  "function getContextCount(uint256 tokenId) external view returns (uint256)",
  "function getActiveContextCount(uint256 tokenId) external view returns (uint256)",
  "function authorizeReader(address reader) external",
  "function revokeReader(address reader) external",
  "function deleteContext(uint256 version) external",
  "function authorizedReaders(uint256, address) external view returns (bool)",
  "function storageQuota(uint256) external view returns (uint256)",
  "function storageUsed(uint256) external view returns (uint256)",
  "function getStorageUsed(uint256 tokenId) external view returns (uint256)",
  "function getStorageQuota(uint256 tokenId) external view returns (uint256)",
  "event ContextStored(uint256 indexed tokenId, uint256 version, uint256 dataSize)",
  "event ContextDeleted(uint256 indexed tokenId, uint256 version)",
  "event ReaderAuthorized(uint256 indexed tokenId, address indexed reader)",
  "event ReaderRevoked(uint256 indexed tokenId, address indexed reader)",
  "event QuotaUpdated(uint256 indexed tokenId, uint256 newQuota)",
  "error NotPassportOwner()",
  "error NotAuthorizedReader()",
  "error QuotaExceeded()",
  "error ContextTooLarge()",
  "error InvalidVersion()",
  "error NoPassport()",
  "error ContextAlreadyDeleted()",
];

/** ABI of `ContextVaultIPFS.sol`, which stores only the IPFS CID on-chain. */
export const CONTEXT_VAULT_IPFS_ABI = [
  "function storeContextIPFS(string ipfsHash, uint256 dataSize, bool isEncrypted) external returns (uint256)",
  "function getContextMetadata(uint256 tokenId, uint256 version) external view returns (string ipfsHash, uint256 dataSize, uint256 timestamp, bool isEncrypted)",
  "function getLatestContextMetadata(uint256 tokenId) external view returns (string ipfsHash, uint256 dataSize, uint256 timestamp, uint256 version, bool isEncrypted)",
  "function batchGetContextMetadata(uint256 tokenId, uint256[] versions) external view returns (string[] ipfsHashes, uint256[] dataSizes, uint256[] timestamps, bool[] isEncryptedArray)",
  "function getContextCount(uint256 tokenId) external view returns (uint256)",
  "function getActiveContextCount(uint256 tokenId) external view returns (uint256)",
  "function authorizeReader(address reader) external",
  "function revokeReader(address reader) external",
  "function deleteContext(uint256 version) external",
  "function authorizedReaders(uint256, address) external view returns (bool)",
  "function storageQuota(uint256) external view returns (uint256)",
  "function storageUsed(uint256) external view returns (uint256)",
  "function getStorageUsed(uint256 tokenId) external view returns (uint256)",
  "function getStorageQuota(uint256 tokenId) external view returns (uint256)",
  "function canGarbageCollect(string ipfsHash) external view returns (bool)",
  "function getIPFSHashRefCount(string ipfsHash) external view returns (uint256)",
  "event ContextStored(uint256 indexed tokenId, uint256 version, string ipfsHash, uint256 dataSize)",
  "event ContextDeleted(uint256 indexed tokenId, uint256 version, string ipfsHash)",
  "event ReaderAuthorized(uint256 indexed tokenId, address indexed reader)",
  "event ReaderRevoked(uint256 indexed tokenId, address indexed reader)",
  "event QuotaUpdated(uint256 indexed tokenId, uint256 newQuota)",
  "event IPFSHashPinned(string indexed ipfsHash, uint256 refCount)",
  "event IPFSHashUnpinned(string indexed ipfsHash)",
  "error NotPassportOwner()",
  "error NotAuthorizedReader()",
  "error QuotaExceeded()",
  "error ContextTooLarge()",
  "error InvalidVersion()",
  "error NoPassport()",
  "error ContextAlreadyDeleted()",
  "error InvalidIPFSHash()",
];

/**
 * ABI of `PaymentStream.sol`. Streams are keyed by `(user, provider)`, where
 * `user` is the wallet whose Super Token balance funds the Superfluid flow;
 * `recordConsumption` is restricted to meters enabled through `setMeter`.
 */
export const PAYMENT_STREAM_ABI = [
  "function registerProvider(address receiver, uint256 ratePerByte) external",
  "function updateProviderRate(uint256 newRate) external",
  "function deregisterProvider() external",
  "function setMeter(address meter, bool allowed) external",
  "function startStream(address provider, uint256 bytesPerSecond) external",
  "function updateStream(address provider, uint256 newBytesPerSecond) external",
  "function stopStream(address provider) external",
  "function recordConsumption(address user, address provider, uint256 bytesConsumed) external",
  "function calculateFlowRate(uint256 ratePerByte, uint256 bytesPerSecond) external pure returns (int96 flowRate)",
  "function getStreamInfo(address user, address provider) external view returns (int96 flowRate, address receiver)",
  "function streams(address user, address provider) external view returns (address receiver, int96 flowRate, uint256 bytesConsumed, uint256 startedAt)",
  "function dataProviders(address provider) external view returns (address receiver, uint256 ratePerByte, uint256 totalBytesServed, bool active)",
  "function meters(address meter) external view returns (bool allowed)",
  "function usdcx() external view returns (address)",
  "function superfluid() external view returns (address)",
  "function cfa() external view returns (address)",
  "function RATE_PRECISION() external view returns (uint256)",
  "function MIN_FLOW_RATE() external view returns (int96)",
  "function MAX_FLOW_RATE() external view returns (uint256)",
  "event ProviderRegistered(address indexed provider, address receiver, uint256 ratePerByte)",
  "event ProviderUpdated(address indexed provider, uint256 newRate)",
  "event ProviderDeregistered(address indexed provider)",
  "event MeterUpdated(address indexed meter, bool allowed)",
  "event StreamStarted(address indexed user, address indexed provider, address receiver, int96 flowRate)",
  "event StreamUpdated(address indexed user, address indexed provider, int96 newFlowRate)",
  "event StreamStopped(address indexed user, address indexed provider)",
  "event BytesConsumed(address indexed user, address indexed provider, uint256 bytesConsumed)",
  "error NotPassportHolder()",
  "error ProviderNotActive()",
  "error InvalidProvider()",
  "error InvalidFlowRate()",
  "error FlowRateOverflow()",
  "error StreamAlreadyActive()",
  "error StreamNotActive()",
  "error NotMeter()",
  "error SelfMetering()",
  // `reason` is the Superfluid host's revert data, usually a 4-byte CFA error selector.
  "error StreamOperationFailed(bytes reason)",
];

/**
 * Superfluid's `CFAv1Forwarder`, deployed at the same address on every
 * Superfluid network. Users grant `PaymentStream` flow-operator permission
 * through it before opening a stream; see `PaymentStream` in `payments.ts`.
 */
export const CFA_V1_FORWARDER_ADDRESS = "0xcfA132E353cB4E398080B9700609bb008eceB125";

/** Mirrors `ContextVault.DEFAULT_QUOTA` (10 MiB), applied when no per-token quota is set. */
export const DEFAULT_STORAGE_QUOTA = 10n * 1024n * 1024n;

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
