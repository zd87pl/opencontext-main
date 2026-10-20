// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test, stdError } from "forge-std/Test.sol";
import {
    ISuperAgreement
} from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperAgreement.sol";
import {
    ISuperfluidToken
} from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperfluidToken.sol";
import { PassportRegistry } from "../PassportRegistry.sol";
import { ContextVault } from "../ContextVault.sol";
import { PaymentStream } from "../PaymentStream.sol";
import { MockSuperfluid, MockCFA, MockSuperToken } from "./mocks/MockSuperfluid.sol";

contract EdgeCasesTest is Test {
    PassportRegistry public passportRegistry;
    ContextVault public contextVault;
    PaymentStream public paymentStream;
    MockSuperfluid public mockSuperfluid;
    MockCFA public mockCfa;
    MockSuperToken public mockUsdcx;

    address public owner = address(this);
    address public alice = address(0x1);
    address public bob = address(0x2);
    address public attacker = address(0x3);
    address public meter = address(0x4);

    /// @dev `RATE_PRECISION` wei per byte, i.e. 1 wei per byte: flow rate equals bytes per second.
    uint256 public constant ONE_WEI_PER_BYTE = 1e18;

    function setUp() public {
        passportRegistry = new PassportRegistry();
        contextVault = new ContextVault(address(passportRegistry));

        mockSuperfluid = new MockSuperfluid();
        mockCfa = new MockCFA(mockSuperfluid);
        mockUsdcx = new MockSuperToken(mockSuperfluid);

        paymentStream =
            new PaymentStream(address(passportRegistry), address(mockSuperfluid), address(mockCfa), address(mockUsdcx));
        paymentStream.setMeter(meter, true);
    }

    function _grantOperator(address user) internal {
        vm.prank(user);
        mockSuperfluid.callAgreement(
            ISuperAgreement(address(mockCfa)),
            abi.encodeCall(
                MockCFA.authorizeFlowOperatorWithFullControl,
                (ISuperfluidToken(address(mockUsdcx)), address(paymentStream), new bytes(0))
            ),
            new bytes(0)
        );
    }

    // ---------------------------------------------------------------------
    // PassportRegistry
    // ---------------------------------------------------------------------

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

    // ---------------------------------------------------------------------
    // ContextVault
    // ---------------------------------------------------------------------

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

        uint256 usageBefore = contextVault.getStorageUsed(1);
        assertEq(usageBefore, testData.length);

        vm.prank(alice);
        contextVault.deleteContext(0);

        uint256 usageAfter = contextVault.getStorageUsed(1);
        assertEq(usageAfter, 0);
    }

    /// @dev Deleting twice is rejected explicitly, so storage accounting can never underflow.
    function testDeleteAlreadyDeletedContext() public {
        passportRegistry.mint(alice, keccak256("alice"));

        vm.prank(alice);
        contextVault.storeContext(bytes("test"));

        vm.prank(alice);
        contextVault.deleteContext(0);

        vm.prank(alice);
        vm.expectRevert(ContextVault.ContextAlreadyDeleted.selector);
        contextVault.deleteContext(0);

        assertEq(contextVault.getStorageUsed(1), 0);
    }

    function testStorageQuotaEnforcement() public {
        passportRegistry.mint(alice, keccak256("alice"));

        contextVault.updateQuota(1, 10);

        vm.prank(alice);
        vm.expectRevert(ContextVault.QuotaExceeded.selector);
        contextVault.storeContext(bytes("this exceeds quota"));
    }

    function testMaxContextSizeEnforcement() public {
        passportRegistry.mint(alice, keccak256("alice"));

        bytes memory largeData = new bytes(contextVault.MAX_CONTEXT_SIZE() + 1);

        vm.prank(alice);
        vm.expectRevert(ContextVault.ContextTooLarge.selector);
        contextVault.storeContext(largeData);
    }

    // ---------------------------------------------------------------------
    // PaymentStream
    // ---------------------------------------------------------------------

    function testRegisterProviderWhenPausedFails() public {
        paymentStream.pause();

        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        paymentStream.registerProvider(alice, ONE_WEI_PER_BYTE);
    }

    function testStartStreamWhenPausedFails() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, ONE_WEI_PER_BYTE);

        passportRegistry.mint(bob, keccak256("bob"));
        _grantOperator(bob);

        paymentStream.pause();

        vm.prank(bob);
        vm.expectRevert("Pausable: paused");
        paymentStream.startStream(alice, 1000);
    }

    function testUpdateStreamWhenPausedFails() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, ONE_WEI_PER_BYTE);

        passportRegistry.mint(bob, keccak256("bob"));
        _grantOperator(bob);

        vm.prank(bob);
        paymentStream.startStream(alice, 1000);

        paymentStream.pause();

        vm.prank(bob);
        vm.expectRevert("Pausable: paused");
        paymentStream.updateStream(alice, 2000);
    }

    function testRecordConsumptionWhenPausedFails() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, ONE_WEI_PER_BYTE);

        passportRegistry.mint(bob, keccak256("bob"));
        _grantOperator(bob);

        vm.prank(bob);
        paymentStream.startStream(alice, 1000);

        paymentStream.pause();

        vm.prank(meter);
        vm.expectRevert("Pausable: paused");
        paymentStream.recordConsumption(bob, alice, 5000);
    }

    function testStartStreamWithZeroBytesPerSecond() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, ONE_WEI_PER_BYTE);

        passportRegistry.mint(bob, keccak256("bob"));
        _grantOperator(bob);

        vm.prank(bob);
        vm.expectRevert(PaymentStream.InvalidFlowRate.selector);
        paymentStream.startStream(alice, 0);
    }

    function testStartStreamToSelfFails() public {
        // A provider who is also a passport holder cannot stream to their own receiver address.
        vm.prank(alice);
        paymentStream.registerProvider(alice, ONE_WEI_PER_BYTE);
        passportRegistry.mint(alice, keccak256("alice"));
        _grantOperator(alice);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentStream.StreamOperationFailed.selector, abi.encodeWithSignature("CFA_NO_SELF_FLOW()")
            )
        );
        paymentStream.startStream(alice, 1000);
    }

    function testUpdateNonExistentStream() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, ONE_WEI_PER_BYTE);

        passportRegistry.mint(bob, keccak256("bob"));

        vm.prank(bob);
        vm.expectRevert(PaymentStream.StreamNotActive.selector);
        paymentStream.updateStream(alice, 2000);
    }

    function testStopNonExistentStream() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, ONE_WEI_PER_BYTE);

        passportRegistry.mint(bob, keccak256("bob"));

        vm.prank(bob);
        vm.expectRevert(PaymentStream.StreamNotActive.selector);
        paymentStream.stopStream(alice);
    }

    function testSuperfluidCallFailure() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, ONE_WEI_PER_BYTE);

        passportRegistry.mint(bob, keccak256("bob"));
        _grantOperator(bob);

        mockSuperfluid.setShouldFail(true);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                PaymentStream.StreamOperationFailed.selector, abi.encodeWithSignature("Error(string)", "Mock failure")
            )
        );
        paymentStream.startStream(alice, 1000);
    }

    /// @dev Flow rates that do not fit Superfluid's int96 are rejected instead of silently truncated.
    function testCalculateFlowRateOverflow() public {
        vm.expectRevert(PaymentStream.FlowRateOverflow.selector);
        paymentStream.calculateFlowRate(1, type(uint256).max);

        vm.expectRevert(PaymentStream.FlowRateOverflow.selector);
        paymentStream.calculateFlowRate(type(uint256).max, type(uint256).max);

        // Exactly the limit is fine.
        assertEq(paymentStream.calculateFlowRate(ONE_WEI_PER_BYTE, paymentStream.MAX_FLOW_RATE()), type(int96).max);
    }

    function testProviderCanUpdateRateToZero() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, ONE_WEI_PER_BYTE);

        // A zero rate is a legitimate "free tier"; streams simply cannot be opened at it.
        vm.prank(alice);
        paymentStream.updateProviderRate(0);

        (, uint256 rate,,) = paymentStream.dataProviders(alice);
        assertEq(rate, 0);

        passportRegistry.mint(bob, keccak256("bob"));
        _grantOperator(bob);
        vm.prank(bob);
        vm.expectRevert(PaymentStream.InvalidFlowRate.selector);
        paymentStream.startStream(alice, 1000);
    }

    /// @dev Solidity 0.8 arithmetic is checked: the byte counters panic rather than wrap.
    function testRecordConsumptionOverflow() public {
        vm.prank(alice);
        paymentStream.registerProvider(alice, ONE_WEI_PER_BYTE);

        passportRegistry.mint(bob, keccak256("bob"));
        _grantOperator(bob);
        vm.prank(bob);
        paymentStream.startStream(alice, 1000);

        vm.prank(meter);
        paymentStream.recordConsumption(bob, alice, type(uint256).max);

        (,, uint256 totalBytes,) = paymentStream.dataProviders(alice);
        assertEq(totalBytes, type(uint256).max);

        vm.prank(meter);
        vm.expectRevert(stdError.arithmeticError);
        paymentStream.recordConsumption(bob, alice, 1);

        (,, totalBytes,) = paymentStream.dataProviders(alice);
        assertEq(totalBytes, type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Gas limits
    // ---------------------------------------------------------------------

    function testLargeContextStorage() public {
        passportRegistry.mint(alice, keccak256("alice"));

        bytes memory maxData = new bytes(contextVault.MAX_CONTEXT_SIZE());

        vm.prank(alice);
        uint256 version = contextVault.storeContext(maxData);

        assertEq(version, 0);
        assertEq(contextVault.getContextCount(1), 1);
    }

    function testManySmallContexts() public {
        passportRegistry.mint(alice, keccak256("alice"));

        bytes memory smallData = bytes("x");
        uint256 quota = contextVault.DEFAULT_QUOTA();

        vm.startPrank(alice);
        for (uint256 i = 0; i < quota && i < 1000; i++) {
            contextVault.storeContext(smallData);
        }
        vm.stopPrank();

        assertEq(contextVault.getContextCount(1), 1000);
        assertEq(contextVault.getStorageUsed(1), 1000);
    }
}
