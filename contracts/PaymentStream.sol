// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { PassportRegistry } from "./PassportRegistry.sol";
import { ISuperfluid } from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperfluid.sol";
import { ISuperToken } from "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperToken.sol";
import {
    IConstantFlowAgreementV1
} from "@superfluid-finance/ethereum-contracts/contracts/interfaces/agreements/IConstantFlowAgreementV1.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PaymentStream
 * @notice Pay-per-byte micropayments between passport holders and data providers, settled as
 *         Superfluid constant-flow streams of a Super Token (USDCx on Base).
 *
 * @dev Money model. This contract never holds or moves funds itself. Every stream is a Superfluid
 *      flow whose *sender is the user* and whose receiver is the provider's payout address; the
 *      user's own Super Token balance funds it. The contract only acts as a Superfluid *flow
 *      operator* (ACL) for the user, so before calling {startStream} a user must grant this
 *      contract create/update/delete permission on the Super Token, e.g. via
 *      `IConstantFlowAgreementV1.authorizeFlowOperatorWithFullControl` through the host, or the
 *      CFAv1Forwarder's `grantPermissions`. Permission can be revoked by the user at any time.
 *
 *      Streams are keyed by (user, provider). Superfluid itself keys flows by
 *      (token, sender, receiver), which leads to the known limitations below.
 *
 * @custom:limitation One live flow per (user, receiver). If two providers share a payout address, or
 *      the user already streams to that address outside this contract, {startStream} reverts with
 *      {StreamOperationFailed} wrapping `CFA_FLOW_ALREADY_EXISTS`. Flows are not aggregated.
 * @custom:limitation Superfluid is the source of truth. A user (or a liquidator, if the user runs
 *      out of balance) can delete a flow directly in Superfluid; this contract learns about it only
 *      when {stopStream} is called, which reconciles local state without reverting. Reads from
 *      {getStreamInfo} reflect the last state written through this contract, not the live flow.
 * @custom:limitation Usage accounting is reported by trusted meters. `recordConsumption` is
 *      restricted to addresses the owner has enabled as meters (e.g. the gateway), and a meter can
 *      never attribute bytes to its own provider record. The contract cannot verify off-chain
 *      byte counts; it enforces who may report, not what they report.
 * @custom:limitation A provider's rate change does not touch existing flows. Each stream keeps the
 *      flow rate it was created with until the user calls {updateStream} or {stopStream}.
 */
contract PaymentStream is Ownable, Pausable, ReentrancyGuard {
    struct DataProvider {
        /// @dev Address that receives the stream. Immutable for live streams: see `Stream.receiver`.
        address receiver;
        /// @dev Price in Super Token wei per byte, scaled by {RATE_PRECISION}.
        uint256 ratePerByte;
        /// @dev Bytes attributed to this provider by meters across all users.
        uint256 totalBytesServed;
        bool active;
    }

    struct Stream {
        /// @dev Receiver the Superfluid flow was opened to. Kept so update/stop target the right
        ///      flow even if the provider re-registers with a different receiver afterwards.
        address receiver;
        /// @dev Flow rate (wei per second) last written through this contract; 0 means no stream.
        int96 flowRate;
        /// @dev Bytes attributed to this stream by meters.
        uint256 bytesConsumed;
        uint256 startedAt;
    }

    PassportRegistry public immutable passportRegistry;
    ISuperfluid public immutable superfluid;
    IConstantFlowAgreementV1 public immutable cfa;
    ISuperToken public immutable usdcx;

    /// @notice Fixed-point scale of `ratePerByte`: `ratePerByte = RATE_PRECISION` is 1 wei per byte.
    uint256 public constant RATE_PRECISION = 1e18;
    /// @notice Smallest flow rate (wei per second) a stream may be opened or updated to.
    int96 public constant MIN_FLOW_RATE = 1;
    /// @notice Largest flow rate Superfluid can represent (`type(int96).max`), as an unsigned value.
    uint256 public constant MAX_FLOW_RATE = uint256(uint96(type(int96).max));

    mapping(address provider => DataProvider) public dataProviders;
    mapping(address user => mapping(address provider => Stream)) public streams;
    /// @notice Addresses allowed to report usage through {recordConsumption}.
    mapping(address meter => bool allowed) public meters;

    event ProviderRegistered(address indexed provider, address receiver, uint256 ratePerByte);
    event ProviderUpdated(address indexed provider, uint256 newRate);
    event ProviderDeregistered(address indexed provider);
    event MeterUpdated(address indexed meter, bool allowed);
    event StreamStarted(address indexed user, address indexed provider, address receiver, int96 flowRate);
    event StreamUpdated(address indexed user, address indexed provider, int96 newFlowRate);
    event StreamStopped(address indexed user, address indexed provider);
    event BytesConsumed(address indexed user, address indexed provider, uint256 bytesConsumed);

    error NotPassportHolder();
    error ProviderNotActive();
    error InvalidProvider();
    error InvalidFlowRate();
    error FlowRateOverflow();
    error StreamAlreadyActive();
    error StreamNotActive();
    error NotMeter();
    error SelfMetering();
    /// @dev Raised when the Superfluid host rejects a flow operation; `reason` is the host's revert data.
    error StreamOperationFailed(bytes reason);

    modifier onlyPassportHolder() {
        if (!passportRegistry.hasPassport(msg.sender)) {
            revert NotPassportHolder();
        }
        _;
    }

    modifier onlyMeter() {
        if (!meters[msg.sender]) {
            revert NotMeter();
        }
        _;
    }

    constructor(address _passportRegistry, address _superfluid, address _cfa, address _usdcx) {
        if (_passportRegistry == address(0) || _superfluid == address(0) || _cfa == address(0) || _usdcx == address(0))
        {
            revert InvalidProvider();
        }
        passportRegistry = PassportRegistry(_passportRegistry);
        superfluid = ISuperfluid(_superfluid);
        cfa = IConstantFlowAgreementV1(_cfa);
        usdcx = ISuperToken(_usdcx);
    }

    // ---------------------------------------------------------------------
    // Providers
    // ---------------------------------------------------------------------

    /// @notice Register the caller as a data provider, or update an existing registration.
    /// @dev Re-registering keeps `totalBytesServed`. Live streams keep streaming to the receiver
    ///      they were opened with (see `Stream.receiver`).
    /// @param receiver Address that receives payment streams
    /// @param ratePerByte Price in Super Token wei per byte, scaled by {RATE_PRECISION}
    function registerProvider(address receiver, uint256 ratePerByte) external whenNotPaused {
        if (receiver == address(0)) {
            revert InvalidProvider();
        }

        DataProvider storage provider = dataProviders[msg.sender];
        provider.receiver = receiver;
        provider.ratePerByte = ratePerByte;
        provider.active = true;

        emit ProviderRegistered(msg.sender, receiver, ratePerByte);
    }

    /// @notice Update the caller's price per byte. Existing streams are unaffected until updated.
    /// @param newRate New price in Super Token wei per byte, scaled by {RATE_PRECISION}
    function updateProviderRate(uint256 newRate) external whenNotPaused {
        DataProvider storage provider = dataProviders[msg.sender];
        if (!provider.active) {
            revert ProviderNotActive();
        }

        provider.ratePerByte = newRate;
        emit ProviderUpdated(msg.sender, newRate);
    }

    /// @notice Deactivate the caller's provider record. No new streams can be opened to it; users
    ///         with live streams can still stop them.
    function deregisterProvider() external whenNotPaused {
        DataProvider storage provider = dataProviders[msg.sender];
        if (!provider.active) {
            revert ProviderNotActive();
        }

        provider.active = false;
        emit ProviderDeregistered(msg.sender);
    }

    /// @notice Allow or disallow an address to report usage through {recordConsumption}.
    /// @dev Meters are trusted infrastructure (the metering gateway). Do not enable providers.
    function setMeter(address meter, bool allowed) external onlyOwner {
        if (meter == address(0)) {
            revert InvalidProvider();
        }
        meters[meter] = allowed;
        emit MeterUpdated(meter, allowed);
    }

    // ---------------------------------------------------------------------
    // Streams
    // ---------------------------------------------------------------------

    /// @notice Open a payment stream from the caller to `provider`, funded by the caller's own
    ///         Super Token balance.
    /// @dev Requires the caller to have granted this contract flow-operator permission on `usdcx`.
    /// @param provider Provider address
    /// @param bytesPerSecond Expected consumption rate; the flow rate is `ratePerByte * bytesPerSecond`
    function startStream(address provider, uint256 bytesPerSecond)
        external
        onlyPassportHolder
        whenNotPaused
        nonReentrant
    {
        DataProvider memory providerData = dataProviders[provider];
        if (!providerData.active) {
            revert ProviderNotActive();
        }
        if (streams[msg.sender][provider].flowRate != 0) {
            revert StreamAlreadyActive();
        }

        int96 flowRate = calculateFlowRate(providerData.ratePerByte, bytesPerSecond);
        if (flowRate < MIN_FLOW_RATE) {
            revert InvalidFlowRate();
        }

        _callCfa(
            abi.encodeCall(cfa.createFlowByOperator, (usdcx, msg.sender, providerData.receiver, flowRate, new bytes(0)))
        );

        streams[msg.sender][provider] = Stream({
            receiver: providerData.receiver, flowRate: flowRate, bytesConsumed: 0, startedAt: block.timestamp
        });
        emit StreamStarted(msg.sender, provider, providerData.receiver, flowRate);
    }

    /// @notice Re-price an existing stream at the provider's current rate for a new consumption rate.
    /// @param provider Provider address
    /// @param newBytesPerSecond New expected consumption rate
    function updateStream(address provider, uint256 newBytesPerSecond)
        external
        onlyPassportHolder
        whenNotPaused
        nonReentrant
    {
        Stream storage stream = streams[msg.sender][provider];
        if (stream.flowRate == 0) {
            revert StreamNotActive();
        }
        DataProvider memory providerData = dataProviders[provider];
        if (!providerData.active) {
            revert ProviderNotActive();
        }

        int96 newFlowRate = calculateFlowRate(providerData.ratePerByte, newBytesPerSecond);
        if (newFlowRate < MIN_FLOW_RATE) {
            revert InvalidFlowRate();
        }

        _callCfa(
            abi.encodeCall(cfa.updateFlowByOperator, (usdcx, msg.sender, stream.receiver, newFlowRate, new bytes(0)))
        );

        stream.flowRate = newFlowRate;
        emit StreamUpdated(msg.sender, provider, newFlowRate);
    }

    /// @notice Close the caller's stream to `provider`.
    /// @dev Deliberately callable while paused and without a passport: a user must always be able to
    ///      stop their own outgoing flow. If the flow was already removed in Superfluid (deleted by
    ///      the user directly, or liquidated), only the local record is cleared.
    /// @param provider Provider address
    function stopStream(address provider) external nonReentrant {
        Stream memory stream = streams[msg.sender][provider];
        if (stream.flowRate == 0) {
            revert StreamNotActive();
        }

        (, int96 liveFlowRate,,) = cfa.getFlow(usdcx, msg.sender, stream.receiver);
        if (liveFlowRate != 0) {
            _callCfa(abi.encodeCall(cfa.deleteFlowByOperator, (usdcx, msg.sender, stream.receiver, new bytes(0))));
        }

        delete streams[msg.sender][provider];
        emit StreamStopped(msg.sender, provider);
    }

    // ---------------------------------------------------------------------
    // Metering
    // ---------------------------------------------------------------------

    /// @notice Attribute `bytesConsumed` served by `provider` to `user`'s active stream.
    /// @dev Only enabled meters may call this, and never for their own provider record.
    /// @param user Stream sender (passport holder)
    /// @param provider Provider that served the bytes
    /// @param bytesConsumed Number of bytes served
    function recordConsumption(address user, address provider, uint256 bytesConsumed) external onlyMeter whenNotPaused {
        if (msg.sender == provider) {
            revert SelfMetering();
        }
        Stream storage stream = streams[user][provider];
        if (stream.flowRate == 0) {
            revert StreamNotActive();
        }

        stream.bytesConsumed += bytesConsumed;
        dataProviders[provider].totalBytesServed += bytesConsumed;
        emit BytesConsumed(user, provider, bytesConsumed);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Flow rate for a price and consumption rate, reverting instead of truncating.
    /// @param ratePerByte Price in Super Token wei per byte, scaled by {RATE_PRECISION}
    /// @param bytesPerSecond Expected consumption rate
    /// @return flowRate `ratePerByte * bytesPerSecond / RATE_PRECISION` as a Superfluid int96
    function calculateFlowRate(uint256 ratePerByte, uint256 bytesPerSecond) public pure returns (int96 flowRate) {
        // A product that does not fit uint256 is, after dividing by 1e18, still far above int96.
        if (ratePerByte != 0 && bytesPerSecond > type(uint256).max / ratePerByte) {
            revert FlowRateOverflow();
        }
        uint256 rate = (ratePerByte * bytesPerSecond) / RATE_PRECISION;
        if (rate > MAX_FLOW_RATE) {
            revert FlowRateOverflow();
        }
        // Safe: `rate <= MAX_FLOW_RATE == int96.max`, checked just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return int96(uint96(rate));
    }

    /// @notice Last stream state written through this contract for (user, provider).
    /// @dev Not the live Superfluid flow; see the contract-level limitations.
    function getStreamInfo(address user, address provider) external view returns (int96 flowRate, address receiver) {
        Stream storage stream = streams[user][provider];
        return (stream.flowRate, stream.receiver);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Pause provider registration, stream opening/updating and metering. Stopping is always allowed.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause contract
    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev Routes a CFA call through the Superfluid host (which injects the real ctx in place of
    ///      the empty placeholder) and surfaces any failure as a typed error carrying the reason.
    function _callCfa(bytes memory callData) private {
        try superfluid.callAgreement(cfa, callData, new bytes(0)) { }
        catch (bytes memory reason) {
            revert StreamOperationFailed(reason);
        }
    }
}
