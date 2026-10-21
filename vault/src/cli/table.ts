/** Column widths are code-point counts: good enough for ids, labels and dates; East Asian width is not modelled (§11). */
function width(s: string): number {
  return [...s].length;
}

/** Cut a cell to `max` code points with a trailing ellipsis, so one long statement never pushes the other columns off screen. */
export function truncate(s: string, max: number): string {
  const chars = [...s.replace(/[\r\n\t]+/g, ' ')];
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/**
 * Fixed-width text table: header, a dashed rule, one line per row, columns separated by two spaces and padded to the
 * widest cell. Kept dependency-free and dumb on purpose; `--json` exists for anything a script needs to parse. Cells
 * are truncated with `maxWidths` (by column index) before padding. Returns the text with a trailing newline.
 */
export function renderTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>, maxWidths?: Readonly<Record<number, number>>): string {
  const cells = rows.map((r) => headers.map((_, i) => {
    const raw = r[i] ?? '';
    const max = maxWidths?.[i];
    return max === undefined ? raw.replace(/[\r\n\t]+/g, ' ') : truncate(raw, max);
  }));
  const widths = headers.map((h, i) => Math.max(width(h), ...cells.map((r) => width(r[i] ?? ''))));
  const line = (r: readonly string[]): string =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat((widths[i] ?? 0) - width(c))))
      .join('  ')
      .replace(/\s+$/, '');
  const out = [line(headers), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)];
  return `${out.join('\n')}\n`;
}

/** Two-column "key  value" block for status-style output; keys are padded to the longest so values line up. */
export function renderPairs(pairs: ReadonlyArray<readonly [string, string]>): string {
  const w = Math.max(0, ...pairs.map(([k]) => width(k)));
  return pairs.map(([k, v]) => `${k}${' '.repeat(w - width(k))}  ${v}`).join('\n') + (pairs.length > 0 ? '\n' : '');
}
