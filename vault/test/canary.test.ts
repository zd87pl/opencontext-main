import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadKey } from '../src/crypto/keyfile.js';
import { hashToken } from '../src/crypto/token.js';
import { newId, nowIso } from '../src/ids.js';
import { createVaultServer } from '../src/mcp/server.js';
import { TOOL_NAMES } from '../src/mcp/tools.js';
import { VaultSearch } from '../src/search/vault-search.js';
import { EXPORT_FORMAT, EXPORT_VERSION, type SourceMeta } from '../src/types.js';
import { tmpVault } from './helpers/tmp-vault.js';

const PASSPHRASE = 'CANARY-PASS';
const TOKEN = `ocv_CANARYTOKEN${'0'.repeat(21)}`; // ocv_ + 32 chars, the real token shape
const CANARY = 'CANARY-7f3a';

interface Result {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe('canary: secrets never reach the audit log, stderr, error texts, the export or the vault files', () => {
  const restore: Array<() => void> = [];
  afterEach(() => {
    for (const f of restore.splice(0)) f();
  });

  it('end to end with a scrypt key, a known token and a known passphrase', async () => {
    expect(TOKEN).toMatch(/^ocv_[A-Za-z0-9_-]{32}$/);
    const v = tmpVault({ passphrase: PASSPHRASE });
    restore.push(() => v.cleanup());
    const key = loadKey(v.keyFile, v.store.vaultId, { passphrase: PASSPHRASE });
    const keyHex = key.toString('hex');
    const keyB64 = key.toString('base64');
    const keyB64Url = key.toString('base64url');
    const secrets: Array<[string, string]> = [
      ['token', TOKEN],
      ['passphrase', PASSPHRASE],
      ['key hex', keyHex],
      ['key base64', keyB64],
      ['key base64url', keyB64Url],
    ];
    v.store.putGrant({ id: newId('grt'), label: 'canary', tokenHash: hashToken(TOKEN), scopes: ['read', 'write', 'sources', 'forget', 'instruct'], createdAt: nowIso() });

    // Capture everything written to stderr (the server's own diagnostics and anything a dependency prints).
    const stderr: string[] = [];
    const warnings: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderr.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
    restore.push(() => {
      process.stderr.write = origWrite;
    });

    const search = new VaultSearch(v.store);
    const vault = createVaultServer({ store: v.store, search, token: TOKEN, version: '0.1.0-test', onWarn: (m) => warnings.push(m) });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'canary-client', version: '0.0.1' });
    await vault.connect(st);
    await client.connect(ct);
    await search.buildSourceIndex();
    const call = async (name: string, args: Record<string, unknown> = {}): Promise<Result> =>
      (await client.callTool({ name, arguments: args })) as unknown as Result;

    const errorTexts: string[] = [];
    const note = (r: Result): Result => {
      if (r.isError) errorTexts.push(r.content[0]?.text ?? '');
      return r;
    };

    // Every tool once, with the canary in its arguments.
    const called = new Set<string>();
    const status = note(await call('vault_status'));
    called.add('vault_status');
    expect(status.structuredContent?.authorized).toBe(true);
    const added = note(await call('vault_source_add', { title: `${CANARY} chat`, turns: [{ role: 'user', text: `codename ${CANARY}` }, { role: 'assistant', text: 'ok' }] }));
    called.add('vault_source_add');
    const sourceId = (added.structuredContent?.source as SourceMeta).id;
    note(await call('vault_source_list', { tags: [CANARY.toLowerCase()] }));
    called.add('vault_source_list');
    note(await call('vault_source_search', { query: CANARY }));
    called.add('vault_source_search');
    note(await call('vault_source_read', { id: sourceId, maxChars: 500 }));
    called.add('vault_source_read');
    const remembered = note(
      await call('vault_remember', { statement: `User codename is ${CANARY}.`, kind: 'fact', confidence: 'stated', sources: [{ sourceId, turn: 0, quote: `codename ${CANARY}` }] }),
    );
    called.add('vault_remember');
    const memoryId = (remembered.structuredContent?.memory as { id: string }).id;
    note(await call('vault_search', { query: CANARY }));
    called.add('vault_search');
    note(await call('vault_source_review', { id: sourceId, note: CANARY }));
    called.add('vault_source_review');
    note(await call('vault_forget', { ids: [memoryId], reason: CANARY }));
    called.add('vault_forget');
    expect([...called].sort()).toEqual([...TOOL_NAMES].sort());

    // Error paths whose text must not echo secrets: the token pasted as a statement, as a quote, and a secret-looking key.
    const tokenStatement = note(await call('vault_remember', { statement: `User token is ${TOKEN}`, kind: 'fact', confidence: 'stated' }));
    expect(tokenStatement.isError).toBe(true);
    expect(tokenStatement.content[0]?.text).toContain('SECRET_DETECTED');
    const tokenQuote = note(await call('vault_remember', { statement: 'User has a token.', kind: 'fact', confidence: 'stated', sources: [{ sourceId, turn: 0, quote: TOKEN }] }));
    expect(tokenQuote.isError).toBe(true);
    note(await call('vault_remember', { statement: 'password: hunter2hunter2', kind: 'fact', confidence: 'stated' }));
    note(await call('vault_source_read', { id: 'src_0000000000000000' }));
    note(await call('vault_forget', { ids: [] })); // SDK input-validation error text
    expect(errorTexts.length).toBe(5);

    await client.close();
    await vault.closed;

    // 1. The decrypted audit log holds the canary (args are logged on purpose) but none of the secrets.
    const audit = v.store.readAudit();
    const auditJson = JSON.stringify(audit);
    expect(auditJson).toContain(CANARY);
    expect(audit.some((e) => e.event === 'session_start')).toBe(true);
    expect(audit.some((e) => e.event === 'session_end')).toBe(true);
    for (const [name, value] of secrets) expect(auditJson, `audit contains ${name}`).not.toContain(value);
    expect(auditJson).toContain('ocv_[redacted]');

    // 2. stderr and every isError text.
    const allStderr = [...stderr, ...warnings].join('\n');
    for (const [name, value] of secrets) expect(allStderr, `stderr contains ${name}`).not.toContain(value);
    for (const text of errorTexts) for (const [name, value] of secrets) expect(text, `error text contains ${name}`).not.toContain(value);

    // 3. A portable export (built the way the exporter builds it: all memories + full sources) contains no token.
    const exportDoc = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: nowIso(),
      vaultId: v.store.vaultId,
      generator: '@opencontext/vault 0.1.0-test',
      memories: v.store.listMemories({ status: 'all' }),
      sources: v.store.listSources().map((s) => v.store.getSource(s.id)),
    };
    const exportText = `${JSON.stringify(exportDoc, null, 2)}\n`;
    expect(exportText).not.toContain('ocv_');
    for (const [name, value] of secrets) expect(exportText, `export contains ${name}`).not.toContain(value);
    expect(exportText).toContain(CANARY); // the data itself is in the export, as it should be

    // 4. Nothing under the vault directory holds any secret or even the canary in plaintext (everything is sealed).
    for (const file of filesUnder(v.dir)) {
      const text = readFileSync(file, 'latin1');
      for (const [name, value] of secrets) expect(text, `${file} contains ${name}`).not.toContain(value);
      if (!file.endsWith('.json') || !file.includes('sessions')) expect(text, `${file} contains the canary in plaintext`).not.toContain(CANARY);
    }
    // The key file is a sibling, not inside the vault dir, and in scrypt mode holds neither the key nor the passphrase in clear.
    const keyFileText = readFileSync(v.keyFile, 'utf8');
    expect(keyFileText).not.toContain(PASSPHRASE);
    expect(keyFileText).not.toContain(keyB64);
    expect(keyFileText).not.toContain(keyHex);
    expect(v.keyFile.startsWith(`${v.dir}/`)).toBe(false);
  });
});
