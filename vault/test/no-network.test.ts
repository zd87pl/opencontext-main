import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIST = join(import.meta.dirname, '..', 'dist');

/** Substrings that must not appear anywhere in what ships: the vault has no network code and makes no LLM calls. */
const BANNED = ['node:http', 'node:https', 'node:net', 'node:dns', 'node:tls', 'fetch(', 'WebSocket'];
/** The only SDK modules the server may use (stdio transport + McpServer); tests may import more, dist may not. */
const ALLOWED_SDK = new Set(['@modelcontextprotocol/sdk/server/mcp.js', '@modelcontextprotocol/sdk/server/stdio.js']);

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

// dist/ is always present under `npm test` (pretest builds); a bare `npx vitest run` without a build skips, never fails.
describe.skipIf(!existsSync(join(DIST, 'cli.js')))('no network code ships in dist/', () => {
  const files = existsSync(DIST) ? jsFiles(DIST) : [];

  it('has the built CLI and library', () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith(`${join('dist', 'index.js')}`))).toBe(true);
  });

  it('contains none of the banned modules or globals', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const banned of BANNED) expect(text, `${relative(DIST, file)} contains ${banned}`).not.toContain(banned);
    }
  });

  it('imports from the MCP SDK only server/mcp.js and server/stdio.js', () => {
    const seen = new Set<string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](@modelcontextprotocol\/sdk[^'"]*)['"]/g)) seen.add(m[1] ?? '');
    }
    expect([...seen].sort()).toEqual([...ALLOWED_SDK].sort());
  });

  it('spawns no child process outside the passphrase command', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('child_process')) expect(relative(DIST, file)).toBe(join('crypto', 'keyfile.js'));
    }
  });
});
