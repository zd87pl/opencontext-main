// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "./PassportRegistry.sol";
import "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperfluid.sol";
import "@superfluid-finance/ethereum-contracts/contracts/interfaces/superfluid/ISuperToken.sol";
import "@superfluid-finance/ethereum-contracts/contracts/interfaces/agreements/IConstantFlowAgreementV1.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PaymentStream
 * @notice Handles micropayments using Superfluid constant flow agreements
 * @dev Integrates with Superfluid on Base for USDC streaming payments
 */
contract PaymentStream is Ownable, Pausable, ReentrancyGuard {
    PassportRegistry public immutable passportRegistry;
    ISuperfluid public immutable superfluid;
    IConstantFlowAgreementV1 public immutable cfa;
    ISuperToken public immutable usdcx;
    
    struct DataProvider {
        address receiver;
        uint256 ratePerByte;
        uint256 totalBytesServed;
        bool active;
    }
    
    mapping(address => DataProvider) public dataProviders;
    mapping(uint256 => mapping(address => int96)) public activeStreams;
    
    uint256 public constant MIN_FLOW_RATE = 1; // 1 wei per second minimum
    uint256 public constant RATE_PRECISION = 1e18;
    
    event ProviderRegistered(address indexed provider, address receiver, uint256 ratePerByte);
    event ProviderUpdated(address indexed provider, uint256 newRate);
    event StreamStarted(uint256 indexed tokenId, address indexed provider, int96 flowRate);
    event StreamUpdated(uint256 indexed tokenId, address indexed provider, int96 newFlowRate);
    event StreamStopped(uint256 indexed tokenId, address indexed provider);
    event BytesConsumed(uint256 indexed tokenId, address indexed provider, uint256 bytes);
    
    error NotPassportHolder();
    error ProviderNotActive();
    error InvalidFlowRate();
    error StreamOperationFailed();
    error InvalidProvider();
    
    modifier onlyPassportHolder() {
        if (!passportRegistry.hasPassport(msg.sender)) {
            revert NotPassportHolder();
        }
        _;
    }
    
    constructor(
        address _passportRegistry,
        address _superfluid,
        address _cfa,
        address _usdcx
    ) {
        passportRegistry = PassportRegistry(_passportRegistry);
        superfluid = ISuperfluid(_superfluid);
        cfa = IConstantFlowAgreementV1(_cfa);
        usdcx = ISuperToken(_usdcx);
    }
    
    /// @notice Register as a data provider
    /// @param receiver Address to receive payments
    /// @param ratePerByte Rate in wei per byte
    function registerProvider(address receiver, uint256 ratePerByte) external whenNotPaused {
        if (receiver == address(0)) {
            revert InvalidProvider();
        }
        
        dataProviders[msg.sender] = DataProvider({
            receiver: receiver,
            ratePerByte: ratePerByte,
            totalBytesServed: 0,
            active: true
        });
        
        emit ProviderRegistered(msg.sender, receiver, ratePerByte);
    }
    
    /// @notice Update provider rate
    /// @param newRate New rate per byte
    function updateProviderRate(uint256 newRate) external whenNotPaused {
        DataProvider storage provider = dataProviders[msg.sender];
        if (!provider.active) {
            revert ProviderNotActive();
        }
        
        provider.ratePerByte = newRate;
        emit ProviderUpdated(msg.sender, newRate);
    }
    
    /// @notice Start a payment stream to a provider
    /// @param provider Provider address
    /// @param bytesPerSecond Expected bytes per second consumption
    function startStream(address provider, uint256 bytesPerSecond) external onlyPassportHolder whenNotPaused nonReentrant {
        DataProvider memory providerData = dataProviders[provider];
        if (!providerData.active) {
            revert ProviderNotActive();
        }
        
        uint256 tokenId = passportRegistry.getTokenId(msg.sender);
        int96 flowRate = _calculateFlowRate(providerData.ratePerByte, bytesPerSecond);
        
        if (flowRate < int96(MIN_FLOW_RATE)) {
            revert InvalidFlowRate();
        }
        
        try superfluid.callAgreement(
            cfa,
            abi.encodeWithSelector(
                cfa.createFlow.selector,
                usdcx,
                providerData.receiver,
                flowRate,
                new bytes(0)
            ),
            "0x"
        ) {
            activeStreams[tokenId][provider] = flowRate;
            emit StreamStarted(tokenId, provider, flowRate);
        } catch {
            revert StreamOperationFailed();
        }
    }
    
    /// @notice Update an existing stream
    /// @param provider Provider address
    /// @param newBytesPerSecond New consumption rate
    function updateStream(address provider, uint256 newBytesPerSecond) external onlyPassportHolder whenNotPaused nonReentrant {
        DataProvider memory providerData = dataProviders[provider];
        if (!providerData.active) {
            revert ProviderNotActive();
        }
        
        uint256 tokenId = passportRegistry.getTokenId(msg.sender);
        int96 currentFlow = activeStreams[tokenId][provider];
        
        if (currentFlow == 0) {
            revert InvalidFlowRate();
        }
        
        int96 newFlowRate = _calculateFlowRate(providerData.ratePerByte, newBytesPerSecond);
        
        try superfluid.callAgreement(
            cfa,
            abi.encodeWithSelector(
                cfa.updateFlow.selector,
                usdcx,
                providerData.receiver,
                newFlowRate,
                new bytes(0)
            ),
            "0x"
        ) {
            activeStreams[tokenId][provider] = newFlowRate;
            emit StreamUpdated(tokenId, provider, newFlowRate);
        } catch {
            revert StreamOperationFailed();
        }
    }
    
    /// @notice Stop a payment stream
    /// @param provider Provider address
    function stopStream(address provider) external onlyPassportHolder whenNotPaused nonReentrant {
        DataProvider memory providerData = dataProviders[provider];
        uint256 tokenId = passportRegistry.getTokenId(msg.sender);
        int96 currentFlow = activeStreams[tokenId][provider];
        
        if (currentFlow == 0) {
            return;
        }
        
        try superfluid.callAgreement(
            cfa,
            abi.encodeWithSelector(
                cfa.deleteFlow.selector,
                usdcx,
                msg.sender,
                providerData.receiver,
                new bytes(0)
            ),
            "0x"
        ) {
            delete activeStreams[tokenId][provider];
            emit StreamStopped(tokenId, provider);
        } catch {
            revert StreamOperationFailed();
        }
    }
    
    /// @notice Record bytes consumed (called by providers)
    /// @param tokenId Consumer's token ID
    /// @param bytesConsumed Number of bytes consumed
    function recordConsumption(uint256 tokenId, uint256 bytesConsumed) external whenNotPaused {
        DataProvider storage provider = dataProviders[msg.sender];
        if (!provider.active) {
            revert ProviderNotActive();
        }
        
        provider.totalBytesServed += bytesConsumed;
        emit BytesConsumed(tokenId, msg.sender, bytesConsumed);
    }
    
    /// @notice Calculate flow rate from bytes per second
    /// @param ratePerByte Rate in wei per byte
    /// @param bytesPerSecond Expected bytes per second
    function _calculateFlowRate(uint256 ratePerByte, uint256 bytesPerSecond)
        private
        pure
        returns (int96)
    {
        uint256 flowRate = (ratePerByte * bytesPerSecond) / RATE_PRECISION;
        // Integer division truncates; revert rather than silently create a zero-rate stream
        if (flowRate == 0) {
            revert InvalidFlowRate();
        }
        return int96(int256(flowRate));
    }
    
    /// @notice Get active stream info
    /// @param tokenId Passport token ID
    /// @param provider Provider address
    function getStreamInfo(uint256 tokenId, address provider) 
        external 
        view 
        returns (int96 flowRate, address receiver) 
    {
        DataProvider memory providerData = dataProviders[provider];
        return (activeStreams[tokenId][provider], providerData.receiver);
    }
    
    /// @notice Pause contract (emergency stop)
    function pause() external onlyOwner {
        _pause();
    }
    
    /// @notice Unpause contract
    function unpause() external onlyOwner {
        _unpause();
    }
}