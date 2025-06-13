// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import "openzeppelin-contracts/contracts/access/Ownable.sol";
import "openzeppelin-contracts/contracts/utils/cryptography/SignatureChecker.sol";
import "openzeppelin-contracts/contracts/utils/math/SafeCast.sol";

/// @title Soul-bound Passport
/// @notice Minimal ERC721 soul-bound token for proof-of-personhood.
contract Passport is ERC721, Ownable {
    using SafeCast for uint256;

    // Token revocation status indexed by 64-bit token ID
    mapping(uint64 => bool) private revoked;

    constructor() ERC721("OpenContext Passport", "PASS") {}

    /// @notice Mint a new passport after verifying the user's signature.
    /// @param to The owner address of the soul-bound token.
    /// @param tokenId ID to mint.
    /// @param hash Signed payload hash.
    /// @param signature User signature (EOA or ERC4337 wallet).
    function mint(
        address to,
        uint256 tokenId,
        bytes32 hash,
        bytes calldata signature
    ) external onlyOwner {
        require(!_exists(tokenId), "ALREADY_MINTED");
        require(verifySignature(to, hash, signature), "BAD_SIGNATURE");
        _mint(to, tokenId);
    }

    /// @notice Revoke (burn) an existing passport.
    /// @param tokenId Token to revoke.
    function revoke(uint256 tokenId) external {
        require(_isApprovedOrOwner(msg.sender, tokenId), "NOT_AUTH");
        revoked[tokenId.toUint64()] = true;
        _burn(tokenId);
    }

    /// @notice Check if a passport has been revoked.
    /// @param tokenId Token ID to query.
    function isRevoked(uint256 tokenId) external view returns (bool) {
        return revoked[tokenId.toUint64()];
    }

    /// @notice Verify a signature from either an EOA or ERC-4337 wallet.
    function verifySignature(
        address signer,
        bytes32 hash,
        bytes memory signature
    ) public view returns (bool) {
        return SignatureChecker.isValidSignatureNow(signer, hash, signature);
    }

    // --- Soul-bound ---
    function _transfer(address, address, uint256) internal pure override {
        revert("SOUL_BOUND");
    }
}

