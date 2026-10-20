// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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

/**
 * @title MockSuperfluid
 * @notice Minimal stand-in for the Superfluid host. It only implements `callAgreement`, which is
 *         the single host entry point `PaymentStream` uses: it forwards the call to the agreement
 *         and exposes the original caller so the mock CFA can apply ACL checks against it, the way
 *         the real host does through the injected `ctx`.
 * @dev Deliberately does not implement `ISuperfluid` in full; the production interface has ~60
 *      functions that are irrelevant to these tests.
 */
contract MockSuperfluid {
    bool public shouldFail;
    /// @dev `msg.sender` of the in-flight `callAgreement`, readable by the agreement being called.
    address public currentMsgSender;

    function setShouldFail(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }

    function callAgreement(
        ISuperAgreement agreementClass,
        bytes calldata callData,
        bytes calldata /* userData */
    )
        external
        returns (bytes memory returnedData)
    {
        if (shouldFail) {
            revert("Mock failure");
        }

        currentMsgSender = msg.sender;
        (bool ok, bytes memory ret) = address(agreementClass).call(callData);
        currentMsgSender = address(0);

        if (!ok) {
            // Bubble the agreement's revert data up unchanged, like the real host.
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}

/**
 * @title MockCFA
 * @notice In-memory model of the Constant Flow Agreement: flows keyed by (token, sender, receiver)
 *         and flow-operator permissions keyed by (token, sender, operator), with the same error
 *         selectors as the real CFA for the paths `PaymentStream` exercises.
 */
contract MockCFA {
    struct Flow {
        uint256 timestamp;
        int96 flowRate;
    }

    MockSuperfluid public immutable host;

    mapping(address token => mapping(address sender => mapping(address receiver => Flow))) private _flows;
    mapping(address token => mapping(address sender => mapping(address operator => uint8))) private _permissions;
    mapping(address token => mapping(address sender => mapping(address operator => int96))) private _allowances;

    constructor(MockSuperfluid _host) {
        host = _host;
    }

    modifier onlyHost() {
        require(msg.sender == address(host), "MockCFA: only host");
        _;
    }

    // ---------------------------------------------------------------------
    // ACL
    // ---------------------------------------------------------------------

    function authorizeFlowOperatorWithFullControl(ISuperfluidToken token, address flowOperator, bytes calldata ctx)
        external
        onlyHost
        returns (bytes memory)
    {
        address sender = host.currentMsgSender();
        _permissions[address(token)][sender][flowOperator] = FlowOperatorDefinitions.AUTHORIZE_FULL_CONTROL;
        _allowances[address(token)][sender][flowOperator] = type(int96).max;
        return ctx;
    }

    function updateFlowOperatorPermissions(
        ISuperfluidToken token,
        address flowOperator,
        uint8 permissions,
        int96 flowRateAllowance,
        bytes calldata ctx
    ) external onlyHost returns (bytes memory) {
        if (!FlowOperatorDefinitions.isPermissionsClean(permissions)) {
            revert IConstantFlowAgreementV1.CFA_ACL_UNCLEAN_PERMISSIONS();
        }
        if (flowRateAllowance < 0) {
            revert IConstantFlowAgreementV1.CFA_ACL_NO_NEGATIVE_ALLOWANCE();
        }
        address sender = host.currentMsgSender();
        _permissions[address(token)][sender][flowOperator] = permissions;
        _allowances[address(token)][sender][flowOperator] = flowRateAllowance;
        return ctx;
    }

    function revokeFlowOperatorWithFullControl(ISuperfluidToken token, address flowOperator, bytes calldata ctx)
        external
        onlyHost
        returns (bytes memory)
    {
        address sender = host.currentMsgSender();
        delete _permissions[address(token)][sender][flowOperator];
        delete _allowances[address(token)][sender][flowOperator];
        return ctx;
    }

    function getFlowOperatorData(ISuperfluidToken token, address sender, address flowOperator)
        external
        view
        returns (bytes32 flowOperatorId, uint8 permissions, int96 flowRateAllowance)
    {
        flowOperatorId = keccak256(abi.encode("flowOperator", sender, flowOperator));
        permissions = _permissions[address(token)][sender][flowOperator];
        flowRateAllowance = _allowances[address(token)][sender][flowOperator];
    }

    // ---------------------------------------------------------------------
    // Flows
    // ---------------------------------------------------------------------

    function createFlow(ISuperfluidToken token, address receiver, int96 flowRate, bytes calldata ctx)
        external
        onlyHost
        returns (bytes memory)
    {
        _createFlow(address(token), host.currentMsgSender(), receiver, flowRate);
        return ctx;
    }

    function createFlowByOperator(
        ISuperfluidToken token,
        address sender,
        address receiver,
        int96 flowRate,
        bytes calldata ctx
    ) external onlyHost returns (bytes memory) {
        address operator = host.currentMsgSender();
        if (operator != sender) {
            _requirePermission(
                address(token),
                sender,
                operator,
                FlowOperatorDefinitions.AUTHORIZE_FLOW_OPERATOR_CREATE,
                IConstantFlowAgreementV1.CFA_ACL_OPERATOR_NO_CREATE_PERMISSIONS.selector
            );
            _consumeAllowance(address(token), sender, operator, flowRate);
        }
        _createFlow(address(token), sender, receiver, flowRate);
        return ctx;
    }

    function updateFlow(ISuperfluidToken token, address receiver, int96 flowRate, bytes calldata ctx)
        external
        onlyHost
        returns (bytes memory)
    {
        _updateFlow(address(token), host.currentMsgSender(), receiver, flowRate);
        return ctx;
    }

    function updateFlowByOperator(
        ISuperfluidToken token,
        address sender,
        address receiver,
        int96 flowRate,
        bytes calldata ctx
    ) external onlyHost returns (bytes memory) {
        address operator = host.currentMsgSender();
        if (operator != sender) {
            _requirePermission(
                address(token),
                sender,
                operator,
                FlowOperatorDefinitions.AUTHORIZE_FLOW_OPERATOR_UPDATE,
                IConstantFlowAgreementV1.CFA_ACL_OPERATOR_NO_UPDATE_PERMISSIONS.selector
            );
            int96 current = _flows[address(token)][sender][receiver].flowRate;
            if (flowRate > current) {
                _consumeAllowance(address(token), sender, operator, flowRate - current);
            }
        }
        _updateFlow(address(token), sender, receiver, flowRate);
        return ctx;
    }

    function deleteFlow(ISuperfluidToken token, address sender, address receiver, bytes calldata ctx)
        external
        onlyHost
        returns (bytes memory)
    {
        address caller = host.currentMsgSender();
        // The real CFA lets the sender or the receiver close a flow without operator permissions.
        require(caller == sender || caller == receiver, "MockCFA: not a party to the flow");
        _deleteFlow(address(token), sender, receiver);
        return ctx;
    }

    function deleteFlowByOperator(ISuperfluidToken token, address sender, address receiver, bytes calldata ctx)
        external
        onlyHost
        returns (bytes memory)
    {
        address operator = host.currentMsgSender();
        if (operator != sender && operator != receiver) {
            _requirePermission(
                address(token),
                sender,
                operator,
                FlowOperatorDefinitions.AUTHORIZE_FLOW_OPERATOR_DELETE,
                IConstantFlowAgreementV1.CFA_ACL_OPERATOR_NO_DELETE_PERMISSIONS.selector
            );
        }
        _deleteFlow(address(token), sender, receiver);
        return ctx;
    }

    function getFlow(ISuperfluidToken token, address sender, address receiver)
        external
        view
        returns (uint256 timestamp, int96 flowRate, uint256 deposit, uint256 owedDeposit)
    {
        Flow storage flow = _flows[address(token)][sender][receiver];
        return (flow.timestamp, flow.flowRate, 0, 0);
    }

    function agreementType() external pure returns (bytes32) {
        return keccak256("org.superfluid-finance.agreements.ConstantFlowAgreement.v1");
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _createFlow(address token, address sender, address receiver, int96 flowRate) private {
        if (sender == address(0)) revert IConstantFlowAgreementV1.CFA_ZERO_ADDRESS_SENDER();
        if (receiver == address(0)) revert IConstantFlowAgreementV1.CFA_ZERO_ADDRESS_RECEIVER();
        if (sender == receiver) revert IConstantFlowAgreementV1.CFA_NO_SELF_FLOW();
        if (flowRate <= 0) revert IConstantFlowAgreementV1.CFA_INVALID_FLOW_RATE();
        if (_flows[token][sender][receiver].flowRate != 0) revert IConstantFlowAgreementV1.CFA_FLOW_ALREADY_EXISTS();
        _flows[token][sender][receiver] = Flow({ timestamp: block.timestamp, flowRate: flowRate });
    }

    function _updateFlow(address token, address sender, address receiver, int96 flowRate) private {
        if (flowRate <= 0) revert IConstantFlowAgreementV1.CFA_INVALID_FLOW_RATE();
        Flow storage flow = _flows[token][sender][receiver];
        if (flow.flowRate == 0) revert IConstantFlowAgreementV1.CFA_FLOW_DOES_NOT_EXIST();
        flow.timestamp = block.timestamp;
        flow.flowRate = flowRate;
    }

    function _deleteFlow(address token, address sender, address receiver) private {
        if (_flows[token][sender][receiver].flowRate == 0) revert IConstantFlowAgreementV1.CFA_FLOW_DOES_NOT_EXIST();
        delete _flows[token][sender][receiver];
    }

    function _requirePermission(address token, address sender, address operator, uint8 bit, bytes4 errorSelector)
        private
        view
    {
        if (_permissions[token][sender][operator] & bit == 0) {
            bytes memory data = abi.encodeWithSelector(errorSelector);
            assembly ("memory-safe") {
                revert(add(data, 32), mload(data))
            }
        }
    }

    function _consumeAllowance(address token, address sender, address operator, int96 amount) private {
        int96 allowance = _allowances[token][sender][operator];
        if (allowance == type(int96).max) return;
        if (amount > allowance) revert IConstantFlowAgreementV1.CFA_ACL_FLOW_RATE_ALLOWANCE_EXCEEDED();
        _allowances[token][sender][operator] = allowance - amount;
    }
}

/**
 * @title MockSuperToken
 * @notice `PaymentStream` only ever passes the token address through to the CFA, so this mock
 *         carries nothing but identity metadata.
 */
contract MockSuperToken {
    MockSuperfluid public immutable host;

    constructor(MockSuperfluid _host) {
        host = _host;
    }

    function getHost() external view returns (address) {
        return address(host);
    }

    function name() external pure returns (string memory) {
        return "Super USD Coin";
    }

    function symbol() external pure returns (string memory) {
        return "USDCx";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }
}
