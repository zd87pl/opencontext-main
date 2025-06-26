// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PassportRegistry.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ContextVault
 * @notice Stores encrypted context data for passport holders
 * @dev Each passport holder can store encrypted conversation history and preferences
 */
contract ContextVault is Ownable, Pausable {
    PassportRegistry public immutable passportRegistry;
    
    struct Context {
        bytes encryptedData;
        uint256 timestamp;
        uint256 version;
        bool isDeleted;
    }
    
    mapping(uint256 => Context[]) private tokenContexts;
    mapping(uint256 => mapping(address => bool)) public authorizedReaders;
    mapping(uint256 => uint256) public storageQuota;
    mapping(uint256 => uint256) public storageUsed;
    
    uint256 public constant DEFAULT_QUOTA = 10 * 1024 * 1024; // 10MB
    uint256 public constant MAX_CONTEXT_SIZE = 1024 * 1024; // 1MB per entry
    
    event ContextStored(uint256 indexed tokenId, uint256 version, uint256 dataSize);
    event ContextDeleted(uint256 indexed tokenId, uint256 version);
    event ReaderAuthorized(uint256 indexed tokenId, address indexed reader);
    event ReaderRevoked(uint256 indexed tokenId, address indexed reader);
    event QuotaUpdated(uint256 indexed tokenId, uint256 newQuota);
    
    error NotPassportOwner();
    error NotAuthorizedReader();
    error QuotaExceeded();
    error ContextTooLarge();
    error InvalidVersion();
    error NoPassport();
    error ContextAlreadyDeleted();
    
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
    
    /// @notice Store encrypted context data
    /// @param encryptedData The encrypted context data
    function storeContext(bytes calldata encryptedData) external whenNotPaused returns (uint256) {
        uint256 tokenId = passportRegistry.getTokenId(msg.sender);
        if (tokenId == 0) {
            revert NoPassport();
        }
        
        if (encryptedData.length > MAX_CONTEXT_SIZE) {
            revert ContextTooLarge();
        }
        
        uint256 currentUsage = storageUsed[tokenId];
        uint256 quota = storageQuota[tokenId] == 0 ? DEFAULT_QUOTA : storageQuota[tokenId];
        
        if (currentUsage + encryptedData.length > quota) {
            revert QuotaExceeded();
        }
        
        uint256 version = tokenContexts[tokenId].length;
        tokenContexts[tokenId].push(Context({
            encryptedData: encryptedData,
            timestamp: block.timestamp,
            version: version,
            isDeleted: false
        }));
        
        storageUsed[tokenId] += encryptedData.length;
        
        emit ContextStored(tokenId, version, encryptedData.length);
        return version;
    }
    
    /// @notice Retrieve context data by version
    /// @param tokenId The passport token ID
    /// @param version The context version to retrieve
    function getContext(uint256 tokenId, uint256 version) 
        external 
        view 
        onlyAuthorizedReader(tokenId) 
        returns (bytes memory, uint256) 
    {
        if (version >= tokenContexts[tokenId].length) {
            revert InvalidVersion();
        }
        
        Context memory context = tokenContexts[tokenId][version];
        if (context.isDeleted) {
            return ("", 0);
        }
        return (context.encryptedData, context.timestamp);
    }
    
    /// @notice Get the latest context
    /// @param tokenId The passport token ID
    function getLatestContext(uint256 tokenId) 
        external 
        view 
        onlyAuthorizedReader(tokenId) 
        returns (bytes memory, uint256, uint256) 
    {
        uint256 length = tokenContexts[tokenId].length;
        if (length == 0) {
            return ("", 0, 0);
        }
        
        // Find the latest non-deleted context
        for (uint256 i = length; i > 0; i--) {
            Context memory context = tokenContexts[tokenId][i - 1];
            if (!context.isDeleted) {
                return (context.encryptedData, context.timestamp, context.version);
            }
        }
        
        return ("", 0, 0);
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
        
        Context storage context = tokenContexts[tokenId][version];
        
        // Check if already deleted
        if (context.isDeleted) {
            revert ContextAlreadyDeleted();
        }
        
        uint256 dataSize = context.encryptedData.length;
        
        // Update storage usage
        if (dataSize > 0) {
            storageUsed[tokenId] -= dataSize;
        }
        
        // Mark as deleted instead of deleting the struct
        context.isDeleted = true;
        delete context.encryptedData; // Free storage space
        
        emit ContextDeleted(tokenId, version);
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