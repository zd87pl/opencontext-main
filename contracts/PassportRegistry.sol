// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/**
 * @title Passport Registry
 * @notice ERC-721 based soulbound token (SBT)
 */
contract PassportRegistry is ERC721 {
    constructor() ERC721("Passport", "PPT") {}

    /// @notice Mint a new passport.
    /// @dev Functionality not implemented.
    /// @param to Address receiving the SBT
    /// @param tokenId Token ID to mint
    function mint(address to, uint256 tokenId) external {
        // intentionally left blank
    }

    /// @notice Revoke (burn) a passport.
    /// @dev Functionality not implemented.
    /// @param tokenId Token ID to revoke
    function revoke(uint256 tokenId) external {
        // intentionally left blank
    }

    /// @dev Disable transfers to make the token soulbound.
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 tokenId,
        uint256 batchSize
    ) internal override {
        require(from == address(0) || to == address(0), "SBT: transfers disabled");
        super._beforeTokenTransfer(from, to, tokenId, batchSize);
    }
}
