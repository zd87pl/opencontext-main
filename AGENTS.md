# 🤖 Project Agents.md Guide — **OpenContext Network**

This file is a **cheat-sheet for OpenAI Codex, GitHub Copilot Chat, and any other AI agents** that read or write code in this monorepo.  
Follow these rules to stay consistent with our architecture, style-guide, and CI pipeline.

---

## 1 · Project Map for AI Navigation

| Path | What lives here | AI-agent notes |
|------|-----------------|----------------|
| `/contracts` | Solidity sources (Foundry) | Only `.sol` files; use SPDX = MIT & `pragma solidity ^0.8.24` |
| `/sdk/js` | TypeScript client SDK | Node 20+, ESM, `ethers v6` |
| `/sdk/python` | Python client SDK | Python 3.11+, Poetry, `web3-py` |
| `/docs` | MkDocs / Docusaurus | Markdown & Mermaid; no executable code |
| `/specs` | Protocol & interface specs | Read before inventing new APIs |
| `/governance` | Tokenomics & DAO docs | Docs only—do **not** generate code here |
| `/tests` | Extra fixtures (non-Foundry / non-Jest) | Keep unit tests near source when possible |
| `.github/workflows` | CI definitions | Touch only if the pipeline demands it |

> **Do NOT** commit compiled artifacts, `.env`, or large (> 5 MB) fixtures—use GitHub Actions artifacts or IPFS.

---

## 2 · Coding Conventions

### 2.1 General
1. **Languages:** Solidity (on-chain), TypeScript (Node/browser), Python (data tooling).  
2. **Formatting:** `forge fmt` · Prettier · `black`+`ruff`.  
3. **Comments:** Explain **why**, not **what**. Use NatSpec/JSDoc.  
4. **Naming:** `PascalCase` (contracts/classes), `camelCase` (func/var), `SCREAMING_SNAKE_CASE` (const).  
5. **Errors:** Custom Solidity errors (`error AlreadyMinted();`), typed TS errors, Python exceptions.

### 2.2 Solidity

| Rule | Example |
|------|---------|
| Version pragma | `pragma solidity ^0.8.24;` |
| Libraries | Import from `@openzeppelin/contracts` when available. |
| Upgradeability | None in MVP—contracts are immutable at deploy. |
| Tests | Foundry (`forge test -vv`) in `/contracts/test`. |

### 2.3 TypeScript (SDK)

| Topic | Rule |
|-------|------|
| Modules | Pure ESM (`"type": "module"`). |
| Bundling | `tsup` for build; `vitest` for tests. |
| Public API | Export named fns only (`authenticate`, `streamPay`, …). |
| Errors | `export enum SDKError { … }` for predictable throws. |

### 2.4 Python (SDK)

| Topic | Rule |
|-------|------|
| Packaging | Poetry, `pyproject.toml`. |
| Async | All network calls must be `async`/`await`. |
| Testing | `pytest` + `pytest-asyncio`. |
| Typing | `mypy --strict` must pass. |

---

## 3 · Styling & UI (future frontend)

* Tailwind CSS + shadcn/ui if React UI appears.  
* Functional components with hooks; files `PascalCase.tsx`.  
* Keep UI in `/frontend`; **do not** mix with SDK.

---

## 4 · Testing & Programmatic Checks

| Stack | Command | Enforced in CI |
|-------|---------|----------------|
| Solidity | `forge test -vv` | ✅ |
| TypeScript | `npm test` in `/sdk/js` | ✅ |
| Python | `pytest -q` in `/sdk/python` | ✅ |
| Lint / static | `make lint` | ✅ |
| Slither | `slither .` | Fails CI on **High** severity |

Coverage goals: ≥ 90 % (Foundry) · ≥ 80 % (Vitest/Pytest).

---

## 5 · Pull-Request Checklist for AI Agents

Before opening a PR, **Codex/Copilot must ensure**:

1. Clear description (one-sentence summary + bullets).  
2. Linked Issue (`Closes #123`).  
3. Local CI green (`make test`).  
4. Screenshots/logs for UI/CLI changes.  
5. Small scope—one feature/fix per PR.  
6. No unintended lock-file changes (`package-lock.json`, `poetry.lock`).

---

## 6 · Commit Message Format

<type>: <subject>            # ≤ 50 chars, imperative mood

<body>                       # optional, wrap at 72 chars
                             # Focus on *why* the change is needed.

BREAKING CHANGE: <details>   # only if behaviour/API breaks`type` must be one of  
`feat | fix | docs | refactor | test | ci | chore`.

---

## 7 · AI-Specific Tips & TODO Markers

* Prefix inline prompts with `/// @codex` so future Codex runs can target them.  
* Use `TODO(op-context): …` comments; CI flags TODOs older than **30 days**.  
* Reusable prompt examples live in `/specs/prompts/`—add more as you learn.

---

## 8 · Phase-1 Exit Criteria (high priority)

- [ ] `PassportRegistry.sol` with unit tests merged.  
- [ ] `ContextVault.sol` storage stub committed.  
- [ ] JS SDK `authenticate()` works against zkSync Sepolia.  
- [ ] CI badge in **README** is green.

When all four boxes are ticked, the **Phase 1 · Core PoC** milestone closes automatically.

---

*Last updated: **2025-06-13** — maintainers @OpenContext Network*

