const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decode the entities Gemini's exported HTML uses; unknown names are left as-is because guessing would corrupt verbatim text. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED[body.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Minimal HTML → text for Gemini Takeout responses: <br>, </p>, </div>, </li>, </h1-6>, </tr> → "\n"; <li> → "- ";
 * every other tag stripped; entities decoded; 3+ newlines collapsed to 2. No DOM and no eval, because the input is
 * untrusted vendor markup and the only goal is readable, searchable text that keeps the original words.
 */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // pre/blockquote are not in the spec's list but Gemini wraps code in <pre>; without a break the code glues to the next paragraph.
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|pre|blockquote)\s*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '- ');
  s = s.replace(/<\/(td|th)\s*>/gi, ' ');
  s = s.replace(/<[a-zA-Z/!][^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
