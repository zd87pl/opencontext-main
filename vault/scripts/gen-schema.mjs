#!/usr/bin/env node
// Regenerates schema/opencontext-vault-export.v1.schema.json from the zod type in src/types.ts.
// test/schema.test.ts asserts the checked-in file equals z.toJSONSchema(PortableExportV1), so run this after
// changing the export shape and commit the result. Prefers the built dist/ (what ships); without a build it loads
// the TypeScript source directly (Node ≥ 22.18 strips types natively; the hook below maps ".js" specifiers to ".ts").
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outPath = join(root, 'schema', 'opencontext-vault-export.v1.schema.json');

async function loadTypes() {
  const dist = join(root, 'dist', 'types.js');
  if (existsSync(dist)) return import(pathToFileURL(dist).href);
  if (process.features.typescript === undefined || process.features.typescript === false) {
    throw new Error('dist/ is missing and this Node cannot load TypeScript directly: run `npm run build` first');
  }
  const srcUrl = pathToFileURL(join(root, 'src') + '/').href;
  const hook = `
    import { existsSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    export async function resolve(specifier, context, next) {
      if (specifier.endsWith('.js') && context.parentURL && context.parentURL.startsWith(${JSON.stringify(srcUrl)})) {
        const candidate = new URL(specifier, context.parentURL);
        const ts = candidate.href.replace(/\\.js$/, '.ts');
        if (existsSync(fileURLToPath(ts))) return next(ts, context);
      }
      return next(specifier, context);
    }`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);
  return import(pathToFileURL(join(root, 'src', 'types.ts')).href);
}

const { PortableExportV1 } = await loadTypes();
const schema = z.toJSONSchema(PortableExportV1);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(schema, null, 2)}\n`);
process.stderr.write(`wrote ${outPath}\n`);
