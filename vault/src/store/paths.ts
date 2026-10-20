import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Inputs to path resolution; env and home are injectable so tests never read the real environment. */
export interface PathOptions {
  vaultDir?: string;
  keyFile?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}

/** Flag > env (OPENCONTEXT_VAULT_DIR / OPENCONTEXT_VAULT_KEY_FILE) > default (~/.opencontext/vault, ~/.opencontext/vault.key). Returns absolute paths. The key file defaults to a SIBLING of the vault dir (`<vaultDir>.key`), never inside it, so the directory can be backed up or synced without the key. */
export function resolvePaths(o: PathOptions): { vaultDir: string; keyFile: string } {
  const env = o.env ?? process.env;
  const home = nonEmpty(o.home) ?? homedir();
  const vaultDir = resolve(nonEmpty(o.vaultDir) ?? nonEmpty(env.OPENCONTEXT_VAULT_DIR) ?? join(home, '.opencontext', 'vault'));
  const keyFile = resolve(nonEmpty(o.keyFile) ?? nonEmpty(env.OPENCONTEXT_VAULT_KEY_FILE) ?? `${vaultDir}.key`);
  return { vaultDir, keyFile };
}

/** Every path inside a vault directory, computed in one place so the store, verify and the CLI never disagree about the layout. */
export function vaultFiles(vaultDir: string): {
  manifest: string;
  memories: string;
  sources: string;
  grants: string;
  audit: string;
  sourcesDir: string;
  sessionsDir: string;
  lock: string;
  tmpDir: string;
} {
  return {
    manifest: join(vaultDir, 'vault.json'),
    memories: join(vaultDir, 'memories.jsonl'),
    sources: join(vaultDir, 'sources.jsonl'),
    grants: join(vaultDir, 'grants.jsonl'),
    audit: join(vaultDir, 'audit.jsonl'),
    sourcesDir: join(vaultDir, 'sources'),
    sessionsDir: join(vaultDir, 'sessions'),
    lock: join(vaultDir, '.lock'),
    tmpDir: join(vaultDir, 'tmp'),
  };
}
