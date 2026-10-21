import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deterministicId, newId, nowIso } from '../../src/ids.js';
import { VaultStore } from '../../src/store/vault-store.js';
import { type Memory, type Source, type Turn } from '../../src/types.js';
import { canonicalJson, sha256Hex } from '../../src/util/canonical-json.js';

/** Creates a fresh vault + key in a mkdtemp dir; returns paths, the opened store, and a cleanup(). Used by every agent's tests so none of them touches a real ~/.opencontext. */
export function tmpVault(o?: { passphrase?: string }): {
  dir: string;
  keyFile: string;
  store: VaultStore;
  cleanup: () => void;
  env: Record<string, string>;
} {
  const root = mkdtempSync(join(tmpdir(), 'ocv-test-'));
  const dir = join(root, 'vault');
  const keyFile = join(root, 'vault.key');
  const store = VaultStore.init({
    dir,
    keyFile,
    passphraseForNewKey: o?.passphrase,
    passphrase: o?.passphrase !== undefined ? { passphrase: o.passphrase } : undefined,
    onWarn: () => undefined,
  });
  const env: Record<string, string> = { OPENCONTEXT_VAULT_DIR: dir, OPENCONTEXT_VAULT_KEY_FILE: keyFile };
  if (o?.passphrase !== undefined) env.OPENCONTEXT_VAULT_PASSPHRASE = o.passphrase;
  const cleanup = (): void => {
    try {
      store.close();
    } catch {
      /* already closed by the test */
    }
    rmSync(root, { recursive: true, force: true });
  };
  return { dir, keyFile, store, cleanup, env };
}

/** Valid conversation source with a deterministic id (from origin.externalId) so tests can re-put the same source and expect an update, not a duplicate. */
export function makeSource(partial?: Partial<Source> & { turnsText?: string[] }): Source {
  const { turnsText, ...rest } = partial ?? {};
  const externalId = rest.origin?.externalId ?? rest.id ?? 'conv-1';
  const id = rest.id ?? deterministicId('src', 'test@1', externalId);
  const now = nowIso();
  const texts = turnsText ?? ['how should I format Go?', 'gofmt uses tabs.'];
  const turns: Turn[] = texts.map((text, i) => ({ i, role: i % 2 === 0 ? 'user' : 'assistant', text }));
  const content: Source['content'] = rest.content ?? { kind: 'conversation', turns };
  const base: Omit<Source, 'content'> = {
    id,
    type: 'claude',
    kind: content.kind,
    title: 'Test conversation',
    origin: { importer: 'test@1', path: '/tmp/test.json', externalId, trust: 'imported' },
    tags: [],
    createdAt: now,
    importedAt: now,
    sha256: '',
    bytes: 0,
    turnCount: 0,
    hasRaw: false,
    notes: [],
    review: { status: 'unreviewed' },
  };
  const merged: Source = { ...base, ...rest, id, content };
  merged.sha256 = sha256Hex(canonicalJson(content));
  merged.bytes = Buffer.byteLength(JSON.stringify(content), 'utf8');
  merged.turnCount = content.kind === 'conversation' ? content.turns.length : 1;
  merged.hasRaw = content.raw !== undefined;
  return merged;
}

/** Minimal valid active memory; every field can be overridden. */
export function makeMemory(partial?: Partial<Memory>): Memory {
  const now = nowIso();
  return {
    id: newId('mem'),
    kind: 'fact',
    statement: 'User likes well-tested code.',
    subject: 'user',
    tags: [],
    confidence: 'stated',
    sources: [],
    createdAt: now,
    updatedAt: now,
    createdBy: 'cli',
    status: 'active',
    ...partial,
  };
}
