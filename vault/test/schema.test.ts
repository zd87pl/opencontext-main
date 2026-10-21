import { scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { VaultError } from '../src/errors.js';
import { parsePortable } from '../src/importers/portable.js';
import { PortableExportV1 } from '../src/types.js';
import { canonicalJson, sha256Hex } from '../src/util/canonical-json.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string): string => readFileSync(`${ROOT}${rel}`, 'utf8');

interface Vectors {
  keyHex: string;
  keyId: string;
  vaultId: string;
  vectors: Array<{ name: string; aad: string; aadHex: string; ivHex: string; ctBase64: string; tagBase64: string; line: string; lineSha256: string }>;
}

describe('schema/opencontext-vault-export.v1.schema.json', () => {
  it('equals z.toJSONSchema(PortableExportV1), pretty-printed with a trailing newline', () => {
    const generated = z.toJSONSchema(PortableExportV1);
    const text = read('schema/opencontext-vault-export.v1.schema.json');
    expect(JSON.parse(text)).toEqual(generated);
    expect(text).toBe(`${JSON.stringify(generated, null, 2)}\n`);
    expect((generated as { $schema?: string }).$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect((generated as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });

  it('the §4.4 example validates and is internally consistent', () => {
    const example = JSON.parse(read('test/fixtures/portable/export.json')) as unknown;
    const parsed = PortableExportV1.safeParse(example);
    expect(parsed.success).toBe(true);
    const data = parsePortable(example);
    expect(data.memories).toHaveLength(1);
    expect(data.sources).toHaveLength(1);
    const source = data.sources[0];
    expect(source?.sha256).toBe(sha256Hex(canonicalJson(source?.content)));
    expect(source?.bytes).toBe(Buffer.byteLength(JSON.stringify(source?.content), 'utf8'));
    expect(read('test/fixtures/portable/export.json')).toBe(`${JSON.stringify(example, null, 2)}\n`);
  });

  it('SPEC.md embeds that same example and the committed envelope vectors', () => {
    const spec = read('SPEC.md');
    const block = /<!-- example:begin -->\s*```json\n([\s\S]*?)```\s*<!-- example:end -->/.exec(spec);
    expect(block, 'SPEC.md must carry the example between example:begin/end markers').not.toBeNull();
    const example = JSON.parse(block?.[1] ?? '{}') as unknown;
    expect(PortableExportV1.safeParse(example).success).toBe(true);
    expect(canonicalJson(example)).toBe(canonicalJson(JSON.parse(read('test/fixtures/portable/export.json'))));
    const vectors = JSON.parse(read('test/vectors/envelope-vectors.json')) as Vectors;
    expect(spec).toContain(vectors.keyHex);
    expect(spec).toContain(vectors.keyId);
    expect(spec).toContain(vectors.vaultId);
    for (const v of vectors.vectors) {
      expect(spec, v.name).toContain(v.ivHex);
      expect(spec, v.name).toContain(v.ctBase64);
      expect(spec, v.name).toContain(v.tagBase64);
      expect(spec, v.name).toContain(v.lineSha256);
      expect(spec, v.name).toContain(v.aadHex);
    }
    expect(spec).toContain('opencontext-vault/1\\n');
    expect(spec).toContain('N = 131072');
  });

  it('SPEC.md scrypt vector matches node:crypto', () => {
    const spec = read('SPEC.md');
    const m = /<!-- scrypt-vector: passphrase="([^"]+)" saltHex=([0-9a-f]+) N=(\d+) r=(\d+) p=(\d+) dkLen=(\d+) kekHex=([0-9a-f]{64}) -->/.exec(spec);
    expect(m, 'SPEC.md must carry the scrypt vector marker').not.toBeNull();
    if (!m) return;
    const [, passphrase, saltHex, N, r, p, dkLen, kekHex] = m;
    const kek = scryptSync(passphrase ?? '', Buffer.from(saltHex ?? '', 'hex'), Number(dkLen), { N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 });
    expect(kek.toString('hex')).toBe(kekHex);
    expect(spec).toContain(`| KEK (hex) | \`${kekHex}\` |`);
  });

  it('rejects other versions with UNSUPPORTED and malformed files with INVALID_ARGUMENT', () => {
    const v2 = JSON.parse(read('test/fixtures/portable/export-v2.json')) as unknown;
    const err = (() => {
      try {
        parsePortable(v2);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(VaultError.is(err, 'UNSUPPORTED')).toBe(true);
    expect((err as VaultError).message).toBe('export written by format version 2; this build reads 1');
    const example = JSON.parse(read('test/fixtures/portable/export.json')) as Record<string, unknown>;
    expect(() => parsePortable({ ...example, version: '1' })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED' }));
    expect(() => parsePortable({ ...example, extra: 1 })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => parsePortable({ ...example, memories: [{ ...(example.memories as unknown[])[0] as object, kind: 'opinion' }] })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => parsePortable(JSON.parse(read('test/fixtures/portable/not-an-export.json')))).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => parsePortable(null)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => parsePortable([])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('writers cannot emit fields outside the schema (strict parse drops nothing, rejects extras)', () => {
    const example = JSON.parse(read('test/fixtures/portable/export.json')) as Record<string, unknown>;
    const parsed = PortableExportV1.parse(example);
    expect(canonicalJson(parsed)).toBe(canonicalJson(example));
    const withExtraTurnField = {
      ...example,
      sources: [{ ...(example.sources as Array<Record<string, unknown>>)[0], content: { kind: 'conversation', turns: [{ i: 0, role: 'user', text: 'x', mood: 'happy' }] } }],
    };
    expect(PortableExportV1.safeParse(withExtraTurnField).success).toBe(false);
  });
});
