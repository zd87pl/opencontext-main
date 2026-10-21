// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test, stdError } from "forge-std/Test.sol";
import {
    ISuperAgreement
} from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperAgreement.sol";
import {
    ISuperfluidToken
} from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperfluidToken.sol";
import {
    IConstantFlowAgreementV1
} from "@superfluid-finance/ethereum-contracts/contracts/interfaces/agreements/IConstantFlowAgreementV1.sol";
import {
    FlowOperatorDefinitions
} from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/Definitions.sol";
import { PaymentStream } from "../PaymentStream.sol";
import { PassportRegistry } from "../PassportRegistry.sol";
import { MockSuperfluid, MockCFA, MockSuperToken } from "./mocks/MockSuperfluid.sol";

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
    address public meter = address(0x5);

    /// @dev 1e15 / 1e18 = 0.001 wei per byte, so 1000 bytes/s streams 1 wei/s.
    uint256 public constant RATE_PER_BYTE = 1e15;

    event ProviderRegistered(address indexed provider, address receiver, uint256 ratePerByte);
    event ProviderUpdated(address indexed provider, uint256 newRate);
    event ProviderDeregistered(address indexed provider);
    event MeterUpdated(address indexed meter, bool allowed);
    event StreamStarted(address indexed user, address indexed provider, address receiver, int96 flowRate);
    event StreamUpdated(address indexed user, address indexed provider, int96 newFlowRate);
    event StreamStopped(address indexed user, address indexed provider);
    event BytesConsumed(address indexed user, address indexed provider, uint256 bytesConsumed);

    function setUp() public {
        registry = new PassportRegistry();
        superfluid = new MockSuperfluid();
        cfa = new MockCFA(superfluid);
        usdcx = new MockSuperToken(superfluid);

        payments = new PaymentStream(address(registry), address(superfluid), address(cfa), address(usdcx));

        registry.mint(alice, keccak256("alice"));
        registry.mint(bob, keccak256("bob"));
        payments.setMeter(meter, true);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev What a real user does once, through the Superfluid host: grant PaymentStream full
    ///      flow-operator control over their USDCx.
    function _grantOperator(address user) internal {
        vm.prank(user);
        superfluid.callAgreement(
            ISuperAgreement(address(cfa)),
            abi.encodeCall(
                MockCFA.authorizeFlowOperatorWithFullControl,
                (ISuperfluidToken(address(usdcx)), address(payments), new bytes(0))
            ),
            new bytes(0)
        );
    }

    function _grantOperatorWith(address user, uint8 permissions, int96 allowance) internal {
        vm.prank(user);
        superfluid.callAgreement(
            ISuperAgreement(address(cfa)),
            abi.encodeCall(
                MockCFA.updateFlowOperatorPermissions,
                (ISuperfluidToken(address(usdcx)), address(payments), permissions, allowance, new bytes(0))
            ),
            new bytes(0)
        );
    }

    function _registerProvider() internal {
        vm.prank(provider);
        payments.registerProvider(providerReceiver, RATE_PER_BYTE);
    }

    function _liveFlowRate(address sender, address receiver) internal view returns (int96 flowRate) {
        (, flowRate,,) = cfa.getFlow(ISuperfluidToken(address(usdcx)), sender, receiver);
    }

    function _cfaError(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(PaymentStream.StreamOperationFailed.selector, abi.encodeWithSelector(selector));
    }

    // ---------------------------------------------------------------------
    // Construction and providers
    // ---------------------------------------------------------------------

    function testConstructor() public view {
        assertEq(address(payments.passportRegistry()), address(registry));
        assertEq(address(payments.superfluid()), address(superfluid));
        assertEq(address(payments.cfa()), address(cfa));
        assertEq(address(payments.usdcx()), address(usdcx));
        assertEq(payments.owner(), owner);
    }

    function testConstructorRejectsZeroAddresses() public {
        vm.expectRevert(PaymentStream.InvalidProvider.selector);
        new PaymentStream(address(0), address(superfluid), address(cfa), address(usdcx));
        vm.expectRevert(PaymentStream.InvalidProvider.selector);
        new PaymentStream(address(registry), address(0), address(cfa), address(usdcx));
        vm.expectRevert(PaymentStream.InvalidProvider.selector);
        new PaymentStream(address(registry), address(superfluid), address(0), address(usdcx));
        vm.expectRevert(PaymentStream.InvalidProvider.selector);
        new PaymentStream(address(registry), address(superfluid), address(cfa), address(0));
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

    function testReRegisterKeepsServedBytes() public {
        _registerProvider();
        _grantOperator(alice);
        vm.prank(alice);
        payments.startStream(provider, 1000);
        vm.prank(meter);
        payments.recordConsumption(alice, provider, 42);

        address newReceiver = address(0x44);
        vm.prank(provider);
        payments.registerProvider(newReceiver, RATE_PER_BYTE * 3);

        (address receiver, uint256 rate, uint256 totalBytes, bool active) = payments.dataProviders(provider);
        assertEq(receiver, newReceiver);
        assertEq(rate, RATE_PER_BYTE * 3);
        assertEq(totalBytes, 42);
        assertTrue(active);
    }

    function testUpdateProviderRate() public {
        _registerProvider();

        uint256 newRate = RATE_PER_BYTE * 2;
        vm.prank(provider);
        vm.expectEmit(true, false, false, true);
        emit ProviderUpdated(provider, newRate);

        payments.updateProviderRate(newRate);

        (, uint256 rate,,) = payments.dataProviders(provider);
        assertEq(rate, newRate);
    }

    function testUpdateProviderRateFailsNotActive() public {
        vm.prank(provider);
        vm.expectRevert(PaymentStream.ProviderNotActive.selector);
        payments.updateProviderRate(RATE_PER_BYTE * 2);
    }

    function testDeregisterProvider() public {
        _registerProvider();

        vm.prank(provider);
        vm.expectEmit(true, false, false, true);
        emit ProviderDeregistered(provider);
        payments.deregisterProvider();

        (,,, bool active) = payments.dataProviders(provider);
        assertFalse(active);

        vm.prank(provider);
        vm.expectRevert(PaymentStream.ProviderNotActive.selector);
        payments.deregisterProvider();

        _grantOperator(alice);
        vm.prank(alice);
        vm.expectRevert(PaymentStream.ProviderNotActive.selector);
        payments.startStream(provider, 1000);
    }

    function testDeregisteredProviderStreamsCanStillBeStopped() public {
        _registerProvider();
        _grantOperator(alice);
        vm.prank(alice);
        payments.startStream(provider, 1000);

        vm.prank(provider);
        payments.deregisterProvider();

        vm.prank(alice);
        vm.expectRevert(PaymentStream.ProviderNotActive.selector);
        payments.updateStream(provider, 2000);

        vm.prank(alice);
        payments.stopStream(provider);
        assertEq(_liveFlowRate(alice, providerReceiver), 0);
    }

    // ---------------------------------------------------------------------
    // Meters
    // ---------------------------------------------------------------------

    function testSetMeter() public {
        address newMeter = address(0x55);
        vm.expectEmit(true, false, false, true);
        emit MeterUpdated(newMeter, true);
        payments.setMeter(newMeter, true);
        assertTrue(payments.meters(newMeter));

        payments.setMeter(newMeter, false);
        assertFalse(payments.meters(newMeter));
    }

    function testSetMeterOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert("Ownable: caller is not the owner");
        payments.setMeter(alice, true);
    }

    function testSetMeterRejectsZeroAddress() public {
        vm.expectRevert(PaymentStream.InvalidProvider.selector);
        payments.setMeter(address(0), true);
    }

    // ---------------------------------------------------------------------
    // startStream
    // ---------------------------------------------------------------------

    function testStartStream() public {
        _registerProvider();
        _grantOperator(alice);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit StreamStarted(alice, provider, providerReceiver, int96(1));
        payments.startStream(provider, 1000);

        (int96 flowRate, address receiver) = payments.getStreamInfo(alice, provider);
        assertEq(flowRate, int96(1));
        assertEq(receiver, providerReceiver);

        (address storedReceiver, int96 storedRate, uint256 consumed, uint256 startedAt) =
            payments.streams(alice, provider);
        assertEq(storedReceiver, providerReceiver);
        assertEq(storedRate, int96(1));
        assertEq(consumed, 0);
        assertEq(startedAt, block.timestamp);
    }

    /// @dev The flow must be funded by the user: its Superfluid sender is alice, not the contract.
    function testStartStreamOpensFlowFromUserNotContract() public {
        _registerProvider();
        _grantOperator(alice);

        vm.prank(alice);
        payments.startStream(provider, 1000);

        assertEq(_liveFlowRate(alice, providerReceiver), int96(1));
        assertEq(_liveFlowRate(address(payments), providerReceiver), 0);
    }

    function testStartStreamFailsWithoutOperatorPermission() public {
        _registerProvider();

        vm.prank(alice);
        vm.expectRevert(_cfaError(IConstantFlowAgreementV1.CFA_ACL_OPERATOR_NO_CREATE_PERMISSIONS.selector));
        payments.startStream(provider, 1000);
    }

    function testStartStreamRespectsFlowRateAllowance() public {
        _registerProvider();
        _grantOperatorWith(alice, FlowOperatorDefinitions.AUTHORIZE_FULL_CONTROL, int96(5));

        vm.prank(alice);
        vm.expectRevert(_cfaError(IConstantFlowAgreementV1.CFA_ACL_FLOW_RATE_ALLOWANCE_EXCEEDED.selector));
        payments.startStream(provider, 6000);

        vm.prank(alice);
        payments.startStream(provider, 5000);
        assertEq(_liveFlowRate(alice, providerReceiver), int96(5));
    }

    function testStartStreamFailsNoPassport() public {
        _registerProvider();

        vm.prank(address(0x999));
        vm.expectRevert(PaymentStream.NotPassportHolder.selector);
        payments.startStream(provider, 1000);
    }

    function testStartStreamFailsProviderNotActive() public {
        vm.prank(alice);
        vm.expectRevert(PaymentStream.ProviderNotActive.selector);
        payments.startStream(provider, 1000);
    }

    function testStartStreamFailsBelowMinimumFlowRate() public {
        _registerProvider();
        _grantOperator(alice);

        // 0.001 wei/byte * 999 bytes/s rounds down to 0 wei/s.
        vm.prank(alice);
        vm.expectRevert(PaymentStream.InvalidFlowRate.selector);
        payments.startStream(provider, 999);
    }

    function testStartStreamFailsWhenAlreadyActive() public {
        _registerProvider();
        _grantOperator(alice);

        vm.prank(alice);
        payments.startStream(provider, 1000);

        vm.prank(alice);
        vm.expectRevert(PaymentStream.StreamAlreadyActive.selector);
        payments.startStream(provider, 2000);
    }

    /// @dev Several users paying the same provider must not collide: each has its own flow.
    function testMultipleUsersCanStreamToSameProvider() public {
        _registerProvider();
        _grantOperator(alice);
        _grantOperator(bob);

        vm.prank(alice);
        payments.startStream(provider, 1000);
        vm.prank(bob);
        payments.startStream(provider, 3000);

        assertEq(_liveFlowRate(alice, providerReceiver), int96(1));
        assertEq(_liveFlowRate(bob, providerReceiver), int96(3));

        (int96 aliceRate,) = payments.getStreamInfo(alice, provider);
        (int96 bobRate,) = payments.getStreamInfo(bob, provider);
        assertEq(aliceRate, int96(1));
        assertEq(bobRate, int96(3));

        vm.prank(alice);
        payments.stopStream(provider);
        assertEq(_liveFlowRate(alice, providerReceiver), 0);
        assertEq(_liveFlowRate(bob, providerReceiver), int96(3), "bob's flow must survive alice stopping hers");
    }

    /// @dev Documented limitation: Superfluid keys flows by (sender, receiver), so two providers
    ///      sharing a payout address cannot both be streamed to by the same user.
    function testStartStreamFailsWhenReceiverAlreadyHasFlowFromUser() public {
        _registerProvider();
        address provider2 = address(0x33);
        vm.prank(provider2);
        payments.registerProvider(providerReceiver, RATE_PER_BYTE);
        _grantOperator(alice);

        vm.prank(alice);
        payments.startStream(provider, 1000);

        vm.prank(alice);
        vm.expectRevert(_cfaError(IConstantFlowAgreementV1.CFA_FLOW_ALREADY_EXISTS.selector));
        payments.startStream(provider2, 1000);
    }

    function testStreamOperationFailure() public {
        _registerProvider();
        _grantOperator(alice);
        superfluid.setShouldFail(true);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentStream.StreamOperationFailed.selector, abi.encodeWithSignature("Error(string)", "Mock failure")
            )
        );
        payments.startStream(provider, 1000);

        // Nothing was recorded for the failed attempt.
        (int96 flowRate,) = payments.getStreamInfo(alice, provider);
        assertEq(flowRate, 0);
    }

    // ---------------------------------------------------------------------
    // updateStream
    // ---------------------------------------------------------------------

    function testUpdateStream() public {
        _registerProvider();
        _grantOperator(alice);

        vm.prank(alice);
        payments.startStream(provider, 1000);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit StreamUpdated(alice, provider, int96(2));
        payments.updateStream(provider, 2000);

        (int96 flowRate,) = payments.getStreamInfo(alice, provider);
        assertEq(flowRate, int96(2));
        assertEq(_liveFlowRate(alice, providerReceiver), int96(2));
    }

    function testUpdateStreamPicksUpNewProviderRate() public {
        _registerProvider();
        _grantOperator(alice);

        vm.prank(alice);
        payments.startStream(provider, 1000);

        vm.prank(provider);
        payments.updateProviderRate(RATE_PER_BYTE * 5);

        // The live flow is untouched by the provider's rate change...
        assertEq(_liveFlowRate(alice, providerReceiver), int96(1));

        // ...until the user re-prices it.
        vm.prank(alice);
        payments.updateStream(provider, 1000);
        assertEq(_liveFlowRate(alice, providerReceiver), int96(5));
    }

    function testUpdateStreamFailsWhenNotActive() public {
        _registerProvider();
        _grantOperator(alice);

        vm.prank(alice);
        vm.expectRevert(PaymentStream.StreamNotActive.selector);
        payments.updateStream(provider, 2000);
    }

    function testUpdateStreamFailsBelowMinimumFlowRate() public {
        _registerProvider();
        _grantOperator(alice);

        vm.prank(alice);
        payments.startStream(provider, 1000);

        vm.prank(alice);
        vm.expectRevert(PaymentStream.InvalidFlowRate.selector);
        payments.updateStream(provider, 0);
    }

    function testUpdateStreamFailsAfterPermissionRevoked() public {
        _registerProvider();
        _grantOperator(alice);

        vm.prank(alice);
        payments.startStream(provider, 1000);

        vm.prank(alice);
        superfluid.callAgreement(
            ISuperAgreement(address(cfa)),
            abi.encodeCall(
                MockCFA.revokeFlowOperatorWithFullControl,
                (ISuperfluidToken(address(usdcx)), address(payments), new bytes(0))
            ),
            new bytes(0)
        );

        vm.prank(alice);
        vm.expectRevert(_cfaError(IConstantFlowAgreementV1.CFA_ACL_OPERATOR_NO_UPDATE_PERMISSIONS.selector));
        payments.updateStream(provider, 2000);
    }

    /// @dev If the provider re-registers with a new receiver, the user's live flow (to the old
    ///      receiver) must still be the one updated and stopped.
    function testUpdateAndStopTargetOriginalReceiver() public {
        _registerProvider();
        _grantOperator(alice);

        vm.prank(alice);
        payments.startStream(provider, 1000);

        address newReceiver = address(0x44);
        vm.prank(provider);
        payments.registerProvider(newReceiver, RATE_PER_BYTE);

        vm.prank(alice);
        payments.updateStream(provider, 2000);
        assertEq(_liveFlowRate(alice, providerReceiver), int96(2));
        assertEq(_liveFlowRate(alice, newReceiver), 0);

        vm.prank(alice);
        payments.stopStream(provider);
        assertEq(_liveFlowRate(alice, providerReceiver), 0);
    }

    // ---------------------------------------------------------------------
    // stopStream
    // ---------------------------------------------------------------------

    function testStopStream() public {
        _registerProvider();
        _grantOperator(alice);

        vm.prank(alice);
        payments.startStream(provider, 1000);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit StreamStopped(alice, provider);
        payments.stopStream(provider);

        (int96 flowRate, address receiver) = payments.getStreamInfo(alice, provider);
        assertEq(flowRate, 0);
        assertEq(receiver, address(0));
        assertEq(_liveFlowRate(alice, providerReceiver), 0);
    }

    function testStopStreamFailsWhenNotActive() public {
        _registerProvider();

        vm.prank(alice);
        vm.expectRevert(PaymentStream.StreamNotActive.selector);
        payments.stopStream(provider);
    }

    /// @dev Superfluid is the source of truth: if alice already closed the flow herself, stopStream
    ///      just reconciles the local record instead of reverting on CFA_FLOW_DOES_NOT_EXIST.
    function testStopStreamReconcilesExternallyDeletedFlow() public {
        _registerProvider();
        _grantOperator(alice);

        vm.prank(alice);
        payments.startStream(provider, 1000);

        vm.prank(alice);
        superfluid.callAgreement(
            ISuperAgreement(address(cfa)),
            abi.encodeCall(
                MockCFA.deleteFlow, (ISuperfluidToken(address(usdcx)), alice, providerReceiver, new bytes(0))
            ),
            new bytes(0)
        );
        assertEq(_liveFlowRate(alice, providerReceiver), 0);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit StreamStopped(alice, provider);
        payments.stopStream(provider);

        (int96 flowRate,) = payments.getStreamInfo(alice, provider);
        assertEq(flowRate, 0);

        // And the user can start again.
        vm.prank(alice);
        payments.startStream(provider, 1000);
        assertEq(_liveFlowRate(alice, providerReceiver), int96(1));
    }

    function testStopStreamAllowedWhilePaused() public {
        _registerProvider();
        _grantOperator(alice);

        vm.prank(alice);
        payments.startStream(provider, 1000);

        payments.pause();

        vm.prank(alice);
        payments.stopStream(provider);
        assertEq(_liveFlowRate(alice, providerReceiver), 0);
    }

    function testStopStreamAllowedAfterPassportRevoked() public {
        _registerProvider();
        _grantOperator(alice);

        vm.prank(alice);
        payments.startStream(provider, 1000);

        registry.revoke(registry.getTokenId(alice));
        assertFalse(registry.hasPassport(alice));

        vm.prank(alice);
        payments.stopStream(provider);
        assertEq(_liveFlowRate(alice, providerReceiver), 0);
    }

    // ---------------------------------------------------------------------
    // recordConsumption
    // ---------------------------------------------------------------------

    function testRecordConsumption() public {
        _registerProvider();
        _grantOperator(alice);
        vm.prank(alice);
        payments.startStream(provider, 1000);

        uint256 bytesConsumed = 5000;

        vm.prank(meter);
        vm.expectEmit(true, true, false, true);
        emit BytesConsumed(alice, provider, bytesConsumed);
        payments.recordConsumption(alice, provider, bytesConsumed);

        (,, uint256 totalBytes,) = payments.dataProviders(provider);
        assertEq(totalBytes, bytesConsumed);
        (,, uint256 streamBytes,) = payments.streams(alice, provider);
        assertEq(streamBytes, bytesConsumed);
    }

    function testRecordConsumptionFailsForNonMeter() public {
        _registerProvider();
        _grantOperator(alice);
        vm.prank(alice);
        payments.startStream(provider, 1000);

        vm.prank(alice);
        vm.expectRevert(PaymentStream.NotMeter.selector);
        payments.recordConsumption(alice, provider, 5000);

        vm.prank(owner);
        vm.expectRevert(PaymentStream.NotMeter.selector);
        payments.recordConsumption(alice, provider, 5000);
    }

    /// @dev The old design let any provider report any amount for anyone. Providers are not meters.
    function testRecordConsumptionFailsForProvider() public {
        _registerProvider();
        _grantOperator(alice);
        vm.prank(alice);
        payments.startStream(provider, 1000);

        vm.prank(provider);
        vm.expectRevert(PaymentStream.NotMeter.selector);
        payments.recordConsumption(alice, provider, 5000);
    }

    function testRecordConsumptionFailsForSelfMetering() public {
        _registerProvider();
        _grantOperator(alice);
        vm.prank(alice);
        payments.startStream(provider, 1000);

        // Even if the owner mistakenly enables a provider as a meter, it cannot credit itself.
        payments.setMeter(provider, true);
        vm.prank(provider);
        vm.expectRevert(PaymentStream.SelfMetering.selector);
        payments.recordConsumption(alice, provider, 5000);
    }

    function testRecordConsumptionFailsWithoutActiveStream() public {
        _registerProvider();

        vm.prank(meter);
        vm.expectRevert(PaymentStream.StreamNotActive.selector);
        payments.recordConsumption(alice, provider, 5000);
    }

    function testRecordConsumptionAfterMeterDisabled() public {
        _registerProvider();
        _grantOperator(alice);
        vm.prank(alice);
        payments.startStream(provider, 1000);

        payments.setMeter(meter, false);
        vm.prank(meter);
        vm.expectRevert(PaymentStream.NotMeter.selector);
        payments.recordConsumption(alice, provider, 5000);
    }

    // ---------------------------------------------------------------------
    // calculateFlowRate
    // ---------------------------------------------------------------------

    function testCalculateFlowRate() public view {
        uint256 precision = payments.RATE_PRECISION();
        uint256 maxFlowRate = payments.MAX_FLOW_RATE();
        assertEq(maxFlowRate, uint256(int256(type(int96).max)));

        assertEq(payments.calculateFlowRate(RATE_PER_BYTE, 1000), int96(1));
        assertEq(payments.calculateFlowRate(precision, 7), int96(7));
        assertEq(payments.calculateFlowRate(0, 1000), int96(0));
        assertEq(payments.calculateFlowRate(RATE_PER_BYTE, 0), int96(0));
        assertEq(payments.calculateFlowRate(precision, maxFlowRate), type(int96).max);
    }

    function testCalculateFlowRateRevertsAboveInt96() public {
        uint256 precision = payments.RATE_PRECISION();
        uint256 maxFlowRate = payments.MAX_FLOW_RATE();

        vm.expectRevert(PaymentStream.FlowRateOverflow.selector);
        payments.calculateFlowRate(precision, maxFlowRate + 1);

        vm.expectRevert(PaymentStream.FlowRateOverflow.selector);
        payments.calculateFlowRate(1, type(uint256).max);

        // Raw product overflows uint256 as well.
        vm.expectRevert(PaymentStream.FlowRateOverflow.selector);
        payments.calculateFlowRate(type(uint256).max, 2);
    }

    function testFuzzCalculateFlowRateNeverTruncates(uint256 ratePerByte, uint256 bytesPerSecond) public view {
        uint256 precision = payments.RATE_PRECISION();
        uint256 maxFlowRate = payments.MAX_FLOW_RATE();
        // Keep the raw product inside uint256 so the reference computation below cannot overflow.
        bytesPerSecond = bound(bytesPerSecond, 0, type(uint128).max);
        ratePerByte = bound(ratePerByte, 0, type(uint128).max);
        uint256 expected = (ratePerByte * bytesPerSecond) / precision;

        try payments.calculateFlowRate(ratePerByte, bytesPerSecond) returns (int96 flowRate) {
            assertGe(flowRate, 0);
            // Safe: non-negativity is asserted on the line above.
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(uint256(int256(flowRate)), expected);
            assertLe(expected, maxFlowRate);
        } catch (bytes memory reason) {
            assertEq(reason, abi.encodeWithSelector(PaymentStream.FlowRateOverflow.selector));
            assertGt(expected, maxFlowRate);
        }
    }

    // ---------------------------------------------------------------------
    // End to end
    // ---------------------------------------------------------------------

    function testComplexScenario() public {
        _registerProvider();

        address provider2 = address(0x6);
        address provider2Receiver = address(0x7);
        vm.prank(provider2);
        payments.registerProvider(provider2Receiver, RATE_PER_BYTE * 2);

        _grantOperator(alice);
        vm.startPrank(alice);
        payments.startStream(provider, 1000);
        payments.startStream(provider2, 500);
        vm.stopPrank();

        (int96 flow1,) = payments.getStreamInfo(alice, provider);
        (int96 flow2,) = payments.getStreamInfo(alice, provider2);
        assertEq(flow1, int96(1));
        assertEq(flow2, int96(1));
        assertEq(_liveFlowRate(alice, providerReceiver), int96(1));
        assertEq(_liveFlowRate(alice, provider2Receiver), int96(1));

        vm.startPrank(meter);
        payments.recordConsumption(alice, provider, 10000);
        payments.recordConsumption(alice, provider2, 5000);
        vm.stopPrank();

        (,, uint256 totalBytes1,) = payments.dataProviders(provider);
        (,, uint256 totalBytes2,) = payments.dataProviders(provider2);
        assertEq(totalBytes1, 10000);
        assertEq(totalBytes2, 5000);

        vm.prank(alice);
        payments.stopStream(provider);

        (flow1,) = payments.getStreamInfo(alice, provider);
        assertEq(flow1, 0);
        assertEq(_liveFlowRate(alice, providerReceiver), 0);
        assertEq(_liveFlowRate(alice, provider2Receiver), int96(1), "second stream untouched");

        // Consumption can no longer be attributed to the closed stream.
        vm.prank(meter);
        vm.expectRevert(PaymentStream.StreamNotActive.selector);
        payments.recordConsumption(alice, provider, 1);
    }

    function testCountersUseCheckedArithmetic() public {
        _registerProvider();
        _grantOperator(alice);
        vm.prank(alice);
        payments.startStream(provider, 1000);

        vm.prank(meter);
        payments.recordConsumption(alice, provider, type(uint256).max);

        vm.prank(meter);
        vm.expectRevert(stdError.arithmeticError);
        payments.recordConsumption(alice, provider, 1);
    }

    function testPauseAndUnpause() public {
        vm.prank(alice);
        vm.expectRevert("Ownable: caller is not the owner");
        payments.pause();

        payments.pause();
        assertTrue(payments.paused());

        vm.prank(alice);
        vm.expectRevert("Ownable: caller is not the owner");
        payments.unpause();

        payments.unpause();
        assertFalse(payments.paused());

        _registerProvider();
        (,,, bool active) = payments.dataProviders(provider);
        assertTrue(active);
    }
}
