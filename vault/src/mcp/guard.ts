import { assertScopes, resolveCaller } from '../access/policy.js';
import type { AuditSink } from '../access/audit.js';
import { VaultError } from '../errors.js';
import { nowIso } from '../ids.js';
import type { AuditOutcome, Caller, Grant, Scope } from '../types.js';
import type { VaultStore } from '../store/vault-store.js';
import type { VaultSearch } from '../search/vault-search.js';
import { fail, ok, type ToolResult } from './results.js';

/** Everything a guarded call needs; one object so tools, resources and prompts are wired identically. */
export interface GuardDeps {
  store: VaultStore;
  search: VaultSearch;
  audit: AuditSink;
  token: string | undefined;
  now: () => Date;
}

/** What a handler learns about its caller: the grant (null for unauthenticated-capable calls), the raw caller and the call's timestamp. */
export interface CallCtx {
  grant: Grant | null;
  caller: Caller;
  now: string;
}

/** What a handler returns: the structured payload plus optional ids/count for the audit entry's `result`. */
export interface HandlerResult {
  structured: Record<string, unknown>;
  ids?: string[];
  count?: number;
}

/** Spec of one guarded call; `required` may depend on the arguments (e.g. `instruct` only for instruction memories). */
export interface GuardSpec<A> {
  event: 'tool' | 'resource' | 'prompt';
  name: string;
  required: Scope[] | ((args: A) => Scope[]);
}

const AUDIT_IDS_MAX = 50;

/**
 * The one gate every tool, resource and prompt goes through. Order: store.refresh() → search.applyChanges() →
 * resolveCaller → assertScopes(required) → handler → audit (ok | denied | error, ms, result ids) → map errors to
 * fail(). The audit entry is written BEFORE the result is returned; if auditing throws, the result is fail(IO) —
 * the vault refuses to serve what it cannot log. required = [] registers an unauthenticated-capable call
 * (vault_status, vault://status, prompts): the caller is still resolved so the audit names the grant.
 * Nothing here is memoized: a revoke or rotate from the CLI is seen by the very next call.
 */
export function guarded<A>(
  deps: GuardDeps,
  spec: GuardSpec<A>,
  handler: (args: A, ctx: CallCtx) => HandlerResult,
): (args: A) => ToolResult {
  return (args: A): ToolResult => {
    const started = Date.now();
    const at = nowIso(deps.now);
    let caller: Caller = { kind: 'anonymous', reason: 'no-token' };
    let grant: Grant | null = null;
    let outcome: AuditOutcome = 'ok';
    let error: VaultError | undefined;
    let unexpected: unknown;
    let result: HandlerResult | undefined;
    let refreshed = false;
    try {
      deps.search.applyChanges(deps.store.refresh());
      refreshed = true;
      caller = resolveCaller(deps.store, deps.token);
      const required = typeof spec.required === 'function' ? spec.required(args) : spec.required;
      if (required.length > 0) grant = assertScopes(caller, required, spec.name);
      else if (caller.kind === 'granted') grant = caller.grant;
      result = handler(args, { grant, caller, now: at });
    } catch (err) {
      if (err instanceof VaultError) {
        error = err;
        outcome = err.code === 'DENIED' ? 'denied' : 'error';
      } else {
        unexpected = err;
        error = new VaultError('IO', err instanceof Error ? err.message : String(err));
        outcome = 'error';
      }
    }
    const ms = Math.max(0, Date.now() - started);
    const auditGrant = caller.kind === 'granted' ? { id: caller.grant.id, label: caller.grant.label } : null;
    const auditResult =
      result !== undefined && (result.ids !== undefined || result.count !== undefined)
        ? {
            ...(result.count !== undefined ? { count: result.count } : {}),
            ...(result.ids !== undefined ? { ids: result.ids.slice(0, AUDIT_IDS_MAX) } : {}),
          }
        : undefined;
    try {
      deps.audit.record({
        at,
        grant: auditGrant,
        event: spec.event,
        name: spec.name,
        args,
        outcome,
        ...(error !== undefined ? { error: error.code } : {}),
        ms,
        ...(auditResult !== undefined ? { result: auditResult } : {}),
      });
    } catch (auditErr) {
      // The vault could not even be read (refresh failed): the specific error is more useful than "audit failed",
      // and the audit append would have failed for the same reason. Otherwise: refuse what cannot be logged.
      if (!refreshed && error !== undefined) return fail(error);
      return fail(auditErr);
    }
    if (unexpected !== undefined) return fail(unexpected);
    if (error !== undefined) return fail(error);
    if (result === undefined) return fail(new VaultError('IO', 'handler produced no result'));
    return ok(result.structured);
  };
}
