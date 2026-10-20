import { createHash } from 'node:crypto';

/** Code-point order (not UTF-16 code-unit order) so the canonical form is the same in every language a third party might reimplement it in. */
function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const na = ia.next();
    const nb = ib.next();
    if (na.done && nb.done) return 0;
    if (na.done) return -1;
    if (nb.done) return 1;
    const ca = na.value.codePointAt(0) ?? 0;
    const cb = nb.value.codePointAt(0) ?? 0;
    if (ca !== cb) return ca - cb;
  }
}

function canon(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return JSON.stringify(value); // NaN / Infinity → "null", like JSON.stringify
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new TypeError('canonicalJson: bigint is not JSON');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'object':
      break;
  }
  const obj = value as { toJSON?: unknown };
  if (typeof obj.toJSON === 'function') {
    return canon((obj.toJSON as () => unknown).call(value));
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canon(item) ?? 'null').join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodePoints);
  const parts: string[] = [];
  for (const key of keys) {
    const encoded = canon(record[key]);
    if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Deterministic JSON for hashing: object keys sorted (code-point order), no whitespace, arrays in order,
 * numbers via JSON.stringify, strings escaped by JSON.stringify, undefined properties omitted.
 * Used for SourceMeta.sha256 and test equality. NOT used for the export file (which is pretty-printed in schema order).
 */
export function canonicalJson(value: unknown): string {
  return canon(value) ?? 'null';
}

/** Lowercase hex SHA-256; strings are hashed as UTF-8. The one hash helper so every digest in the vault is produced the same way. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}
