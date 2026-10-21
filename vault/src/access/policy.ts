import { hashToken } from '../crypto/token.js';
import { VaultError } from '../errors.js';
import { ALL_SCOPES, type Caller, type Grant, type Memory, type Scope, type SourceMeta } from '../types.js';
import { normalizeTags } from '../util/text.js';
import type { VaultStore } from '../store/vault-store.js';

/**
 * Exact scope matrix (§5.1) as data, used by the tools and by the README generator test. Conditional extras
 * (`instruct` for instruction memories, `sources` for forgetting a source) are decided per call by the tools
 * themselves; this table holds the unconditional minimum so docs and code cannot drift apart.
 */
export const SCOPE_MATRIX: Readonly<Record<string, Scope[]>> = Object.freeze({
  vault_status: [],
  vault_search: ['read'],
  vault_remember: ['write'],
  vault_forget: ['forget'],
  vault_source_list: ['sources'],
  vault_source_search: ['sources'],
  vault_source_read: ['sources'],
  vault_source_add: ['sources', 'write'],
  vault_source_review: ['sources', 'write'],
  'vault://status': [],
  'vault://profile': ['read'],
  distill: [],
  capture: [],
});

/**
 * Token → hashToken → store.getGrantByTokenHash. Called on EVERY tool/resource/prompt call after store.refresh()
 * and never memoized per connection, so a revoke or rotate from the CLI applies on the client's very next call
 * without a reconnect. An empty token counts as no token (an MCP host may pass an empty env value).
 */
export function resolveCaller(store: Pick<VaultStore, 'getGrantByTokenHash'>, token: string | undefined): Caller {
  if (token === undefined || token === '') return { kind: 'anonymous', reason: 'no-token' };
  const grant = store.getGrantByTokenHash(hashToken(token));
  if (grant === undefined) return { kind: 'anonymous', reason: 'unknown-token' };
  return { kind: 'granted', grant };
}

function grantHint(label: string, scopes: readonly Scope[]): string {
  const ordered = ALL_SCOPES.filter((s) => scopes.includes(s));
  return `ask the user to run: opencontext-vault grant ${label} --scopes ${ordered.join(',')} and put the printed token in this client's MCP config as OPENCONTEXT_VAULT_TOKEN`;
}

/**
 * The single place a DENIED error is produced, so every tool, resource and audit entry carries the same exact
 * wording and the same copy-pasteable hint. Returns the grant so handlers get a non-null grant without a cast.
 * `what` names the call for diagnostics; it is deliberately not part of the message (the audit entry has it).
 */
export function assertScopes(caller: Caller, scopes: Scope[], what: string): Grant {
  void what;
  if (caller.kind === 'anonymous') {
    const message =
      caller.reason === 'no-token'
        ? 'this client has no access to the vault (no token)'
        : "this client's token is not recognized (revoked or rotated?)";
    throw new VaultError('DENIED', message, grantHint('CLIENT', scopes.length > 0 ? scopes : ['read', 'write']));
  }
  const { grant } = caller;
  const missing = scopes.find((s) => !grant.scopes.includes(s));
  if (missing !== undefined) {
    throw new VaultError(
      'DENIED',
      `grant "${grant.label}" lacks scope "${missing}" (has: ${grant.scopes.join(',')})`,
      grantHint(grant.label, [...grant.scopes, ...scopes]),
    );
  }
  return grant;
}

/** True when the caller holds the scope; anonymous callers hold none. Used for optional behaviour, never as a gate (gates go through assertScopes so they are logged uniformly). */
export function hasScope(caller: Caller, scope: Scope): boolean {
  return caller.kind === 'granted' && caller.grant.scopes.includes(scope);
}

/** A tag-restricted grant sees only records carrying at least one of its tags; an unrestricted grant sees everything. */
export function memoryVisible(grant: Grant, m: Memory): boolean {
  return grant.tags === undefined || m.tags.some((t) => grant.tags?.includes(t));
}

/** Same rule as memoryVisible, for sources: raw conversations are scoped by the same tags as the memories distilled from them. */
export function sourceVisible(grant: Grant, s: SourceMeta): boolean {
  return grant.tags === undefined || s.tags.some((t) => grant.tags?.includes(t));
}

/**
 * Union of the caller's tags with the grant's tags (normalized), so everything a tag-restricted client writes stays
 * visible to that client and is attributable to its scope. Tags bound what a client READS (memoryVisible/sourceVisible);
 * a write may carry further tags, which is documented as such (README "Access control and audit"). The one place tags
 * could reach a record the client did not write, the dedupe merge, refuses records of other authors.
 */
export function applyWriteTags(grant: Grant, tags: string[]): string[] {
  return normalizeTags([...tags, ...(grant.tags ?? [])]);
}
