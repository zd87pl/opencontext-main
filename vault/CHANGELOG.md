# Changelog

## 0.1.0 — 2026-10-21

First release: a user-owned, encrypted, portable memory for AI agents, served locally over MCP (stdio).

- Encrypted vault directory: four chained journals (memories, sources, grants, audit) and per-source bodies, AES-256-GCM with position-bound AAD; key file next to the vault (plain or scrypt-wrapped by a passphrase); `verify`, `rekey`, `compact`.
- Memories with provenance: one-sentence records with kind, confidence, tags, versions (`supersedes`) and verbatim quotes verified against the cited source turn.
- Importers for ChatGPT, Claude (conversations and projects), Gemini (Google Takeout) and folders of Markdown/text, with the raw vendor record kept; streaming JSON import; deterministic source ids so re-imports are idempotent.
- Portable export (`opencontext-vault-export` v1, documented in SPEC.md with a JSON Schema) and a Markdown export.
- MCP server with 9 `vault_*` tools, 2 resources, 2 prompts; per-client tokens with scopes (`read`, `write`, `sources`, `forget`, `instruct`) and optional tag restriction; revocation applies on the next call; every call logged with its arguments in an encrypted audit journal.
- BM25 keyword search over memories, background source index with snippets.
- CLI (`opencontext-vault`) with config snippets for Claude Desktop, Claude Code, Cursor, Windsurf and VS Code.
