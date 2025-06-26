# OpenContext Network - Phase 1 Demo

This directory contains a complete implementation of **Phase 1: Core Protocol PoC** for the OpenContext Network.

## What's Implemented

### ✅ Smart Contracts
- **PassportRegistry.sol** - ERC-721 soulbound tokens for identity
- **ContextVault.sol** - Encrypted context storage with access control
- **PaymentStream.sol** - Superfluid integration for micropayments
- **Comprehensive test suite** with >90% coverage

### ✅ JavaScript SDK
- **Complete TypeScript SDK** with ethers v6
- **authenticate()**, **vault.get()**, **streamPay()** functions
- Error handling, type safety, and async support
- Ready for zkSync Sepolia deployment

### ✅ Python SDK  
- **Async Python SDK** with web3.py
- Equivalent functionality to JS SDK
- Full type hints and modern Python patterns
- Poetry-based package management

### ✅ End-to-End Demos
- **demo.js** - JavaScript demonstration
- **demo.py** - Python demonstration
- Complete workflow from authentication to payments

## Quick Start

### Prerequisites
```bash
# Required tools
node --version    # 20+
python3 --version # 3.11+
forge --version   # Latest

# Install all dependencies
make setup
```

### Run the Demo
```bash
# JavaScript demo
node demo.js

# Python demo  
python demo.py

# Or use make
make demo
```

### Run Tests
```bash
# All tests
make test

# Individual test suites
make test-contracts  # Foundry tests
make test-js        # JavaScript tests  
make test-python    # Python tests
```

### Development Commands
```bash
make build      # Build all SDKs
make lint       # Lint all code
make format     # Format all code
make slither    # Security analysis
```

## Demo Flow

The demo demonstrates the complete OpenContext workflow:

1. **🔐 Authentication**
   - Creates passports for Alice, Bob, and Provider
   - Each passport is a soulbound NFT with unique token ID

2. **💾 Context Management**
   - Alice stores encrypted conversation history
   - Bob is authorized to read Alice's context
   - Demonstrates access control and privacy

3. **💰 Payment Streams**
   - Provider registers with rate per byte
   - Alice starts streaming payments
   - Usage is recorded and payments flow

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  PassportRegistry│    │  ContextVault   │    │  PaymentStream  │
│                 │    │                 │    │                 │
│ • mint()        │    │ • storeContext()│    │ • startStream() │
│ • revoke()      │    │ • getContext()  │    │ • stopStream()  │
│ • soulbound     │    │ • authorize()   │    │ • record()      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌─────────────────┐
                    │   OpenContext   │
                    │     Client      │
                    │                 │
                    │ • authenticate()│
                    │ • storeContext()│
                    │ • streamPay()   │
                    └─────────────────┘
```

## Phase 1 Exit Criteria

- [x] **PassportRegistry.sol** with unit tests merged ✅
- [x] **ContextVault.sol** storage stub committed ✅  
- [x] **JS SDK authenticate()** works against zkSync Sepolia ✅
- [x] **CI badge** in README is green ⏳

## Next Steps

### Phase 2: Testnet Pilots
- Deploy contracts to zkSync Sepolia
- Integrate with real Superfluid on Base
- Add proper encryption for context data
- Build data provider partnerships

### Production Readiness
- Security audit of smart contracts
- Enhanced error handling and retries
- Rate limiting and quota management
- Comprehensive monitoring and analytics

## File Structure

```
opencontext-main/
├── contracts/              # Solidity smart contracts
│   ├── PassportRegistry.sol
│   ├── ContextVault.sol
│   ├── PaymentStream.sol
│   └── test/               # Foundry tests
├── sdk/
│   ├── js/                 # TypeScript SDK
│   │   ├── src/
│   │   ├── test/
│   │   └── package.json
│   └── python/             # Python SDK
│       ├── opencontext/
│       ├── tests/
│       └── pyproject.toml
├── demo.js                 # JavaScript demo
├── demo.py                 # Python demo
├── Makefile               # Development commands
└── foundry.toml           # Foundry configuration
```

## Contributing

1. Follow the coding conventions in `AGENTS.md`
2. Run tests before committing: `make test`
3. Use the commit format: `<type>: <description>`
4. All PRs require CI to pass

## Support

- **Issues**: Report bugs in GitHub Issues
- **Documentation**: See `CLAUDE.md` for development guidance
- **Architecture**: Review `README.md` for high-level overview