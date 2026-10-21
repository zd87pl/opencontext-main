# Demos

> **Looking for the real thing?** The product in this repository is [OpenContext Vault](vault/README.md), a local MCP server. Its quick start is six commands and needs nothing but git and Node 20+: see the [root README](README.md#quick-start) or [vault/README.md](vault/README.md#quick-start).

Everything on this page is a **June 2025 prototype** kept for history. None of it is deployed, it is not audited, and none of it is part of the vault.

## The Docker demo (`demo/`, `docker-compose.demo.yml`, `setup-demo.sh`)

This is the content-marketplace prototype from June 2025 ("creators get paid when AI uses their content"). `./setup-demo.sh` builds and starts the `backend/`, a React frontend, WordPress with the plugin, PostgreSQL, Redis, nginx, a data seeder, optionally Prometheus and Grafana, and a **blockchain simulator** (`demo/blockchain-simulator`, an Express process that fakes blocks and transactions on port 8545). It runs with `DEMO_MODE=true`: the Stripe keys in `docker-compose.demo.yml` are placeholder `sk_test_…` strings, so no card is ever charged; the USD→USDC settlement is **simulated** (the backend returns a hash and moves no funds); no real contract or network is involved. The backend's `/mcp` endpoint is a custom JSON-RPC-over-HTTP API, not the Model Context Protocol, so an MCP client cannot connect to it. [demo/README.md](demo/README.md) has the service list and manual steps; it was written at the time and has not been re-run as part of the 2026 cleanup.

## The contract demos (`demo.js`, `demo.py`): do not run as shipped

These scripts were written to drive `PassportRegistry`, `ContextVault` and `PaymentStream` through the JS and Python SDKs on zkSync Sepolia: mint passports, store an encrypted context, authorize a reader, register a provider, open a payment stream. They read the contract addresses from `PASSPORT_REGISTRY_ADDRESS`, `CONTEXT_VAULT_ADDRESS` and `PAYMENT_STREAM_ADDRESS` and fall back to the placeholders `0x…01`, `0x…02`, `0x…03`. **Nothing is deployed on any network**, and, run in this checkout on 2026-10-21, neither script gets anywhere from a fresh clone:

- `node demo.js` (what `make demo` runs) exits 1 at its first line of imports: `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ethers'`. The repository root has no `node_modules` and the root `package.json` declares no dependencies; `ethers` is installed only under `sdk/js/`. Its second import, `./sdk/js/src/index.js`, names a file that does not exist either: the SDK source is TypeScript and builds to `sdk/js/dist/index.js`.
- `cd sdk/python && poetry run python ../../demo.py` prints the warning `Using placeholder contract addresses ... Nothing is deployed there. Set PASSPORT_REGISTRY_ADDRESS, ...` and then **keeps going**: it creates three clients, makes live RPC calls to `https://sepolia.era.zksync.dev` against the placeholder addresses, retries three times and exits 1 with `Demo failed: Get passport failed: Could not decode contract function call to getTokenId with return data: b'' ... Error code: SDKError.TRANSACTION_FAILED`. The warning is accurate; the error that follows is misleading, because there is no contract at that address, not a failed transaction. (`make demo-python` runs plain `python3 demo.py`, which additionally needs the `opencontext` package importable outside Poetry.)

Treat both as unrunnable until someone deploys the contracts (for example to a local Anvil node), exports the three addresses, installs `ethers` at the repository root and points `demo.js` at the built SDK. The vault does not use any of this. What does run, from a fresh clone with Foundry installed (both commands from the repository root, where `foundry.toml` is):

```bash
git submodule update --init --recursive   # forge-std, openzeppelin-contracts, protocol-monorepo into lib/
forge test -vv                            # 5 suites, 153 tests pass in this checkout
```

`make setup` is meant to install every package's dependencies but is being reworked; [README.md → Development](README.md#development) says what has been verified.

## What to read instead

- [README.md](README.md) for the per-directory status of everything here.
- [vault/README.md](vault/README.md), [vault/SECURITY.md](vault/SECURITY.md) and [vault/SPEC.md](vault/SPEC.md) for the vault.
- [docs/archive/](docs/archive/README.md) for the June 2025 plans these demos came from.
