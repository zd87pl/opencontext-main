# AGENTS.md — conventions for coding agents in this repository

A cheat-sheet for Codex, Copilot, Claude Code and any other agent that reads or writes code here. [CLAUDE.md](CLAUDE.md) has the layout and the commands; this file has the rules.

## 1 · Project map

| Path | What lives here | Notes for agents |
|---|---|---|
| `vault/` | **The product.** TypeScript MCP server + CLI, its own lockfile, lint gate, tests, `SPEC.md`, `SECURITY.md`, `CHANGELOG.md` | Node ≥ 20, pure ESM, `tsc --strict`, vitest. Two direct runtime deps (`@modelcontextprotocol/sdk`, `zod`; `npm ci --omit=dev` installs 95 packages, 93 of them via the SDK). No network code, no LLM calls, nothing imported from `../`. Change `SPEC.md` and the JSON schema together with `src/types.ts` |
| `contracts/` | Solidity (Foundry) | Experimental. Not deployed, not audited. `PassportRegistry` is a non-transferable ERC-721 and is not zero-knowledge. Deps are submodules in `lib/` |
| `sdk/js/`, `sdk/python/` | Clients for the contracts | ABIs are pinned to compiler output; regenerate when a contract's interface changes |
| `gateway/` | Fastify metering proxy | DePIN node endpoints are placeholders; auth state is in-memory |
| `backend/` | June 2025 marketplace API (Express + Prisma) | Simulated USDC settlement; `/mcp` is custom JSON-RPC, not the MCP protocol. Keep it compiling; do not extend it |
| `wordpress-plugin/`, `demo/`, `demo.js`, `demo.py` | June 2025 prototypes | Untested; `demo.js` and `demo.py` do not run from a fresh clone and need undeployed contract addresses (see [DEMO.md](DEMO.md)) |
| `docs/archive/` | June 2025 planning documents | Read-only history; never cite their numbers |
| `docs/launch/` | Show HN material | |
| `.github/workflows/` | `ci.yml`, `vault.yml`, `security.yml` | Touch only when the pipeline demands it |

Do not commit `.env`, keys, vault directories, `dist/`, `node_modules/` or fixtures over 5 MB. Vault test fixtures are synthetic and fictional; keep them that way.

## 2 · Coding conventions

### 2.1 General
1. Languages: TypeScript (vault, SDK, gateway, backend), Solidity (contracts), Python (SDK), PHP (plugin, frozen).
2. Formatting: vault has no Prettier/ESLint, `tsc --strict` plus `scripts/lint.mjs` is the gate · `forge fmt` · `eslint` (sdk/js, gateway, backend) · `black` + `ruff`.
3. Comments explain **why**, not **what**. NatSpec / JSDoc on public surfaces.
4. Naming: `PascalCase` (contracts, classes, types), `camelCase` (functions, variables), `SCREAMING_SNAKE_CASE` (constants).
5. Errors: custom Solidity errors (`error AlreadyMinted();`), typed TS errors with codes (the vault CLI prints `CODE: message` and exits 2), Python exceptions.

### 2.2 Vault (TypeScript)

| Topic | Rule |
|---|---|
| Modules | Pure ESM, named exports, absolute `node:` imports |
| Forbidden | `console.log` in `src/` (stdout is the MCP transport; diagnostics go to stderr), `node:http`/`https`/`net`/`dns`/`tls`, `fetch`, `WebSocket`, `any`, `@ts-ignore` |
| Secrets | Tokens are printed once by `grant` and stored only as hashes; `test/canary.test.ts` proves the audit log, stderr, errors and exports never contain a token, key or passphrase. Keep it true |
| Audit | Every tool/resource/prompt handler writes its audit entry before returning; a failed write fails the call |
| Formats | Changing a record shape means: `src/types.ts`, `npm run schema`, `SPEC.md`, a test vector if the on-disk envelope changed, a `CHANGELOG.md` line |
| Help text | `README.md`'s CLI block is generated; regenerate it or `test/cli-help.test.ts` fails |

### 2.3 Solidity

| Rule | Example |
|---|---|
| Version pragma | `pragma solidity ^0.8.24;` |
| Libraries | `@openzeppelin/contracts` via `lib/` submodules and `remappings.txt` |
| Upgradeability | None; the contracts are experiments |
| Tests | Foundry (`forge test -vv`) in `contracts/test` |

### 2.4 TypeScript (SDK, gateway, backend)

| Topic | Rule |
|---|---|
| Modules | Pure ESM (`"type": "module"`) |
| Build / test | `tsup` (sdk/js, gateway) or `tsc` (backend); `vitest` |
| Public API | Named exports only |
| Errors | Typed error classes / enums for predictable throws |

### 2.5 Python (SDK)

| Topic | Rule |
|---|---|
| Packaging | Poetry, `pyproject.toml` |
| Async | All network calls `async`/`await` |
| Testing | `pytest` + `pytest-asyncio` |
| Typing | `mypy --strict` must pass |

## 3 · Documentation rules

Every number in a README, changelog or launch document comes from a command run in the same change (test counts, coverage, timings) and says where it came from. Vault test counts name the user and `CI` setting that produced them (one test skips as root or on Windows, one under `CI=1`); coverage is quoted rounded, together with the enforced thresholds, because the second decimal moves between runs and users. Words that do not appear in this repository's documentation: "zero-knowledge" (except to say the registry is not), "military-grade", "audited" (except "not audited"), "unhackable", "tamper-proof" (the vault's journals are tamper-evident), "production-ready", and status badges for a workflow that has no green run on `main`. Prefer "experimental", "simulated", "placeholder", "not deployed", "untested" where they apply.

## 4 · Testing and checks

| Stack | Command | In CI |
|---|---|---|
| Vault | `cd vault && npm run lint && npm run test:coverage` | `vault.yml`, Node 20/22 × ubuntu/macos, `CI=1` |
| Solidity | `forge build && forge test -vv && forge fmt --check` | `ci.yml` |
| sdk/js | `npm test && npm run typecheck && npm run build` | `ci.yml`, Node 20/22 |
| sdk/python | `poetry run pytest -q && poetry run mypy --strict opencontext` | `ci.yml`, Python 3.11/3.13 |
| Gateway, backend | `npm test && npm run typecheck` | `ci.yml` |
| Slither / Mythril / Semgrep | `security.yml` | Slither and Mythril steps are `continue-on-error` |

Coverage: vault thresholds 80 % lines/functions/statements, 70 % branches (enforced); contracts ≥ 90 % and SDKs ≥ 80 % are goals.

## 5 · Pull-request checklist

1. One feature or fix per PR, with a one-sentence summary and bullets.
2. Linked issue (`Closes #123`) when one exists.
3. The suite of every package you touched is green locally.
4. Logs or output for CLI changes; a `CHANGELOG.md` line for a vault change.
5. No unintended lockfile changes (`package-lock.json`, `poetry.lock`, `foundry.lock`).
6. No new claims in docs without the command that proves them.

## 6 · Commit message format

```
<type>: <subject>            # ≤ 50 chars, imperative mood; a scope is fine: feat(vault): ...

<body>                       # optional, wrap at 72 chars, say why

BREAKING CHANGE: <details>   # only if behaviour or a format breaks
```

`type` must be one of `feat | fix | docs | refactor | test | ci | chore`.

## 7 · Markers

Use `TODO(op-context): …` for future work. Reusable prompts for the vault live in `vault/src/mcp/prompts.ts` (`distill`, `capture`); add new ones there with their scope requirements in the text.
