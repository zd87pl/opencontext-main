import { readSync } from 'node:fs';
import { VaultError } from '../errors.js';

const STDIN_FD = 0;

/** Decode the collected bytes, dropping the last code point (a backspace in a masked prompt). */
function dropLastChar(bytes: number[]): number[] {
  const text = Buffer.from(bytes).toString('utf8');
  const chars = [...text];
  chars.pop();
  return [...Buffer.from(chars.join(''), 'utf8')];
}

/**
 * Synchronous line prompt on the controlling terminal. The question goes to stderr so a prompt never pollutes stdout
 * (which may be piped or, for `serve`, is the protocol). Masked mode switches stdin to raw mode so a passphrase is
 * neither echoed nor left in the terminal's scrollback; Ctrl-C and Ctrl-D cancel with a VaultError so the CLI exits 2
 * with a clear message instead of a stack trace. Synchronous on purpose: the store is synchronous and a prompt is the
 * only thing the CLI does at that moment.
 */
export function promptSync(question: string, masked: boolean): string {
  process.stderr.write(question);
  const stdin = process.stdin;
  const rawCapable = masked && stdin.isTTY && typeof stdin.setRawMode === 'function';
  if (rawCapable) stdin.setRawMode(true);
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  try {
    for (;;) {
      let n: number;
      try {
        n = readSync(STDIN_FD, one, 0, 1, null);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EAGAIN') continue;
        if (code === 'EOF') break;
        throw new VaultError('IO', `cannot read from the terminal: ${(err as Error).message}`);
      }
      if (n === 0) break;
      const b = one[0] ?? 0;
      if (b === 0x0a || b === 0x0d) break;
      if (rawCapable) {
        if (b === 0x03 || b === 0x04) throw new VaultError('INVALID_ARGUMENT', 'cancelled');
        if (b === 0x7f || b === 0x08) {
          bytes.splice(0, bytes.length, ...dropLastChar(bytes));
          continue;
        }
      }
      bytes.push(b);
    }
  } finally {
    if (rawCapable) stdin.setRawMode(false);
    process.stderr.write('\n');
  }
  return Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
}
