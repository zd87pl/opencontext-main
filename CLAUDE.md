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

### TypeScript SDK (not yet implemented)
```bash
cd sdk/js
npm ci          # Install dependencies
npm test        # Run tests with vitest
npm run build   # Build with tsup
```

### Python SDK (not yet implemented)
```bash
cd sdk/python
poetry install  # Install dependencies
pytest -q       # Run tests
mypy --strict   # Type checking
```

### Unified Commands (when Makefile is implemented)
```bash
make setup      # Install all dependencies
make test       # Run all tests
make lint       # Run all linters
```

## Architecture & Code Organization

### Directory Structure
```
opencontext-main/
├─ contracts/           # Solidity smart contracts (Foundry)
│  └─ PassportRegistry.sol  # ERC-721 soulbound token (stub)
├─ sdk/                 # Client SDKs (planned)
│  ├─ js/              # TypeScript SDK
│  └─ python/          # Python SDK
├─ docs/               # Documentation
├─ specs/              # Protocol specifications (planned)
├─ governance/         # Tokenomics/DAO docs (planned)
└─ ops/                # Infrastructure (planned)
```

### Key Components

1. **PassportRegistry** (contracts/PassportRegistry.sol)
   - ERC-721 based soulbound token (SBT) for user identity
   - Currently a stub with mint/revoke functions to be implemented
   - Uses OpenZeppelin ERC721 base contract

2. **ContextVault** (not yet implemented)
   - Will store encrypted conversation history and preferences
   - Portable across AI assistants

3. **Payment Rail** (not yet implemented)
   - Superfluid integration for constant-flow USDC streams
   - Sub-cent micropayments for data/API/compute usage

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

The project is in Phase 0/1 (Foundation/Core PoC) as of June 2025:
- PassportRegistry.sol exists as a stub
- No SDKs, tests, or build configuration yet
- Focus on implementing core smart contracts and basic SDK functionality

### Phase 1 Exit Criteria
- [ ] PassportRegistry.sol with unit tests merged
- [ ] ContextVault.sol storage stub committed
- [ ] JS SDK authenticate() works against zkSync Sepolia
- [ ] CI badge in README is green

## AI Agent Integration Notes

When implementing features:
1. Check AGENTS.md for detailed AI-specific guidelines
2. Follow existing patterns in the codebase
3. Verify deployment targets: zkSync for identity/vault, Base for payments
4. Always run formatters and linters before committing
5. Keep PRs focused on single features/fixes