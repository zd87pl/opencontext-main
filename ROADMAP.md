---

### `ROADMAP.md`

```markdown
# 🗺 OpenContext Network — Detailed Roadmap (v2025‑06‑13)

> **Total horizon: 18 months** (kick‑off July 2025).  
> Milestones are mirrored as GitHub *Milestones*; each bullet below should exist as an Issue linked to its milestone and project board column.

---

## Phase 0 · Foundation (📆 Jul 2025)

| Stream | Issue key | Deliverable |
|--------|-----------|-------------|
| Strategy | #1 | 20‑page white‑paper v0.9 |
| Funding  | #2 | Signed pre‑seed term‑sheet ($2–3 M) |
| Legal    | #3 | Cayman → Delaware entity stack + token legal memo |
| Hiring   | #4 | 2 Solidity/ZK eng, 1 Backend Go/Rust, 1 DevRel |

**Exit gate:** funding soft‑circled **AND** founding team contracts signed.

---

## Phase 1 · Core Protocol PoC (📆 Aug → Oct 2025)

| Work‑stream | Epic | Key tasks | Done when |
|-------------|------|-----------|-----------|
| Smart Contracts | #10 | Implement `PassportRegistry.sol`, `ContextVault.sol`, deploy to zkSync testnet | >90 % unit‑test coverage |
| Wallet & SDK | #11 | ERC‑4337 AA wallet fork, JS + Python SDK (`authenticate`, `vault.get`, `streamPay`) | Demo `node demo.js` runs e2e |
| Micropayments | #12 | Integrate Superfluid constant‑flow USDC on Base | Stream latency < 300 ms |
| Security | #13 | Slither static analysis + external audit quote | All “High” findings resolved |

**KPI:** 1 000 UserOperations / day on testnet.

---

## Phase 2 · Testnet Pilots (📆 Nov 2025 → Jan 2026)

| Partner type | Epic | Actions |
|--------------|------|---------|
| Newswire API | #21 | Gateway proxy meters bytes → charges stream |
| Code host | #22 | Same as above; add GitHub → wallet login |
| Satellite imagery | #23 | Large‑blob chunked streaming payment |
| Compute DePIN | #24 | Route inference to Akash/Gensyn; reward nodes |

**KPI:** ≥ 3 partners live, ≥ $1 000 testnet flow / month.

---

## Phase 3 · Ecosystem + Seed (📆 Feb → Apr 2026)

| Initiative | Epic | Deliverable |
|------------|------|-------------|
| DevPortal & Docs | #31 | Docusaurus site with tutorials, API ref |
| Grants DAO | #32 | Multi‑sig treasury, 1st cohort of 10 grantees |
| Content Crawler SDK | #33 | `wget`‑style tool auto‑tipping origin sites |
| Seed round | #34 | Close $8–12 M @ $40–60 M FDV |

---

## Phase 4 · Mainnet β + Token TGE (📆 May → Jul 2026)

* **Mainnet Deployment** (Base + zkSync)  
* **Smart‑contract audit** (Trail of Bits) passed  
* **Token Generation Event** via LBP; initial liquidity → Uniswap v3  
* **Guardrails API GA** (safety event logging)

**Success metric:** 100 k monthly active wallets, avg txn fee < $0.01.

---

## Phase 5 · Consumer & Scale (📆 Aug 2026 → …)

| Track | Epic | Goals |
|-------|------|-------|
| Mobile Vault | #51 | iOS & Android apps (secure‑enclave split key) |
| Cross‑assistant memory | #52 | Plugins for OpenAI, Anthropic, LM Studio |
| DePIN nodes | #53 | 100 community GPU/storage nodes live |
| DAO Governance v1 | #54 | Snapshot → on‑chain execution |

---

## Cross‑cutting “Forever” Streams

| Stream | Owner | Cadence | Artefact |
|--------|-------|---------|----------|
| Security & Audits | Head of Sec | Quarterly | Audit reports in `/security-reports` |
| Compliance & Risk | General Counsel | Monthly | Risk register updates |
| DevRel & Community | DevRel Lead | Weekly | Newsletter + office hours |
| Analytics | Data Eng | Real‑time | Grafana dashboard |

---

## KPIs at a glance

| Date | Wallets | Paid API calls / mo | Streaming $ / mo | DePIN nodes |
|------|---------|---------------------|------------------|-------------|
| Oct 2025 (P1) | 1 k | 10 k | $100 | – |
| Jan 2026 (P2) | 10 k | 1 M | $10 k | 5 |
| Apr 2026 (P3) | 50 k | 5 M | $250 k | 25 |
| Jul 2026 (P4) | 100 k | 20 M | $2 M | 50 |
| Dec 2026 (P5) | 1 M | 100 M | $10 M | 100 |

---

## How to keep this file alive

1. **Update every sprint retro** — move completed issues to ☐ → ✅.  
2. **If scope changes**, edit here **first**, then update GitHub Milestones.  
3. **Use relative links** (`../contracts/...`) so everything survives repo moves.

*Last updated: **2025‑06‑13** — by @OpenContext‑Maintainers.*