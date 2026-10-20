// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PassportRegistry } from "../PassportRegistry.sol";

contract PassportRegistryTest is Test {
    PassportRegistry public registry;
    address public owner = address(this);
    address public alice = address(0x1);
    address public bob = address(0x2);
    address public minter = address(0x3);

    bytes32 public constant TEST_DATA_HASH = keccak256("test data");

    event PassportMinted(address indexed to, uint256 indexed tokenId);
    event PassportRevoked(uint256 indexed tokenId, address indexed previousOwner);
    event DataHashUpdated(uint256 indexed tokenId, bytes32 indexed dataHash);
    event MinterAuthorized(address indexed minter);
    event MinterRevoked(address indexed minter);

    function setUp() public {
        registry = new PassportRegistry();
    }

    function testConstructor() public view {
        assertEq(registry.name(), "OpenContext Passport");
        assertEq(registry.symbol(), "OCP");
        assertEq(registry.owner(), owner);
    }

    function testAuthorizeMinter() public {
        vm.expectEmit(true, false, false, true);
        emit MinterAuthorized(minter);

        registry.authorizeMinter(minter);
        assertTrue(registry.authorizedMinters(minter));
    }

    function testRevokeMinter() public {
        registry.authorizeMinter(minter);

        vm.expectEmit(true, false, false, true);
        emit MinterRevoked(minter);

        registry.revokeMinter(minter);
        assertFalse(registry.authorizedMinters(minter));
    }

    function testMintByOwner() public {
        vm.expectEmit(true, true, false, true);
        emit PassportMinted(alice, 1);
        vm.expectEmit(true, true, false, true);
        emit DataHashUpdated(1, TEST_DATA_HASH);

        uint256 tokenId = registry.mint(alice, TEST_DATA_HASH);

        assertEq(tokenId, 1);
        assertEq(registry.ownerOf(1), alice);
        assertEq(registry.addressToTokenId(alice), 1);
        assertEq(registry.tokenIdToDataHash(1), TEST_DATA_HASH);
        assertTrue(registry.hasPassport(alice));
    }

    function testMintByAuthorizedMinter() public {
        registry.authorizeMinter(minter);

        vm.prank(minter);
        uint256 tokenId = registry.mint(alice, TEST_DATA_HASH);

        assertEq(tokenId, 1);
        assertEq(registry.ownerOf(1), alice);
    }

    function testMintFailsUnauthorized() public {
        vm.prank(alice);
        vm.expectRevert(PassportRegistry.NotAuthorized.selector);
        registry.mint(bob, TEST_DATA_HASH);
    }

    function testMintFailsAlreadyMinted() public {
        registry.mint(alice, TEST_DATA_HASH);

        vm.expectRevert(PassportRegistry.AlreadyMinted.selector);
        registry.mint(alice, TEST_DATA_HASH);
    }

    function testRevokeByOwner() public {
        uint256 tokenId = registry.mint(alice, TEST_DATA_HASH);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit PassportRevoked(tokenId, alice);

        registry.revoke(tokenId);

        vm.expectRevert("ERC721: invalid token ID");
        registry.ownerOf(tokenId);

        assertEq(registry.addressToTokenId(alice), 0);
        assertEq(registry.tokenIdToDataHash(tokenId), bytes32(0));
        assertFalse(registry.hasPassport(alice));
    }

    function testRevokeByContractOwner() public {
        uint256 tokenId = registry.mint(alice, TEST_DATA_HASH);

        vm.expectEmit(true, true, false, true);
        emit PassportRevoked(tokenId, alice);

        registry.revoke(tokenId);

        vm.expectRevert("ERC721: invalid token ID");
        registry.ownerOf(tokenId);
    }

    function testRevokeFailsUnauthorized() public {
        uint256 tokenId = registry.mint(alice, TEST_DATA_HASH);

        vm.prank(bob);
        vm.expectRevert(PassportRegistry.NotAuthorized.selector);
        registry.revoke(tokenId);
    }

    function testRevokeFailsNonExistent() public {
        vm.expectRevert(PassportRegistry.TokenDoesNotExist.selector);
        registry.revoke(999);
    }

    function testUpdateDataHash() public {
        uint256 tokenId = registry.mint(alice, TEST_DATA_HASH);
        bytes32 newHash = keccak256("new data");

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit DataHashUpdated(tokenId, newHash);

        registry.updateDataHash(tokenId, newHash);

        assertEq(registry.tokenIdToDataHash(tokenId), newHash);
    }

    function testUpdateDataHashFailsUnauthorized() public {
        uint256 tokenId = registry.mint(alice, TEST_DATA_HASH);
        bytes32 newHash = keccak256("new data");

        vm.prank(bob);
        vm.expectRevert(PassportRegistry.NotAuthorized.selector);
        registry.updateDataHash(tokenId, newHash);
    }

    function testUpdateDataHashFailsNonExistent() public {
        bytes32 newHash = keccak256("new data");

        vm.expectRevert(PassportRegistry.TokenDoesNotExist.selector);
        registry.updateDataHash(999, newHash);
    }

    function testGetTokenId() public {
        assertEq(registry.getTokenId(alice), 0);

        registry.mint(alice, TEST_DATA_HASH);
        assertEq(registry.getTokenId(alice), 1);
    }

    function testTransfersDisabled() public {
        uint256 tokenId = registry.mint(alice, TEST_DATA_HASH);

        vm.prank(alice);
        vm.expectRevert(PassportRegistry.TransfersDisabled.selector);
        registry.transferFrom(alice, bob, tokenId);

        vm.prank(alice);
        vm.expectRevert(PassportRegistry.TransfersDisabled.selector);
        registry.safeTransferFrom(alice, bob, tokenId);

        vm.prank(alice);
        vm.expectRevert(PassportRegistry.TransfersDisabled.selector);
        registry.safeTransferFrom(alice, bob, tokenId, "");
    }

    function testMultipleMints() public {
        registry.mint(alice, keccak256("alice"));
        registry.mint(bob, keccak256("bob"));

        assertEq(registry.getTokenId(alice), 1);
        assertEq(registry.getTokenId(bob), 2);
        assertTrue(registry.hasPassport(alice));
        assertTrue(registry.hasPassport(bob));
    }

    function testMintRevokeRemint() public {
        uint256 tokenId1 = registry.mint(alice, TEST_DATA_HASH);
        registry.revoke(tokenId1);

        uint256 tokenId2 = registry.mint(alice, TEST_DATA_HASH);
        assertEq(tokenId2, 2);
        assertEq(registry.getTokenId(alice), 2);
    }
}
