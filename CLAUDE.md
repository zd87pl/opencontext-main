# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenContext Network is a Web3 infrastructure project building user-owned identity, context vault, and micropayment rails for AI agents. The project consists of:
- **Smart contracts** (Solidity) for ZK-Passport DID and encrypted context storage
- **SDKs** (TypeScript/Python) for client integration
- **Micropayment layer** using Superfluid for streaming USDC payments

## Development Commands

### Smart Contracts (Solidity/Foundry)
```bash
# Run tests
cd contracts && forge test -vv

# Format code
forge fmt

# Security analysis (when implemented)
slither .
```

### TypeScript SDK
```bash
cd sdk/js
npm ci          # Install dependencies
npm test        # Run tests with vitest
npm run build   # Build with tsup
npm run typecheck # Type checking
```

### Python SDK
```bash
cd sdk/python
poetry install  # Install dependencies
pytest -q       # Run tests
mypy --strict   # Type checking
```

### Gateway Services
```bash
cd gateway
npm ci          # Install dependencies
npm test        # Run tests
npm run dev     # Start development server
npm run build   # Build for production
```

### Unified Commands
```bash
make setup      # Install all dependencies (Foundry, Node, Python)
make test       # Run all tests (contracts, SDKs, gateway, integration)
make lint       # Run all linters
make typecheck  # Type check all TypeScript code
make gateway    # Start gateway server
make env-check  # Validate environment configuration
```

## Architecture & Code Organization

### Directory Structure
```
opencontext-main/
├─ config/             # Environment configuration with validation
├─ contracts/          # Solidity smart contracts (Foundry)
│  ├─ PassportRegistry.sol  # ERC-721 soulbound token
│  ├─ ContextVault.sol     # Encrypted context storage
│  ├─ PaymentStream.sol    # Superfluid micropayments
│  └─ test/               # Comprehensive contract tests
├─ sdk/                # Client SDKs
│  ├─ js/             # TypeScript SDK (complete)
│  └─ python/         # Python SDK (complete)
├─ gateway/           # Phase 2 proxy infrastructure
│  ├─ src/           # Core gateway services
│  ├─ partners/      # Partner integration modules
│  ├─ examples/      # Demo scripts
│  └─ test/          # Gateway test suite
├─ test/             # Integration tests
│  └─ integration/   # End-to-end test suite
├─ docs/             # Documentation
└─ .env.example      # Environment configuration template
```

### Key Components

1. **PassportRegistry** (contracts/PassportRegistry.sol)
   - ERC-721 based soulbound token (SBT) for user identity
   - Mint/revoke functions with access control
   - Data hash storage for off-chain metadata
   - Non-transferable (soulbound) implementation

2. **ContextVault** (contracts/ContextVault.sol)
   - Encrypted conversation history and preferences storage
   - Access control with reader authorization
   - Storage quotas and usage tracking
   - Versioned context with deletion capabilities

3. **PaymentStream** (contracts/PaymentStream.sol)
   - Superfluid integration for constant-flow USDC streams
   - Provider registration and rate management
   - Usage tracking and automatic billing
   - Sub-cent micropayments for data/API/compute usage

4. **Gateway Proxy** (gateway/)
   - HTTP proxy with request metering
   - Partner API integration (Newswire, GitHub, Satellite, DePIN)
   - OAuth authentication and wallet linking
   - Large file streaming with chunked payments
   - AI inference job routing

5. **SDKs** (sdk/)
   - TypeScript SDK with ethers v6 integration
   - Python SDK with web3-py and async support
   - AES-256-GCM encryption for context data
   - Complete API coverage for all contracts

### Technology Stack
- **Blockchain**: zkSync (zk-EVM L2), Base (for Superfluid)
- **Smart Contracts**: Solidity ^0.8.24, OpenZeppelin, Foundry
- **JS SDK**: Node 20+, ESM modules, ethers v6, vitest
- **Python SDK**: Python 3.11+, Poetry, web3-py, pytest-asyncio
- **Standards**: ERC-4337 (Account Abstraction), ERC-721 (NFTs)

## Development Guidelines

### Code Style
- **Solidity**: Use `pragma solidity ^0.8.24`, SPDX-License-Identifier: MIT
- **TypeScript**: Pure ESM, named exports only
- **Python**: async/await for network calls, mypy --strict must pass
- **Comments**: Explain why, not what; use NatSpec/JSDoc
- **Errors**: Custom Solidity errors, typed TS errors, Python exceptions

### Testing Requirements
- **Solidity**: ≥90% coverage with Foundry tests
- **JS/Python**: ≥80% coverage
- Tests go in `/contracts/test`, `/sdk/js/test`, `/sdk/python/tests`

### Git Workflow
- Commit format: `<type>: <subject>` where type is `feat|fix|docs|refactor|test|ci|chore`
- PR requirements: Clear description, linked issue, all tests passing
- Use `TODO(op-context): ...` for future work markers

## Current Development Phase

The project is in Phase 2 (Testnet Pilots) as of June 2025:
- Phase 1 completed with all smart contracts and SDKs implemented
- Phase 2 gateway infrastructure deployed with partner integrations
- Focus on testnet deployment and partner onboarding

### Phase 1 Exit Criteria ✅
- [x] PassportRegistry.sol with comprehensive unit tests
- [x] ContextVault.sol with encryption and access control
- [x] PaymentStream.sol with Superfluid integration
- [x] JS & Python SDKs with authenticate(), vault operations, streaming payments
- [x] Gateway proxy system with API metering and micropayments
- [x] Comprehensive test coverage (>90% contracts, >80% SDKs)

### Phase 2 Current Focus
- Partner integrations (Newswire, GitHub, Satellite, DePIN)
- Production-ready infrastructure and monitoring
- Environment management and security hardening

## AI Agent Integration Notes

When implementing features:
1. Check AGENTS.md for detailed AI-specific guidelines
2. Follow existing patterns in the codebase
3. Verify deployment targets: zkSync for identity/vault, Base for payments
4. Always run formatters and linters before committing
5. Keep PRs focused on single features/fixes