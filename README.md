# 🌐 OpenContext Network

*A user‑owned identity, context‑vault, and micropayment rail for AI agents.*

---

## 1 · What is OpenContext?

OpenContext lets any conversational AI—or the autonomous agents soon to follow—answer three questions out‑of‑the‑box:

| Question | OpenContext layer |
|----------|------------------|
| **Who am I talking to?** | **ZK‑Passport DID** — revocable, biometric‑optional proof‑of‑personhood that stays under the user’s control. |
| **What does this user already know / prefer?** | **Encrypted Context Vault** — portable conversation & preference history shared across assistants. |
| **Who should get paid when data/API/compute is used?** | **Pay‑Per‑Byte rail** — sub‑cent, streaming payments on a low‑fee zk‑EVM L2, with automatic royalty splits. |

Designed around the 11 *AI × Crypto* cross‑over theses, OpenContext aims to be the default passport & payment substrate for autonomous AI.

---

opencontext-main/
├─ contracts/           # Solidity (Foundry)
├─ sdk/
│  ├─ js/               # TypeScript client
│  └─ python/           # Python client
├─ docs/                # MkDocs / Docusaurus → GitHub Pages
├─ specs/               # Detailed protocol + SDK specs
├─ governance/          # Tokenomics, DAO model
├─ ops/                 # Infra‑as‑code, CI, k8s manifests
└─ .github/             # CI workflows, templates, CODEOWNERS

> **Codex‑friendly:** every `TODO:` and Issue is phrased as a declarative statement, ready for generative autocomplete.

---

## 3 · Quick‑start

> Requires **Node 20+**, **Python 3.11+**, and **Foundry**.

```bash
git clone https://github.com/<your‑org>/opencontext-main.git
cd opencontext-main

# install everything (JS + Python + Solidity) and run tests
make setup
make test
# Contracts
cd contracts && forge test -vv

# JS SDK
cd sdk/js && npm ci && npm test

# Python SDK
cd sdk/python && pip install -r requirements.txt && pytest

## 4 · Architecture (high‑level)

graph TD
  subgraph User Side
    Wallet[ERC‑4337 Wallet] --> DID[ZK‑Passport]
    Wallet --> Vault[Context Vault]
  end

  Wallet -->|streamPay| Superfluid[(USDC streams)]
  Agent[AI Agent / Assistant] -->|read/write| Vault
  API[Data/API Gateway] -->|metered bytes| Superfluid
  GPU[Community GPU Node] -->|reward| Token[Protocol Token]

  ## 5 · Roadmap snapshot

  Phase
Timeline (est.)
Exit KPI
0 · Foundation
Jul → Aug 2025
Pre‑seed closed, 4 core hires
1 · Core PoC
Aug → Oct 2025
DID + Vault on testnet, 1 k tx/day
2 · Pilots
Nov 2025 → Jan 2026
3 paid API partners, $1 k/mo flow
3 · Ecosystem + Seed
Feb → Apr 2026
50 dev projects, $8–12 M seed
4 · Mainnet β + TGE
May → Jul 2026
100 k wallets, audited mainnet
5 · Consumer & Scale
Aug 2026 → …
1 M AI companions, DAO live

## 6 · Using Codex / Copilot effectively

Goal
Example prompt
Generate a contract unit test
“Write a Foundry test that checks Vault slice quota enforcement.”

Scaffold an SDK call
“Implement streamPay(recipient, bytes) in index.ts using ethers v6.”

Extend docs
“Add a Mermaid sequence diagram to docs/architecture.md showing payment flow.”


Built with ❤️ by the OpenContext Network maintainers. Join the Discord and help shape the open AI future!