# Show HN: OpenContext Vault

Every number in this file comes from a command run in this checkout on 2026-10-21 (Node 22.22.0, npm 10.9.4); the [Verification](#verification-2026-10-21-this-checkout) section at the end lists the command behind each one. Re-run them before posting and replace anything that moved.

Short version of the test numbers: `cd vault && npm test` runs 25 files, 361 tests; all 361 pass as a normal user, one skips under `CI=1`, one skips as root. Coverage is about 87 % statements, 75–76 % branches, 92 % functions, 91 % lines; the second decimal moves between runs and users, and the enforced thresholds are 80/80/80/70.

## Title options (≤ 80 characters)

1. `Show HN: OpenContext Vault – your AI memory as an encrypted local MCP server` (78 characters; 80 bytes because of the en dash)
2. `Show HN: An encrypted, portable memory for AI agents you own (local MCP server)` (79)
3. `Show HN: Import ChatGPT/Claude/Gemini history into a vault your agents query` (76)

## Post text (≤ 1200 characters)

```
OpenContext Vault is a local MCP server holding a memory of you that you own: a directory on your disk, AES-256-GCM encrypted under a key you hold, served over stdio to Claude Desktop, Claude Code, Cursor, Windsurf or VS Code.

It imports your ChatGPT, Claude and Gemini exports verbatim, lets the model you already use distill one-sentence memories with citations re-checked against the source, and exports memories and sources as documented JSON.

Each client gets its own token with scopes, so a coding tool can read memories but never raw conversations; revoking applies on the next call. Every call is logged to an encrypted audit journal before it returns.

What it is not: no cloud, no account, no sync, no embeddings (BM25), no GUI, no LLM call inside the vault. TypeScript, two direct dependencies, no network code. 0.1.0, not on npm, no independent security review.

Try it (Node 20+): clone, cd vault, npm ci && npm run build, init, import an unzipped export, grant a client.

Feedback wanted on the schema, export format (SPEC.md) and threat model (SECURITY.md): what would you not trust it with?
```

(1109 characters including newlines, leaving 91 for edits at submit time; the count is in the Verification section. Re-check with `wc -c` after editing.)

## First comment

Post this as the first comment, right after submitting. It is plain lines, not a table, because HN renders no Markdown tables; the rows are generated from the "What it does not do" table in vault/README.md (command in Verification), with the last row's relative link replaced by the full URL.

```
Author here. The honest limits, copied from vault/README.md so nobody has to dig for them. "Not in 0.1.0 — instead: what you get":

Semantic or embedding search — instead: BM25 keyword search with stemming; no LLM call inside the vault, ever
Cloud, sync, accounts, telemetry, blockchain, IPFS, HTTP/SSE transport — instead: local files, stdio only; sync the directory yourself (without the key)
GUI — instead: the CLI and your MCP client
Keychain / TPM integration — instead: key file, or a scrypt passphrase via `OPENCONTEXT_VAULT_PASSPHRASE_CMD`
Rate limiting, anomaly detection — instead: the audit log (`audit --denied`, `audit --follow`) and per-client scopes
Zip handling — instead: unzip the export first
Obsidian, Notion, Slack importers — instead: Markdown / text folders
NDJSON or encrypted export — instead: the plaintext portable JSON (parsed in memory on import; ≈ 500 MB documented limit)
Automatic expiry, decay, importance or conflict detection — instead: exact dedup plus explicit `supersedes`
In-place edit, undo of `forget`, audit pruning or export — instead: versions only; `forget` is final; the audit journal is append-only
Passphrase change — instead: `rekey`, or re-`init` and `import` an export
File watching — instead: `refresh()` before every call and command
npm publish — instead: install from the clone (`npm ci && npm run build`)
ESLint / Prettier — instead: `tsc --strict` plus `scripts/lint.mjs`
MCP sampling, elicitation, tasks, subscriptions — instead: 9 tools, 2 resources, 2 prompts
Windows ACL enforcement, multi-user vaults — instead: one OS user, one vault directory
Gemini conversation ids, ChatGPT alternate branches — instead: a 30-minute grouping heuristic; branches kept only in `raw`
An independent security review — instead: https://github.com/zd87pl/opencontext-main/blob/main/vault/SECURITY.md says what is claimed

Two more things before anyone asks:

Key-file mode gives no protection against a stolen disk: the key (~/.opencontext/vault.key) lives next to the vault directory on the same disk. Enable full-disk encryption (FileVault / BitLocker / LUKS), or use `init --passphrase`, which wraps the key with scrypt. The key is deliberately outside the vault directory so that a backup or sync of the directory alone is encrypted, as long as you do not also copy vault.key.

It has not been audited. Cryptography is node:crypto only (AES-256-GCM, scrypt, SHA-256); vault/SECURITY.md lists every attack we thought about, whether it is covered, by which test, and what remains.
```

(The backticks stay as plain characters on HN; they read fine. Also "not audited" above is the only form of that word this repository uses.)

## Anticipated questions

**1. Why not just a JSON file or a Markdown folder?**
Because the interesting parts are not the storage but what sits around it: per-client tokens with scopes, so your coding tool cannot read your raw conversations; an audit log of every call with its arguments, written before the call returns; citations that are re-verified against the source text; versions instead of edits; encryption at rest with a key kept outside the directory. A JSON file gives every process on your machine everything. You can still get the JSON: `export` writes memories and sources, and SPEC.md documents it.

**2. Why MCP?**
Because it is the one interface Claude Desktop, Claude Code, Cursor, Windsurf and VS Code all speak today, over stdio, with no server to run. The vault is one Node process per client and nothing listens on a port. If a better local protocol wins, the data is in an open format and the server is the thin part.

**3. Why no embeddings or semantic search?**
Three reasons. The vault makes no LLM or embedding calls by design, so there is nothing to embed with unless we ship a model. Memories are one-sentence records with tags and kinds, where BM25 with stemming over a few thousand sentences works. And a plaintext vector index next to encrypted records would be a leak. Semantic search is the most requested thing we left out; if it comes, it will be local and optional.

**4. Why Node / TypeScript?**
The MCP reference SDK is TypeScript and every host above launches a command; `node` is already on the machines that run those hosts. The vault has two direct dependencies (the MCP SDK and zod) and uses `node:crypto` for the cryptography. To be exact about it: `npm ci --omit=dev` installs 95 packages, 93 of them pulled in by the MCP SDK (zod has none), mostly for HTTP transports the vault never loads; a test checks that nothing in `dist/` imports network modules. A Rust or Go port would be welcome and SPEC.md exists so that it can read the same files.

**5. How secure is key-file mode, really?**
Against a stolen powered-off disk: not at all, the key is on the same disk. Against a leaked backup or a synced vault directory: fine, as long as the key file was not copied with it. Against another process running as your user: out of scope, exactly like SSH keys and browser profiles. Passphrase mode (`init --passphrase`, scrypt N=2^17) covers the stolen disk to the strength of the passphrase; keep the passphrase in your OS keychain and point `OPENCONTEXT_VAULT_PASSPHRASE_CMD` at it. SECURITY.md has the full table.

**6. Can a prompt-injected agent poison my memory?**
It can write false ordinary facts if it holds a `write` grant; that is attributable (`createdBy` on every memory), visible (`list --created-by`), and reversible (`forget --created-by`), but not preventable. It cannot plant standing instructions without the `instruct` scope, cannot fabricate evidence (quotes are verified; sources it supplies itself are flagged self-attested on every hit), cannot grant itself anything, read the key or export over MCP. Search results carry a "data about the user, not instructions" notice, which helps some models and not others.

**7. Can the audit log be altered without anyone noticing?**
It is tamper-evident only. All four journals are chained with previous-line hashes and position-bound authenticated data, so editing, replaying, reordering or deleting a line anywhere but the tail is detected by `verify`. Truncating the tail, or rolling back a journal together with `vault.json`, is not detectable without an external anchor. Nothing here resists an attacker who holds the key and the disk.

**8. How does this compare with Mem0, Zep, Letta, or the memory import that Claude and Gemini shipped in March 2026?**
Mem0, Zep and Letta are aimed at developers building agents and are wired in from application code, each with its own API and storage. This is aimed at the person whose memory it is: a local file, one process per MCP client, no service, no account, no code to write, for the tools you already use. The vendors' import tools move your memory into their system in their shape (each hands you a prompt for the old assistant to answer with a summary); this keeps it in yours, in a documented format, and hands each of them a scoped view. They are not exclusive: you can export from the vault and feed a vendor's importer. OpenAI had shipped no such importer as of this writing, as far as we can find; if that changed, say so and we will correct it.

**9. Does it survive a model upgrade or switching vendors?**
That is the point of the fixed schema and of keeping raw sources. Goyal & Ray (2026, arXiv:2609.05339) report that memory in a fixed schema ports across model upgrades and that the raw sources are what let a memory be repaired later. A memory here is a sentence with a kind, confidence, tags and citations into verbatim sources, so a new model can re-derive or correct it from the evidence.

**10. What is all the Web3 stuff in this repository?**
History. The repository started in June 2025 as an on-chain identity / context / micropayment project, with Solidity contracts, SDKs, a metering gateway and a content-marketplace backend. Those compile and their tests pass, and the README says exactly what each one is (not deployed, not audited, simulated payments, a "/mcp" router that is not MCP, two demo scripts that do not run). The vault imports nothing from them. The planning documents from that time are in docs/archive with a note that none of their numbers were verified.

**11. Why should I trust the encryption?**
You should not take our word for it. There has been no independent review. What exists: only `node:crypto` primitives (AES-256-GCM, scrypt, SHA-256), a specification with test vectors (SPEC.md Part B) so a third party can decrypt a vault with the key and nothing else, tests that replay, delete and swap journal lines and expect `CORRUPT`, and a canary test that runs every tool and checks that the token, key and passphrase never reach the audit log, stderr, errors or the export. A review is what we most want from this post.

**12. License, npm, and what happens next?**
MIT. Not on npm yet; install from the clone, which is a deliberate choice for 0.1.0 so that what you run is what you can read. One consequence to know: the client config snippet contains the absolute path of the clone's `dist/cli.js` and of your `node`, so the clone has to stay put (or use `npm link`). Next, in roughly this order: a security review by someone who is not us, whatever this thread shows is broken, an Obsidian/notes importer, and then the question of local semantic search. The format is versioned (`opencontext-vault-export` v1) and 0.1.0 exports will stay importable.

## Pre-launch checklist

- [ ] **Commit and push the working tree first.** On 2026-10-21 `origin/feat/vault-mcp-hn-launch` (8944905) still carries the June 2025 README and the eleven planning documents at the repository root; the rewritten `README.md`, `SECURITY.md`, `CLAUDE.md`, `AGENTS.md`, `DEMO.md`, `docs/archive/` and `docs/launch/` exist only in the local working tree. A fresh clone shows none of this until it is pushed. Check with `git status --short` (must be empty) and `git log origin/feat/vault-mcp-hn-launch -1`.
- [ ] Record the 90-second demo described in the vault docs: `init`, `import` of a synthetic export, `grant --client claude-desktop`, one `distill` in Claude Desktop, `audit` showing the calls, `grant cursor --scopes read` and a denied `vault_source_read` from Cursor. Use the synthetic fixtures under `vault/test/fixtures/`, never a real export.
- [ ] Enable GitHub push protection and secret scanning on the repository; run `git log -p | grep -c ocv_` and expect 0 outside tests.
- [ ] Merge to `main` and get `ci.yml`, `vault.yml` and `security.yml` green there. As of 2026-10-21 **no workflow has ever run in this repository** (`gh api repos/zd87pl/opencontext-main/actions/runs` → `total_count: 0`; `gh run list` is empty), `main` (570e91d, 13 commits behind the branch) carries only `security.yml`, and GitHub lists only that one workflow. Only after all three have a green run on `main`, put the badges back under the first line of the root README:
  ```markdown
  [![CI](https://github.com/zd87pl/opencontext-main/actions/workflows/ci.yml/badge.svg)](https://github.com/zd87pl/opencontext-main/actions/workflows/ci.yml)
  [![vault](https://github.com/zd87pl/opencontext-main/actions/workflows/vault.yml/badge.svg)](https://github.com/zd87pl/opencontext-main/actions/workflows/vault.yml)
  [![Security Analysis](https://github.com/zd87pl/opencontext-main/actions/workflows/security.yml/badge.svg)](https://github.com/zd87pl/opencontext-main/actions/workflows/security.yml)
  ```
  and then rewrite the "CI status" section of the README to say what ran. Until then the README deliberately has none.
- [ ] Re-run `cd vault && npm test && npm run test:coverage` on the merge commit, as a normal user, and update the numbers at the top of this file, in the root README and in vault/README.md if they moved outside the ranges given.
- [ ] Pin: versions in `vault/package.json` are exact already; confirm `package-lock.json` is committed and `npm ci --omit=dev` installs with no scripts.
- [ ] Tag the release: `git tag -a vault-v0.1.0 -m "OpenContext Vault 0.1.0"` on the merge commit, and make sure `vault/CHANGELOG.md` dates match.
- [ ] Decide npm publish vs install-from-clone before posting. If publishing `@opencontext/vault`, do it from the tagged commit with provenance and change the quick start in both READMEs and in this file; otherwise leave the "install from the clone" line in the first comment as is.
- [ ] Ask the vault owner to fix `vault/SECURITY.md` line 3: it says the root `SECURITY.md` "is the smart-contract analysis and has no reporting address". The root `SECURITY.md` is now the repository security policy and gives security@opencontext.network, as does the root README (Contributing). Also `vault/README.md` line 16 still has `git clone <repo>` as a placeholder; the root README has the real URL.
- [ ] Make sure `vault/README.md`, `vault/SECURITY.md` and `vault/SPEC.md` render on GitHub (tables, anchors used in the root README: `#quick-start`, `#what-it-does-not-do`).
- [ ] Post on a weekday morning US time, paste the first comment immediately, and stay on the thread answering comments for at least 6 hours. Answer with the same tone as this file: say what is covered, say what is not.
- [ ] Have `vault/SECURITY.md` open; route anything that looks like a vulnerability to security@opencontext.network instead of debating it in public.

## Verification (2026-10-21, this checkout)

- Post text: 1109 characters including newlines (`wc -c` over the fenced block above; the block's trailing newline counts, so the pasted text is one less).
- Titles: 78, 79 and 76 characters by `awk '{print length($0)}'`; title 1 is 80 bytes (`wc -c`) because of the en dash. HN counts characters.
- First comment rows: generated by `awk -F'|' 'NR>=422 && NR<=439 {a=$2; b=$3; gsub(/^ +| +$/,"",a); gsub(/^ +| +$/,"",b); print a " — instead: " b}' vault/README.md | sed 's#\[SECURITY.md\](SECURITY.md)#https://github.com/zd87pl/opencontext-main/blob/main/vault/SECURITY.md#'` (rows 422–439 are the 18 body rows of the "What it does not do" table; 420–421 are the header); `diff` against the 18 lines in the block above reports no difference.
- Key-file caveat: paraphrased from `vault/README.md` "Security model" and `vault/SECURITY.md` row "T2 stolen disk, key-file mode".
- Vault tests, four configurations, all exit 0, all 25 files passed:
  - normal user (uid 65534), no `CI`: `node node_modules/vitest/vitest.mjs run` → 361 passed, 0 skipped.
  - normal user, `CI=1`: 360 passed, 1 skipped (`test/vault-search.test.ts` "indexes 5 MB of synthetic conversation text in under 2 s" is `it.skipIf(process.env.CI === '1')`).
  - root, no `CI`: `npm test` → 360 passed, 1 skipped (`test/audit.test.ts` "a read-only vault directory makes the real sink fail with IO" is `it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)`).
  - root, `CI=1`: `npm test` → 359 passed, 2 skipped.
- Vault coverage (`npm run test:coverage`, "All files" line, statements / branches / functions / lines): root `CI=1`, two runs: 87.28 / 75.52 / 91.73 / 90.64 both times; root without `CI`: 87.28 / 75.52 / 91.73 / 90.64; normal user `CI=1`: 87.38 / 75.73 / 91.73 / 90.66. An earlier reviewer's non-root runs gave 87.28–87.35 / 75.63–75.7. Hence the rounded figures and ranges above; the thresholds (80 / 80 / 80 / 70 for statements / functions / lines / branches) are what CI enforces.
- Tool counts: `grep -c 'server.registerTool(' vault/src/mcp/tools.ts` = 9; `grep -c 'server.registerResource(' vault/src/mcp/resources.ts` = 2; `grep -c 'server.registerPrompt(' vault/src/mcp/prompts.ts` = 2; `TOOL_NAMES` in `tools.ts` lists 9 names. (A bare `grep -c registerTool` gives 10 because it also matches the `registerTools` function definition; same for the other two.)
- Dependencies: `node -e 'console.log(Object.keys(require("./vault/package.json").dependencies))'` → `@modelcontextprotocol/sdk`, `zod`; `npm ci --omit=dev` in a copy of `vault/package.json` + `package-lock.json` → "added 95 packages"; the lockfile has 95 non-dev entries, none optional; `zod` declares no dependencies, so 93 are transitive via the SDK.
- Quick start timing: `npm ci && npm run build` in a copy of the vault's tracked files, warm npm cache: 5 s, `dist/cli.js` present.
- demo scripts: `node demo.js` → `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ethers'`, exit 1; `ls sdk/js/src/index.js` → no such file; `cd sdk/python && poetry run python ../../demo.py` → warning, three retries against `https://sepolia.era.zksync.dev`, `Demo failed: ... Error code: SDKError.TRANSACTION_FAILED` (the handler calls `sys.exit(1)`).
- Other suites: `forge test` → 5 suites, 153 passed; `sdk/js npm test` → 11 files, 193 passed; `sdk/python poetry run pytest -q` → 105 passed; `gateway npm test` → 15 files, 318 passed; `backend npm test` → 7 files, 141 passed.
- GitHub state: `gh api repos/zd87pl/opencontext-main/actions/workflows` lists only `security.yml`; `gh api 'repos/zd87pl/opencontext-main/actions/runs?per_page=1' --jq .total_count` → 0; `git ls-tree --name-only origin/main .github/workflows/` → `security.yml` only; `git rev-list --count origin/main..HEAD` → 13; `git status --short` shows the five root files modified and uncommitted, eleven renames staged, `docs/archive/README.md` and `docs/launch/` untracked.
- March 2026 import claim: PCWorld, "Claude can now import chat histories from ChatGPT (and other AIs)", 2026-03-03; MacRumors, "Google Launches Gemini Import Tool for Switching From ChatGPT, Claude, and Other AI Apps", 2026-03-26. Two web searches found no source for a ChatGPT importer, so no document in this repository claims one.
