# Security model — OpenContext Vault 0.1.0

**Status:** no independent security review has been performed. Cryptography uses only `node:crypto` primitives (AES-256-GCM, scrypt, SHA-256). Report issues to security@opencontext.network, the address given in the repository's root [SECURITY.md](../SECURITY.md) (the reporting policy for every component) and root README.

This document says what the vault protects, against whom, and — just as deliberately — what it does not. Every row that says "yes" names the mechanism and the test or command that exercises it.

## Assets

- **A1** memory statements
- **A2** raw sources — the highest sensitivity: verbatim conversations and documents
- **A3** access patterns — who searched what (the audit log)
- **A4** grant tokens
- **A5** the data key
- **A6** memory integrity (no silent poisoning)
- **A7** audit integrity

## Adversaries

- **T1** a prompt-injected or malicious MCP client holding a valid token
- **T2** a thief with the powered-off disk, a leaked backup, or a cloud-synced vault directory
- **T3** another process running as your OS user
- **T4** whoever reads logs, exports and temp files
- **T5** an agent writing poisoned memories

## Attacks

| Attack | Protected? | Mechanism | Residual |
|---|---|---|---|
| T1 reads memories in bulk via many `vault_search` calls | partially | per-call cap of 50, every call logged with its full arguments, no export over MCP, tag-scoped grants | a `read` grant can page through what it may read; the audit log makes it visible, not impossible (no rate limiting in v1) |
| T1 reads raw conversations | yes unless granted | separate `sources` scope; the quick start gives coding tools `read` only (`test/access.test.ts`, `test/mcp.test.ts` scenario 2) | — |
| T1 escalates (grants itself, reads the key, exports) | yes | no grant, key or export surface over MCP; CLI only (`test/mcp.test.ts` lists exactly 9 tools) | — |
| T1 plants standing instructions | yes unless granted | `instruction` kind needs the `instruct` scope; the standing block and `vault://profile` mark the section; `createdBy` on every memory | a `write` grant can still write ordinary false facts: visible (`list --created-by`), attributable, reversible (`forget --created-by`), not preventable |
| T1 fabricates evidence | yes | quotes are verified against sources; agent-supplied sources are marked and citations to them are flagged self-attested (`test/mcp.test.ts` scenario 3) | paraphrases are allowed and shown as unverified |
| T1 uses a revoked or rotated token | yes | the grant is resolved on every call after `refresh()`, never cached (`test/mcp.test.ts` scenario 6, `test/multiprocess.test.ts` 4) | — |
| T1 spoofs `clientInfo.name` | irrelevant | names never confer rights; only the token in that client's own config does | a process that can read another client's config has that client's token — that is T3 |
| T2 stolen disk, **key-file mode** | **no** | the key is on the same disk (next to, not inside, the vault). **Enable full-disk encryption** (FileVault / BitLocker / LUKS) | counts, sizes, ids and mtimes are plaintext regardless |
| T2 leaked backup or synced **vault directory** | yes | the key lives outside the directory; every record is AES-256-GCM; there is no plaintext index | sizes and counts leak; `cp -r` of the directory is an encrypted backup **only** if you do not also copy `vault.key` |
| T2 stolen disk, passphrase mode | to the strength of the passphrase | scrypt N=2^17 r=8 p=1, maxmem 256 MiB (`test/crypto.test.ts` printed 372 ms and 433 ms on two runs on the linux/x64 development container, Node 22.22.0) | a passphrase in the client's MCP config (`OPENCONTEXT_VAULT_PASSPHRASE`) is plaintext — no better than key-file mode; use `OPENCONTEXT_VAULT_PASSPHRASE_CMD` with the OS keychain |
| T3 same-uid process reads the key, token configs or process memory | **no, out of scope** | 0600/0700 modes, stdio only, no listener, tokens hashed at rest | OS isolation is the user's job; the same limit as ssh keys and browser profiles |
| T3 edits, replays, reorders or deletes journal lines without the key | yes (detected) | GCM with AAD binding (vaultId, kind, gen, seq, prev); `verify` (`test/journal.test.ts`) | **tail truncation** of a journal and **whole-file rollback** of a journal together with `vault.json` are undetectable without an external anchor |
| T3 rolls back a source body | yes (detected) | the body sha256 is in the seq-bound sources journal (`test/store.test.ts`) | — |
| T4 secrets in logs, errors or exports | yes | `test/canary.test.ts`; stderr-only diagnostics; errors carry codes; tokens are never written anywhere after `grant` prints them | the export is plaintext by design (written 0600, warning printed) |
| T5 poisoned memories steer later agents | partially | `createdBy` and provenance on every hit; a data-not-instructions notice; supersede keeps history; `forget --created-by` | no injection classifier; a model may still follow injected text |
| Nonce reuse | yes | random 96-bit IVs; the NIST bound is 2^32 messages per key, personal scale is orders of magnitude below; `rekey` resets | — |
| The vault calls the network or an LLM | yes | no network code (`test/no-network.test.ts`, `scripts/lint.mjs`), no LLM calls anywhere, no telemetry | the host app and the model vendor see whatever the authorized agent reads — by definition |
| Forgotten data in free blocks or snapshots | partially | `forget` compacts immediately (the ciphertext leaves the live files); `rekey` destroys the key that sealed the old ciphertext | no scrubbing claims |
| Windows file permissions | **no** | chmod is a no-op; a warning is printed | untested platform |
| Secrets stored by an agent | hint only | `looksLikeSecret` basic patterns (`test/secrets.test.ts`) | not a guarantee; false positives and negatives are possible |

## Things worth knowing

- **The audit log is tamper-evident, not tamper-proof.** All four journals chain (`prev` hashes, seq-bound AAD), so an edit, replay, reorder or deletion anywhere but at the tail is detected by `verify`. Truncating the tail, or rolling back a journal together with `vault.json`, is not detectable without an external anchor.
- **Audit content policy:** full tool arguments, encrypted, never exported — so you can see what agents wrote and searched. Vault tokens that a model pastes into an argument are redacted to `ocv_[redacted]` before the entry is written. Calls that fail the SDK's input validation (for example `vault_forget` with an empty `ids` list) are rejected before they reach the vault and are therefore not logged; every call that reaches the scope gate or a handler is.
- **`rekey` crash window:** `rekey` re-seals journals and bodies under the lock, then rewrites the key file and the manifest. It refuses up front when the key file cannot be rewritten (missing passphrase, foreign key file), so every refusal happens before anything is re-sealed; a hard crash or disk error between the re-seal and the key-file rewrite leaves a vault that the old key file no longer opens. Keep a backup of `vault.key` and the vault directory before running `rekey` on data you cannot recreate.
- **Memory footprint:** each server process holds all decrypted memories and metadata plus the search index for its lifetime; source bodies are read on demand (LRU of 32); each MCP client spawns its own process.
- **Dependencies:** two direct runtime dependencies (`@modelcontextprotocol/sdk`, `zod`; 95 packages installed, pure JavaScript, no install scripts, lockfile committed).
