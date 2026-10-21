# OpenContext Vault

A user-owned, encrypted, portable memory for your AI agents, as a local MCP server.

## What it is

Your AI memory is a directory you own, encrypted with a key you hold, readable only by the agents you explicitly authorize, with every access logged. It imports your ChatGPT, Claude and Gemini history verbatim, lets the model you already use distill durable memories from it with provenance, and exports everything to an open JSON format so it survives switching models or vendors. It is a single Node process per client, speaking MCP over stdio: two direct runtime dependencies, no network, no LLM calls, no cloud, no account.

- Node ≥ 20, pure ESM, `tsc` build, `vitest` tests. Two direct runtime dependencies (`@modelcontextprotocol/sdk`, `zod`; 95 packages installed by `npm ci --omit=dev` from the committed lockfile, pure JavaScript, no install scripts — the lockfile's only `hasInstallScript` entry is the dev-only `fsevents`).
- No network code ships: `test/no-network.test.ts` scans `dist/` for `node:http`, `node:https`, `node:net`, `node:dns`, `node:tls`, `fetch(` and `WebSocket`, allows only the SDK's `server/mcp.js` and `server/stdio.js` imports, and `scripts/lint.mjs` bans the same imports in `src/`.
- No independent security review has been performed: [SECURITY.md](SECURITY.md) says exactly what is and is not protected.

## Quick start

```bash
git clone --recursive https://github.com/zd87pl/opencontext-main.git && cd opencontext-main/vault
npm ci && npm run build                                   # Node 20+; about 5 s with a warm npm cache, longer cold
node dist/cli.js init                                     # ~/.opencontext/vault + ~/.opencontext/vault.key (0600)
node dist/cli.js import ~/Downloads/chatgpt-export/       # or a Claude export folder, Google Takeout JSON, or a folder of .md
node dist/cli.js grant claude-desktop --scopes read,write,sources --client claude-desktop   # token printed once + snippet
# paste the snippet, restart Claude Desktop, then use the "distill" prompt
node dist/cli.js grant cursor --scopes read --client cursor                                # memory-only, no raw conversations
```

In key-file mode the key sits next to the vault on the same disk, so **enable full-disk encryption** (FileVault / BitLocker / LUKS); `init --passphrase` wraps the key with scrypt instead (see [Security model](#security-model)). `test/cli.test.ts` runs the same commands (`init`, `grant --client`, `import`, `export`, `verify`, `revoke`) in-process on a temporary vault.

## Client config snippets

`grant <label> --client <kind>` prints the token exactly once, inside a ready-to-paste snippet that uses your absolute `node` path (`process.execPath`) and the absolute path of `dist/cli.js`, because MCP hosts do not inherit the shell `PATH` reliably (`test/cli.test.ts` "renders every client kind with absolute paths and the token exactly once", and parses the JSON). `config <label> --client <kind|all>` reprints the same snippets later with a `<TOKEN>` placeholder: tokens are stored only as hashes and cannot be recovered (`grant --rotate` mints a new one). `npm link` and `"command": "opencontext-vault"` are the alternative to absolute paths.

This is the output of `node dist/cli.js config demo --client all` on the development container, with the two absolute paths replaced by `<NODE>` and `<CLI>`; `grant --client` prints the same blocks with the real `ocv_…` token in place of `<TOKEN>`:

```text
# Claude Desktop — ~/Library/Application Support/Claude/claude_desktop_config.json (macOS) · %APPDATA%\Claude\claude_desktop_config.json (Windows)
{
  "mcpServers": {
    "opencontext-vault": {
      "command": "<NODE>",
      "args": [
        "<CLI>",
        "serve"
      ],
      "env": {
        "OPENCONTEXT_VAULT_TOKEN": "<TOKEN>"
      }
    }
  }
}

# Claude Code — run this command once
claude mcp add opencontext-vault -s user -e OPENCONTEXT_VAULT_TOKEN=<TOKEN> -- <NODE> <CLI> serve

# Cursor — ~/.cursor/mcp.json (or .cursor/mcp.json per project)
{
  "mcpServers": {
    "opencontext-vault": {
      "command": "<NODE>",
      "args": [
        "<CLI>",
        "serve"
      ],
      "env": {
        "OPENCONTEXT_VAULT_TOKEN": "<TOKEN>"
      }
    }
  }
}

# Windsurf — ~/.codeium/windsurf/mcp_config.json
{
  "mcpServers": {
    "opencontext-vault": {
      "command": "<NODE>",
      "args": [
        "<CLI>",
        "serve"
      ],
      "env": {
        "OPENCONTEXT_VAULT_TOKEN": "<TOKEN>"
      }
    }
  }
}

# VS Code — .vscode/mcp.json
{
  "servers": {
    "opencontext-vault": {
      "type": "stdio",
      "command": "<NODE>",
      "args": [
        "<CLI>",
        "serve"
      ],
      "env": {
        "OPENCONTEXT_VAULT_TOKEN": "<TOKEN>"
      }
    }
  }
}
(replace <TOKEN> with the token printed by grant; run: opencontext-vault grant demo --rotate for a new one)
```

Passphrase mode: add `OPENCONTEXT_VAULT_PASSPHRASE_CMD` (a command whose stdout is the passphrase, run without a shell — for example your OS keychain CLI) to the `env` block; `serve` never prompts. Run `opencontext-vault clients --pending` to see what your client calls itself: names are informational and never confer access.

## How memory works

**Schema.** A memory is one sentence in third person (`"User prefers tabs over spaces in Go."`) with a `kind` (`fact`, `preference`, `instruction`, `goal`, `skill`, `relationship`, `event`), a `subject`, `tags`, a `confidence` (`stated` when the user said it in so many words, `inferred` otherwise), optional validity dates, `createdBy` (the grant label or `cli`) and a list of source citations. The full zod schema is `src/types.ts`; the export schema generated from it is `schema/opencontext-vault-export.v1.schema.json`.

**Provenance.** Every citation names a source and, for conversations, a turn and a verbatim quote. The store re-checks each quote against the source text (NFKC, whitespace-collapsed, case-sensitive) on every write, so `verified` is computed, never asserted (`test/store.test.ts` "verifyQuote", `test/mcp.test.ts` scenario 3). `show <id>` prints the chain; `verify --provenance` recomputes every flag and lists citations to forgotten sources.

**Versions.** Memories are never edited in place: `vault_remember { supersedes }` writes a new record and marks the old one `superseded` with a pointer to its replacement (also when the new statement turns out to be a duplicate of one the same client wrote: the duplicate then supersedes the old one, or the response says why it could not); `list --status all` shows the chain, `forget` deletes a memory together with the older versions it supersedes (`test/mcp.test.ts` scenarios 3 and 9, `test/store.test.ts` "supersede chain"). Exact duplicates (same normalized statement and subject) written by the same client merge their citations instead of creating a second record; a duplicate of a record another client or the owner wrote is reported (`deduplicated: true`, a warning) and left untouched, so tags and citations always stay under the label that wrote them, and `forget --created-by` reverses everything a client did. "prefers tabs over spaces" and "prefers spaces over tabs" are distinct (`test/store.test.ts` "findDuplicate").

**Trust.** Imported sources are `trust: "imported"`; a source an agent files with `vault_source_add` is `trust: "agent-supplied"`, and memories citing it are flagged self-attested in every search result and counted in the `vault_remember` response (`test/mcp.test.ts` scenario 3). When a source body is replaced (a re-import, or the same client refiling the same `externalId`), every citation to it is re-verified at once, so `verified` never asserts a quote the current text does not contain (`test/durability.test.ts`). `vault_search` results carry a `notice` that memories are data about the user, not instructions, and `vault_source_read` returns archived text behind the same notice; a conversation turn longer than one page is read in pieces with `fromOffset`/`nextOffset`.

**Search.** Keyword search only: BM25 over memories (always in memory) and, after a background build, over source bodies with snippets (`test/bm25.test.ts`, `test/vault-search.test.ts`; the perf smoke in that file printed `indexed 198 sources / 5.0 MB in 677 ms; top-5 query with snippets 1 ms` on the linux/x64 development container, Node 22.22.0). For a tag-restricted grant the statistics (N, average length, document frequency) are computed over the records it may see, so its scores and ranks say nothing about hidden records. Tokens go through `Intl.Segmenter` and a Porter stemmer, so `"wörld"` and `"世界"` are found; there are no embeddings.

## Importing your history

`import <path…>` takes files or directories, detects the format from content (a vendor shape is recognised by its id keys, so an arbitrary JSON array with a `docs` or `mapping` key next to your notes is listed as not supported rather than imported as empty sources), keeps the vendor record verbatim as `raw` (unless `--no-raw`) and computes deterministic ids, so re-importing the same export is idempotent and a changed conversation is updated in place with its review state kept (`test/importers.test.ts` "runImport"). An older export never rolls a conversation back: ChatGPT's `update_time` and Claude's `updated_at` are stored as `updatedAt`, and a record older than the stored one is skipped and reported, so the order in which you import several export zips does not matter. Symbolic links are not followed (a link to `.` or to a parent would import every note some 40 times) and are listed under `ignored`, as are files the run cannot read; only fatal errors change the exit code.

| Vendor / format | What is kept | Only in `raw` | Known limits |
|---|---|---|---|
| ChatGPT (`conversations.json`, the folder of a data export) | the current branch of every conversation as turns, custom instructions (`user_editable_context`) and model-set context (`model_editable_context`) as system turns, titles, times | alternate / abandoned branches (counted in a note), tool call and tool output payloads, generated images | non-text parts appear as `omitted` markers naming the vendor content type; hidden system scaffolding is skipped; `chat.html` and `user.json` are listed as ignored |
| Claude (`conversations.json`, `projects.json`) | text content blocks, attachments with extracted text appended as `[attachment: name]`, project documents and `prompt_template` as documents | tool use / tool result / thinking blocks, binary files (`omitted` markers) | — |
| Gemini (Google Takeout `MyActivity.json`) | prompts and answers (HTML converted to text), grouped into conversations when less than `--gemini-window` minutes apart (default 30; `0` = one source per record) | the Takeout records | the grouping is a heuristic; Takeout has no conversation ids; `MyActivity.html` is refused with a hint to re-export as JSON; English-language exports only (Takeout localizes the `Prompted …` titles, and a file with none is reported as unsupported with the fix); choose the window once: re-importing with another window regroups the records under new ids (adds sources, rewrites the group leaders) instead of regrouping in place — preview with `--dry-run` |
| Markdown / text files and folders | the whole file verbatim, title from front matter `title:`, the first heading or the file name, `date:` and `tags:` from front matter, mtime otherwise | — (documents have no `raw`) | dot-files, dot-directories, `node_modules` and symbolic links are skipped; `.csv` and other extensions are listed as ignored; no size limit (a 100 MB note is one source, read back whole) |
| Portable export (`export --format json`) | memories and sources with their original ids | — | parsed in memory; documented limit ≈ 500 MB |

Vendor exports stream (`test/json-array-stream.test.ts` reads a generated 50 MB array with less than 100 MB of heap growth) and source bodies are written one at a time, so a multi-hundred-MB export never has to fit in RAM. Fixtures under `test/fixtures/` are synthetic and fictional.

## Access control and audit

Identity is the token, nothing else. `grant <label> --scopes …` mints an `ocv_` token, stores only its hash and prints the token exactly once (`test/cli.test.ts`). The server resolves the grant on every call after re-reading the vault, so `revoke` and `grant --rotate` apply to a running client's very next call without a restart (`test/mcp.test.ts` scenario 6, `test/multiprocess.test.ts` (4), `test/access.test.ts` "is re-evaluated on every call"). A grant with `--tags` **reads** only records carrying one of its tags, and its writes always carry those tags; it may add tags of its own (so a coding tool can label a note `go`), which means tag scopes bound what a client sees, not which labels it may write — a record it creates is attributable and reversible like any other (`test/mcp.test.ts` scenario 5). Its `forget` deletes a supersede chain only as far as its tags reach. Every text field an agent writes (statement, subject, quote, title, note) refuses control characters, and the CLI replaces any control character in a human-readable line with `\uFFFD`, so stored data can never rewrite your terminal when you review it (`test/mcp.test.ts` scenario 9, `test/cli.test.ts`).

| Call | Required scopes | Notes |
|---|---|---|
| `vault_status` | — | unauthenticated callers get only `authorized: false` and how to grant: no path, no counts |
| `vault_search` | `read` | tag filter applied; also returns the caller-visible standing `instruction` memories |
| `vault_remember` | `write` (+ `instruct` when `kind` is `instruction`, `supersedes` points at one, or the statement merges into one) | auto-tagging applied; a duplicate written by another client is reported, not merged; without `read` the response carries only the caller's own citations |
| `vault_forget` | `forget` (+ `sources` when any id is `src_`) | chain-deletes the older versions the grant can see |
| `vault_source_list`, `vault_source_search`, `vault_source_read` | `sources` | raw conversations are more sensitive than memories |
| `vault_source_add` | `sources` + `write` | marks the source `trust: "agent-supplied"` |
| `vault_source_review` | `sources` + `write` | |
| resource `vault://status` | — | same payload as `vault_status` |
| resource `vault://profile` | `read` | markdown |
| prompts `distill`, `capture` | — | text only; the text names the scopes the model will need |
| grant / revoke / rotate, export, import, rekey, compact | CLI only | not reachable over MCP by design |

The table is the `SCOPE_MATRIX` constant in `src/access/policy.ts`, exercised for every tool in `test/access.test.ts` and `test/mcp.test.ts` scenario 1 (no token: every tool except `vault_status` is denied with the exact message and hint).

Every tool, resource and prompt call is written to the encrypted audit journal **before** its result is returned, with the client's grant, the full arguments (vault tokens redacted, then truncated at 1024 characters, in that order, so a token cut by the limit is still redacted), outcome and duration; the client's self-asserted name, version and title are clipped to 200 characters each; if the entry cannot be written, the call fails (`test/audit.test.ts`). `audit` decrypts and prints it, `audit --follow` tails it, `audit --denied` shows refused calls; `audit --limit N` and `status` read the newest entries from the end of the file without decrypting the rest, and every open verifies the whole chain without decrypting it, so a year of entries does not slow every command down. `test/canary.test.ts` runs every tool with a canary string and proves the audit log contains the arguments but never the token, the key bytes or the passphrase, and that stderr, error texts and the export contain none of the three. Calls rejected by MCP input validation never reach the vault and are not logged. `clients --pending` lists the clients that connected without a valid token in the last 30 days (a `session_start` is written before a client's first call even when it skipped the handshake notification), with the `grant` command to run. The audit journal is never compacted: the arguments of the call that wrote a record stay in it after a `forget` (see [Security model](#security-model)).

## Portable export

`export --out memory.json` streams the documented `opencontext-vault-export` v1 format: every memory including superseded versions, every source with its full body and raw vendor record, nothing else (no grants, tokens, keys or audit entries). [SPEC.md](SPEC.md) is the normative description — file layout, envelope format, AAD bytes, key file, canonical JSON rules, test vectors — and `schema/opencontext-vault-export.v1.schema.json` is generated from the zod schema (`test/schema.test.ts` checks it is fresh). `import memory.json` restores a vault with the same ids; `test/roundtrip.test.ts` exports 50 seeded random vaults, imports each into a fresh vault and re-exports, asserting deep equality of `memories` and `sources`. `export --format md` writes a human-readable Markdown digest that is not re-importable. Exports are plaintext: `--out` writes with mode 0600 and refuses to overwrite without `--force`. A source forgotten by another process while an export runs ends the export with `NOT_FOUND` and "run the export again", not with a corruption report.

You do not need this package to get your data back: [`examples/decrypt_vault.py`](examples/decrypt_vault.py) (Python 3.10+, `pip install cryptography`) was written from SPEC.md and the test vectors alone, without the TypeScript sources, and decrypts and verifies a vault directory — key file, manifest check, the four journal chains, every body hash — then prints the memories or dumps everything to JSON: `python3 -I examples/decrypt_vault.py read --vault-dir ~/.opencontext/vault --key-file ~/.opencontext/vault.key --all-bodies`. It is an example, not part of the test suite.

## CLI reference

<!-- cli:begin -->
```text
opencontext-vault — a user-owned, encrypted, portable memory for your AI agents, as a local MCP server

Usage: opencontext-vault <command> [flags]

Commands:
  init [flags]              Create a new vault and its key file
  serve [flags]             Run the MCP server on stdio (what the client config launches)
  grant <label> [flags]     Mint a token for an MCP client and print its config snippet
  revoke <label>            Delete a client's grant; it is denied on its next call
  clients [flags]           List grants with their scopes and last activity, or clients waiting for a grant
  config <label> [flags]    Print the MCP config snippet for an existing grant
  import <path…> [flags]    Import ChatGPT/Claude/Gemini exports, folders of notes, or a portable vault export
  export [flags]            Write the portable JSON export (or markdown) to a file or stdout
  search <query…> [flags]   Keyword (BM25) search over memories, or over sources with --sources
  list [flags]              List memories (newest first) with kind, confidence, author and provenance counts
  show <id>                 Show a memory with provenance and versions, or a source with its first turns
  remember [flags]          Store a memory yourself (createdBy "cli")
  forget [id…] [flags]      Delete memories or sources by id, by author, or by cited source
  sources [flags]           List sources (imported conversations and documents) with trust and review state
  audit [flags]             Print the access log (who called what, with full arguments); --follow tails it
  verify [flags]            Check journal chains, manifest generations, body hashes and (optionally) provenance
  status                    Paths, key mode, counts, disk use, grants, live sessions and the last audit entry
  rekey [flags]             Generate a new data key and re-encrypt every journal and body
  compact                   Rewrite the memories, sources and grants journals without superseded lines
  help [command]            Show this reference, or the details of one command

Global flags (before or after the command):
  --vault-dir <dir>         vault directory (env OPENCONTEXT_VAULT_DIR; default
                            ~/.opencontext/vault)
  --key-file <path>         key file (env OPENCONTEXT_VAULT_KEY_FILE; default
                            ~/.opencontext/vault.key)
  --passphrase-file <path>  read the key passphrase from this file (else
                            OPENCONTEXT_VAULT_PASSPHRASE, OPENCONTEXT_VAULT_PASSPHRASE_CMD, or a
                            prompt)
  --json                    machine-readable JSON output
  --quiet                   print only the essential result (ids, tokens, tables)
  --version                 print the version and exit
  --help                    print this help (or `help <command>`) and exit

Environment:
  OPENCONTEXT_VAULT_DIR             vault directory (default ~/.opencontext/vault)
  OPENCONTEXT_VAULT_KEY_FILE        key file (default ~/.opencontext/vault.key, a sibling of the vault directory)
  OPENCONTEXT_VAULT_PASSPHRASE      passphrase for a passphrase-protected key file
  OPENCONTEXT_VAULT_PASSPHRASE_CMD  command printing the passphrase (split on whitespace, run without a shell, 5 s timeout)
  OPENCONTEXT_VAULT_TOKEN           client token, read by serve only

Exit codes: 0 ok · 1 usage · 2 vault error (printed as CODE: message, then a hint) · 3 unexpected

opencontext-vault init [flags]
  Creates the vault directory (mode 0700), the plaintext manifest, four empty encrypted journals and
  the key file (mode 0600, a sibling of the vault directory so the directory can be backed up
  without the key). A directory that already exists keeps its mode (a warning names it when it is
  wider than 0700). Fails with EXISTS if the directory already holds a vault or the key file exists;
  a failed init removes what it created so it can be run again. On Windows file permissions are not
  enforced.
  --passphrase              wrap the key with a passphrase (scrypt N=2^17); asks twice on a
                            terminal, else uses OPENCONTEXT_VAULT_PASSPHRASE,
                            OPENCONTEXT_VAULT_PASSPHRASE_CMD or --passphrase-file

opencontext-vault serve [flags]
  Loads the key, opens the vault, builds the memory index, answers MCP over stdin/stdout and builds
  the source index in the background. The client token comes from OPENCONTEXT_VAULT_TOKEN
  (preferred) or --token; without a valid token only vault_status answers. In passphrase mode set
  OPENCONTEXT_VAULT_PASSPHRASE_CMD (or OPENCONTEXT_VAULT_PASSPHRASE) in the client config: serve
  never prompts. Exits 0 when the client closes the pipe.
  --token <token>           client token (visible in the process list; prefer the
                            OPENCONTEXT_VAULT_TOKEN environment variable)

opencontext-vault grant <label> [flags]
  Creates a grant named <label> with the given scopes, mints an ocv_ token, stores only its hash and
  prints the token exactly once. With --client the token is embedded in a ready-to-paste config
  snippet (absolute node and dist/cli.js paths). --rotate replaces the token of an existing label;
  the old token is denied on its very next call. Scope read covers memories, write lets the client
  store memories, sources exposes raw conversations, forget allows deletion, instruct allows
  standing instructions. Logged in the audit journal as a cli event (label, scopes and tags only).
  --scopes read,write[,sources,forget,instruct]
                            scopes to grant (default read,write)
  --tags <a,b>              restrict what the client reads to records carrying one of these tags;
                            its writes always carry them (it may add tags of its own)
  --note <text>             free-text note stored with the grant (max 200 chars)
  --rotate                  replace the token of an existing label (scopes/tags/note are kept unless
                            given again)
  --client claude-desktop|claude-code|cursor|windsurf|vscode|all
                            also print the config snippet for this MCP host (all: every host, with
                            the token shown once above them)

opencontext-vault revoke <label>
  Removes the grant and compacts the grants journal. A server process started with that token keeps
  running but every further call is denied (grants are resolved on every call, never cached). Logged
  in the audit journal as a cli event.

opencontext-vault clients [flags]
  Without flags: one row per grant (label, scopes, tags, created, last seen — what the client called
  itself in the MCP handshake and when). With --pending: the distinct self-asserted client
  identities of unauthenticated sessions in the last 30 days, with the grant command to run for
  each. Client names are informational; only tokens confer access.
  --pending                 show unauthenticated clients seen in the last 30 days instead of grants

opencontext-vault config <label> [flags]
  Prints the snippet(s) for the grant with the given label using absolute paths for node and
  dist/cli.js. Tokens are stored only as hashes, so the snippet shows <TOKEN> unless you pass
  --token; to get a new token run grant --rotate.
  --client claude-desktop|claude-code|cursor|windsurf|vscode|all
                            which host to print for (default all)
  --token <token>           embed this token instead of the <TOKEN> placeholder

opencontext-vault import <path…> [flags]
  Takes files or directories (recursive; dot-dirs, node_modules and symbolic links skipped) and
  auto-detects each file's format from its content. Re-importing is idempotent: an unchanged
  conversation is skipped, a changed one is updated in place (review state kept) unless the export
  is older than the stored version (ChatGPT update_time, Claude updated_at), and the vendor record
  is kept verbatim as `raw` unless --no-raw. A portable export (`export --format json`) restores
  memories and sources with their original ids. Files it cannot read, skipped links and older
  versions are listed under "ignored"; the exit code is non-zero only for fatal errors. Gemini:
  English-language Takeout exports only; choose --gemini-window once (another window regroups
  records under new ids; preview with --dry-run). Logged in the audit journal as a cli event.
  --format chatgpt|claude|claude-projects|gemini|markdown|text|vault
                            force the format instead of auto-detecting
  --tags <a,b>              tag every imported source
  --no-raw                  do not keep the untouched vendor record (smaller, lossy)
  --dry-run                 parse and count without writing
  --gemini-window <minutes> group Gemini activity records closer than this into one conversation
                            (default 30; 0 = one source per record)

opencontext-vault export [flags]
  JSON (default) is the documented opencontext-vault-export v1 format (SPEC.md): every memory
  including superseded versions and every source with its full body and raw vendor record, streamed
  so a large vault never has to fit in RAM; `import` reads it back. Markdown (--format md) is for
  humans and is not re-importable. The export is plaintext: --out writes with mode 0600 and refuses
  to overwrite without --force. Never includes grants, tokens, keys or audit entries. Logged in the
  audit journal as a cli event.
  --out <file>              write here instead of stdout (mode 0600)
  --format json|md          output format (default json)
  --no-raw                  omit raw vendor records (lossy)
  --full                    markdown: do not truncate sources at 2000 chars
  --include-superseded      markdown: include superseded memory versions
  --force                   overwrite an existing --out file

opencontext-vault search <query…> [flags]
  Builds the in-memory index for this invocation (never persisted) and ranks by BM25 with Porter
  stemming; the same ranking vault_search and vault_source_search give an agent. Source search reads
  every body once to index it, so it takes longer on a large vault.
  --sources                 search raw sources (title + text) instead of memories
  --limit <n>               max hits (default 10)
  --kind fact|preference|skill|goal|relationship|event|instruction
                            memories of this kind only
  --tag <tag>               records carrying this tag only (repeatable)

opencontext-vault list [flags]
  Filters combine. SRC is the number of cited sources and VERIFIED how many of those citations were
  found verbatim in the cited turn. --created-by shows everything one client wrote (what `forget
  --created-by` would remove).
  --kind fact|preference|skill|goal|relationship|event|instruction
                            this kind only
  --tag <tag>               carrying this tag (repeatable, any-of)
  --created-by <label>      written by this grant label, "cli" or "import"
  --status active|superseded|all
                            default active
  --since <ISO|24h>         updated at or after this time (ISO date or 30m/24h/7d)
  --limit <n>               max rows (default 50)

opencontext-vault show <id>
  For a mem_ id: statement, subject, tags, author, every cited source with title, turn, verbatim
  quote, whether the quote was found in the cited turn, and whether the source was supplied by the
  same client that wrote the memory (self-attested); then the supersede chain. For a src_ id:
  metadata (origin, trust, review state, notes) and the first 20 turns (or the first 2000 chars of a
  document).

opencontext-vault remember [flags]
  One sentence in third person ("User prefers …"), no newlines, max 500 chars. Secret-looking
  statements (API keys, tokens, "password: …") are refused with SECRET_DETECTED. An active memory
  with the same normalized statement and subject is reported instead of duplicated. Logged in the
  audit journal as a cli event.
  --kind fact|preference|skill|goal|relationship|event|instruction
                            what kind of memory (required)
  --statement <sentence>    the memory (required)
  --subject <who>           default "user"; a name or "project:<name>"
  --tag <tag>               tag (repeatable)
  --confidence stated|inferred
                            default stated

opencontext-vault forget [id…] [flags]
  Deleting a memory also deletes the older versions it supersedes; deleting a source removes its
  body and record while memories keep their citation (shown as forgotten). --created-by removes
  every memory a client wrote (reverses poisoning); --source removes every memory citing that source
  and then the source itself. The memories, sources and grants journals are compacted in the same
  step so the ciphertext leaves those files; run `rekey` afterwards for a sensitive deletion. The
  audit journal is never compacted: the arguments of the MCP call that wrote a record (statement,
  filed text) stay in it, readable by the key holder with `audit`. Asks for confirmation on a
  terminal unless --yes; without a terminal --yes is required. Logged in the audit journal as a cli
  event.
  --created-by <label>      every memory written by this grant label (or "cli"/"import")
  --source <src_id>         every memory citing this source, then the source itself
  --yes                     do not ask for confirmation

opencontext-vault sources [flags]
  TRUST is "imported" for files you imported and "agent-supplied" for sources an MCP client filed
  with vault_source_add (those cannot be verified against anything). RAW says whether the untouched
  vendor record was kept.
  --review unreviewed|reviewed|skipped
                            this review state only
  --type chatgpt|claude|gemini|markdown|text|agent|vault
                            this source type only
  --limit <n>               max rows (default 50)

opencontext-vault audit [flags]
  Every MCP call, denied or not, every session start/end and every auditable CLI command is one
  encrypted entry with its full arguments (tokens redacted, truncated at 1 KB). CLIENT is the grant
  label, "cli", or the self-asserted name of an unauthenticated client marked with "?". The log is
  append-only and chained; `verify` checks it.
  --follow                  keep printing new entries every 500 ms until Ctrl-C
  --since <24h|ISO>         entries at or after this time (ISO date or 30m/24h/7d)
  --client <label>          this grant label only
  --event session_start|session_end|tool|resource|prompt|cli
                            this event type only
  --denied                  denied calls only
  --limit <n>               newest N entries (default 100; 0 = all)

opencontext-vault verify [flags]
  Without the key: every journal's header, sequence contiguity and prev-hash chain, plus the
  generation recorded in vault.json (detects a journal swapped for an older copy; a compaction
  interrupted between its rename and its manifest write is finished, not reported). With the key:
  every source body is decrypted and its sha256 compared to its record. --provenance recomputes each
  memory citation's `verified` flag against the cited turn and lists citations whose source is gone;
  --fix writes the recomputed flags. Exit 2 with CORRUPT when anything fails; a vault that does not
  open is still checked key-less so the report names the problem. Tail truncation of a journal is
  not detectable without an external anchor (SECURITY.md).
  --provenance              also recompute quote verification and list orphaned citations
  --fix                     with --provenance: write the recomputed flags

opencontext-vault status
  Also reports how long the memory search index took to build for this vault (what every `serve`
  pays at startup; the source index is built in the background).

opencontext-vault rekey [flags]
  Runs entirely under the vault lock: every source body is checked to be readable, the new key is
  staged next to the key file (<key file>.next), journals are rewritten with new generations, every
  source body is re-sealed, then the manifest and the key file are replaced. An interrupted rekey is
  finished by the next command that opens the vault, because both keys stay on disk until the switch
  is complete. Running servers reload the key automatically (they read the passphrase from the same
  environment they started with). In passphrase mode the current passphrase is asked for once (or
  taken from the usual sources) and proven against the key file before anything is re-sealed;
  --new-passphrase changes it (asked twice on a terminal, or read from --new-passphrase-file).
  Logged in the audit journal as a cli event.
  --new-passphrase          wrap the new key under a different passphrase: asked twice on a
                            terminal, else read from --new-passphrase-file (also turns a plain key
                            file into a passphrase-protected one)
  --new-passphrase-file <path>
                            read the new passphrase from this file (one line)

opencontext-vault compact
  Deleted records already leave the live files when they are forgotten; compact also drops the older
  versions of updated records (re-imports, review changes). Safe while servers run: they reload on
  the generation change. The audit journal is append-only and never compacted. Logged in the audit
  journal as a cli event.

opencontext-vault help [command]
  Generated from the command table, so it cannot drift from what the binary accepts;
  test/cli-help.test.ts checks the README copy against it.
```
<!-- cli:end -->

## Security model

[SECURITY.md](SECURITY.md) lists the assets, the adversaries, and for every attack whether the vault protects against it, by which mechanism, and what remains. The short version:

- **Key-file mode gives no protection against a stolen disk**: the key (`~/.opencontext/vault.key`) lives next to the vault directory on the same disk. Enable full-disk encryption. The key is deliberately *outside* the vault directory, so a backup or sync of the directory alone is encrypted — as long as you do not also copy `vault.key`.
- **Passphrase mode** (`init --passphrase`) wraps the key with scrypt (N=2^17, r=8, p=1, maxmem 256 MiB; `test/crypto.test.ts` printed 372 ms and 433 ms on two runs on the linux/x64 development container, Node 22.22.0). A passphrase in a client's MCP config is plaintext; prefer `OPENCONTEXT_VAULT_PASSPHRASE_CMD` with the OS keychain.
- Every record is AES-256-GCM with a random 96-bit IV, and the authenticated data binds the vault id, journal, generation, position and previous-line hash, so a line cannot be moved, replayed, reordered or deleted without the key (`test/journal.test.ts`: replayed, deleted and swapped lines are `CORRUPT`). The journals are tamper-evident, not tamper-proof: tail truncation, and rollback of a journal together with `vault.json`, are undetectable without an external anchor.
- Tokens are 192-bit random, stored hashed, compared in constant time, never written anywhere after `grant` prints them; `serve` keeps stdout for the protocol and writes diagnostics to stderr only (`test/stdio.test.ts` asserts the token never appears there).
- `forget` compacts the memories, sources and grants journals in the same step so the ciphertext leaves those files, and unlinks the body; run `rekey` afterwards for a sensitive deletion. The audit journal is never compacted: the arguments of the MCP call that wrote a record (the statement, the first 1 KB of a filed source) stay in it, re-sealed by `rekey`, readable by the key holder with `audit`; CLI writes log only ids and metadata. No scrubbing of free blocks or filesystem snapshots is claimed.
- `rekey` stages the new key in `vault.key.next` before re-sealing anything and promotes it last; an interrupted rekey is finished by the next command. A passphrase is asked for once and proven against the key file before it wraps anything; `rekey --new-passphrase` (or `--new-passphrase-file`) changes it. `forget`, `revoke` and `compact` announce the journal generations they are about to write in `vault.json` first, so a crash between a journal rename and the manifest write is finished, not reported as a rollback. Every write checks what the kernel accepted, so a full disk fails loudly (`IO`) instead of acknowledging a record that is not on disk (`test/durability.test.ts`, `test/short-write.test.ts`).
- `looksLikeSecret` refuses statements that look like API keys, private keys or `password: …` — basic patterns, a hint and not a guarantee (`test/secrets.test.ts`).
- Windows: not tested; file permissions are not enforced there (chmod is a no-op; a warning is printed).

## What it does not do

| Not in 0.1.0 | Instead |
|---|---|
| Semantic or embedding search | BM25 keyword search with stemming; no LLM call inside the vault, ever |
| Cloud, sync, accounts, telemetry, blockchain, IPFS, HTTP/SSE transport | local files, stdio only; sync the directory yourself (without the key) |
| GUI | the CLI and your MCP client |
| Keychain / TPM integration | key file, or a scrypt passphrase via `OPENCONTEXT_VAULT_PASSPHRASE_CMD` |
| Rate limiting, anomaly detection | the audit log (`audit --denied`, `audit --follow`) and per-client scopes |
| Zip handling | unzip the export first |
| Obsidian, Notion, Slack importers | Markdown / text folders |
| NDJSON or encrypted export | the plaintext portable JSON (parsed in memory on import; ≈ 500 MB documented limit) |
| Automatic expiry, decay, importance or conflict detection | exact dedup plus explicit `supersedes` |
| In-place edit, undo of `forget`, audit pruning or export | versions only; `forget` is final for the memory and source journals; the audit journal is append-only and keeps the arguments of the call that wrote a record |
| Passphrase removal | `rekey --new-passphrase` changes it or adds one; re-`init` and `import` an export to drop it |
| File watching | `refresh()` before every call and command |
| npm publish | install from the clone (`npm ci && npm run build`) |
| ESLint / Prettier | `tsc --strict` plus `scripts/lint.mjs` |
| MCP sampling, elicitation, tasks, subscriptions | 9 tools, 2 resources, 2 prompts |
| Windows ACL enforcement, multi-user vaults | one OS user, one vault directory |
| Gemini conversation ids, ChatGPT alternate branches | a 30-minute grouping heuristic; branches kept only in `raw` |
| An independent security review | [SECURITY.md](SECURITY.md) says what is claimed |

## Running several clients at once

Each MCP client spawns its own `serve` process; all of them share one directory. Every mutation runs under a directory lock (`.lock`, held for milliseconds, stolen only from a dead process or after 60 s without a touch, and never deleted or overwritten by the process it was stolen from — `test/lock.test.ts`), and every process re-reads the journals before each call, taking the lock only when it detects a change, so it never observes a half-written compaction or `rekey` (`test/multiprocess.test.ts`: two processes appending 200 records each converge; a client that keeps the store open survives a compaction and a `rekey` from the CLI and reloads the key automatically). A process that saw a torn tail re-reads it on every call until a writer has truncated it, so a sibling's record of the same length is never mistaken for the torn bytes. The worst case for a client is waiting up to 10 s while another process compacts a very large vault. `status` lists the live server processes; `rekey` warns about them but does not need them to quit. Back up the directory with the servers stopped (or from a filesystem snapshot) and run `verify` on the copy: a copy taken while a writer runs can catch a journal and `vault.json` from different instants.

Memory footprint: each server process holds all decrypted memories and metadata plus the search index for its lifetime; source bodies are read on demand (LRU of 32); each MCP client spawns its own process.

## Development

```bash
npm ci                 # exact pins from package-lock.json
npm run lint           # tsc --strict over src and test, then scripts/lint.mjs (console.log, network imports, any, @ts-ignore, foreign trees)
npm run build          # tsc → dist/ (dist/cli.js keeps its shebang)
npm test               # builds first, then vitest: the spawned-binary and multi-process tests run against dist/
npm run test:coverage  # thresholds: 80 % lines / functions / statements, 70 % branches (enforced in CI)
npm run schema         # regenerate schema/opencontext-vault-export.v1.schema.json from src/types.ts
```

Layout: `src/store` (journals, lock, the `VaultStore`), `src/crypto` (envelopes, key file, tokens), `src/search` (tokenizer, stemmer, BM25, snippets), `src/importers` and `src/exporters`, `src/access` and `src/mcp` (policy, audit, the server), `src/cli`, `src/util` (base64, canonical JSON, text, `writeFully`). The vault imports nothing from the rest of the repository. `test/cli-help.test.ts` fails when the CLI block above drifts from `renderHelp()`; regenerate it with:

```bash
npm run build && node -e "import('./dist/cli/run.js').then(m=>process.stdout.write(m.renderHelp()))"
```

Real numbers from this checkout on the linux/x64 development container (Node 22.22.0, npm 10.9.4), run as root: `npm test` → 27 test files, 412 passed, 1 skipped (413); the skipped case is `test/audit.test.ts`'s read-only-directory test, which only runs as a non-root user. `npm run test:coverage`, same run: statements 88.1 %, branches 77.2 %, functions 92.6 %, lines 91.1 %, exit 0 (thresholds 80/80/80/70 in `vitest.config.ts`; the second decimal moves between runs). Under `CI=1` one more case is skipped by design, the search perf smoke in `test/vault-search.test.ts`.

CI (`.github/workflows/vault.yml`) runs `npm ci`, `npm run lint`, `npm run build`, `node dist/cli.js --version` and `npm run test:coverage` with `CI=1` on Node 20 and 22 × ubuntu-latest and macos-latest. Windows is deliberately not in the matrix: the vault is not tested there, and file permissions are not enforced on Windows.

## License

MIT — see [LICENSE](LICENSE).
