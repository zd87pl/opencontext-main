// Public API of @opencontext/vault: the store, crypto primitives, search, the MCP server, importers/exporters and the
// CLI entry point, plus every shared type. Named exports only (§3.5); the on-disk and MCP contracts are in SPEC.md.
export { VaultStore, type OpenOptions } from './store/vault-store.js';
export { Sealer, aad, envelopeToLine, lineToEnvelope } from './crypto/envelope.js';
export { createKeyFile, loadKey, rewriteKeyFile, resolvePassphrase, keyIdOf, SCRYPT, type PassphraseSource } from './crypto/keyfile.js';
export { newToken, hashToken, hashesEqual, looksLikeToken } from './crypto/token.js';
export { VaultSearch, type SearchStoreView } from './search/vault-search.js';
export { tokenize, tokenizeQuery, STOPWORDS } from './search/tokenize.js';
export { createVaultServer, runStdioServer, type ServerDeps, type VaultServer } from './mcp/server.js';
export { runImport, type ImportOptions, type ImportReport } from './importers/run.js';
export { detectFormat, type ImportFormat } from './importers/detect.js';
export { parseChatGptConversation } from './importers/chatgpt.js';
export { parseClaudeConversation, parseClaudeProject } from './importers/claude.js';
export { parseGeminiActivity } from './importers/gemini.js';
export { parseDocument } from './importers/document.js';
export { parsePortable } from './importers/portable.js';
export { type ParsedSource, type ParseContext } from './importers/common.js';
export { writePortable, buildPortable } from './exporters/portable.js';
export { writeMarkdown } from './exporters/markdown.js';
export { runCli, renderHelp, COMMANDS } from './cli/run.js';
export { processIo, type CliIo } from './cli/io.js';
export { renderSnippet, renderAllSnippets, type ClientKind } from './cli/snippets.js';
export { VaultError, type VaultErrorCode } from './errors.js';
export * from './types.js';
