import { VaultError } from '../errors.js';
import { nowIso } from '../ids.js';
import { LIMITS, type AuditEntry, type ClientInfo } from '../types.js';
import { truncateText } from '../util/text.js';
import type { VaultStore } from '../store/vault-store.js';

/**
 * What a caller must supply to record one entry. `pid`, `at` and `client` are optional because the sink knows
 * them (from its context) and the guard does not; the store assigns `id` and `session`.
 */
export type AuditInput = Omit<AuditEntry, 'id' | 'session' | 'pid' | 'at' | 'client'> &
  Partial<Pick<AuditEntry, 'pid' | 'at' | 'client'>>;

/** The only way the server writes audit entries, so every entry is shaped and truncated the same way. */
export interface AuditSink {
  record(e: AuditInput): void;
}

/** Our own token shape; a model that pastes a token into an argument must not get it archived in the audit log ("never tokens or keys"). */
const VAULT_TOKEN_RE = /ocv_[A-Za-z0-9_-]{32}/g;

/** Replace every vault token in serialized args with a fixed marker; the rest of the args stay verbatim on purpose. */
export function redactTokens(json: string): string {
  return json.replace(VAULT_TOKEN_RE, 'ocv_[redacted]');
}

/**
 * Wraps store.appendAudit: fills pid/at/client from the server context, serializes and truncates `args` to
 * LIMITS.auditArgsChars (so one huge call cannot bloat the log) and throws VaultError('IO', 'audit append failed')
 * on any failure — the guard turns that into a tool error because the vault refuses to serve what it cannot log.
 * `args` is stored as the (possibly truncated) JSON string, never as the raw object, so readers get one type.
 */
export function createAuditSink(store: VaultStore, ctx: { pid: number; now: () => Date; client: () => ClientInfo | null }): AuditSink {
  return {
    record(e: AuditInput): void {
      const entry: Omit<AuditEntry, 'id' | 'session'> = {
        at: e.at ?? nowIso(ctx.now),
        pid: e.pid ?? ctx.pid,
        grant: e.grant,
        client: e.client !== undefined ? e.client : ctx.client(),
        event: e.event,
        name: e.name,
        // Redact BEFORE truncating: a token cut in two by the 1 KB limit no longer matches the pattern and would be stored almost whole.
        args: truncateText(redactTokens(JSON.stringify(e.args) ?? 'null'), LIMITS.auditArgsChars),
        outcome: e.outcome,
        ms: e.ms,
        ...(e.error !== undefined ? { error: e.error } : {}),
        ...(e.result !== undefined ? { result: e.result } : {}),
      };
      try {
        store.appendAudit(entry);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new VaultError('IO', 'audit append failed', `the vault refuses to serve what it cannot log (${reason}); check that the vault directory is writable`);
      }
    },
  };
}
