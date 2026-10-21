import { VaultError } from '../errors.js';
import { EXPORT_FORMAT, EXPORT_VERSION, PortableExportV1 } from '../types.js';
import { isRecord } from './common.js';

function issuePath(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  const first = issues[0];
  if (!first) return 'invalid';
  const path = first.path.map(String).join('.');
  return `${path || '(root)'}: ${first.message}`;
}

/**
 * Validates a parsed export with PortableExportV1 (strict: unknown keys are rejected so a future field never
 * silently drops). A different `version` is UNSUPPORTED ("written by format version N; this build reads 1") rather than
 * INVALID_ARGUMENT, because the file is fine — this build is what is too old (or too new).
 */
export function parsePortable(json: unknown): PortableExportV1 {
  if (!isRecord(json)) {
    throw new VaultError('INVALID_ARGUMENT', 'not an opencontext-vault export: expected a JSON object');
  }
  if (json.format !== EXPORT_FORMAT) {
    throw new VaultError('INVALID_ARGUMENT', `not an opencontext-vault export: "format" is ${JSON.stringify(json.format ?? null)}`);
  }
  if (json.version !== EXPORT_VERSION) {
    const v = typeof json.version === 'number' ? String(json.version) : JSON.stringify(json.version ?? null);
    throw new VaultError(
      'UNSUPPORTED',
      `export written by format version ${v}; this build reads ${EXPORT_VERSION}`,
      'upgrade @opencontext/vault to a release that reads this version (see SPEC.md "Versioning")',
    );
  }
  const parsed = PortableExportV1.safeParse(json);
  if (!parsed.success) {
    throw new VaultError('INVALID_ARGUMENT', `invalid export: ${issuePath(parsed.error.issues)}`);
  }
  return parsed.data;
}
