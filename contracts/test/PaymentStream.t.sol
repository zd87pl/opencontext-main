// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../PaymentStream.sol";
import "../PassportRegistry.sol";
import "./mocks/MockSuperfluid.sol";

contract PaymentStreamTest is Test {
    PaymentStream public payments;
    PassportRegistry public registry;
    MockSuperfluid public superfluid;
    MockCFA public cfa;
    MockSuperToken public usdcx;
    
    address public owner = address(this);
    address public alice = address(0x1);
    address public bob = address(0x2);
    address public provider = address(0x3);
    address public providerReceiver = address(0x4);
    
    uint256 public constant RATE_PER_BYTE = 1e15; // 0.001 USDC per byte
    
    event ProviderRegistered(address indexed provider, address receiver, uint256 ratePerByte);
    event ProviderUpdated(address indexed provider, uint256 newRate);
    event StreamStarted(uint256 indexed tokenId, address indexed provider, int96 flowRate);
    event StreamUpdated(uint256 indexed tokenId, address indexed provider, int96 newFlowRate);
    event StreamStopped(uint256 indexed tokenId, address indexed provider);
    event BytesConsumed(uint256 indexed tokenId, address indexed provider, uint256 bytes);
    
    function setUp() public {
        registry = new PassportRegistry();
        superfluid = new MockSuperfluid();
        cfa = new MockCFA();
        usdcx = new MockSuperToken();
        
        payments = new PaymentStream(
            address(registry),
            address(superfluid),
            address(cfa),
            address(usdcx)
        );
        
        registry.mint(alice, keccak256("alice"));
        registry.mint(bob, keccak256("bob"));
    }
    
    function testConstructor() public {
        assertEq(address(payments.passportRegistry()), address(registry));
        assertEq(address(payments.superfluid()), address(superfluid));
        assertEq(address(payments.cfa()), address(cfa));
        assertEq(address(payments.usdcx()), address(usdcx));
    }
    
    function testRegisterProvider() public {
        vm.prank(provider);
        vm.expectEmit(true, false, false, true);
        emit ProviderRegistered(provider, providerReceiver, RATE_PER_BYTE);
        
        payments.registerProvider(providerReceiver, RATE_PER_BYTE);
        
        (address receiver, uint256 rate, uint256 totalBytes, bool active) = payments.dataProviders(provider);
        assertEq(receiver, providerReceiver);
        assertEq(rate, RATE_PER_BYTE);
        assertEq(totalBytes, 0);
        assertTrue(active);
    }
    
    function testRegisterProviderFailsZeroAddress() public {
        vm.prank(provider);
        vm.expectRevert(PaymentStream.InvalidProvider.selector);
        payments.registerProvider(address(0), RATE_PER_BYTE);
    }
    
    function testUpdateProviderRate() public {
        vm.prank(provider);
        payments.registerProvider(providerReceiver, RATE_PER_BYTE);
        
        uint256 newRate = RATE_PER_BYTE * 2;
        vm.prank(provider);
        vm.expectEmit(true, false, false, true);
        emit ProviderUpdated(provider, newRate);
        
        payments.updateProviderRate(newRate);
        
        (,uint256 rate,,) = payments.dataProviders(provider);
        assertEq(rate, newRate);
    }
    
    function testUpdateProviderRateFailsNotActive() public {
        vm.prank(provider);
        vm.expectRevert(PaymentStream.ProviderNotActive.selector);
        payments.updateProviderRate(RATE_PER_BYTE * 2);
    }
    
    function testStartStream() public {
        vm.prank(provider);
        payments.registerProvider(providerReceiver, RATE_PER_BYTE);
        
        uint256 bytesPerSecond = 1000;
        
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit StreamStarted(1, provider, int96(1));
        
        payments.startStream(provider, bytesPerSecond);
        
        (int96 flowRate,) = payments.getStreamInfo(1, provider);
        assertGt(flowRate, 0);
    }
    
    function testStartStreamFailsNoPassport() public {
        vm.prank(provider);
        payments.registerProvider(providerReceiver, RATE_PER_BYTE);
        
        vm.prank(address(0x999));
        vm.expectRevert(PaymentStream.NotPassportHolder.selector);
        payments.startStream(provider, 1000);
    }
    
    function testStartStreamFailsProviderNotActive() public {
        vm.prank(alice);
        vm.expectRevert(PaymentStream.ProviderNotActive.selector);
        payments.startStream(provider, 1000);
    }
    
    function testUpdateStream() public {
        vm.prank(provider);
        payments.registerProvider(providerReceiver, RATE_PER_BYTE);
        
        vm.prank(alice);
        payments.startStream(provider, 1000);
        
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit StreamUpdated(1, provider, int96(2));
        
        payments.updateStream(provider, 2000);
        
        (int96 flowRate,) = payments.getStreamInfo(1, provider);
        assertGt(flowRate, int96(1));
    }
    
    function testStopStream() public {
        vm.prank(provider);
        payments.registerProvider(providerReceiver, RATE_PER_BYTE);
        
        vm.prank(alice);
        payments.startStream(provider, 1000);
        
        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit StreamStopped(1, provider);
        
        payments.stopStream(provider);
        
        (int96 flowRate,) = payments.getStreamInfo(1, provider);
        assertEq(flowRate, 0);
    }
    
    function testRecordConsumption() public {
        vm.prank(provider);
        payments.registerProvider(providerReceiver, RATE_PER_BYTE);
        
        uint256 bytesConsumed = 5000;
        
        vm.prank(provider);
        vm.expectEmit(true, true, false, true);
        emit BytesConsumed(1, provider, bytesConsumed);
        
        payments.recordConsumption(1, bytesConsumed);
        
        (,, uint256 totalBytes,) = payments.dataProviders(provider);
        assertEq(totalBytes, bytesConsumed);
    }
    
    function testRecordConsumptionFailsNotActive() public {
        vm.prank(provider);
        vm.expectRevert(PaymentStream.ProviderNotActive.selector);
        payments.recordConsumption(1, 5000);
    }
    
    function testStreamOperationFailure() public {
        vm.prank(provider);
        payments.registerProvider(providerReceiver, RATE_PER_BYTE);
        
        superfluid.setShouldFail(true);
        
        vm.prank(alice);
        vm.expectRevert(PaymentStream.StreamOperationFailed.selector);
        payments.startStream(provider, 1000);
    }
    
    function testComplexScenario() public {
        vm.prank(provider);
        payments.registerProvider(providerReceiver, RATE_PER_BYTE);
        
        address provider2 = address(0x5);
        address provider2Receiver = address(0x6);
        vm.prank(provider2);
        payments.registerProvider(provider2Receiver, RATE_PER_BYTE * 2);
        
        vm.startPrank(alice);
        payments.startStream(provider, 1000);
        payments.startStream(provider2, 500);
        vm.stopPrank();
        
        (int96 flow1,) = payments.getStreamInfo(1, provider);
        (int96 flow2,) = payments.getStreamInfo(1, provider2);
        assertGt(flow1, 0);
        assertGt(flow2, 0);
        
        vm.prank(provider);
        payments.recordConsumption(1, 10000);
        
        vm.prank(provider2);
        payments.recordConsumption(1, 5000);
        
        (,, uint256 totalBytes1,) = payments.dataProviders(provider);
        (,, uint256 totalBytes2,) = payments.dataProviders(provider2);
        assertEq(totalBytes1, 10000);
        assertEq(totalBytes2, 5000);
        
        vm.prank(alice);
        payments.stopStream(provider);
        
        (flow1,) = payments.getStreamInfo(1, provider);
        assertEq(flow1, 0);
    }
}