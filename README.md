# OpenContext

**OpenContext Vault: a user-owned, encrypted, portable memory for AI agents, served to the tools you already use as a local MCP server.**

The vault lives in [`vault/`](vault/README.md) and is the product. Everything else in this repository is the experimental Web3 work it grew out of; the [repository map](#repository-map) says, per directory, what runs, what is tested, and what is a placeholder. There are no CI badges here yet, on purpose: see [CI status](#ci-status).

## Quick start

Six commands on a machine with git and Node 20+; [vault/README.md](vault/README.md#quick-start) has the vault's own quick start and explains each step:

```bash
git clone https://github.com/zd87pl/opencontext-main.git && cd opencontext-main/vault   # the directory is named after the repository
npm ci && npm run build                                   # Node 20+ (5 s here with a warm npm cache: 2 s install, 3 s build)
node dist/cli.js init                                     # ~/.opencontext/vault + ~/.opencontext/vault.key (0600)
node dist/cli.js import ~/Downloads/chatgpt-export/       # an UNZIPPED export folder (ChatGPT, Claude), Google Takeout JSON, or a folder of .md
node dist/cli.js grant claude-desktop --scopes read,write,sources --client claude-desktop   # token printed once + config snippet
# paste the snippet into Claude Desktop's config, restart it, then use the "distill" prompt
node dist/cli.js grant cursor --scopes read --client cursor                                # memory-only, no raw conversations
```

Three things to know before you paste:

- **Unzip first.** Vendors ship exports as ZIP files and the vault has no zip handling; `import` reads a folder or a JSON file.
- **The clone has to stay where it is.** The snippet from `grant --client` contains the absolute path of your `node` binary and of this clone's `dist/cli.js`, because MCP hosts do not reliably inherit your shell `PATH`. If you move or delete the clone, or remove the Node version the snippet points at, every client's config stops working until you print the snippets again (`node dist/cli.js config <label> --client <kind>`) and paste them. `npm link` plus `"command": "opencontext-vault"` is the alternative.
- **Key-file mode is only as safe as your disk.** The key sits next to the vault on the same disk, so enable full-disk encryption (FileVault / BitLocker / LUKS); `init --passphrase` wraps the key with scrypt instead.

`grant --client` prints ready-to-paste config for Claude Desktop, Claude Code, Cursor, Windsurf and VS Code.

## Why

Every assistant now keeps a memory of you, and each keeps it in its own shape, on its own servers, readable by its own models. In March 2026 Claude and Gemini each gained a way to import memory from other assistants (press coverage dates them 3 March and 26 March); both work through a prompt that the old assistant answers with a summary of you, in whatever shape that model chooses (Gemini also takes a ZIP of chat history). There is still no shared format, and what you export from one is not what the next one reads. Goyal & Ray (2026, [arXiv:2609.05339](https://arxiv.org/abs/2609.05339)) report two things that shape this project: memory kept in a fixed schema carries across model upgrades, and keeping the raw sources is what makes a memory repairable later instead of a fossil.

The vault takes those two findings and adds the part a vendor cannot offer, which is that you hold it:

- **A directory you own.** Memories, imported conversations, grants and the audit log are files on your disk, AES-256-GCM encrypted under a key you hold. No cloud, no account, no network code (a test scans the build for it), no LLM call inside the vault.
- **Per-client scoped tokens.** Each MCP client gets its own token with scopes (`read`, `write`, `sources`, `forget`, `instruct`) and optional tag restriction; revoking applies on the client's next call. Your coding tool can read memories without ever seeing raw conversations.
- **An audit log.** Every tool, resource and prompt call is written to an encrypted, chained journal before its result is returned, with the full arguments.
- **Provenance, not assertion.** A memory is one sentence with a kind, confidence and citations; every quoted citation is re-checked against the source text on write.
- **An open format.** The export (memories and sources, with their original ids) is plain JSON with a checked-in [JSON Schema](vault/schema/opencontext-vault-export.v1.schema.json), and [vault/SPEC.md](vault/SPEC.md) documents the on-disk layout with test vectors, so you can leave without this code.

Keyword search (BM25) only, no embeddings; no sync, no GUI, no independent security review yet. [vault/README.md](vault/README.md#what-it-does-not-do) lists everything it does not do, and [vault/SECURITY.md](vault/SECURITY.md) says what is and is not protected, against whom.

## Repository map

Test counts and coverage below are from running each suite in this checkout on 2026-10-21 (Node 22.22.0, npm 10.9.4, forge 1.5.1, Python 3.13.16). "Not deployed" means no contract address exists on any network; "not audited" means no independent security review of any kind has been done.

| Path | What it is | Tests run now | Honest status |
|---|---|---|---|
| [`vault/`](vault/README.md) | The vault: TypeScript, MCP over stdio, two direct runtime dependencies (`@modelcontextprotocol/sdk`, `zod`; `npm ci --omit=dev` installs 95 packages, 93 of them pulled in by the SDK), 9 tools, 2 resources, 2 prompts, a CLI | `npm test`: 25 files, 361 tests. 361 passed as a normal user; 360 passed + 1 skipped under `CI=1` (a 5 MB indexing benchmark skips) or as root (a read-only-directory test skips); 359 + 2 as root under `CI=1`. `npm run test:coverage`: about 87 % statements, 75–76 % branches, 92 % functions, 91 % lines (rounded; the second decimal moves between runs and users, even two runs with identical settings, so no two-decimal figure is quoted); thresholds 80/80/80/70 are enforced in CI ([vault.yml](.github/workflows/vault.yml)) | 0.1.0. Works end to end. Not on npm (install from the clone). Not audited. Key-file mode is only as safe as your disk. Not tested on Windows (not in the CI matrix; file permissions are not enforced there). CI: [vault.yml](.github/workflows/vault.yml), Node 20/22 on ubuntu and macos, no run yet (see [CI status](#ci-status)) |
| [`contracts/`](contracts/) | Solidity 0.8.24 (Foundry): `PassportRegistry` (non-transferable ERC-721; the old "ZK-Passport" name is historical and misleading: it is not zero-knowledge), `ContextVault` (stores encrypted bytes on-chain), `ContextVaultIPFS` (stores IPFS hashes), `PaymentStream` (Superfluid constant-flow streams) | `forge test`: 5 suites, 153 passed | Compiles and passes with the submodule dependencies in `lib/`. **Not deployed on any network. Not audited.** Storing ciphertext on-chain is an experiment, not a recommendation |
| [`sdk/js/`](sdk/js/README.md) | TypeScript client for those contracts (ethers v6, ESM) | `npm test`: 11 files, 193 passed | ABIs pinned to the compiler output. Not on npm. Nothing to talk to until the contracts are deployed somewhere |
| [`sdk/python/`](sdk/python/README.md) | Python client for the same contracts (web3.py, async, `mypy --strict`) | `poetry run pytest -q`: 105 passed | Same as the JS SDK |
| [`gateway/`](gateway/README.md) | Fastify metering proxy: agents call partner APIs through it, it meters bytes and verifies a Superfluid stream before serving | `npm test`: 15 files, 318 passed | Proxy, metering, chunking and flow verification are real and tested. The two bundled DePIN compute nodes are placeholders whose endpoints do not resolve. Auth sessions live in process memory (single worker) |
| [`backend/`](backend/README.md) | Express + Prisma API from the June 2025 "creators get paid when AI uses content" pivot: Google OAuth, managed (custodial) wallets, Stripe intents, key escrow | `npm test`: 7 files, 141 passed | USD→USDC settlement is **simulated** (returns a hash; no funds move). Its `/mcp` router is a custom JSON-RPC-over-HTTP endpoint, **not the Model Context Protocol**; an MCP client cannot connect to it. Key escrow has a documented flaw (`TODO(op-context)` in `key-escrow.service.ts`) |
| [`wordpress-plugin/`](wordpress-plugin/README.md) | PHP plugin for that marketplace | none exist | Prototype from June 2025, untested |
| [`demo/`](demo/README.md), `docker-compose.demo.yml`, `setup-demo.sh` | Docker Compose of the marketplace prototype with a blockchain **simulator** (`demo/blockchain-simulator`) and `DEMO_MODE` payments | not run here | June 2025 prototype; see [DEMO.md](DEMO.md). Not the vault |
| `demo.js`, `demo.py` | Scripts meant to exercise the contracts through the SDKs on zkSync Sepolia | run now: both fail | **Do not run from a fresh clone.** `node demo.js` exits 1 on `import { ethers }` (`ERR_MODULE_NOT_FOUND`: the root has no `node_modules`) and its next import names a file that does not exist. `demo.py` prints its placeholder-address warning, then makes live RPC calls to zkSync Sepolia against `0x…01/02/03`, retries three times and exits 1 with `SDKError.TRANSACTION_FAILED`. Details in [DEMO.md](DEMO.md) |
| `test/integration/` | Spawns `npm run start` in `gateway/` on port 3002 with a mocked `fetch` and runs an end-to-end suite against it | not run here; not in `ci.yml` | A smoke test of the proxy process, not a unit suite; it needs its own `npm ci` and a built gateway. The Makefile rework makes `make test` skip it with a message and `make test-integration INTEGRATION=1` run it, and records in the Makefile why the suite cannot pass as written (it spawns the gateway from a `cwd` that does not exist and mocks its own `fetch`). Kept so that it can be repaired |
| `config/` | zod schema for `.env`, with its own `package.json` | — | Imported by no other package in this checkout (`grep` for `@opencontext/config` and `config/env` finds no consumer). The Makefile's `setup` target runs `npm ci` in it, and `typecheck` and `env-check` run `tsc --noEmit` in it, as the check that `.env` names the variables gateway/ and backend/ read. Until the Makefile rework in [Development](#development) it had no `package-lock.json`, so that `npm ci` exited 1 (`EUSAGE`); the rework adds the lockfile. Delete the directory together with those targets if that check is not wanted |
| `docs/` | [`docs/archive/`](docs/archive/README.md): June 2025 planning documents, kept for history, never verified. [`docs/launch/`](docs/launch/README.md): Show HN material. `whitepaper.md` is a one-line stub | — | |
| `.github/workflows/` | [ci.yml](.github/workflows/ci.yml), [vault.yml](.github/workflows/vault.yml), [security.yml](.github/workflows/security.yml) | — | No workflow has run in this repository yet; see [CI status](#ci-status) |

## CI status

There are no status badges in this README, on purpose. As of 2026-10-21 no workflow run exists in this repository (`gh api repos/zd87pl/opencontext-main/actions/runs` reports `total_count: 0`), and `main` carries only `security.yml`; `ci.yml` and `vault.yml` exist only on the branch that adds the vault. A badge for a workflow that has never run shows "no status", which this repository's own rule in [AGENTS.md](AGENTS.md) treats as a fake badge.

The three workflows:

- [ci.yml](.github/workflows/ci.yml): sdk/js on Node 20/22, sdk/python on 3.11/3.13, gateway, backend, contracts.
- [vault.yml](.github/workflows/vault.yml): `npm run lint` and `npm run test:coverage` for the vault on Node 20/22 × ubuntu/macos, thresholds 80/80/80/70.
- [security.yml](.github/workflows/security.yml): Slither, Mythril and Semgrep over the contracts; the Slither and Mythril steps are `continue-on-error`, so a green run there does not mean zero findings.

The badges go back at the top of this file once all three have a green run on `main`; the pre-launch checklist in [docs/launch/show-hn.md](docs/launch/show-hn.md) has the markdown.

## History and scope

This repository started in June 2025 as a Web3 project: a non-transferable identity token, an on-chain encrypted context store, and Superfluid micropayment rails so AI agents could pay data providers, later pivoted toward a content marketplace where creators would be paid when AI used their work (the `backend/`, `wordpress-plugin/` and `demo/` directories, and the planning documents now in [`docs/archive/`](docs/archive/README.md)). None of it was deployed, and it is not audited. In October 2026 the useful idea underneath it all, a context store that the user owns, was rebuilt as a local, file-based MCP server with no chain, no server and no account: [`vault/`](vault/README.md). The on-chain parts, the SDKs and the gateway are kept because they compile and their tests pass, and because someone may want them; they are experiments, not the product, and the vault imports nothing from them.

## Development

```bash
make vault-build        # npm ci && npm run build in vault/
make vault-test         # vault test suite (builds first)
make vault-lint         # tsc --strict + scripts/lint.mjs

make setup              # tool checks (Foundry, Node, Poetry), the lib/ submodules, and every package's dependencies from its lockfile
make test               # every suite: vault, contracts, sdk/js, sdk/python, gateway, backend (test/integration is skipped with a message; INTEGRATION=1 runs it)
make lint               # every linter: vault lint gate, forge fmt --check, eslint (sdk/js, gateway, backend), black + ruff
make typecheck          # every type check: config, vault, sdk/js, gateway, backend (tsc) and sdk/python (mypy --strict)
make slither            # Slither over contracts/ if installed
```

The four aggregate targets (`setup`, `test`, `lint`, `typecheck`) are meant to work from a fresh clone and to cover every package, `vault/` and `backend/` included; that is what the Makefile rework in progress does, and none of the four was run from a fresh clone for this README. What was run on 2026-10-21: `npm ci` in a copy of `config/` as it was before the rework, which exited 1 (`EUSAGE`) because `config/` had no lockfile; the rework adds one. The per-package commands are what the numbers in this file come from.

Per package: `cd vault && npm ci && npm run lint && npm test` · `forge test -vv` (contracts; `git submodule update --init --recursive` first) · `cd sdk/js && npm ci && npm test` · `cd sdk/python && poetry install && poetry run pytest -q` · `cd gateway && npm ci && npm test` · `cd backend && npm ci && npm test` (the root `npm test` chains vault, sdk/js, gateway and backend).

Guides for people and agents working here: [CLAUDE.md](CLAUDE.md), [AGENTS.md](AGENTS.md), [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome, on the vault above all. Commit messages are `<type>: <subject>` with `type` one of `feat|fix|docs|refactor|test|ci|chore`; keep one change per PR and run the relevant suite before opening it. Security reports go to **security@opencontext.network** (see [SECURITY.md](SECURITY.md)), not to the issue tracker.

## License

MIT, see [LICENSE](LICENSE). The vault carries its own copy at [vault/LICENSE](vault/LICENSE).
