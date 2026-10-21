import { VaultError } from '../errors.js';

/** The MCP hosts we print ready-to-paste config for; `all` on the CLI expands to every one of these. */
export type ClientKind = 'claude-desktop' | 'claude-code' | 'cursor' | 'windsurf' | 'vscode';
export const CLIENT_KINDS: readonly ClientKind[] = ['claude-desktop', 'claude-code', 'cursor', 'windsurf', 'vscode'];

/** The server name used in every host config; one constant so `config` and the README agree. */
export const SERVER_NAME = 'opencontext-vault';

const TITLES: Readonly<Record<ClientKind, string>> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  vscode: 'VS Code',
};

const LOCATIONS: Readonly<Record<ClientKind, string>> = {
  'claude-desktop': '~/Library/Application Support/Claude/claude_desktop_config.json (macOS) · %APPDATA%\\Claude\\claude_desktop_config.json (Windows)',
  'claude-code': 'run this command once',
  cursor: '~/.cursor/mcp.json (or .cursor/mcp.json per project)',
  windsurf: '~/.codeium/windsurf/mcp_config.json',
  vscode: '.vscode/mcp.json',
};

/** Parse a --client value; `all` is handled by the caller. Throws INVALID_ARGUMENT naming the accepted kinds. */
export function parseClientKind(value: string): ClientKind {
  if ((CLIENT_KINDS as readonly string[]).includes(value)) return value as ClientKind;
  throw new VaultError('INVALID_ARGUMENT', `unknown client "${value}"`, `use one of: ${CLIENT_KINDS.join(', ')}, all`);
}

/** The `mcpServers` entry shared by Claude Desktop, Cursor and Windsurf; VS Code wraps the same thing under `servers` with `type: stdio`. */
function serverEntry(token: string, execPath: string, cliPath: string, stdio: boolean): Record<string, unknown> {
  return {
    ...(stdio ? { type: 'stdio' } : {}),
    command: execPath,
    args: [cliPath, 'serve'],
    env: { OPENCONTEXT_VAULT_TOKEN: token },
  };
}

/**
 * Config snippet for one host, as a `#` comment line naming where it goes followed by the JSON (or, for Claude
 * Code, the `claude mcp add` command). Absolute node and dist/cli.js paths because MCP hosts do not inherit the
 * shell PATH reliably; `token` may be the literal "<TOKEN>" placeholder (tokens are not recoverable after `grant`).
 */
export function renderSnippet(kind: ClientKind, token: string, execPath: string, cliPath: string): string {
  const header = `# ${TITLES[kind]} — ${LOCATIONS[kind]}`;
  if (kind === 'claude-code') {
    return `${header}\nclaude mcp add ${SERVER_NAME} -s user -e OPENCONTEXT_VAULT_TOKEN=${token} -- ${execPath} ${cliPath} serve\n`;
  }
  const body =
    kind === 'vscode'
      ? { servers: { [SERVER_NAME]: serverEntry(token, execPath, cliPath, true) } }
      : { mcpServers: { [SERVER_NAME]: serverEntry(token, execPath, cliPath, false) } };
  return `${header}\n${JSON.stringify(body, null, 2)}\n`;
}

/** Every host's snippet, blank-line separated, in CLIENT_KINDS order. */
export function renderAllSnippets(token: string, execPath: string, cliPath: string): string {
  return CLIENT_KINDS.map((k) => renderSnippet(k, token, execPath, cliPath)).join('\n');
}
