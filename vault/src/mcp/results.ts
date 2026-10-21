import { VaultError } from '../errors.js';

/** The subset of the SDK's CallToolResult the vault produces; kept local so src/mcp never imports SDK types beyond server/mcp.js. */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Deep copy through JSON so no `undefined`-valued key survives: the SDK validates structuredContent with strict object schemas, and an explicit undefined key fails them (§5.2 pitfall). */
function jsonClean(structured: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(structured)) as Record<string, unknown>;
}

/** Success: content[0].text = JSON.stringify(structured); structuredContent = structured. Both are always present because every vault tool declares an outputSchema, and the SDK rejects a success without structuredContent. */
export function ok(structured: Record<string, unknown>): ToolResult {
  const text = JSON.stringify(structured);
  return { content: [{ type: 'text', text }], structuredContent: jsonClean(structured) };
}

/** Failure: { isError: true, content: [{ text: `${code}: ${message}` + (hint ? `\n${hint}` : '') }] } with NO structuredContent (the SDK passes that through unchanged). Non-VaultError → code IO with err.message, so an unexpected exception still reaches the model as a readable error rather than a protocol failure. */
export function fail(err: unknown): ToolResult {
  const code = err instanceof VaultError ? err.code : 'IO';
  const message = err instanceof Error ? err.message : String(err);
  const hint = err instanceof VaultError ? err.hint : undefined;
  const text = `${code}: ${message}${hint !== undefined && hint !== '' ? `\n${hint}` : ''}`;
  return { isError: true, content: [{ type: 'text', text }] };
}
