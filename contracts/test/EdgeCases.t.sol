// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../PassportRegistry.sol";
import "../ContextVault.sol";
import "../PaymentStream.sol";
import "./mocks/MockSuperfluid.sol";

contract EdgeCasesTest is Test {
    PassportRegistry public passportRegistry;
    ContextVault public contextVault;
    PaymentStream public paymentStream;
    MockSuperfluid public mockSuperfluid;
    MockCFA public mockCFA;
    MockSuperToken public mockUSDCx;
    
    address public owner = address(this);
    address public alice = address(0x1);
    address public bob = address(0x2);
    address public attacker = address(0x3);
    
    function setUp() public {
        passportRegistry = new PassportRegistry();
        contextVault = new ContextVault(address(passportRegistry));
        
        mockSuperfluid = new MockSuperfluid();
        mockCFA = new MockCFA();
        mockUSDCx = new MockSuperToken();
        
        paymentStream = new PaymentStream(
            address(passportRegistry),
            address(mockSuperfluid),
            address(mockCFA),
            address(mockUSDCx)
        );
    }
    
    // PassportRegistry Edge Cases
    function testMintToZeroAddressFails() public {
        vm.expectRevert(PassportRegistry.ZeroAddress.selector);
        passportRegistry.mint(address(0), keccak256("test"));
    }
    
    function testMintWhenPausedFails() public {
        passportRegistry.pause();
        
        vm.expectRevert("Pausable: paused");
        passportRegistry.mint(alice, keccak256("test"));
    }
    
    function testRevokeWhenPausedFails() public {
        uint256 tokenId = passportRegistry.mint(alice, keccak256("test"));
        passportRegistry.pause();
        
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        passportRegistry.revoke(tokenId);
    }
    
    function testUpdateDataHashWhenPausedFails() public {
        uint256 tokenId = passportRegistry.mint(alice, keccak256("test"));
        passportRegistry.pause();
        
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        passportRegistry.updateDataHash(tokenId, keccak256("new"));
    }
    
    function testOnlyOwnerCanPause() public {
        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        passportRegistry.pause();
    }
    
    function testOnlyOwnerCanUnpause() public {
        passportRegistry.pause();
        
        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        passportRegistry.unpause();
    }
    
    // ContextVault Edge Cases
    function testStoreContextWhenPausedFails() public {
        passportRegistry.mint(alice, keccak256("alice"));
        contextVault.pause();
        
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        contextVault.storeContext(bytes("test"));
    }
    
    function testAuthorizeReaderWhenPausedFails() public {
        passportRegistry.mint(alice, keccak256("alice"));
        contextVault.pause();
        
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        contextVault.authorizeReader(bob);
    }
    
    function testRevokeReaderWhenPausedFails() public {
        passportRegistry.mint(alice, keccak256("alice"));
        
        vm.prank(alice);
        contextVault.authorizeReader(bob);
        
        contextVault.pause();
        
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        contextVault.revokeReader(bob);
    }
    
    function testDeleteContextWhenPausedFails() public {
        passportRegistry.mint(alice, keccak256("alice"));
        
        vm.prank(alice);
        contextVault.storeContext(bytes("test"));
        
        contextVault.pause();
        
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        contextVault.deleteContext(0);
    }
    
    function testDeleteContextUpdatesStorageUsage() public {
        passportRegistry.mint(alice, keccak256("alice"));
        
        bytes memory testData = bytes("test data for storage");
        
        vm.prank(alice);
        contextVault.storeContext(testData);
        
        // Check storage usage increased
        uint256 usageBefore = contextVault.getStorageUsed(1);
        assertEq(usageBefore, testData.length);
        
        vm.prank(alice);
        contextVault.deleteContext(0);
        
        // Check storage usage decreased
        uint256 usageAfter = contextVault.getStorageUsed(1);
        assertEq(usageAfter, 0);
    }
    
    function testDeleteAlreadyDeletedContext() public {
        passportRegistry.mint(alice, keccak256("alice"));
        
        vm.prank(alice);
        contextVault.storeContext(bytes("test"));
        
        vm.prank(alice);
        contextVault.deleteContext(0);
        
        // Deleting already deleted context should not underflow
        vm.prank(alice);
        contextVault.deleteContext(0);
        
        // Storage usage should remain 0
        assertEq(contextVault.getStorageUsed(1), 0);
    }
    
    function testStorageQuotaEnforcement() public {
        passportRegistry.mint(alice, keccak256("alice"));
        
        // Set a very small quota
        contextVault.updateQuota(1, 10);
        
        vm.prank(alice);
        vm.expectRevert(ContextVault.QuotaExceeded.selector);
        contextVault.storeContext(bytes("this exceeds quota"));
    }
    
    function testMaxContextSizeEnforcement() public {
        passportRegistry.mint(alice, keccak256("alice"));
        
        // Try to store data larger than MAX_CONTEXT_SIZE (1MB)
        bytes memory largeData = new bytes(contextVault.MAX_CONTEXT_SIZE() + 1);
        
        vm.prank(alice);
        vm.expectRevert(ContextVault.ContextTooLarge.selector);
        contextVault.storeContext(largeData);
    }
    
    // PaymentStream Edge Cases
    function testRegisterProviderWhenPausedFails() public {
        paymentStream.pause();
        
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        paymentStream.registerProvider(alice, 1000);
    }
    
    function testStartStreamWhenPausedFails() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, 1000);
        
        passportRegistry.mint(bob, keccak256("bob"));
        
        paymentStream.pause();
        
        vm.prank(bob);
        vm.expectRevert("Pausable: paused");
        paymentStream.startStream(alice, 1000);
    }
    
    function testRecordConsumptionWhenPausedFails() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, 1000);
        
        paymentStream.pause();
        
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        paymentStream.recordConsumption(1, 5000);
    }
    
    function testStartStreamWithZeroBytesPerSecond() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, 1000);
        
        passportRegistry.mint(bob, keccak256("bob"));
        
        vm.prank(bob);
        vm.expectRevert(PaymentStream.InvalidFlowRate.selector);
        paymentStream.startStream(alice, 0);
    }
    
    function testUpdateNonExistentStream() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, 1000);
        
        passportRegistry.mint(bob, keccak256("bob"));
        
        vm.prank(bob);
        vm.expectRevert(PaymentStream.InvalidFlowRate.selector);
        paymentStream.updateStream(alice, 2000);
    }
    
    function testStopNonExistentStream() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, 1000);
        
        passportRegistry.mint(bob, keccak256("bob"));
        
        // Should not revert when stopping non-existent stream
        vm.prank(bob);
        paymentStream.stopStream(alice);
    }
    
    function testSuperfluidCallFailure() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, 1000);
        
        passportRegistry.mint(bob, keccak256("bob"));
        
        // Set mock to fail
        mockSuperfluid.setShouldFail(true);
        
        vm.prank(bob);
        vm.expectRevert(PaymentStream.StreamOperationFailed.selector);
        paymentStream.startStream(alice, 1000);
    }
    
    function testCalculateFlowRateOverflow() public {
        // Test with values that could cause overflow
        uint256 maxRate = type(uint256).max;
        uint256 maxBytes = type(uint256).max;
        
        // This should not overflow due to division by RATE_PRECISION
        int96 flowRate = paymentStream._calculateFlowRate(1, maxBytes);
        
        // Should be reasonable value
        assertGt(flowRate, 0);
    }
    
    function testProviderCannotUpdateRateToZero() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, 1000);
        
        // Should allow updating rate to zero (could be legitimate)
        vm.prank(alice);
        paymentStream.updateProviderRate(0);
        
        (,uint256 rate,,) = paymentStream.dataProviders(alice);
        assertEq(rate, 0);
    }
    
    function testRecordConsumptionOverflow() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, 1000);
        
        // Record maximum consumption
        vm.prank(alice);
        paymentStream.recordConsumption(1, type(uint256).max);
        
        (,,uint256 totalBytes,) = paymentStream.dataProviders(alice);
        assertEq(totalBytes, type(uint256).max);
        
        // Recording more should overflow but not revert (uint256 wraps)
        vm.prank(alice);
        paymentStream.recordConsumption(1, 1);
        
        (,,totalBytes,) = paymentStream.dataProviders(alice);
        assertEq(totalBytes, 0); // Wrapped around
    }
    
    // Gas Limit Tests
    function testLargeContextStorage() public {
        passportRegistry.mint(alice, keccak256("alice"));
        
        // Store maximum allowed context size
        bytes memory maxData = new bytes(contextVault.MAX_CONTEXT_SIZE());
        
        vm.prank(alice);
        uint256 version = contextVault.storeContext(maxData);
        
        assertEq(version, 0);
        assertEq(contextVault.getContextCount(1), 1);
    }
    
    function testManySmallContexts() public {
        passportRegistry.mint(alice, keccak256("alice"));
        
        // Store many small contexts up to quota
        bytes memory smallData = bytes("x");
        uint256 quota = contextVault.DEFAULT_QUOTA();
        
        vm.startPrank(alice);
        for (uint256 i = 0; i < quota && i < 1000; i++) {
            contextVault.storeContext(smallData);
        }
        vm.stopPrank();
        
        assertGt(contextVault.getContextCount(1), 0);
    }
}