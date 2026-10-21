# Security policy

## Reporting

Email **security@opencontext.network**. The same address is given in the [root README](README.md#contributing) and in [vault/SECURITY.md](vault/SECURITY.md). Please do not open a public issue for anything exploitable. Include the component, the commit, and steps to reproduce. There is no bug bounty.

## Status, in one sentence

**Nothing in this repository has had an independent security review.** What follows is what each component claims and what it does not; the claims come with the tests that exercise them, not with a third party's signature.

## Scope by component

| Component | In scope | What you should know |
|---|---|---|
| [`vault/`](vault/README.md) | Yes. This is the product and the place where a report matters most | [vault/SECURITY.md](vault/SECURITY.md) is the threat model: assets, adversaries, and for each attack whether it is protected, by which mechanism, by which test, and what remains. Short version: AES-256-GCM journals with position-bound authenticated data; tokens hashed at rest and resolved on every call; an audit journal that is tamper-evident, not tamper-resistant (tail truncation and whole-file rollback need an external anchor to detect); **key-file mode gives no protection against a stolen disk**, enable full-disk encryption or use `init --passphrase`; a same-user process is out of scope; Windows is not tested (not in the CI matrix) and file permissions are not enforced there. Cryptography is `node:crypto` only |
| `contracts/` | Yes, as code review | Solidity contracts that compile and pass 153 Foundry tests. **Not audited and not deployed on any network.** Do not deploy them with real value. `security.yml` runs Slither, Mythril and Semgrep, but the Slither and Mythril steps are `continue-on-error`, so a passing workflow is not a clean report |
| `sdk/js/`, `sdk/python/` | Yes | Clients for the undeployed contracts. They hold whatever private key you give them in memory; the AES-256-GCM helpers are for the on-chain context payload |
| `gateway/` | Yes | Metering proxy with SSRF protection, header hygiene and server-side credential injection; auth sessions and OAuth state are in process memory; the bundled DePIN nodes are placeholders. Do not put it in front of real partner credentials without reading `gateway/README.md` |
| `backend/` | Low priority | June 2025 prototype. Custodial wallets whose encryption key defaults to being derived from `SESSION_SECRET`; a known key-escrow flaw (`TODO(op-context)` in `key-escrow.service.ts`); simulated USDC settlement. Treat as a demo, not a service |
| `wordpress-plugin/`, `demo/` | Reports welcome, fixes unlikely | Untested prototypes from June 2025 |
| `docs/archive/` | No | Historical plans, not code |

## What a report gets

An acknowledgement, a fix in the vault if it is a vault issue, and a note in [vault/CHANGELOG.md](vault/CHANGELOG.md). For the experimental directories the likely outcome is a documented limitation rather than a fix.
