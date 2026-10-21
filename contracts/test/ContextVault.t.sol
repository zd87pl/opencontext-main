// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ContextVault } from "../ContextVault.sol";
import { PassportRegistry } from "../PassportRegistry.sol";

contract ContextVaultTest is Test {
    ContextVault public vault;
    PassportRegistry public registry;

    address public owner = address(this);
    address public alice = address(0x1);
    address public bob = address(0x2);
    address public charlie = address(0x3);

    // Deliberately not prefixed with `test`: forge would treat the public getter as a (trivially passing) test.
    bytes public sampleData = bytes("encrypted context data");
    bytes public largeData;

    event ContextStored(uint256 indexed tokenId, uint256 version, uint256 dataSize);
    event ContextDeleted(uint256 indexed tokenId, uint256 version);
    event ReaderAuthorized(uint256 indexed tokenId, address indexed reader);
    event ReaderRevoked(uint256 indexed tokenId, address indexed reader);
    event QuotaUpdated(uint256 indexed tokenId, uint256 newQuota);

    function setUp() public {
        registry = new PassportRegistry();
        vault = new ContextVault(address(registry));

        registry.mint(alice, keccak256("alice"));
        registry.mint(bob, keccak256("bob"));

        largeData = new bytes(2 * 1024 * 1024); // 2MB
    }

    function testConstructor() public view {
        assertEq(address(vault.passportRegistry()), address(registry));
        assertEq(vault.DEFAULT_QUOTA(), 10 * 1024 * 1024);
        assertEq(vault.MAX_CONTEXT_SIZE(), 1024 * 1024);
    }

    function testStoreContext() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit ContextStored(1, 0, sampleData.length);

        uint256 version = vault.storeContext(sampleData);

        assertEq(version, 0);
        assertEq(vault.getContextCount(1), 1);
    }

    function testStoreMultipleContexts() public {
        vm.startPrank(alice);

        uint256 version1 = vault.storeContext(bytes("context 1"));
        uint256 version2 = vault.storeContext(bytes("context 2"));
        uint256 version3 = vault.storeContext(bytes("context 3"));

        vm.stopPrank();

        assertEq(version1, 0);
        assertEq(version2, 1);
        assertEq(version3, 2);
        assertEq(vault.getContextCount(1), 3);
    }

    function testStoreContextFailsNoPassport() public {
        vm.prank(charlie);
        vm.expectRevert(ContextVault.NoPassport.selector);
        vault.storeContext(sampleData);
    }

    function testStoreContextFailsTooLarge() public {
        vm.prank(alice);
        vm.expectRevert(ContextVault.ContextTooLarge.selector);
        vault.storeContext(largeData);
    }

    function testStoreContextFailsQuotaExceeded() public {
        vault.updateQuota(1, 100); // Set small quota

        // Exactly at the quota is allowed...
        vm.prank(alice);
        vault.storeContext(new bytes(100));
        assertEq(vault.getStorageUsed(1), 100);

        // ...one more byte is not.
        vm.prank(alice);
        vm.expectRevert(ContextVault.QuotaExceeded.selector);
        vault.storeContext(new bytes(1));
    }

    function testGetContext() public {
        vm.prank(alice);
        vault.storeContext(sampleData);

        vm.prank(alice);
        (bytes memory data, uint256 timestamp) = vault.getContext(1, 0);

        assertEq(data, sampleData);
        assertEq(timestamp, block.timestamp);
    }

    function testGetContextFailsUnauthorized() public {
        vm.prank(alice);
        vault.storeContext(sampleData);

        vm.prank(bob);
        vm.expectRevert(ContextVault.NotAuthorizedReader.selector);
        vault.getContext(1, 0);
    }

    function testGetContextFailsInvalidVersion() public {
        vm.prank(alice);
        vault.storeContext(sampleData);

        vm.prank(alice);
        vm.expectRevert(ContextVault.InvalidVersion.selector);
        vault.getContext(1, 5);
    }

    function testGetLatestContext() public {
        vm.startPrank(alice);
        vault.storeContext(bytes("v1"));
        vault.storeContext(bytes("v2"));
        vault.storeContext(bytes("v3"));

        (bytes memory data, uint256 timestamp, uint256 version) = vault.getLatestContext(1);
        vm.stopPrank();

        assertEq(data, bytes("v3"));
        assertEq(version, 2);
        assertEq(timestamp, block.timestamp);
    }

    function testGetLatestContextEmpty() public {
        vm.prank(alice);
        (bytes memory data, uint256 timestamp, uint256 version) = vault.getLatestContext(1);

        assertEq(data, bytes(""));
        assertEq(timestamp, 0);
        assertEq(version, 0);
    }

    function testAuthorizeReader() public {
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit ReaderAuthorized(1, bob);

        vault.authorizeReader(bob);

        assertTrue(vault.authorizedReaders(1, bob));
    }

    function testAuthorizedReaderCanRead() public {
        vm.prank(alice);
        vault.storeContext(sampleData);

        vm.prank(alice);
        vault.authorizeReader(bob);

        vm.prank(bob);
        (bytes memory data,) = vault.getContext(1, 0);
        assertEq(data, sampleData);
    }

    function testRevokeReader() public {
        vm.prank(alice);
        vault.authorizeReader(bob);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit ReaderRevoked(1, bob);

        vault.revokeReader(bob);

        assertFalse(vault.authorizedReaders(1, bob));
    }

    function testDeleteContext() public {
        vm.prank(alice);
        vault.storeContext(sampleData);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit ContextDeleted(1, 0);

        vault.deleteContext(0);

        vm.prank(alice);
        (bytes memory data,) = vault.getContext(1, 0);
        assertEq(data, bytes(""));
    }

    function testDeleteContextFailsInvalidVersion() public {
        vm.prank(alice);
        vm.expectRevert(ContextVault.InvalidVersion.selector);
        vault.deleteContext(5);
    }

    function testUpdateQuota() public {
        vm.expectEmit(true, false, false, true);
        emit QuotaUpdated(1, 50 * 1024 * 1024);

        vault.updateQuota(1, 50 * 1024 * 1024);

        assertEq(vault.storageQuota(1), 50 * 1024 * 1024);
    }

    function testUpdateQuotaFailsUnauthorized() public {
        vm.prank(alice);
        vm.expectRevert(ContextVault.NotAuthorizedReader.selector);
        vault.updateQuota(1, 50 * 1024 * 1024);
    }

    function testComplexScenario() public {
        vm.startPrank(alice);

        vault.storeContext(bytes("initial data"));
        vault.authorizeReader(bob);
        vault.storeContext(bytes("second version"));
        vault.storeContext(bytes("third version"));

        vm.stopPrank();

        assertEq(vault.getContextCount(1), 3);

        vm.prank(bob);
        (bytes memory data,) = vault.getContext(1, 1);
        assertEq(data, bytes("second version"));

        vm.prank(alice);
        vault.deleteContext(1);

        vm.prank(bob);
        (data,) = vault.getContext(1, 1);
        assertEq(data, bytes(""));

        vm.prank(alice);
        vault.revokeReader(bob);

        vm.prank(bob);
        vm.expectRevert(ContextVault.NotAuthorizedReader.selector);
        vault.getContext(1, 2);
    }

    function testGetActiveContextCount() public {
        assertEq(vault.getActiveContextCount(1), 0);

        vm.startPrank(alice);
        vault.storeContext(bytes("v1"));
        vault.storeContext(bytes("v2"));
        vault.storeContext(bytes("v3"));
        assertEq(vault.getActiveContextCount(1), 3);

        vault.deleteContext(1);
        vm.stopPrank();

        assertEq(vault.getContextCount(1), 3);
        assertEq(vault.getActiveContextCount(1), 2);
    }

    function testGetLatestContextSkipsDeleted() public {
        vm.startPrank(alice);
        vault.storeContext(bytes("v1"));
        vault.storeContext(bytes("v2"));
        vault.storeContext(bytes("v3"));
        vault.deleteContext(2);

        (bytes memory data,, uint256 version) = vault.getLatestContext(1);
        assertEq(data, bytes("v2"));
        assertEq(version, 1);

        vault.deleteContext(1);
        vault.deleteContext(0);
        (data,, version) = vault.getLatestContext(1);
        vm.stopPrank();

        assertEq(data, bytes(""));
        assertEq(version, 0);
    }

    function testGetContextDeletedVersionReturnsEmpty() public {
        vm.startPrank(alice);
        vault.storeContext(sampleData);
        vault.deleteContext(0);
        (bytes memory data, uint256 timestamp) = vault.getContext(1, 0);
        vm.stopPrank();

        assertEq(data, bytes(""));
        assertEq(timestamp, 0);
    }

    function testGetStorageQuota() public {
        assertEq(vault.getStorageQuota(1), vault.DEFAULT_QUOTA());
        assertEq(vault.storageQuota(1), 0);

        vault.updateQuota(1, 4096);
        assertEq(vault.getStorageQuota(1), 4096);
        // Other tokens keep the default.
        assertEq(vault.getStorageQuota(2), vault.DEFAULT_QUOTA());
    }

    function testStorageUsedTracksStoresAndDeletes() public {
        vm.startPrank(alice);
        vault.storeContext(bytes("abc"));
        vault.storeContext(bytes("defgh"));
        assertEq(vault.getStorageUsed(1), 8);
        assertEq(vault.storageUsed(1), 8);

        vault.deleteContext(0);
        vm.stopPrank();
        assertEq(vault.getStorageUsed(1), 5);
    }

    function testWriteFunctionsRequirePassport() public {
        vm.startPrank(charlie);
        vm.expectRevert(ContextVault.NoPassport.selector);
        vault.authorizeReader(bob);

        vm.expectRevert(ContextVault.NoPassport.selector);
        vault.revokeReader(bob);

        vm.expectRevert(ContextVault.NoPassport.selector);
        vault.deleteContext(0);
        vm.stopPrank();
    }

    function testDeleteContextFailsAlreadyDeleted() public {
        vm.startPrank(alice);
        vault.storeContext(sampleData);
        vault.deleteContext(0);

        vm.expectRevert(ContextVault.ContextAlreadyDeleted.selector);
        vault.deleteContext(0);
        vm.stopPrank();
    }

    function testReadsAreIsolatedPerToken() public {
        vm.prank(alice);
        vault.storeContext(bytes("alice's"));
        vm.prank(bob);
        vault.storeContext(bytes("bob's"));

        vm.prank(alice);
        vault.authorizeReader(charlie);

        vm.prank(charlie);
        (bytes memory data,) = vault.getContext(1, 0);
        assertEq(data, bytes("alice's"));

        vm.prank(charlie);
        vm.expectRevert(ContextVault.NotAuthorizedReader.selector);
        vault.getContext(2, 0);

        vm.prank(charlie);
        vm.expectRevert(ContextVault.NotAuthorizedReader.selector);
        vault.getLatestContext(2);
    }

    function testOnlyOwnerCanPauseAndUnpause() public {
        vm.prank(alice);
        vm.expectRevert("Ownable: caller is not the owner");
        vault.pause();

        vault.pause();
        assertTrue(vault.paused());

        vm.prank(alice);
        vm.expectRevert("Ownable: caller is not the owner");
        vault.unpause();

        vault.unpause();
        assertFalse(vault.paused());

        vm.prank(alice);
        vault.storeContext(sampleData);
        assertEq(vault.getContextCount(1), 1);
    }
}
