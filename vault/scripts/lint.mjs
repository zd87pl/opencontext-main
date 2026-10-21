#!/usr/bin/env node
// Style gate for src/** (spec §7), run by `npm run lint` after the strict typecheck. It fails on:
//   (a) console.log / console.info / console.debug calls outside src/cli/io.ts (stdout is the MCP protocol in `serve`);
//   (b) imports of node:http, node:https, node:net, node:dns, node:tls, express, hono, or the SDK's SSE / streamable
//       HTTP transports anywhere in src/** (the vault has no network code; test/no-network.test.ts checks dist/);
//   (c) `: any`, `as any` and `@ts-ignore` in src/**;
//   (d) a src/** file importing from the repository's sdk/, gateway/ or backend/ trees (the vault is standalone).
// Comment-only lines are skipped so prose mentioning these names does not trip the gate. No dependencies on purpose.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, 'src');
const CONSOLE_ALLOWED = 'src/cli/io.ts';
const BANNED_IMPORTS = new Set([
  'node:http',
  'node:https',
  'node:net',
  'node:dns',
  'node:tls',
  'http',
  'https',
  'net',
  'dns',
  'tls',
  'express',
  'hono',
  '@modelcontextprotocol/sdk/server/sse.js',
  '@modelcontextprotocol/sdk/server/streamableHttp.js',
]);
const FOREIGN_TREE = /(^|\/)(sdk|gateway|backend)(\/|$)/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

const problems = [];
for (const file of walk(srcDir)) {
  const rel = relative(root, file).split(sep).join('/');
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    const where = `${rel}:${i + 1}`;
    const consoleCall = /\bconsole\.(log|info|debug)\(/.exec(line);
    if (consoleCall && rel !== CONSOLE_ALLOWED) problems.push(`${where}: console.${consoleCall[1]}( outside ${CONSOLE_ALLOWED}`);
    for (const m of line.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (BANNED_IMPORTS.has(spec)) problems.push(`${where}: banned import "${spec}" (no network code in the vault)`);
      if (spec.startsWith('.') && FOREIGN_TREE.test(spec)) problems.push(`${where}: import from the repository tree "${spec}" (the vault is standalone)`);
    }
    if (/:\s*any\b/.test(line) || /\bas any\b/.test(line)) problems.push(`${where}: "any" is not allowed`);
    if (line.includes('@ts-ignore')) problems.push(`${where}: @ts-ignore is not allowed`);
  });
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\nlint: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n`);
  process.exit(1);
}
process.stderr.write('lint: ok\n');
