// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title PassportRegistry
 * @notice ERC-721 based soulbound token (SBT) for user identity
 * @dev Non-transferable NFT that represents a user's identity in the OpenContext Network
 */
contract PassportRegistry is ERC721, Ownable, Pausable {
    using Counters for Counters.Counter;
    
    Counters.Counter private _tokenIdCounter;
    
    mapping(address => uint256) public addressToTokenId;
    mapping(uint256 => bytes32) public tokenIdToDataHash;
    mapping(address => bool) public authorizedMinters;
    
    event PassportMinted(address indexed to, uint256 indexed tokenId);
    event PassportRevoked(uint256 indexed tokenId, address indexed previousOwner);
    event DataHashUpdated(uint256 indexed tokenId, bytes32 indexed dataHash);
    event MinterAuthorized(address indexed minter);
    event MinterRevoked(address indexed minter);
    
    error AlreadyMinted();
    error NotAuthorized();
    error TokenDoesNotExist();
    error TransfersDisabled();
    error ZeroAddress();
    
    modifier onlyAuthorizedMinter() {
        if (!authorizedMinters[msg.sender] && msg.sender != owner()) {
            revert NotAuthorized();
        }
        _;
    }
    
    constructor() ERC721("OpenContext Passport", "OCP") {}
    
    /// @notice Authorize an address to mint passports
    /// @param minter Address to authorize
    function authorizeMinter(address minter) external onlyOwner {
        authorizedMinters[minter] = true;
        emit MinterAuthorized(minter);
    }
    
    /// @notice Revoke minting authorization
    /// @param minter Address to revoke authorization from
    function revokeMinter(address minter) external onlyOwner {
        authorizedMinters[minter] = false;
        emit MinterRevoked(minter);
    }
    
    /// @notice Mint a new passport to an address
    /// @param to Address receiving the SBT
    /// @param dataHash Initial data hash for the passport
    function mint(address to, bytes32 dataHash) external onlyAuthorizedMinter whenNotPaused returns (uint256) {
        if (to == address(0)) {
            revert ZeroAddress();
        }
        if (addressToTokenId[to] != 0) {
            revert AlreadyMinted();
        }
        
        _tokenIdCounter.increment();
        uint256 tokenId = _tokenIdCounter.current();
        
        _safeMint(to, tokenId);
        addressToTokenId[to] = tokenId;
        tokenIdToDataHash[tokenId] = dataHash;
        
        emit PassportMinted(to, tokenId);
        emit DataHashUpdated(tokenId, dataHash);
        
        return tokenId;
    }
    
    /// @notice Revoke (burn) a passport
    /// @param tokenId Token ID to revoke
    function revoke(uint256 tokenId) external whenNotPaused {
        if (!_exists(tokenId)) {
            revert TokenDoesNotExist();
        }
        
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && msg.sender != owner()) {
            revert NotAuthorized();
        }
        
        delete addressToTokenId[owner];
        delete tokenIdToDataHash[tokenId];
        _burn(tokenId);
        
        emit PassportRevoked(tokenId, owner);
    }
    
    /// @notice Update the data hash for a passport
    /// @param tokenId Token ID to update
    /// @param newDataHash New data hash
    function updateDataHash(uint256 tokenId, bytes32 newDataHash) external whenNotPaused {
        if (!_exists(tokenId)) {
            revert TokenDoesNotExist();
        }
        
        address owner = ownerOf(tokenId);
        if (msg.sender != owner) {
            revert NotAuthorized();
        }
        
        tokenIdToDataHash[tokenId] = newDataHash;
        emit DataHashUpdated(tokenId, newDataHash);
    }
    
    /// @notice Get passport token ID for an address
    /// @param owner Address to query
    /// @return Token ID (0 if no passport)
    function getTokenId(address owner) external view returns (uint256) {
        return addressToTokenId[owner];
    }
    
    /// @notice Check if an address has a passport
    /// @param owner Address to check
    /// @return True if the address has a passport
    function hasPassport(address owner) external view returns (bool) {
        return addressToTokenId[owner] != 0;
    }
    
    /// @notice Pause contract (emergency stop)
    function pause() external onlyOwner {
        _pause();
    }
    
    /// @notice Unpause contract
    function unpause() external onlyOwner {
        _unpause();
    }
    
    /// @dev Override to disable transfers (soulbound)
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 tokenId,
        uint256 batchSize
    ) internal override {
        if (from != address(0) && to != address(0)) {
            revert TransfersDisabled();
        }
        super._beforeTokenTransfer(from, to, tokenId, batchSize);
    }
    
    /// @dev Override transferFrom to prevent transfers
    function transferFrom(address, address, uint256) public pure override {
        revert TransfersDisabled();
    }
    
    /// @dev Override safeTransferFrom to prevent transfers
    function safeTransferFrom(address, address, uint256) public pure override {
        revert TransfersDisabled();
    }
    
    /// @dev Override safeTransferFrom to prevent transfers
    function safeTransferFrom(address, address, uint256, bytes memory) public pure override {
        revert TransfersDisabled();
    }
}
