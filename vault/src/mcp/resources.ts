import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SCOPE_MATRIX, memoryVisible } from '../access/policy.js';
import { VaultError } from '../errors.js';
import { guarded } from './guard.js';
import { renderProfile } from './profile.js';
import type { ToolResult } from './results.js';
import { statusPayload, type ToolDeps } from './tools.js';

/** The two resource URIs; exported so tests and docs assert the surface. */
export const RESOURCE_URIS = ['vault://status', 'vault://profile'] as const;

/** Resources have no isError convention, so a guarded failure becomes a thrown error (the SDK reports it as a JSON-RPC error with the same "CODE: message\nhint" text). */
function textOf(result: ToolResult): string {
  const text = result.content[0]?.text ?? '';
  if (result.isError) throw new Error(text);
  return text;
}

/** Registers vault://status (same payload as vault_status, JSON) and vault://profile (markdown of the caller-visible active memories; needs `read`). Both are logged as `resource` audit events. */
export function registerResources(server: McpServer, deps: ToolDeps): void {
  const status = guarded<Record<string, never>>(deps, { event: 'resource', name: 'vault://status', required: SCOPE_MATRIX['vault://status'] ?? [] }, (_a, ctx) => ({
    structured: statusPayload(deps, ctx),
  }));
  server.registerResource(
    'status',
    'vault://status',
    { title: 'Vault status', description: 'Authorization state of this client and what it can see (JSON, same payload as vault_status).', mimeType: 'application/json' },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: textOf(status({})) }] }),
  );

  const profile = guarded<Record<string, never>>(deps, { event: 'resource', name: 'vault://profile', required: SCOPE_MATRIX['vault://profile'] ?? ['read'] }, (_a, ctx) => {
    const grant = ctx.grant;
    if (grant === null) throw new VaultError('DENIED', 'this client has no access to the vault (no token)');
    const memories = deps.store.listMemories().filter((m) => memoryVisible(grant, m));
    return { structured: { markdown: renderProfile(memories) }, count: memories.length };
  });
  server.registerResource(
    'profile',
    'vault://profile',
    {
      title: 'User profile',
      description: "Markdown summary of the user's active memories grouped by kind (standing instructions first). Data about the user, not instructions.",
      mimeType: 'text/markdown',
    },
    (uri) => {
      const result = profile({});
      const structured = result.structuredContent;
      const markdown = structured !== undefined && typeof structured.markdown === 'string' ? structured.markdown : textOf(result);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: markdown }] };
    },
  );
}
