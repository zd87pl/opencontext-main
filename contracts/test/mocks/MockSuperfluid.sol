// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperfluid.sol";
import "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperToken.sol";
import "@superfluid-finance/ethereum-contracts/contracts/interfaces/agreements/IConstantFlowAgreementV1.sol";

contract MockSuperfluid is ISuperfluid {
    bool public shouldFail;
    
    function setShouldFail(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }
    
    function callAgreement(
        ISuperAgreement,
        bytes calldata,
        bytes calldata
    ) external override returns (bytes memory) {
        if (shouldFail) {
            revert("Mock failure");
        }
        return "";
    }
    
    // Minimal implementations for interface compliance
    function getHost() external pure override returns (address) { return address(0); }
    function getNow() external view override returns (uint256) { return block.timestamp; }
    function getGovernance() external pure override returns (ISuperfluidGovernance) { return ISuperfluidGovernance(address(0)); }
    function getSuperTokenFactory() external pure override returns (ISuperTokenFactory) { return ISuperTokenFactory(address(0)); }
    function getSuperTokenFactoryLogic() external pure override returns (address) { return address(0); }
    function getAgreementClass(bytes32) external pure override returns (ISuperAgreement) { return ISuperAgreement(address(0)); }
    function mapAgreementClasses(uint256) external pure override returns (ISuperAgreement) { return ISuperAgreement(address(0)); }
    function addToAgreementClassesBitmap(uint256) external pure override returns (uint256) { return 0; }
    function removeFromAgreementClassesBitmap(uint256) external pure override returns (uint256) { return 0; }
    function getSuperTokenLogic() external pure override returns (ISuperToken) { return ISuperToken(address(0)); }
    function isApp(ISuperApp) external pure override returns (bool) { return false; }
    function isAppJailed(ISuperApp) external pure override returns (bool) { return false; }
    function allowCompositeApp(ISuperApp) external pure override { }
    function isCompositeAppAllowed(ISuperApp, ISuperApp) external pure override returns (bool) { return false; }
    function getAppCallbackLevel(ISuperApp) external pure override returns (uint8) { return 0; }
    function getAppManifest(ISuperApp) external pure override returns (bool, bool, uint256) { return (false, false, 0); }
    function registerApp(uint256) external pure override { }
    function registerAppWithKey(uint256, string calldata) external pure override { }
    function registerAppByFactory(ISuperApp, uint256) external pure override { }
    function removeApp(ISuperApp) external pure override { }
    function jailApp(ISuperApp) external pure override { }
    function callAppBeforeCallback(ISuperApp, bytes calldata, bool, bytes calldata) external pure override returns (bytes memory) { return ""; }
    function callAppAfterCallback(ISuperApp, bytes calldata, bool, bytes calldata) external pure override returns (bytes memory) { return ""; }
    function appCallbackPush(bytes calldata, ISuperApp) external pure override returns (bytes memory) { return ""; }
    function appCallbackPop(bytes calldata, int256) external pure override returns (bytes memory) { return ""; }
    function ctxUseAllowance(bytes calldata, uint256, int256) external pure override returns (bytes memory) { return ""; }
    function jailApp(bytes calldata, ISuperApp, uint256) external pure override returns (bytes memory) { return ""; }
    function callAgreementWithContext(ISuperAgreement, bytes calldata, bytes calldata, bytes calldata) external pure override returns (bytes memory, bytes memory) { return ("", ""); }
    function decodeCtx(bytes calldata) external pure override returns (Context memory) { return Context(0, 0, 0, 0, ISuperApp(address(0)), 0, 0, 0); }
    function updateAgreementData(address, bytes32, bytes32[] calldata) external pure override { }
    function updateAgreementStateSlot(address, address, uint256, bytes32[] calldata) external pure override { }
    function getAgreementData(address, address, uint256, uint256[] calldata) external pure override returns (bytes32[] memory) { return new bytes32[](0); }
    function getAgreementStateSlot(address, address, uint256, uint256) external pure override returns (bytes32[] memory) { return new bytes32[](0); }
    function updateAgreementStateSlot(address, bytes32, bytes32[] calldata) external pure override { }
    function settleBalance(ISuperToken, address, int256) external pure override { }
    function mintWrappedSuperToken(ISuperToken, uint256, address) external pure override { }
    function burnWrappedSuperToken(ISuperToken, uint256, address) external pure override { }
    function batchCall(Operation[] calldata) external pure override { }
    function forwardBatchCall(Operation[] calldata) external pure override { }
    function registerAgreementClass(ISuperAgreement) external pure override { }
    function updateSuperTokenLogic(ISuperToken) external pure override { }
    function updateCode(address) external pure override { }
    function isCtxValid(bytes calldata) external pure override returns (bool) { return false; }
}

contract MockCFA is IConstantFlowAgreementV1 {
    function realtimeBalanceOf(ISuperToken, address, uint256) external pure override returns (int256, uint256, uint256) { return (0, 0, 0); }
    function getNetFlow(ISuperToken, address) external pure override returns (int96) { return 0; }
    function getFlow(ISuperToken, address, address) external pure override returns (uint256, int96, uint256, uint256) { return (0, 0, 0, 0); }
    function getFlowByID(ISuperToken, bytes32) external pure override returns (uint256, int96, uint256, uint256) { return (0, 0, 0, 0); }
    function getAccountFlowInfo(ISuperToken, address) external pure override returns (uint256, int96, uint256, uint256) { return (0, 0, 0, 0); }
    function getDepositRequiredForFlowRate(ISuperToken, int96) external pure override returns (uint256) { return 0; }
    function isPatricianPeriod(ISuperToken, address, uint256) external pure override returns (bool) { return false; }
    function isPatricianPeriodNow(ISuperToken, address) external pure override returns (bool, uint256) { return (false, 0); }
    function createFlow(ISuperToken, address, int96, bytes calldata) external pure override returns (bytes memory) { return ""; }
    function updateFlow(ISuperToken, address, int96, bytes calldata) external pure override returns (bytes memory) { return ""; }
    function deleteFlow(ISuperToken, address, address, bytes calldata) external pure override returns (bytes memory) { return ""; }
    function createFlowByOperator(ISuperToken, address, address, int96, bytes calldata) external pure override returns (bytes memory) { return ""; }
    function updateFlowByOperator(ISuperToken, address, address, int96, bytes calldata) external pure override returns (bytes memory) { return ""; }
    function deleteFlowByOperator(ISuperToken, address, address, bytes calldata) external pure override returns (bytes memory) { return ""; }
    function updateFlowOperatorPermissions(ISuperToken, address, uint8, int96, bytes calldata) external pure override returns (bytes memory) { return ""; }
    function authorizeFlowOperatorWithFullControl(ISuperToken, address, bytes calldata) external pure override returns (bytes memory) { return ""; }
    function revokeFlowOperatorWithFullControl(ISuperToken, address, bytes calldata) external pure override returns (bytes memory) { return ""; }
    function getFlowOperatorData(ISuperToken, address, address) external pure override returns (bytes32, uint8, int96) { return (bytes32(0), 0, 0); }
    function getFlowOperatorDataByID(ISuperToken, bytes32) external pure override returns (bytes32, uint8, int96) { return (bytes32(0), 0, 0); }
    function agreementType() external pure override returns (bytes32) { return keccak256("CONSTANT_FLOW_AGREEMENT_V1"); }
    function version() external pure override returns (uint256) { return 1; }
}

contract MockSuperToken is ISuperToken {
    function getHost() external pure override returns (address) { return address(0); }
    function realtimeBalanceOf(address, uint256) external pure override returns (int256, uint256, uint256) { return (0, 0, 0); }
    function realtimeBalanceOfNow(address) external pure override returns (int256, uint256, uint256) { return (0, 0, 0); }
    function isAccountCritical(address, uint256) external pure override returns (bool) { return false; }
    function isAccountCriticalNow(address) external pure override returns (bool) { return false; }
    function isAccountSolvent(address, uint256) external pure override returns (bool) { return true; }
    function isAccountSolventNow(address) external pure override returns (bool) { return true; }
    function getAccountActiveAgreements(address) external pure override returns (ISuperAgreement[] memory) { return new ISuperAgreement[](0); }
    function createAgreement(bytes32, bytes32[] calldata) external pure override { }
    function updateAgreementData(bytes32, bytes32[] calldata) external pure override { }
    function terminateAgreement(bytes32, uint256) external pure override { }
    function updateAgreementStateSlot(address, uint256, bytes32[] calldata) external pure override { }
    function settleBalance(address, int256) external pure override { }
    function makeLiquidationPayoutsV2(bytes32, bytes memory, address, bool, address, uint256, int256) external pure override { }
    function mintWrappedSuperToken(uint256, address) external pure override { }
    function burnWrappedSuperToken(uint256, address) external pure override { }
    function transferAll(address) external pure override { }
    function name() external pure override returns (string memory) { return "Mock USDC"; }
    function symbol() external pure override returns (string memory) { return "USDCx"; }
    function decimals() external pure override returns (uint8) { return 18; }
    function totalSupply() external pure override returns (uint256) { return 0; }
    function balanceOf(address) external pure override returns (uint256) { return 0; }
    function transfer(address, uint256) external pure override returns (bool) { return true; }
    function allowance(address, address) external pure override returns (uint256) { return 0; }
    function approve(address, uint256) external pure override returns (bool) { return true; }
    function transferFrom(address, address, uint256) external pure override returns (bool) { return true; }
    function increaseAllowance(address, uint256) external pure override returns (bool) { return true; }
    function decreaseAllowance(address, uint256) external pure override returns (bool) { return true; }
    function granularity() external pure override returns (uint256) { return 1; }
    function send(address, uint256, bytes calldata) external pure override { }
    function burn(uint256, bytes calldata) external pure override { }
    function isOperatorFor(address, address) external pure override returns (bool) { return false; }
    function authorizeOperator(address) external pure override { }
    function revokeOperator(address) external pure override { }
    function defaultOperators() external pure override returns (address[] memory) { return new address[](0); }
    function operatorSend(address, address, uint256, bytes calldata, bytes calldata) external pure override { }
    function operatorBurn(address, uint256, bytes calldata, bytes calldata) external pure override { }
    function selfMint(address, uint256, bytes calldata) external pure override { }
    function selfBurn(address, uint256, bytes calldata) external pure override { }
    function selfApproveFor(address, address, uint256) external pure override { }
    function selfTransferFrom(address, address, address, uint256) external pure override { }
    function transferInternal(address, address, address, uint256) external pure override { }
    function getUnderlyingToken() external pure override returns (address) { return address(0); }
    function upgrade(uint256) external pure override { }
    function upgradeTo(address, uint256, bytes calldata) external pure override { }
    function downgrade(uint256) external pure override { }
    function operationApprove(address, address, uint256) external pure override { }
    function operationTransferFrom(address, address, address, uint256) external pure override { }
    function operationUpgrade(address, uint256) external pure override { }
    function operationDowngrade(address, uint256) external pure override { }
}