// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PassportRegistry.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ContextVaultIPFS
 * @notice Stores IPFS hashes for encrypted context data
 * @dev Optimized version that stores IPFS hashes instead of full data on-chain
 */
contract ContextVaultIPFS is Ownable, Pausable {
    PassportRegistry public immutable passportRegistry;
    
    struct ContextEntry {
        string ipfsHash;        // IPFS hash of encrypted data
        uint256 dataSize;      // Original data size in bytes
        uint256 timestamp;     // When it was stored
        uint256 version;       // Version number
        bool isDeleted;        // Soft delete flag
        bool isEncrypted;      // Whether data is encrypted
    }
    
    mapping(uint256 => ContextEntry[]) private tokenContexts;
    mapping(uint256 => mapping(address => bool)) public authorizedReaders;
    mapping(uint256 => uint256) public storageQuota;
    mapping(uint256 => uint256) public storageUsed;
    
    // IPFS hash tracking for garbage collection
    mapping(string => uint256) public ipfsHashRefCount;
    mapping(string => uint256) public ipfsHashTimestamp;
    
    uint256 public constant DEFAULT_QUOTA = 100 * 1024 * 1024; // 100MB
    uint256 public constant MAX_CONTEXT_SIZE = 10 * 1024 * 1024; // 10MB per entry
    uint256 public constant IPFS_HASH_GC_DELAY = 7 days; // Grace period before GC
    
    event ContextStored(uint256 indexed tokenId, uint256 version, string ipfsHash, uint256 dataSize);
    event ContextDeleted(uint256 indexed tokenId, uint256 version, string ipfsHash);
    event ReaderAuthorized(uint256 indexed tokenId, address indexed reader);
    event ReaderRevoked(uint256 indexed tokenId, address indexed reader);
    event QuotaUpdated(uint256 indexed tokenId, uint256 newQuota);
    event IPFSHashPinned(string indexed ipfsHash, uint256 refCount);
    event IPFSHashUnpinned(string indexed ipfsHash);
    
    error NotPassportOwner();
    error NotAuthorizedReader();
    error QuotaExceeded();
    error ContextTooLarge();
    error InvalidVersion();
    error NoPassport();
    error ContextAlreadyDeleted();
    error InvalidIPFSHash();
    
    modifier onlyPassportOwner(uint256 tokenId) {
        if (passportRegistry.ownerOf(tokenId) != msg.sender) {
            revert NotPassportOwner();
        }
        _;
    }
    
    modifier onlyAuthorizedReader(uint256 tokenId) {
        address owner = passportRegistry.ownerOf(tokenId);
        if (msg.sender != owner && !authorizedReaders[tokenId][msg.sender]) {
            revert NotAuthorizedReader();
        }
        _;
    }
    
    constructor(address _passportRegistry) {
        passportRegistry = PassportRegistry(_passportRegistry);
    }
    
    /// @notice Store IPFS hash for context data
    /// @param ipfsHash The IPFS hash of encrypted context data
    /// @param dataSize Size of the original data in bytes
    /// @param isEncrypted Whether the data stored on IPFS is encrypted
    function storeContextIPFS(
        string calldata ipfsHash, 
        uint256 dataSize,
        bool isEncrypted
    ) external whenNotPaused returns (uint256) {
        uint256 tokenId = passportRegistry.getTokenId(msg.sender);
        if (tokenId == 0) {
            revert NoPassport();
        }
        
        if (dataSize > MAX_CONTEXT_SIZE) {
            revert ContextTooLarge();
        }
        
        if (bytes(ipfsHash).length == 0) {
            revert InvalidIPFSHash();
        }
        
        uint256 currentUsage = storageUsed[tokenId];
        uint256 quota = storageQuota[tokenId] == 0 ? DEFAULT_QUOTA : storageQuota[tokenId];
        
        if (currentUsage + dataSize > quota) {
            revert QuotaExceeded();
        }
        
        uint256 version = tokenContexts[tokenId].length;
        tokenContexts[tokenId].push(ContextEntry({
            ipfsHash: ipfsHash,
            dataSize: dataSize,
            timestamp: block.timestamp,
            version: version,
            isDeleted: false,
            isEncrypted: isEncrypted
        }));
        
        storageUsed[tokenId] += dataSize;
        
        // Track IPFS hash reference
        ipfsHashRefCount[ipfsHash]++;
        if (ipfsHashRefCount[ipfsHash] == 1) {
            ipfsHashTimestamp[ipfsHash] = block.timestamp;
            emit IPFSHashPinned(ipfsHash, 1);
        }
        
        emit ContextStored(tokenId, version, ipfsHash, dataSize);
        return version;
    }
    
    /// @notice Retrieve context metadata by version
    /// @param tokenId The passport token ID
    /// @param version The context version to retrieve
    function getContextMetadata(uint256 tokenId, uint256 version) 
        external 
        view 
        onlyAuthorizedReader(tokenId) 
        returns (string memory ipfsHash, uint256 dataSize, uint256 timestamp, bool isEncrypted) 
    {
        if (version >= tokenContexts[tokenId].length) {
            revert InvalidVersion();
        }
        
        ContextEntry memory context = tokenContexts[tokenId][version];
        if (context.isDeleted) {
            return ("", 0, 0, false);
        }
        
        return (context.ipfsHash, context.dataSize, context.timestamp, context.isEncrypted);
    }
    
    /// @notice Get the latest context metadata
    /// @param tokenId The passport token ID
    function getLatestContextMetadata(uint256 tokenId) 
        external 
        view 
        onlyAuthorizedReader(tokenId) 
        returns (string memory ipfsHash, uint256 dataSize, uint256 timestamp, uint256 version, bool isEncrypted) 
    {
        uint256 length = tokenContexts[tokenId].length;
        if (length == 0) {
            return ("", 0, 0, 0, false);
        }
        
        // Find the latest non-deleted context
        for (uint256 i = length; i > 0; i--) {
            ContextEntry memory context = tokenContexts[tokenId][i - 1];
            if (!context.isDeleted) {
                return (context.ipfsHash, context.dataSize, context.timestamp, context.version, context.isEncrypted);
            }
        }
        
        return ("", 0, 0, 0, false);
    }
    
    /// @notice Get context count for a token
    /// @param tokenId The passport token ID
    function getContextCount(uint256 tokenId) external view returns (uint256) {
        return tokenContexts[tokenId].length;
    }
    
    /// @notice Get active (non-deleted) context count for a token
    /// @param tokenId The passport token ID
    function getActiveContextCount(uint256 tokenId) external view returns (uint256) {
        uint256 activeCount = 0;
        uint256 totalCount = tokenContexts[tokenId].length;
        
        for (uint256 i = 0; i < totalCount; i++) {
            if (!tokenContexts[tokenId][i].isDeleted) {
                activeCount++;
            }
        }
        
        return activeCount;
    }
    
    /// @notice Authorize a reader for your context
    /// @param reader Address to authorize
    function authorizeReader(address reader) external whenNotPaused {
        uint256 tokenId = passportRegistry.getTokenId(msg.sender);
        if (tokenId == 0) {
            revert NoPassport();
        }
        
        authorizedReaders[tokenId][reader] = true;
        emit ReaderAuthorized(tokenId, reader);
    }
    
    /// @notice Revoke reader authorization
    /// @param reader Address to revoke
    function revokeReader(address reader) external whenNotPaused {
        uint256 tokenId = passportRegistry.getTokenId(msg.sender);
        if (tokenId == 0) {
            revert NoPassport();
        }
        
        authorizedReaders[tokenId][reader] = false;
        emit ReaderRevoked(tokenId, reader);
    }
    
    /// @notice Delete a specific context version
    /// @param version Version to delete
    function deleteContext(uint256 version) external whenNotPaused {
        uint256 tokenId = passportRegistry.getTokenId(msg.sender);
        if (tokenId == 0) {
            revert NoPassport();
        }
        
        if (version >= tokenContexts[tokenId].length) {
            revert InvalidVersion();
        }
        
        ContextEntry storage context = tokenContexts[tokenId][version];
        
        // Check if already deleted
        if (context.isDeleted) {
            revert ContextAlreadyDeleted();
        }
        
        uint256 dataSize = context.dataSize;
        string memory ipfsHash = context.ipfsHash;
        
        // Update storage usage
        if (dataSize > 0) {
            storageUsed[tokenId] -= dataSize;
        }
        
        // Mark as deleted
        context.isDeleted = true;
        
        // Decrease IPFS hash reference count
        if (ipfsHashRefCount[ipfsHash] > 0) {
            ipfsHashRefCount[ipfsHash]--;
            if (ipfsHashRefCount[ipfsHash] == 0) {
                // Mark for garbage collection after grace period
                ipfsHashTimestamp[ipfsHash] = block.timestamp + IPFS_HASH_GC_DELAY;
                emit IPFSHashUnpinned(ipfsHash);
            }
        }
        
        emit ContextDeleted(tokenId, version, ipfsHash);
    }
    
    /// @notice Update storage quota for a token (owner only)
    /// @param tokenId The passport token ID
    /// @param newQuota New quota in bytes
    function updateQuota(uint256 tokenId, uint256 newQuota) external {
        if (msg.sender != passportRegistry.owner()) {
            revert NotAuthorizedReader();
        }
        
        storageQuota[tokenId] = newQuota;
        emit QuotaUpdated(tokenId, newQuota);
    }
    
    /// @notice Check if IPFS hash can be garbage collected
    /// @param ipfsHash The IPFS hash to check
    function canGarbageCollect(string calldata ipfsHash) external view returns (bool) {
        return ipfsHashRefCount[ipfsHash] == 0 && 
               ipfsHashTimestamp[ipfsHash] > 0 && 
               block.timestamp >= ipfsHashTimestamp[ipfsHash];
    }
    
    /// @notice Get IPFS hash reference count
    /// @param ipfsHash The IPFS hash to check
    function getIPFSHashRefCount(string calldata ipfsHash) external view returns (uint256) {
        return ipfsHashRefCount[ipfsHash];
    }
    
    /// @notice Batch operation to get multiple context metadata
    /// @param tokenId The passport token ID
    /// @param versions Array of versions to retrieve
    function batchGetContextMetadata(uint256 tokenId, uint256[] calldata versions)
        external
        view
        onlyAuthorizedReader(tokenId)
        returns (
            string[] memory ipfsHashes,
            uint256[] memory dataSizes,
            uint256[] memory timestamps,
            bool[] memory isEncryptedArray
        )
    {
        uint256 length = versions.length;
        ipfsHashes = new string[](length);
        dataSizes = new uint256[](length);
        timestamps = new uint256[](length);
        isEncryptedArray = new bool[](length);
        
        for (uint256 i = 0; i < length; i++) {
            uint256 version = versions[i];
            if (version < tokenContexts[tokenId].length) {
                ContextEntry memory context = tokenContexts[tokenId][version];
                if (!context.isDeleted) {
                    ipfsHashes[i] = context.ipfsHash;
                    dataSizes[i] = context.dataSize;
                    timestamps[i] = context.timestamp;
                    isEncryptedArray[i] = context.isEncrypted;
                }
            }
        }
    }
    
    /// @notice Pause contract (emergency stop)
    function pause() external onlyOwner {
        _pause();
    }
    
    /// @notice Unpause contract
    function unpause() external onlyOwner {
        _unpause();
    }
    
    /// @notice Get current storage usage for a token
    /// @param tokenId The passport token ID
    function getStorageUsed(uint256 tokenId) external view returns (uint256) {
        return storageUsed[tokenId];
    }
    
    /// @notice Get storage quota for a token
    /// @param tokenId The passport token ID
    function getStorageQuota(uint256 tokenId) external view returns (uint256) {
        return storageQuota[tokenId] == 0 ? DEFAULT_QUOTA : storageQuota[tokenId];
    }
}