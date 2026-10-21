import { VaultError } from '../errors.js';
import { nowIso } from '../ids.js';
import type { VaultStore } from '../store/vault-store.js';
import { EXPORT_FORMAT, EXPORT_VERSION, Memory, PortableExportV1, Source, type SourceContent, type SourceMeta } from '../types.js';
import { canonicalJson, sha256Hex } from '../util/canonical-json.js';

/** `generator` is the "@opencontext/vault <version>" string the CLI knows; `now` is injectable for byte-stable tests. */
export interface PortableOptions {
  generator: string;
  now?: () => Date;
  includeRaw?: boolean; // default true; false is lossy (SPEC.md)
}

function byCreated<T extends { createdAt: string; id: string }>(a: T, b: T): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Every memory, all statuses, oldest first (ties by id) so two exports of the same data are byte-identical; re-parsed so keys are in schema order. */
function orderedMemories(store: VaultStore): Memory[] {
  return store
    .listMemories({ status: 'all' })
    .sort(byCreated)
    .map((m) => Memory.parse(m));
}

function orderedSourceMetas(store: VaultStore): SourceMeta[] {
  return store.listSources().sort(byCreated);
}

/**
 * One full source record. With includeRaw:false the vendor record is dropped and sha256/bytes/hasRaw are recomputed,
 * so the file still satisfies "sha256 = sha256(canonicalJson(content))" and imports cleanly — it is simply lossy.
 */
function sourceRecord(store: VaultStore, meta: SourceMeta, includeRaw: boolean): Source {
  const body = store.getSourceContent(meta.id);
  if (!body) throw new VaultError('CORRUPT', `source ${meta.id} vanished during export`, 'run: opencontext-vault verify');
  let content: SourceContent = body;
  let record: Source;
  if (!includeRaw && body.raw !== undefined) {
    const { raw: _raw, ...rest } = body;
    content = rest as SourceContent;
    record = {
      ...meta,
      sha256: sha256Hex(canonicalJson(content)),
      bytes: Buffer.byteLength(JSON.stringify(content), 'utf8'),
      hasRaw: false,
      content,
    };
  } else {
    record = { ...meta, content };
  }
  return Source.parse(record);
}

function header(store: VaultStore, o: PortableOptions): Omit<PortableExportV1, 'memories' | 'sources'> {
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: nowIso(o.now), vaultId: store.vaultId, generator: o.generator };
}

/** Re-indent a pretty-printed record so it sits inside the top-level array exactly as JSON.stringify(whole, null, 2) would place it. */
function indented(record: unknown): string {
  return JSON.stringify(record, null, 2)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function writeChunk(out: NodeJS.WritableStream, chunk: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      out.removeListener('drain', onDrain);
      reject(new VaultError('IO', `export write failed: ${err.message}`));
    };
    const onDrain = (): void => {
      if (settled) return;
      settled = true;
      out.removeListener('error', onError);
      resolve();
    };
    let ok: boolean;
    try {
      ok = out.write(chunk);
    } catch (err) {
      reject(new VaultError('IO', `export write failed: ${(err as Error).message}`));
      return;
    }
    if (ok) {
      settled = true;
      resolve();
      return;
    }
    out.once('drain', onDrain);
    out.once('error', onError);
  });
}

/**
 * Streams the portable JSON (§4.4 / SPEC.md) to a Writable: records are serialized one at a time with
 * JSON.stringify(record, null, 2) re-indented, so the output is byte-identical to JSON.stringify(whole, null, 2) + "\n"
 * without holding every body in RAM (bodies come through the store's LRU one at a time). The stream is not ended:
 * the caller owns it. Never includes grants, tokens, keys or audit entries.
 */
export async function writePortable(store: VaultStore, out: NodeJS.WritableStream, o: PortableOptions): Promise<{ memories: number; sources: number }> {
  const includeRaw = o.includeRaw ?? true;
  const head = JSON.stringify(header(store, o), null, 2);
  // Drop the closing "\n}" so the two arrays can be appended as further top-level keys.
  await writeChunk(out, `${head.slice(0, head.length - 2)},\n  "memories": `);
  const memories = orderedMemories(store);
  if (memories.length === 0) await writeChunk(out, '[]');
  else {
    await writeChunk(out, '[\n');
    for (let i = 0; i < memories.length; i += 1) {
      await writeChunk(out, `${indented(memories[i])}${i + 1 < memories.length ? ',\n' : '\n  ]'}`);
    }
  }
  await writeChunk(out, ',\n  "sources": ');
  const metas = orderedSourceMetas(store);
  if (metas.length === 0) await writeChunk(out, '[]');
  else {
    await writeChunk(out, '[\n');
    for (let i = 0; i < metas.length; i += 1) {
      const meta = metas[i];
      if (!meta) continue;
      await writeChunk(out, `${indented(sourceRecord(store, meta, includeRaw))}${i + 1 < metas.length ? ',\n' : '\n  ]'}`);
    }
  }
  await writeChunk(out, '\n}\n');
  return { memories: memories.length, sources: metas.length };
}

/** Convenience for tests and small vaults: builds the whole object in memory, validated against PortableExportV1 so it can never emit a field outside the schema. */
export function buildPortable(store: VaultStore, o: PortableOptions): PortableExportV1 {
  const includeRaw = o.includeRaw ?? true;
  return PortableExportV1.parse({
    ...header(store, o),
    memories: orderedMemories(store),
    sources: orderedSourceMetas(store).map((meta) => sourceRecord(store, meta, includeRaw)),
  });
}
