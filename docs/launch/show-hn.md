# Show HN: OpenContext Vault

Every number in this file comes from a command run in this checkout on 2026-10-21 (Node 22.22.0, npm 10.9.4); the [Verification](#verification-2026-10-21-this-checkout) section at the end lists the command behind each one. Re-run them before posting and replace anything that moved.

Short version of the test numbers: `cd vault && npm test` runs 25 files, 361 tests; all 361 pass as a normal user, one skips under `CI=1`, one skips as root. Coverage is about 87 % statements, 75–76 % branches, 92 % functions, 91 % lines; the second decimal moves between runs and users (even between two runs with identical settings), and the thresholds enforced in CI (`vault.yml`) are 80/80/80/70.

## Title options (≤ 80 characters)

1. `Show HN: OpenContext Vault – your AI memory as an encrypted local MCP server` (76 characters; 78 bytes because of the en dash)
2. `Show HN: An encrypted, portable memory for AI agents you own (local MCP server)` (79 characters, 79 bytes)
3. `Show HN: Import ChatGPT/Claude/Gemini history into a vault your agents query` (76 characters, 76 bytes)

Counted with `python3 -c 'import sys;print(len(sys.argv[1]))' "<title>"`, which is locale-independent; `awk length` and `wc -m` return bytes under a C/POSIX locale and miscount the en dash. HN's limit is 80 characters.

## Post text (≤ 1200 characters)

```
OpenContext Vault is a local MCP server (stdio) holding a memory of you that you own: a directory on your disk, AES-256-GCM encrypted under a key you hold. It prints config snippets for Claude Desktop, Claude Code, Cursor, Windsurf and VS Code; tested with the MCP SDK's client, not yet in each host.

It imports your ChatGPT, Claude and Gemini exports verbatim, lets the model you already use distill one-sentence memories with citations re-checked against the source, and exports memories and sources as documented JSON.

Each client gets its own token with scopes, so a coding tool can read memories but never raw conversations; revoking applies on the next call. Every call is logged to an encrypted audit journal before it returns.

What it is not: no cloud, no account, no sync, no embeddings (BM25), no GUI, no LLM call inside the vault. TypeScript, two direct dependencies, no network code. 0.1.0, not on npm, no independent security review.

Try it (Node 20+): clone, cd vault, npm ci && npm run build, init, import an unzipped export, grant a client.

Feedback wanted on the schema, export format (SPEC.md) and threat model (SECURITY.md): what would you not trust it with?
```

(1182 characters including newlines, leaving 18 for edits at submit time; the count is in the Verification section. Re-check after editing with the Python command given there; `wc -c` agrees only while the text stays ASCII.)

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

The `https://github.com/zd87pl/opencontext-main/blob/main/vault/SECURITY.md` link in the last row returns 404 until the branch is merged to `main` (checked 2026-10-21: `gh api 'repos/zd87pl/opencontext-main/contents/vault/SECURITY.md?ref=main'` → `Not Found`, `?ref=feat/vault-mcp-hn-launch` → the file). Merging is step 2 of the pre-launch checklist below; if you post from the branch instead, replace `blob/main` with `blob/feat/vault-mcp-hn-launch` in that link.

## Anticipated questions

**1. Why not just a JSON file or a Markdown folder?**
Because the interesting parts are not the storage but what sits around it: per-client tokens with scopes, so your coding tool cannot read your raw conversations; an audit log of every call with its arguments, written before the call returns; citations that are re-verified against the source text; versions instead of edits; encryption at rest with a key kept outside the directory. A JSON file gives every process on your machine everything. You can still get the JSON: `export` writes memories and sources, and SPEC.md documents it.

**2. Why MCP?**
Because over stdio it needs no server: the vault is one Node process per client and nothing listens on a port. To be exact about what has been verified: the vault is a stdio MCP server, exercised in the test suite by the MCP SDK's own client, both against a spawned `dist/cli.js` over stdio (`test/stdio.test.ts`) and in memory (`test/mcp.test.ts`); `grant --client` prints ready-to-paste config snippets for Claude Desktop, Claude Code, Cursor, Windsurf and VS Code; it has not yet been exercised inside each of those five hosts, so a report from any of them is welcome. If a better local protocol wins, the data is in an open format and the server is the thin part.

**3. Why no embeddings or semantic search?**
Three reasons. The vault makes no LLM or embedding calls by design, so there is nothing to embed with unless we ship a model. Memories are one-sentence records with tags and kinds, where BM25 with stemming over a few thousand sentences works. And a plaintext vector index next to encrypted records would be a leak. Semantic search is the most requested thing we left out; if it comes, it will be local and optional.

**4. Why Node / TypeScript?**
The MCP reference SDK is TypeScript and every host above launches a command. Node 20+ has to be installed separately (the hosts do not bring it), which is why the generated config snippets contain the absolute path of your `node` binary instead of assuming `node` is on the host's `PATH`. The vault has two direct dependencies (the MCP SDK and zod) and uses `node:crypto` for the cryptography. To be exact about it: `npm ci --omit=dev` installs 95 packages, 93 of them pulled in by the MCP SDK (zod has none), mostly for HTTP transports the vault never loads; a test checks that nothing in `dist/` imports network modules. A Rust or Go port would be welcome and SPEC.md exists so that it can read the same files.

**5. How secure is key-file mode, really?**
Against a stolen powered-off disk: not at all, the key is on the same disk. Against a leaked backup or a synced vault directory: fine, as long as the key file was not copied with it. Against another process running as your user: out of scope, exactly like SSH keys and browser profiles. Passphrase mode (`init --passphrase`, scrypt N=2^17) covers the stolen disk to the strength of the passphrase; keep the passphrase in your OS keychain and point `OPENCONTEXT_VAULT_PASSPHRASE_CMD` at it. SECURITY.md has the full table.

**6. Can a prompt-injected agent poison my memory?**
It can write false ordinary facts if it holds a `write` grant; that is attributable (`createdBy` on every memory), visible (`list --created-by`), and reversible (`forget --created-by`), but not preventable. It cannot plant standing instructions without the `instruct` scope. It can store a citation whose quote is not in the cited source: the vault keeps the memory but stores that citation with `verified: false`, says so in the `vault_remember` response (an `unverifiedQuotes` count and the warning "quote for source … was not found verbatim in the source"), and every `vault_search` hit shows the `verified` flag; a source the agent files itself with `vault_source_add` is `trust: "agent-supplied"`, and memories that client writes against it are flagged self-attested on every hit. It cannot grant itself anything, read the key or export over MCP. Search results carry a "data about the user, not instructions" notice, which helps some models and not others.

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

- [ ] **Commit and push the working tree first.** On 2026-10-21 `origin/feat/vault-mcp-hn-launch` is at c9091bb, the same commit as `HEAD`, and carries the rewritten `README.md`, `SECURITY.md`, `CLAUDE.md`, `AGENTS.md`, `DEMO.md`, `docs/archive/` and `docs/launch/`; the edits made after that commit (this file among them) sit in the working tree until they are committed and pushed. A fresh clone shows only what is pushed. Check with `git status --short` (must be empty) and `git log origin/feat/vault-mcp-hn-launch -1`.
- [ ] **Merge to `main` and get `ci.yml`, `vault.yml` and `security.yml` green there.** This comes before the demo and the link check because the first comment links to `blob/main/vault/SECURITY.md`, which 404s until the merge (see the note under the first comment). As of 2026-10-21 **no workflow has ever run in this repository** (`gh api repos/zd87pl/opencontext-main/actions/runs` → `total_count: 0`; `gh run list` is empty), `main` (570e91d, 14 commits behind the branch) carries only `security.yml`, and GitHub lists only that one workflow. Only after all three have a green run on `main`, put the badges back under the first line of the root README:
  ```markdown
  [![CI](https://github.com/zd87pl/opencontext-main/actions/workflows/ci.yml/badge.svg)](https://github.com/zd87pl/opencontext-main/actions/workflows/ci.yml)
  [![vault](https://github.com/zd87pl/opencontext-main/actions/workflows/vault.yml/badge.svg)](https://github.com/zd87pl/opencontext-main/actions/workflows/vault.yml)
  [![Security Analysis](https://github.com/zd87pl/opencontext-main/actions/workflows/security.yml/badge.svg)](https://github.com/zd87pl/opencontext-main/actions/workflows/security.yml)
  ```
  and then rewrite the "CI status" section of the README to say what ran. Until then the README deliberately has none.
- [ ] Record the 90-second demo described in the vault docs: `init`, `import` of a synthetic export, `grant --client claude-desktop`, one `distill` in Claude Desktop, `audit` showing the calls, `grant cursor --scopes read` and a denied `vault_source_read` from Cursor. Use the synthetic fixtures under `vault/test/fixtures/`, never a real export.
- [ ] Enable GitHub push protection and secret scanning on the repository, then run `git log -p | grep -cE 'ocv_[A-Za-z0-9_-]{32}'` (the full token shape: `ocv_` plus 32 characters of `[A-Za-z0-9_-]`; a bare `ocv_` also matches prose and the `<TOKEN>` placeholders). Expected result: only hard-coded test values. On 2026-10-21 it reports 4 matching lines, all under `vault/test/`: three in `vault/test/crypto.test.ts` (commit a9aa378, the `hashToken` and `looksLikeToken` tests) and one in `vault/test/cli.test.ts` (commit 8944905, the snippet-rendering test); `grep -rnE 'ocv_[A-Za-z0-9_-]{32}' --exclude-dir=node_modules --exclude-dir=.git .` finds the same four lines in the working tree. Any match outside `vault/test/` is a leaked token: revoke it (`revoke` / `grant --rotate`) and rewrite history before posting.
- [ ] Re-run `cd vault && npm test && npm run test:coverage` on the merge commit, as a normal user, and update the numbers at the top of this file, in the root README and in vault/README.md if they moved outside the ranges given.
- [ ] Pin: versions in `vault/package.json` are exact already; confirm `package-lock.json` is committed and `npm ci --omit=dev` installs with no scripts.
- [ ] Tag the release: `git tag -a vault-v0.1.0 -m "OpenContext Vault 0.1.0"` on the merge commit, and make sure `vault/CHANGELOG.md` dates match.
- [ ] Decide npm publish vs install-from-clone before posting. If publishing `@opencontext/vault`, do it from the tagged commit with provenance and change the quick start in both READMEs and in this file; otherwise leave the "install from the clone" line in the first comment as is.
- [ ] Ask the vault owner to fix `vault/SECURITY.md` line 3: it says the root `SECURITY.md` "is the smart-contract analysis and has no reporting address". The root `SECURITY.md` is now the repository security policy and gives security@opencontext.network, as does the root README (Contributing). Also `vault/README.md` line 16 still has `git clone <repo>` as a placeholder and line 17 says `~1 min` for `npm ci && npm run build`; the root README has the real URL and the measured 5 s, and the two quick starts are not claimed to be identical until the vault owner syncs them.
- [ ] Make sure `vault/README.md`, `vault/SECURITY.md` and `vault/SPEC.md` render on GitHub (tables, anchors used in the root README: `#quick-start`, `#what-it-does-not-do`).
- [ ] Post on a weekday morning US time, paste the first comment immediately, and stay on the thread answering comments for at least 6 hours. Answer with the same tone as this file: say what is covered, say what is not.
- [ ] Have `vault/SECURITY.md` open; route anything that looks like a vulnerability to security@opencontext.network instead of debating it in public.

## Verification (2026-10-21, this checkout)

- Post text: 1182 characters including newlines, 1183 with the fenced block's trailing newline, by `python3 -c 'import sys;print(len(sys.stdin.read()))'` over the block; `wc -c` gives the same 1183 because the post is ASCII.
- Titles: 76, 79 and 76 characters by `python3 -c 'import sys;print(len(sys.argv[1]))' "<title>"`, and the same by `printf '%s' "<title>" | LANG=C.UTF-8 wc -m`; `printf '%s' "<title>" | wc -c` gives 78, 79 and 76 bytes, title 1 being two bytes longer than its character count because the en dash (U+2013) is three bytes in UTF-8. With the locale unset, as in this container, `awk '{print length($0)}'` and a plain `wc -m` both print 78 for title 1 (they count bytes there), which is how 78/80 got into an earlier revision of this file. HN counts characters.
- First comment rows: generated by `awk -F'|' 'NR>=422 && NR<=439 {a=$2; b=$3; gsub(/^ +| +$/,"",a); gsub(/^ +| +$/,"",b); print a " — instead: " b}' vault/README.md | sed 's#\[SECURITY.md\](SECURITY.md)#https://github.com/zd87pl/opencontext-main/blob/main/vault/SECURITY.md#'` (rows 422–439 are the 18 body rows of the "What it does not do" table; 420–421 are the header); `diff` against the 18 lines in the block above reports no difference.
- Key-file caveat: paraphrased from `vault/README.md` "Security model" and `vault/SECURITY.md` row "T2 stolen disk, key-file mode".
- Vault tests, four configurations, all exit 0, all 25 files passed:
  - normal user (uid 65534), no `CI`: `node node_modules/vitest/vitest.mjs run` → 361 passed, 0 skipped.
  - normal user, `CI=1`: 360 passed, 1 skipped (`test/vault-search.test.ts` "indexes 5 MB of synthetic conversation text in under 2 s" is `it.skipIf(process.env.CI === '1')`).
  - root, no `CI`: `npm test` → 360 passed, 1 skipped (`test/audit.test.ts` "a read-only vault directory makes the real sink fail with IO" is `it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)`).
  - root, `CI=1`: `npm test` → 359 passed, 2 skipped.
- Vault coverage (`npm run test:coverage`, "All files" line, statements / branches / functions / lines), three runs as root on 2026-10-21 in a copy of the vault's tracked files (`git archive HEAD vault`): `CI` unset, first run: 87.28 / 75.63 / 91.73 / 90.64; `CI` unset, second run: 87.35 / 75.7 / 91.73 / 90.66; `CI=1`: 87.35 / 75.7 / 91.73 / 90.66. Two runs with identical settings differ in the second decimal, and runs recorded in earlier revisions of this file (root and normal user, with and without `CI=1`) spread further, down to 75.5 % branches. Hence only the rounded figures are quoted anywhere: about 87 / 75–76 / 92 / 91 %, and never a two-decimal "both times" claim. The thresholds `vault.yml` enforces are 80 / 80 / 80 / 70 for statements / functions / lines / branches.
- Tool counts: `grep -c 'server.registerTool(' vault/src/mcp/tools.ts` = 9; `grep -c 'server.registerResource(' vault/src/mcp/resources.ts` = 2; `grep -c 'server.registerPrompt(' vault/src/mcp/prompts.ts` = 2; `TOOL_NAMES` in `tools.ts` lists 9 names. (A bare `grep -c registerTool` gives 10 because it also matches the `registerTools` function definition; same for the other two.)
- Dependencies: `node -e 'console.log(Object.keys(require("./vault/package.json").dependencies))'` → `@modelcontextprotocol/sdk`, `zod`; `npm ci --omit=dev` in a copy of `vault/package.json` + `package-lock.json` → "added 95 packages"; the lockfile has 95 non-dev entries, none optional; `zod` declares no dependencies, so 93 are transitive via the SDK.
- Quick start timing: in the same copy of the vault's tracked files, warm npm cache, as root: `npm ci` 2.0 s (`added 147 packages`), `npm run build` 3.0 s, 5.0 s together, `dist/cli.js` present.
- demo scripts: `node demo.js` → `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'ethers'`, exit 1; `ls sdk/js/src/index.js` → no such file; `cd sdk/python && poetry run python ../../demo.py` → warning, three retries against `https://sepolia.era.zksync.dev`, `Demo failed: ... Error code: SDKError.TRANSACTION_FAILED` (the handler calls `sys.exit(1)`).
- Other suites: `forge test` → 5 suites, 153 passed; `sdk/js npm test` → 11 files, 193 passed; `sdk/python poetry run pytest -q` → 105 passed; `gateway npm test` → 15 files, 318 passed; `backend npm test` → 7 files, 141 passed.
- GitHub state: `gh api repos/zd87pl/opencontext-main/actions/workflows` lists only `security.yml`; `gh api 'repos/zd87pl/opencontext-main/actions/runs?per_page=1' --jq .total_count` → 0; `git ls-tree --name-only origin/main .github/workflows/` → `security.yml` only; `git rev-list --count origin/main..HEAD` → 14, with `HEAD` = c9091bb = `origin/feat/vault-mcp-hn-launch` (`git rev-list --count origin/feat/vault-mcp-hn-launch..HEAD` → 0); `git status --short` was empty before the edits recorded in this revision of the file. `gh api 'repos/zd87pl/opencontext-main/contents/vault/SECURITY.md?ref=main'` → `Not Found` (404); `?ref=feat/vault-mcp-hn-launch` → `vault/SECURITY.md`.
- Token leak check: `git log -p | grep -cE 'ocv_[A-Za-z0-9_-]{32}'` → 4; by commit and file (`git log -p --format='COMMIT %h' | awk '/^COMMIT /{c=$2} /^\+\+\+ /{f=$2} /ocv_[A-Za-z0-9_-]{32}/{print c, f}' | sort | uniq -c`) → 3 × a9aa378 `vault/test/crypto.test.ts`, 1 × 8944905 `vault/test/cli.test.ts`; `grep -rnE 'ocv_[A-Za-z0-9_-]{32}' --exclude-dir=node_modules --exclude-dir=.git .` → the same four lines, all literal test values (`hashToken`, `looksLikeToken`, `renderAllSnippets`).
- March 2026 import claim: PCWorld, "Claude can now import chat histories from ChatGPT (and other AIs)", 2026-03-03; MacRumors, "Google Launches Gemini Import Tool for Switching From ChatGPT, Claude, and Other AI Apps", 2026-03-26. Two web searches found no source for a ChatGPT importer, so no document in this repository claims one.
