import { chmodSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuditSink, redactTokens, type AuditSink } from '../src/access/audit.js';
import { hashToken, newToken } from '../src/crypto/token.js';
import { VaultError } from '../src/errors.js';
import { newId, nowIso } from '../src/ids.js';
import { guarded, type GuardDeps } from '../src/mcp/guard.js';
import { VaultSearch } from '../src/search/vault-search.js';
import { LIMITS, type Grant, type Scope } from '../src/types.js';
import { tmpVault } from './helpers/tmp-vault.js';

const FIXED = new Date('2026-10-20T10:00:00.000Z');

describe('createAuditSink', () => {
  let v: ReturnType<typeof tmpVault>;
  let sink: AuditSink;
  beforeEach(() => {
    v = tmpVault();
    sink = createAuditSink(v.store, { pid: 4242, now: () => FIXED, client: () => ({ name: 'test-client', version: '1.0.0' }) });
  });
  afterEach(() => v.cleanup());

  it('writes one entry per record() with pid, time and client filled from the context', () => {
    sink.record({ grant: null, event: 'tool', name: 'vault_status', args: {}, outcome: 'ok', ms: 3 });
    sink.record({ grant: { id: newId('grt'), label: 'cli' }, event: 'cli', name: 'grant', args: { label: 'cli' }, outcome: 'ok', ms: 1 });
    const entries = v.store.readAudit();
    expect(entries).toHaveLength(2);
    const [a, b] = entries;
    expect(a?.pid).toBe(4242);
    expect(a?.at).toBe('2026-10-20T10:00:00.000Z');
    expect(a?.client).toEqual({ name: 'test-client', version: '1.0.0' });
    expect(a?.session).toBe(v.store.session);
    expect(a?.id).toMatch(/^aud_[0-9a-f]{16}$/);
    expect(a?.args).toBe('{}');
    expect(b?.grant?.label).toBe('cli');
    expect(b?.args).toBe('{"label":"cli"}');
  });

  it('explicit pid/at/client override the context (null client stays null)', () => {
    sink.record({ grant: null, event: 'session_start', name: 'session_start', args: {}, outcome: 'ok', ms: 0, pid: 7, at: '2026-01-01T00:00:00.000Z', client: null });
    const [e] = v.store.readAudit();
    expect(e?.pid).toBe(7);
    expect(e?.at).toBe('2026-01-01T00:00:00.000Z');
    expect(e?.client).toBeNull();
  });

  it('truncates args to LIMITS.auditArgsChars with the …[truncated] suffix', () => {
    const big = { query: 'x'.repeat(5000) };
    sink.record({ grant: null, event: 'tool', name: 'vault_search', args: big, outcome: 'ok', ms: 1 });
    const [e] = v.store.readAudit();
    const args = e?.args;
    expect(typeof args).toBe('string');
    const s = args as string;
    expect(s.endsWith('…[truncated]')).toBe(true);
    expect(s.length).toBe(LIMITS.auditArgsChars + '…[truncated]'.length);
    expect(s.startsWith('{"query":"xxx')).toBe(true);
  });

  it('keeps error codes and result ids/count', () => {
    sink.record({ grant: null, event: 'tool', name: 'vault_remember', args: {}, outcome: 'denied', error: 'DENIED', ms: 2 });
    sink.record({ grant: null, event: 'tool', name: 'vault_forget', args: {}, outcome: 'error', error: 'NOT_FOUND', ms: 2, result: { count: 0, ids: [] } });
    sink.record({ grant: null, event: 'tool', name: 'vault_search', args: {}, outcome: 'ok', ms: 2, result: { count: 2, ids: ['mem_1', 'mem_2'] } });
    const [d, e, o] = v.store.readAudit();
    expect(d?.outcome).toBe('denied');
    expect(d?.error).toBe('DENIED');
    expect(e?.error).toBe('NOT_FOUND');
    expect(o?.result).toEqual({ count: 2, ids: ['mem_1', 'mem_2'] });
    expect(v.store.readAudit({ outcome: 'denied' })).toHaveLength(1);
  });

  it('throws VaultError(IO, "audit append failed") when the store cannot append', () => {
    v.store.close();
    let err: unknown;
    try {
      sink.record({ grant: null, event: 'tool', name: 'vault_status', args: {}, outcome: 'ok', ms: 0 });
    } catch (e) {
      err = e;
    }
    expect(VaultError.is(err, 'IO')).toBe(true);
    expect((err as VaultError).message).toBe('audit append failed');
  });
});

describe('guarded(): one entry per call, outcomes, IO failure', () => {
  let v: ReturnType<typeof tmpVault>;
  let token: string;
  let grant: Grant;
  let deps: GuardDeps;
  const warnings: string[] = [];

  beforeEach(() => {
    v = tmpVault();
    token = newToken();
    grant = v.store.putGrant({ id: newId('grt'), label: 'tester', tokenHash: hashToken(token), scopes: ['read', 'write'], createdAt: nowIso() });
    const search = new VaultSearch(v.store);
    const audit = createAuditSink(v.store, { pid: process.pid, now: () => FIXED, client: () => null });
    deps = { store: v.store, search, audit, token, now: () => FIXED };
    warnings.length = 0;
  });
  afterEach(() => v.cleanup());

  const call = (required: Scope[] | ((a: { n: number }) => Scope[]), body: (a: { n: number }) => { structured: Record<string, unknown>; ids?: string[]; count?: number }) =>
    guarded<{ n: number }>(deps, { event: 'tool', name: 'probe', required }, body);

  it('ok: audits once with grant, ms, result ids/count, and returns ok() with structuredContent', () => {
    const fn = call(['read'], (a) => ({ structured: { doubled: a.n * 2 }, ids: ['mem_x'], count: 1 }));
    const r = fn({ n: 21 });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ doubled: 42 });
    expect(r.content[0]?.text).toBe('{"doubled":42}');
    const entries = v.store.readAudit();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e?.event).toBe('tool');
    expect(e?.name).toBe('probe');
    expect(e?.outcome).toBe('ok');
    expect(e?.grant).toEqual({ id: grant.id, label: 'tester' });
    expect(e?.args).toBe('{"n":21}');
    expect(e?.result).toEqual({ count: 1, ids: ['mem_x'] });
    expect(e?.ms).toBeGreaterThanOrEqual(0);
    expect(e?.error).toBeUndefined();
  });

  it('denied: a missing scope is logged as denied/DENIED and the handler never runs', () => {
    let ran = false;
    const fn = call(['forget'], () => {
      ran = true;
      return { structured: {} };
    });
    const r = fn({ n: 1 });
    expect(ran).toBe(false);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r.content[0]?.text).toBe(
      'DENIED: grant "tester" lacks scope "forget" (has: read,write)\n' +
        "ask the user to run: opencontext-vault grant tester --scopes read,write,forget and put the printed token in this client's MCP config as OPENCONTEXT_VAULT_TOKEN",
    );
    const [e] = v.store.readAudit();
    expect(e?.outcome).toBe('denied');
    expect(e?.error).toBe('DENIED');
    expect(e?.grant?.label).toBe('tester');
  });

  it('denied: no token is logged with grant null', () => {
    deps.token = undefined;
    const r = call(['read'], () => ({ structured: {} }))({ n: 1 });
    expect(r.content[0]?.text.startsWith('DENIED: this client has no access to the vault (no token)\n')).toBe(true);
    const [e] = v.store.readAudit();
    expect(e?.grant).toBeNull();
    expect(e?.outcome).toBe('denied');
  });

  it('required may depend on the arguments', () => {
    const fn = call((a) => (a.n > 0 ? ['forget'] : ['read']), () => ({ structured: { fine: true } }));
    expect(fn({ n: 0 }).isError).toBeUndefined();
    expect(fn({ n: 1 }).isError).toBe(true);
    expect(v.store.readAudit().map((e) => e.outcome)).toEqual(['ok', 'denied']);
  });

  it('error: a VaultError from the handler is logged as error with its code and mapped to fail()', () => {
    const fn = call(['read'], () => {
      throw new VaultError('NOT_FOUND', 'memory not found: mem_0', 'try vault_search');
    });
    const r = fn({ n: 1 });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe('NOT_FOUND: memory not found: mem_0\ntry vault_search');
    const [e] = v.store.readAudit();
    expect(e?.outcome).toBe('error');
    expect(e?.error).toBe('NOT_FOUND');
  });

  it('error: a non-VaultError becomes IO with the message, still logged', () => {
    const fn = call(['read'], () => {
      throw new TypeError('boom');
    });
    const r = fn({ n: 1 });
    expect(r.content[0]?.text).toBe('IO: boom');
    const [e] = v.store.readAudit();
    expect(e?.outcome).toBe('error');
    expect(e?.error).toBe('IO');
  });

  it('anonymous-capable call (required []) runs with grant null and is logged with grant null', () => {
    deps.token = undefined;
    const fn = guarded<Record<string, never>>(deps, { event: 'resource', name: 'vault://status', required: [] }, (_a, ctx) => ({
      structured: { grant: ctx.grant, kind: ctx.caller.kind, now: ctx.now },
    }));
    const r = fn({});
    expect(r.structuredContent).toEqual({ grant: null, kind: 'anonymous', now: '2026-10-20T10:00:00.000Z' });
    const [e] = v.store.readAudit();
    expect(e?.event).toBe('resource');
    expect(e?.grant).toBeNull();
  });

  it('result ids are capped at 50 in the audit entry', () => {
    const ids = Array.from({ length: 80 }, (_, i) => `mem_${i}`);
    call(['read'], () => ({ structured: {}, ids, count: 80 }))({ n: 1 });
    const [e] = v.store.readAudit();
    expect(e?.result?.ids).toHaveLength(50);
    expect(e?.result?.count).toBe(80);
  });

  it('IO failure while auditing → fail(IO) and the handler result is withheld', () => {
    const failing: AuditSink = {
      record() {
        throw new VaultError('IO', 'audit append failed');
      },
    };
    deps.audit = failing;
    const r = call(['read'], () => ({ structured: { secret: 'payload' } }))({ n: 1 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r.content[0]?.text).toBe('IO: audit append failed');
    expect(JSON.stringify(r)).not.toContain('payload');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a read-only vault directory makes the real sink fail with IO', () => {
    chmodSync(v.dir, 0o500);
    try {
      const r = call(['read'], () => ({ structured: { ok: true } }))({ n: 1 });
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text.startsWith('IO: audit append failed')).toBe(true);
    } finally {
      chmodSync(v.dir, 0o700);
    }
  });
});

describe('redactTokens', () => {
  it('replaces every vault-shaped token in serialized args and leaves everything else verbatim', () => {
    const t1 = newToken();
    const t2 = newToken();
    const json = JSON.stringify({ statement: `tokens ${t1} and ${t2}`, keep: 'ocv_short and CANARY-7f3a' });
    const out = redactTokens(json);
    expect(out).not.toContain(t1);
    expect(out).not.toContain(t2);
    expect(out).toContain('ocv_[redacted] and ocv_[redacted]');
    expect(out).toContain('ocv_short and CANARY-7f3a');
  });

  it('is applied by the sink before the entry is written', () => {
    const v = tmpVault();
    try {
      const sink = createAuditSink(v.store, { pid: 1, now: () => FIXED, client: () => null });
      const token = newToken();
      sink.record({ grant: null, event: 'tool', name: 'vault_remember', args: { statement: `my token is ${token}` }, outcome: 'error', error: 'SECRET_DETECTED', ms: 0 });
      const [e] = v.store.readAudit();
      expect(e?.args).toBe('{"statement":"my token is ocv_[redacted]"}');
    } finally {
      v.cleanup();
    }
  });
});
