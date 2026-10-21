# Changelog

## Unreleased (after the pre-launch review)

Fixes from the review of 0.1.0, none of which changes the on-disk format beyond two optional fields (`vault.json` `pendingGens`, `SourceMeta.updatedAt`):

- `rekey` is crash-safe: every body is read first, the new key is staged in `vault.key.next` before anything is re-sealed, and an interrupted rekey is finished by the next open; the passphrase is resolved once and proven before it wraps the new key. `rekey --new-passphrase` / `--new-passphrase-file` change the passphrase (the documented env-variable way never worked).
- Compaction (`forget`, `revoke`, `compact`) announces its journal generations in `vault.json` before renaming, so a crash between the rename and the manifest write no longer bricks the vault; `verify` reports a vault that does not open instead of repeating the error.
- Every file write checks the byte count the kernel accepted: a full disk is an `IO` error, never a silently lost or torn record; a failed lock write leaves no empty `.lock`; a lock stolen as stale is never deleted or overwritten by its previous holder.
- Source bodies of any size read back (linear base64 validation; bodies over about 3.4 MB used to overflow the regex stack and made `export`, `verify`, `show` and `rekey` fail).
- `vault_remember`: a duplicate written by another author is reported, not merged; merging into an instruction needs `instruct`; `supersedes` is applied (or reported) on the dedupe path; write-only grants get only their own citations back. `vault_forget` chain-deletes only versions the grant can see. Replacing a source body re-verifies the citations to it. `vault_source_read` pages inside a turn longer than `maxChars`.
- BM25 statistics are computed over the records a tag-restricted grant may see; control characters are refused in agent-written text and stripped from CLI output; `clientInfo` fields are clipped; audit tokens are redacted before truncation; the audit journal is verified without decryption on open and read from the end for `audit --limit` and `status`.
- Importers: symbolic links are skipped and reported, an unreadable file no longer aborts the run, an older ChatGPT/Claude export never rolls a newer stored conversation back (`updatedAt`), vendor formats are recognised by their id keys, a localized Gemini export is reported as unsupported with the fix.
- `serve` logs transport errors, accepts frames up to 16 MiB, handles SIGHUP and a closed stdout cleanly, writes `session_start` for clients that skip the handshake notification. `init` can be retried after a failure and reports the real directory mode. Passphrase-command failures no longer echo the command's arguments. `Sealer.open` enforces the expected envelope kind.
- SPEC.md: canonicalJson rules spelled out with vectors (`test/vectors/canonical-json-vectors.json`), torn-write rule made precise, `pendingGens`, the rekey procedure; `examples/decrypt_vault.py` is an independent Python reader written from the spec alone.

## 0.1.0 — 2026-10-21

First release: a user-owned, encrypted, portable memory for AI agents, served locally over MCP (stdio).

- Encrypted vault directory: four chained journals (memories, sources, grants, audit) and per-source bodies, AES-256-GCM with position-bound AAD; key file next to the vault (plain or scrypt-wrapped by a passphrase); `verify`, `rekey`, `compact`.
- Memories with provenance: one-sentence records with kind, confidence, tags, versions (`supersedes`) and verbatim quotes verified against the cited source turn.
- Importers for ChatGPT, Claude (conversations and projects), Gemini (Google Takeout) and folders of Markdown/text, with the raw vendor record kept; streaming JSON import; deterministic source ids so re-imports are idempotent.
- Portable export (`opencontext-vault-export` v1, documented in SPEC.md with a JSON Schema) and a Markdown export.
- MCP server with 9 `vault_*` tools, 2 resources, 2 prompts; per-client tokens with scopes (`read`, `write`, `sources`, `forget`, `instruct`) and optional tag restriction; revocation applies on the next call; every call logged with its arguments in an encrypted audit journal.
- BM25 keyword search over memories, background source index with snippets.
- CLI (`opencontext-vault`) with config snippets for Claude Desktop, Claude Code, Cursor, Windsurf and VS Code.
