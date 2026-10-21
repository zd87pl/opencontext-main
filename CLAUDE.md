# CLAUDE.md

Guidance for Claude Code (claude.ai/code) and any other coding agent working in this repository.

## What this repository is

The product is **OpenContext Vault** in `vault/`: a user-owned, encrypted, portable memory for AI agents, served as a local MCP server over stdio (TypeScript, Node 20+, pure ESM, two direct runtime dependencies (`@modelcontextprotocol/sdk`, `zod`), no network code, no LLM calls). Everything else is the experimental Web3 work the project started with in June 2025 and is kept as experiments: Solidity contracts that are **not deployed and not audited**, SDKs for them, a metering gateway, and a content-marketplace backend with simulated payments. The vault imports nothing from the rest of the repository. Read [README.md](README.md) for the per-directory status before touching anything outside `vault/`.

## Layout

```
vault/            the product: src/{store,crypto,search,importers,exporters,access,mcp,cli}, test/, SPEC.md, SECURITY.md
contracts/        Foundry: PassportRegistry (non-transferable ERC-721, not zero-knowledge), ContextVault, ContextVaultIPFS, PaymentStream; tests in contracts/test
lib/              Foundry dependencies as git submodules (forge-std, openzeppelin-contracts, protocol-monorepo)
sdk/js, sdk/python   clients for the contracts; ABIs pinned to compiler output
gateway/          Fastify metering proxy with Superfluid flow verification; DePIN nodes are placeholders
backend/          Express + Prisma marketplace API (June 2025); /mcp is custom JSON-RPC, NOT the MCP protocol; USDC settlement simulated
wordpress-plugin/, demo/, demo.js, demo.py   June 2025 prototypes; the docker demo uses a blockchain simulator; demo.js/demo.py do not run from a fresh clone (DEMO.md)
config/           zod schema for .env
docs/archive/     June 2025 planning documents, historical, unverified
docs/launch/      Show HN material
.github/workflows ci.yml (sdk-js, sdk-python, gateway, backend, contracts), vault.yml, security.yml; README.md "CI status" says whether they have run yet
```

## Commands

Vault (start here):

```bash
cd vault
npm ci                  # exact pins
npm run lint            # tsc --strict over src and test, then scripts/lint.mjs (bans console.log, network imports, any, @ts-ignore)
npm run build           # tsc → dist/ (the spawned-binary tests run against dist/)
npm test                # builds first, then vitest
npm run test:coverage   # thresholds 80/80/80/70 enforced in CI
npm run schema          # regenerate schema/opencontext-vault-export.v1.schema.json after changing src/types.ts
node dist/cli.js --help
```

From the root: `make vault-build`, `make vault-test`, `make vault-lint`. If you change the CLI help text, regenerate the README block (`vault/README.md`, "Development") or `test/cli-help.test.ts` fails.

Everything else:

```bash
git submodule update --init --recursive && forge test -vv && forge fmt --check   # contracts
cd sdk/js && npm ci && npm test && npm run typecheck && npm run build
cd sdk/python && poetry install && poetry run pytest -q && poetry run mypy --strict opencontext
cd gateway && npm ci && npm test && npm run typecheck && npm run build
cd backend && npm ci && npm test && npm run typecheck      # npm ci also runs prisma generate
make setup | make test | make lint | make typecheck         # root aggregates, meant to cover every package (vault and backend included); README.md → Development says what was verified
```

## Rules

- **Vault invariants** (tests enforce them): no network imports in `src/` or `dist/`; no LLM calls; tokens never written after `grant` prints them; every MCP call logged in the audit journal before its result returns; `SPEC.md`, the JSON schema and `src/types.ts` stay in sync; the vault imports nothing from `../`.
- **Honesty in docs**: no coverage or test numbers you did not just produce. Say which user and `CI` setting produced a vault test count (one test skips as root or on Windows, one under `CI=1`), and quote coverage rounded, with the enforced thresholds, because the second decimal moves between runs. No status badge for a workflow without a green run on `main`. No "zero-knowledge" (the registry is not), "military-grade", "audited" (except "not audited"), "unhackable", "tamper-proof", "production-ready". Say "experimental", "simulated", "placeholder", "not deployed", "untested" where it is true.
- Do not edit `docs/archive/`; it is history.
- Solidity: `pragma solidity ^0.8.24`, SPDX MIT, custom errors, NatSpec. TypeScript: pure ESM, named exports, typed errors. Python: async for network calls, `mypy --strict` must pass.
- Comments explain why, not what. Future-work markers are `TODO(op-context): ...`.
- Tests live in `vault/test`, `contracts/test`, `sdk/js/test`, `sdk/python/tests`, `gateway/test`, `backend/src/__tests__`. Coverage targets: vault 80 % lines (70 % branches), contracts ≥ 90 %, SDKs ≥ 80 %.
- Run the formatter and linter of the package you touched before committing.

## Git

- Commit format: `<type>: <subject>` with `type` in `feat|fix|docs|refactor|test|ci|chore`; a scope in parentheses is fine (`feat(vault): ...`).
- One feature or fix per PR, clear description, linked issue, the relevant suite green.
- Never commit `.env`, keys, vault directories, `dist/` or `node_modules/`.

See [AGENTS.md](AGENTS.md) for the per-language conventions and the PR checklist.
