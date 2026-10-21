// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ContextVaultIPFS } from "../ContextVaultIPFS.sol";
import { PassportRegistry } from "../PassportRegistry.sol";

contract ContextVaultIPFSTest is Test {
    ContextVaultIPFS public vault;
    PassportRegistry public registry;

    address public owner = address(this);
    address public alice = address(0x1);
    address public bob = address(0x2);
    address public charlie = address(0x3);

    string public constant CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    string public constant CID_B = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
    uint256 public constant SIZE_A = 4096;
    uint256 public constant SIZE_B = 1024;

    event ContextStored(uint256 indexed tokenId, uint256 version, string ipfsHash, uint256 dataSize);
    event ContextDeleted(uint256 indexed tokenId, uint256 version, string ipfsHash);
    event ReaderAuthorized(uint256 indexed tokenId, address indexed reader);
    event ReaderRevoked(uint256 indexed tokenId, address indexed reader);
    event QuotaUpdated(uint256 indexed tokenId, uint256 newQuota);
    event IPFSHashPinned(string indexed ipfsHash, uint256 refCount);
    event IPFSHashUnpinned(string indexed ipfsHash);

    function setUp() public {
        registry = new PassportRegistry();
        vault = new ContextVaultIPFS(address(registry));

        registry.mint(alice, keccak256("alice"));
        registry.mint(bob, keccak256("bob"));
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    function testConstructor() public view {
        assertEq(address(vault.passportRegistry()), address(registry));
        assertEq(vault.DEFAULT_QUOTA(), 100 * 1024 * 1024);
        assertEq(vault.MAX_CONTEXT_SIZE(), 10 * 1024 * 1024);
        assertEq(vault.IPFS_HASH_GC_DELAY(), 7 days);
        assertEq(vault.getStorageQuota(1), vault.DEFAULT_QUOTA());
        assertEq(vault.getStorageUsed(1), 0);
    }

    // ---------------------------------------------------------------------
    // storeContextIPFS
    // ---------------------------------------------------------------------

    function testStoreContext() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit IPFSHashPinned(CID_A, 1);
        vm.expectEmit(true, false, false, true);
        emit ContextStored(1, 0, CID_A, SIZE_A);

        uint256 version = vault.storeContextIPFS(CID_A, SIZE_A, true);

        assertEq(version, 0);
        assertEq(vault.getContextCount(1), 1);
        assertEq(vault.getActiveContextCount(1), 1);
        assertEq(vault.getStorageUsed(1), SIZE_A);
        assertEq(vault.getIPFSHashRefCount(CID_A), 1);
        assertEq(vault.ipfsHashTimestamp(CID_A), block.timestamp);
        assertFalse(vault.canGarbageCollect(CID_A));
    }

    function testStoreMultipleContextsVersions() public {
        vm.startPrank(alice);
        uint256 v0 = vault.storeContextIPFS(CID_A, SIZE_A, true);
        uint256 v1 = vault.storeContextIPFS(CID_B, SIZE_B, false);
        uint256 v2 = vault.storeContextIPFS(CID_A, SIZE_A, true);
        vm.stopPrank();

        assertEq(v0, 0);
        assertEq(v1, 1);
        assertEq(v2, 2);
        assertEq(vault.getContextCount(1), 3);
        assertEq(vault.getStorageUsed(1), 2 * SIZE_A + SIZE_B);
        // The same CID stored twice is pinned once with a reference count of two.
        assertEq(vault.getIPFSHashRefCount(CID_A), 2);
        assertEq(vault.getIPFSHashRefCount(CID_B), 1);
    }

    function testStoreContextFailsNoPassport() public {
        vm.prank(charlie);
        vm.expectRevert(ContextVaultIPFS.NoPassport.selector);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
    }

    function testStoreContextFailsTooLarge() public {
        // Read the constant first: a prank applies to the very next external call, and an inline
        // `vault.MAX_CONTEXT_SIZE()` argument would consume it.
        uint256 tooLarge = vault.MAX_CONTEXT_SIZE() + 1;
        vm.prank(alice);
        vm.expectRevert(ContextVaultIPFS.ContextTooLarge.selector);
        vault.storeContextIPFS(CID_A, tooLarge, true);
    }

    function testStoreContextFailsEmptyHash() public {
        vm.prank(alice);
        vm.expectRevert(ContextVaultIPFS.InvalidIPFSHash.selector);
        vault.storeContextIPFS("", SIZE_A, true);
    }

    function testStoreContextFailsQuotaExceeded() public {
        vault.updateQuota(1, SIZE_A);

        vm.prank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);

        vm.prank(alice);
        vm.expectRevert(ContextVaultIPFS.QuotaExceeded.selector);
        vault.storeContextIPFS(CID_B, 1, true);
    }

    function testStoreContextWhenPausedFails() public {
        vault.pause();

        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        vault.storeContextIPFS(CID_A, SIZE_A, true);

        vault.unpause();

        vm.prank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        assertEq(vault.getContextCount(1), 1);
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    function testGetContextMetadata() public {
        vm.prank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);

        vm.prank(alice);
        (string memory ipfsHash, uint256 dataSize, uint256 timestamp, bool isEncrypted) = vault.getContextMetadata(1, 0);

        assertEq(ipfsHash, CID_A);
        assertEq(dataSize, SIZE_A);
        assertEq(timestamp, block.timestamp);
        assertTrue(isEncrypted);
    }

    function testGetContextMetadataFailsUnauthorized() public {
        vm.prank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);

        vm.prank(bob);
        vm.expectRevert(ContextVaultIPFS.NotAuthorizedReader.selector);
        vault.getContextMetadata(1, 0);
    }

    function testGetContextMetadataFailsInvalidVersion() public {
        vm.prank(alice);
        vm.expectRevert(ContextVaultIPFS.InvalidVersion.selector);
        vault.getContextMetadata(1, 0);
    }

    function testGetLatestContextMetadata() public {
        vm.startPrank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        vault.storeContextIPFS(CID_B, SIZE_B, false);

        (string memory ipfsHash, uint256 dataSize, uint256 timestamp, uint256 version, bool isEncrypted) =
            vault.getLatestContextMetadata(1);
        vm.stopPrank();

        assertEq(ipfsHash, CID_B);
        assertEq(dataSize, SIZE_B);
        assertEq(timestamp, block.timestamp);
        assertEq(version, 1);
        assertFalse(isEncrypted);
    }

    function testGetLatestContextMetadataSkipsDeleted() public {
        vm.startPrank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        vault.storeContextIPFS(CID_B, SIZE_B, false);
        vault.deleteContext(1);

        (string memory ipfsHash,,, uint256 version,) = vault.getLatestContextMetadata(1);
        vm.stopPrank();

        assertEq(ipfsHash, CID_A);
        assertEq(version, 0);
    }

    function testGetLatestContextMetadataEmpty() public {
        vm.prank(alice);
        (string memory ipfsHash, uint256 dataSize, uint256 timestamp, uint256 version, bool isEncrypted) =
            vault.getLatestContextMetadata(1);

        assertEq(ipfsHash, "");
        assertEq(dataSize, 0);
        assertEq(timestamp, 0);
        assertEq(version, 0);
        assertFalse(isEncrypted);
    }

    function testGetLatestContextMetadataAllDeleted() public {
        vm.startPrank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        vault.deleteContext(0);
        (string memory ipfsHash,,,,) = vault.getLatestContextMetadata(1);
        vm.stopPrank();

        assertEq(ipfsHash, "");
    }

    function testBatchGetContextMetadata() public {
        vm.startPrank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        vault.storeContextIPFS(CID_B, SIZE_B, false);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        vault.deleteContext(1);

        uint256[] memory versions = new uint256[](4);
        versions[0] = 0;
        versions[1] = 1; // deleted
        versions[2] = 2;
        versions[3] = 99; // out of range
        (string[] memory hashes, uint256[] memory sizes, uint256[] memory timestamps, bool[] memory encrypted) =
            vault.batchGetContextMetadata(1, versions);
        vm.stopPrank();

        assertEq(hashes.length, 4);
        assertEq(hashes[0], CID_A);
        assertEq(sizes[0], SIZE_A);
        assertEq(timestamps[0], block.timestamp);
        assertTrue(encrypted[0]);

        // Deleted and out-of-range entries come back zeroed rather than reverting the whole batch.
        assertEq(hashes[1], "");
        assertEq(sizes[1], 0);
        assertEq(timestamps[1], 0);
        assertFalse(encrypted[1]);

        assertEq(hashes[2], CID_A);
        assertEq(hashes[3], "");
        assertEq(sizes[3], 0);
    }

    function testBatchGetContextMetadataFailsUnauthorized() public {
        uint256[] memory versions = new uint256[](1);
        vm.prank(bob);
        vm.expectRevert(ContextVaultIPFS.NotAuthorizedReader.selector);
        vault.batchGetContextMetadata(1, versions);
    }

    // ---------------------------------------------------------------------
    // Readers
    // ---------------------------------------------------------------------

    function testAuthorizeAndRevokeReader() public {
        vm.prank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit ReaderAuthorized(1, bob);
        vault.authorizeReader(bob);
        assertTrue(vault.authorizedReaders(1, bob));

        vm.prank(bob);
        (string memory ipfsHash,,,) = vault.getContextMetadata(1, 0);
        assertEq(ipfsHash, CID_A);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit ReaderRevoked(1, bob);
        vault.revokeReader(bob);
        assertFalse(vault.authorizedReaders(1, bob));

        vm.prank(bob);
        vm.expectRevert(ContextVaultIPFS.NotAuthorizedReader.selector);
        vault.getContextMetadata(1, 0);
    }

    function testReaderFunctionsRequirePassport() public {
        vm.prank(charlie);
        vm.expectRevert(ContextVaultIPFS.NoPassport.selector);
        vault.authorizeReader(bob);

        vm.prank(charlie);
        vm.expectRevert(ContextVaultIPFS.NoPassport.selector);
        vault.revokeReader(bob);
    }

    function testReaderFunctionsWhenPausedFail() public {
        vault.pause();

        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        vault.authorizeReader(bob);

        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        vault.revokeReader(bob);
    }

    // ---------------------------------------------------------------------
    // deleteContext and garbage collection
    // ---------------------------------------------------------------------

    function testDeleteContext() public {
        vm.prank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit IPFSHashUnpinned(CID_A);
        vm.expectEmit(true, false, false, true);
        emit ContextDeleted(1, 0, CID_A);
        vault.deleteContext(0);

        assertEq(vault.getStorageUsed(1), 0);
        assertEq(vault.getContextCount(1), 1);
        assertEq(vault.getActiveContextCount(1), 0);
        assertEq(vault.getIPFSHashRefCount(CID_A), 0);

        vm.prank(alice);
        (string memory ipfsHash, uint256 dataSize, uint256 timestamp, bool isEncrypted) = vault.getContextMetadata(1, 0);
        assertEq(ipfsHash, "");
        assertEq(dataSize, 0);
        assertEq(timestamp, 0);
        assertFalse(isEncrypted);
    }

    function testDeleteContextFailsAlreadyDeleted() public {
        vm.startPrank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        vault.deleteContext(0);

        vm.expectRevert(ContextVaultIPFS.ContextAlreadyDeleted.selector);
        vault.deleteContext(0);
        vm.stopPrank();

        assertEq(vault.getStorageUsed(1), 0);
    }

    function testDeleteContextFailsInvalidVersion() public {
        vm.prank(alice);
        vm.expectRevert(ContextVaultIPFS.InvalidVersion.selector);
        vault.deleteContext(0);
    }

    function testDeleteContextFailsNoPassport() public {
        vm.prank(charlie);
        vm.expectRevert(ContextVaultIPFS.NoPassport.selector);
        vault.deleteContext(0);
    }

    function testDeleteContextWhenPausedFails() public {
        vm.prank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        vault.pause();

        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        vault.deleteContext(0);
    }

    function testSharedHashStaysPinnedUntilLastReferenceGoes() public {
        vm.prank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        vm.prank(bob);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        assertEq(vault.getIPFSHashRefCount(CID_A), 2);

        // Alice dropping her copy must not unpin bob's.
        vm.prank(alice);
        vault.deleteContext(0);
        assertEq(vault.getIPFSHashRefCount(CID_A), 1);
        assertFalse(vault.canGarbageCollect(CID_A));

        vm.prank(bob);
        vm.expectEmit(true, false, false, true);
        emit IPFSHashUnpinned(CID_A);
        vault.deleteContext(0);
        assertEq(vault.getIPFSHashRefCount(CID_A), 0);
    }

    function testGarbageCollectionGracePeriod() public {
        vm.startPrank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        vault.deleteContext(0);
        vm.stopPrank();

        uint256 deletedAt = block.timestamp;
        assertEq(vault.ipfsHashTimestamp(CID_A), deletedAt + vault.IPFS_HASH_GC_DELAY());

        assertFalse(vault.canGarbageCollect(CID_A));
        vm.warp(deletedAt + vault.IPFS_HASH_GC_DELAY() - 1);
        assertFalse(vault.canGarbageCollect(CID_A));
        vm.warp(deletedAt + vault.IPFS_HASH_GC_DELAY());
        assertTrue(vault.canGarbageCollect(CID_A));
    }

    function testRestoringHashCancelsGarbageCollection() public {
        vm.startPrank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        vault.deleteContext(0);
        vm.warp(block.timestamp + vault.IPFS_HASH_GC_DELAY());
        assertTrue(vault.canGarbageCollect(CID_A));

        vm.expectEmit(true, false, false, true);
        emit IPFSHashPinned(CID_A, 1);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        vm.stopPrank();

        assertEq(vault.getIPFSHashRefCount(CID_A), 1);
        assertFalse(vault.canGarbageCollect(CID_A));
    }

    function testUnknownHashIsNotCollectable() public view {
        assertFalse(vault.canGarbageCollect("bafy-never-stored"));
        assertEq(vault.getIPFSHashRefCount("bafy-never-stored"), 0);
    }

    // ---------------------------------------------------------------------
    // Quota and admin
    // ---------------------------------------------------------------------

    function testUpdateQuota() public {
        vm.expectEmit(true, false, false, true);
        emit QuotaUpdated(1, 1024);
        vault.updateQuota(1, 1024);

        assertEq(vault.storageQuota(1), 1024);
        assertEq(vault.getStorageQuota(1), 1024);
        // Other tokens keep the default.
        assertEq(vault.getStorageQuota(2), vault.DEFAULT_QUOTA());
    }

    function testUpdateQuotaFailsUnauthorized() public {
        vm.prank(alice);
        vm.expectRevert(ContextVaultIPFS.NotAuthorizedReader.selector);
        vault.updateQuota(1, 1024);
    }

    function testOnlyOwnerCanPause() public {
        vm.prank(alice);
        vm.expectRevert("Ownable: caller is not the owner");
        vault.pause();

        vault.pause();

        vm.prank(alice);
        vm.expectRevert("Ownable: caller is not the owner");
        vault.unpause();
    }

    function testContextCountsAreIsolatedPerToken() public {
        vm.prank(alice);
        vault.storeContextIPFS(CID_A, SIZE_A, true);
        vm.prank(bob);
        vault.storeContextIPFS(CID_B, SIZE_B, false);

        assertEq(vault.getContextCount(1), 1);
        assertEq(vault.getContextCount(2), 1);
        assertEq(vault.getStorageUsed(1), SIZE_A);
        assertEq(vault.getStorageUsed(2), SIZE_B);

        // A reader authorised by alice cannot read bob's entries.
        vm.prank(alice);
        vault.authorizeReader(charlie);
        vm.prank(charlie);
        vault.getContextMetadata(1, 0);
        vm.prank(charlie);
        vm.expectRevert(ContextVaultIPFS.NotAuthorizedReader.selector);
        vault.getContextMetadata(2, 0);
    }
}
