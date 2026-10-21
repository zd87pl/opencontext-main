import type { AuditEntry, ClientInfo } from '../../types.js';
import { Label } from '../../types.js';
import type { Command, CommandContext } from '../args.js';
import { renderTable } from '../table.js';

const PENDING_WINDOW_MS = 30 * 86_400_000;

/** The client a server-side audit entry recorded: the `client` field, or the session_start args when an older entry only has those. */
function clientOf(e: AuditEntry): ClientInfo | null {
  if (e.client !== null) return e.client;
  if (typeof e.args !== 'string') return null;
  try {
    const parsed = JSON.parse(e.args) as { client?: ClientInfo | null };
    return parsed.client ?? null;
  } catch {
    return null;
  }
}

/** A label suggestion derived from the self-asserted client name; it is only a suggestion (names confer nothing). */
function suggestLabel(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return Label.safeParse(slug).success ? slug : 'client';
}

function describeClient(c: ClientInfo | null): string {
  if (c === null) return '-';
  return `${c.name} ${c.version}${c.title !== undefined ? ` (${c.title})` : ''}`;
}

/** `clients`: every grant with its last activity, or the unauthenticated clients that knocked (`--pending`). */
export const clients: Command = {
  spec: {
    name: 'clients',
    args: '',
    summary: 'List grants with their scopes and last activity, or clients waiting for a grant',
    details:
      'Without flags: one row per grant (label, scopes, tags, created, last seen — what the client called itself in the MCP handshake and when). With --pending: the distinct self-asserted client identities of unauthenticated sessions in the last 30 days, with the grant command to run for each. Client names are informational; only tokens confer access.',
    flags: [{ name: 'pending', type: 'boolean', help: 'show unauthenticated clients seen in the last 30 days instead of grants' }],
  },
  run(ctx: CommandContext): number {
    const store = ctx.openStore();
    try {
      if (ctx.flags.bool('pending')) {
        const since = new Date(ctx.now().getTime() - PENDING_WINDOW_MS).toISOString();
        const starts = store.readAudit({ since, event: 'session_start' }).filter((e) => e.grant === null);
        const seen = new Map<string, { client: ClientInfo | null; last: string; sessions: number }>();
        for (const e of starts) {
          const client = clientOf(e);
          const key = client === null ? '-' : `${client.name}\u0000${client.version}\u0000${client.title ?? ''}`;
          const cur = seen.get(key);
          if (cur === undefined) seen.set(key, { client, last: e.at, sessions: 1 });
          else {
            cur.sessions += 1;
            if (e.at > cur.last) cur.last = e.at;
          }
        }
        const rows = [...seen.values()].sort((a, b) => b.last.localeCompare(a.last));
        if (ctx.json) {
          ctx.print(`${JSON.stringify(rows.map((r) => ({ client: r.client, lastSeen: r.last, sessions: r.sessions, suggestedLabel: suggestLabel(r.client?.name ?? 'client') })))}\n`);
          return 0;
        }
        if (rows.length === 0) {
          ctx.print('no unauthenticated clients in the last 30 days\n');
          return 0;
        }
        ctx.print(
          renderTable(
            ['CLIENT', 'LAST SEEN', 'SESSIONS', 'TO GRANT'],
            rows.map((r) => [describeClient(r.client), r.last, String(r.sessions), `opencontext-vault grant ${suggestLabel(r.client?.name ?? 'client')} --scopes read,write --client <kind>`]),
          ),
        );
        return 0;
      }
      const grants = store.listGrants();
      const audit = store.readAudit();
      const lastByLabel = new Map<string, AuditEntry>();
      for (const e of audit) {
        if (e.grant === null) continue;
        const prev = lastByLabel.get(e.grant.label);
        if (prev === undefined || e.at >= prev.at) lastByLabel.set(e.grant.label, e);
      }
      if (ctx.json) {
        ctx.print(
          `${JSON.stringify(
            grants.map((g) => {
              const last = lastByLabel.get(g.label);
              return { label: g.label, id: g.id, scopes: g.scopes, tags: g.tags ?? [], createdAt: g.createdAt, note: g.note, lastSeen: last ? { at: last.at, client: last.client, event: last.event, name: last.name } : null };
            }),
          )}\n`,
        );
        return 0;
      }
      if (grants.length === 0) {
        ctx.print('no grants\n');
        ctx.info('run: opencontext-vault grant <label> --scopes read,write --client <kind>\n');
        return 0;
      }
      ctx.print(
        renderTable(
          ['LABEL', 'SCOPES', 'TAGS', 'CREATED', 'LAST SEEN'],
          grants.map((g) => {
            const last = lastByLabel.get(g.label);
            return [g.label, g.scopes.join(','), (g.tags ?? []).join(','), g.createdAt, last ? `${last.at} ${describeClient(last.client)}` : 'never'];
          }),
        ),
      );
      return 0;
    } finally {
      store.close();
    }
  },
};
