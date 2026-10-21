import { AuditEvent, type AuditEntry } from '../../types.js';
import { parseSince, type Command, type CommandContext } from '../args.js';

const DEFAULT_LIMIT = 100;
const FOLLOW_INTERVAL_MS = 500;

/** Who made the call: the grant label, "cli" for CLI commands, the self-asserted client name for unauthenticated sessions. */
function who(e: AuditEntry): string {
  if (e.grant !== null) return e.grant.label;
  if (e.event === 'cli') return 'cli';
  return e.client !== null ? `${e.client.name}?` : '-';
}

/** The server stores args as a (possibly truncated) JSON string; anything else is serialized here so one column shape is printed. */
function argsText(e: AuditEntry): string {
  return typeof e.args === 'string' ? e.args : JSON.stringify(e.args) ?? '';
}

/** One fixed-width line per entry, usable both for the static listing and for --follow where column widths cannot be known upfront. */
function line(e: AuditEntry): string {
  const outcome = e.outcome + (e.error !== undefined ? `(${e.error})` : '');
  return `${e.at}  ${who(e).padEnd(16)}  ${e.event.padEnd(13)}  ${e.name.padEnd(20)}  ${outcome.padEnd(10)}  ${String(e.ms).padStart(5)}ms  ${argsText(e)}\n`;
}

const HEADER = `${'TIME'.padEnd(24)}  ${'CLIENT'.padEnd(16)}  ${'EVENT'.padEnd(13)}  ${'NAME'.padEnd(20)}  ${'OUTCOME'.padEnd(10)}  ${'MS'.padStart(7)}  ARGS\n`;

/** `audit`: decrypt and print the access log; --follow tails it like `tail -f`. */
export const audit: Command = {
  spec: {
    name: 'audit',
    args: '',
    summary: 'Print the access log (who called what, with full arguments); --follow tails it',
    details:
      'Every MCP call, denied or not, every session start/end and every auditable CLI command is one encrypted entry with its full arguments (tokens redacted, truncated at 1 KB). CLIENT is the grant label, "cli", or the self-asserted name of an unauthenticated client marked with "?". The log is append-only and chained; `verify` checks it.',
    flags: [
      { name: 'follow', type: 'boolean', help: 'keep printing new entries every 500 ms until Ctrl-C' },
      { name: 'since', type: 'string', placeholder: '<24h|ISO>', help: 'entries at or after this time (ISO date or 30m/24h/7d)' },
      { name: 'client', type: 'string', placeholder: '<label>', help: 'this grant label only' },
      { name: 'event', type: 'string', placeholder: AuditEvent.options.join('|'), help: 'this event type only' },
      { name: 'denied', type: 'boolean', help: 'denied calls only' },
      { name: 'limit', type: 'string', placeholder: '<n>', help: `newest N entries (default ${DEFAULT_LIMIT}; 0 = all)` },
    ],
  },
  async run(ctx: CommandContext): Promise<number> {
    const sinceFlag = ctx.flags.str('since');
    const since = sinceFlag !== undefined ? parseSince(sinceFlag, ctx.now) : undefined;
    const label = ctx.flags.str('client');
    const event = ctx.flags.choice('event', AuditEvent.options);
    const denied = ctx.flags.bool('denied');
    const limitFlag = ctx.flags.int('limit');
    const limit = limitFlag === undefined ? DEFAULT_LIMIT : limitFlag === 0 ? undefined : limitFlag;
    const matches = (e: AuditEntry): boolean =>
      (since === undefined || e.at >= since) && (label === undefined || e.grant?.label === label) && (event === undefined || e.event === event) && (!denied || e.outcome === 'denied');
    const store = ctx.openStore();
    try {
      const entries = store.readAudit({
        ...(since !== undefined ? { since } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(event !== undefined ? { event } : {}),
        ...(denied ? { outcome: 'denied' as const } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      if (ctx.json) {
        for (const e of entries) ctx.print(`${JSON.stringify(e)}\n`);
      } else {
        ctx.print(HEADER);
        for (const e of entries) ctx.print(line(e));
      }
      if (!ctx.flags.bool('follow')) return 0;
      let byte = store.tailAudit(0).byte;
      await new Promise<void>((resolveDone, reject) => {
        let stopped = false;
        const stop = (): void => {
          stopped = true;
          resolveDone();
        };
        process.once('SIGINT', stop);
        const tick = (): void => {
          if (stopped) return;
          try {
            store.refresh();
            const r = store.tailAudit(byte);
            byte = r.byte;
            for (const e of r.entries) {
              if (!matches(e)) continue;
              ctx.print(ctx.json ? `${JSON.stringify(e)}\n` : line(e));
            }
          } catch (err) {
            process.off('SIGINT', stop);
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          setTimeout(tick, FOLLOW_INTERVAL_MS);
        };
        setTimeout(tick, FOLLOW_INTERVAL_MS);
      });
      return 0;
    } finally {
      store.close();
    }
  },
};
