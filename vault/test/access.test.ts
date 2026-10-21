import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCOPE_MATRIX, applyWriteTags, assertScopes, hasScope, memoryVisible, resolveCaller, sourceVisible } from '../src/access/policy.js';
import { hashToken, newToken } from '../src/crypto/token.js';
import { VaultError } from '../src/errors.js';
import { newId, nowIso } from '../src/ids.js';
import { ALL_SCOPES, type Grant, type Scope } from '../src/types.js';
import { makeMemory, makeSource, tmpVault } from './helpers/tmp-vault.js';

function grant(partial: Partial<Grant> & { scopes: Scope[] }): Grant {
  return { id: newId('grt'), label: 'claude-desktop', tokenHash: hashToken(newToken()), createdAt: nowIso(), ...partial };
}

const HINT_RE = /^ask the user to run: opencontext-vault grant \S+ --scopes \S+ and put the printed token in this client's MCP config as OPENCONTEXT_VAULT_TOKEN$/;

describe('resolveCaller (default deny)', () => {
  let v: ReturnType<typeof tmpVault>;
  beforeEach(() => {
    v = tmpVault();
  });
  afterEach(() => v.cleanup());

  it('no token → anonymous/no-token; empty token counts as no token', () => {
    expect(resolveCaller(v.store, undefined)).toEqual({ kind: 'anonymous', reason: 'no-token' });
    expect(resolveCaller(v.store, '')).toEqual({ kind: 'anonymous', reason: 'no-token' });
  });

  it('unknown token → anonymous/unknown-token even when it looks valid', () => {
    expect(resolveCaller(v.store, newToken())).toEqual({ kind: 'anonymous', reason: 'unknown-token' });
    expect(resolveCaller(v.store, 'not-a-token')).toEqual({ kind: 'anonymous', reason: 'unknown-token' });
  });

  it('a granted token resolves to its grant; the label never confers anything', () => {
    const token = newToken();
    const g = v.store.putGrant(grant({ scopes: ['read'], tokenHash: hashToken(token) }));
    expect(resolveCaller(v.store, token)).toEqual({ kind: 'granted', grant: g });
    // Same label, different token: still unknown.
    expect(resolveCaller(v.store, newToken()).kind).toBe('anonymous');
  });

  it('is re-evaluated on every call: a revoke between two calls denies the second', () => {
    const token = newToken();
    const g = v.store.putGrant(grant({ scopes: ['read', 'write'], tokenHash: hashToken(token) }));
    expect(resolveCaller(v.store, token).kind).toBe('granted');
    v.store.deleteGrant(g.id);
    expect(resolveCaller(v.store, token)).toEqual({ kind: 'anonymous', reason: 'unknown-token' });
  });

  it('a rotate (same grant id, new hash) invalidates the old token and honours the new one', () => {
    const oldToken = newToken();
    const newT = newToken();
    const g = v.store.putGrant(grant({ scopes: ['read'], tokenHash: hashToken(oldToken) }));
    v.store.putGrant({ ...g, tokenHash: hashToken(newT) });
    expect(resolveCaller(v.store, oldToken).kind).toBe('anonymous');
    expect(resolveCaller(v.store, newT).kind).toBe('granted');
  });
});

describe('assertScopes: exact messages and hints', () => {
  it('no token', () => {
    let err: unknown;
    try {
      assertScopes({ kind: 'anonymous', reason: 'no-token' }, ['read'], 'vault_search');
    } catch (e) {
      err = e;
    }
    expect(VaultError.is(err, 'DENIED')).toBe(true);
    const e = err as VaultError;
    expect(e.message).toBe('this client has no access to the vault (no token)');
    expect(e.hint).toBe(
      "ask the user to run: opencontext-vault grant CLIENT --scopes read and put the printed token in this client's MCP config as OPENCONTEXT_VAULT_TOKEN",
    );
  });

  it('unknown token', () => {
    expect(() => assertScopes({ kind: 'anonymous', reason: 'unknown-token' }, ['sources', 'write'], 'x')).toThrowError(
      "this client's token is not recognized (revoked or rotated?)",
    );
    try {
      assertScopes({ kind: 'anonymous', reason: 'unknown-token' }, ['sources', 'write'], 'x');
    } catch (e) {
      expect((e as VaultError).hint).toBe(
        "ask the user to run: opencontext-vault grant CLIENT --scopes write,sources and put the printed token in this client's MCP config as OPENCONTEXT_VAULT_TOKEN",
      );
    }
  });

  it('missing scope names the grant, the scope and what it has; hint names the label', () => {
    const g = grant({ label: 'cursor', scopes: ['read'] });
    let err: VaultError | undefined;
    try {
      assertScopes({ kind: 'granted', grant: g }, ['write'], 'vault_remember');
    } catch (e) {
      err = e as VaultError;
    }
    expect(err?.code).toBe('DENIED');
    expect(err?.message).toBe('grant "cursor" lacks scope "write" (has: read)');
    expect(err?.hint).toBe(
      "ask the user to run: opencontext-vault grant cursor --scopes read,write and put the printed token in this client's MCP config as OPENCONTEXT_VAULT_TOKEN",
    );
    expect(err?.hint).toMatch(HINT_RE);
  });

  it('lists all held scopes in the message and returns the grant on success', () => {
    const g = grant({ label: 'ide', scopes: ['read', 'write', 'sources'] });
    expect(() => assertScopes({ kind: 'granted', grant: g }, ['forget'], 'vault_forget')).toThrowError(
      'grant "ide" lacks scope "forget" (has: read,write,sources)',
    );
    expect(assertScopes({ kind: 'granted', grant: g }, ['sources', 'write'], 'vault_source_add')).toBe(g);
    expect(assertScopes({ kind: 'granted', grant: g }, [], 'vault_status')).toBe(g);
  });

  it('hasScope is false for anonymous callers and for missing scopes', () => {
    const g = grant({ scopes: ['read'] });
    expect(hasScope({ kind: 'anonymous', reason: 'no-token' }, 'read')).toBe(false);
    expect(hasScope({ kind: 'granted', grant: g }, 'read')).toBe(true);
    expect(hasScope({ kind: 'granted', grant: g }, 'write')).toBe(false);
  });
});

describe('SCOPE_MATRIX (§5.1) for every tool, resource and prompt', () => {
  const expected: Record<string, Scope[]> = {
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
  };

  it('matches the spec table exactly (no extra, no missing entries)', () => {
    expect(SCOPE_MATRIX).toEqual(expected);
    expect(Object.keys(SCOPE_MATRIX).sort()).toEqual(Object.keys(expected).sort());
    expect(Object.isFrozen(SCOPE_MATRIX)).toBe(true);
  });

  it('every scope in the matrix is a real scope', () => {
    for (const scopes of Object.values(SCOPE_MATRIX)) for (const s of scopes) expect(ALL_SCOPES).toContain(s);
  });

  it.each(Object.entries(expected))('%s: a grant with exactly those scopes passes, one short of them is denied', (name, scopes) => {
    const full = grant({ scopes: scopes.length > 0 ? scopes : ['read'] });
    expect(() => assertScopes({ kind: 'granted', grant: full }, SCOPE_MATRIX[name] ?? [], name)).not.toThrow();
    for (const missing of scopes) {
      const short = grant({ scopes: ALL_SCOPES.filter((s) => s !== missing) });
      expect(() => assertScopes({ kind: 'granted', grant: short }, SCOPE_MATRIX[name] ?? [], name)).toThrowError(`lacks scope "${missing}"`);
    }
  });

  it('the sources+write conjunctions need BOTH scopes', () => {
    for (const name of ['vault_source_add', 'vault_source_review']) {
      const onlySources = grant({ scopes: ['sources', 'read'] });
      const onlyWrite = grant({ scopes: ['write', 'read'] });
      expect(() => assertScopes({ kind: 'granted', grant: onlySources }, SCOPE_MATRIX[name] ?? [], name)).toThrowError('lacks scope "write"');
      expect(() => assertScopes({ kind: 'granted', grant: onlyWrite }, SCOPE_MATRIX[name] ?? [], name)).toThrowError('lacks scope "sources"');
    }
  });

  it('the instruct conjunction: write alone is not enough for an instruction memory', () => {
    const required: Scope[] = [...(SCOPE_MATRIX.vault_remember ?? []), 'instruct'];
    const writer = grant({ scopes: ['read', 'write', 'sources', 'forget'] });
    expect(() => assertScopes({ kind: 'granted', grant: writer }, required, 'vault_remember')).toThrowError('lacks scope "instruct" (has: read,write,sources,forget)');
    const instructor = grant({ scopes: ['write', 'instruct'] });
    expect(assertScopes({ kind: 'granted', grant: instructor }, required, 'vault_remember')).toBe(instructor);
  });

  it('the forget+sources conjunction: forgetting a source needs sources too', () => {
    const required: Scope[] = [...(SCOPE_MATRIX.vault_forget ?? []), 'sources'];
    const forgetter = grant({ scopes: ['forget'] });
    expect(() => assertScopes({ kind: 'granted', grant: forgetter }, required, 'vault_forget')).toThrowError('lacks scope "sources"');
  });
});

describe('tag visibility and auto-tagging', () => {
  it('an unrestricted grant sees everything, a tag-restricted one only overlapping records', () => {
    const open = grant({ scopes: ['read'] });
    const coding = grant({ scopes: ['read'], tags: ['coding'] });
    const untagged = makeMemory({ tags: [] });
    const go = makeMemory({ tags: ['go', 'coding'] });
    const cooking = makeMemory({ tags: ['cooking'] });
    expect(memoryVisible(open, untagged)).toBe(true);
    expect(memoryVisible(open, cooking)).toBe(true);
    expect(memoryVisible(coding, go)).toBe(true);
    expect(memoryVisible(coding, untagged)).toBe(false);
    expect(memoryVisible(coding, cooking)).toBe(false);
  });

  it('sourceVisible applies the same rule to source metas', () => {
    const coding = grant({ scopes: ['sources'], tags: ['coding', 'work'] });
    const { content: _c1, ...tagged } = makeSource({ tags: ['work'] });
    const { content: _c2, ...plain } = makeSource({ origin: { importer: 'test@1', path: '', externalId: 'other', trust: 'imported' } });
    expect(sourceVisible(coding, tagged)).toBe(true);
    expect(sourceVisible(coding, plain)).toBe(false);
    expect(sourceVisible(grant({ scopes: ['sources'] }), plain)).toBe(true);
  });

  it('applyWriteTags unions the grant tags, normalizes and dedupes', () => {
    const coding = grant({ scopes: ['write'], tags: ['coding'] });
    expect(applyWriteTags(coding, ['Go', 'coding', ' go '])).toEqual(['go', 'coding']);
    expect(applyWriteTags(coding, [])).toEqual(['coding']);
    expect(applyWriteTags(grant({ scopes: ['write'] }), ['A'])).toEqual(['a']);
  });

  it('applyWriteTags rejects an invalid tag with INVALID_ARGUMENT naming it', () => {
    expect(() => applyWriteTags(grant({ scopes: ['write'] }), ['bad tag!'])).toThrowError('invalid tag "bad tag!"');
  });
});
