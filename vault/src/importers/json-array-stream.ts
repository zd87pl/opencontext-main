import { open } from 'node:fs/promises';
import { VaultError } from '../errors.js';

const CHUNK = 1 << 20;
const BOM = [0xef, 0xbb, 0xbf] as const;

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}

type State = 'start' | 'between' | 'element' | 'done';

/**
 * Streams the elements of a top-level JSON array from a file with bounded memory: a byte scanner tracks
 * string/escape state and bracket depth, so only the current element is ever held, and each complete element
 * is handed to JSON.parse. Handles a UTF-8 BOM and leading whitespace. Throws VaultError('INVALID_ARGUMENT')
 * if the file is not a top-level array (or an element is not valid JSON), VaultError('IO') when it cannot be read.
 * Exists because a ChatGPT export can be hundreds of MB and must never have to fit in RAM at once.
 */
export async function* iterateJsonArray(path: string): AsyncGenerator<unknown> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    throw new VaultError('IO', `cannot open ${path}: ${(err as Error).message}`);
  }
  const buf = Buffer.allocUnsafe(CHUNK);
  let state: State = 'start';
  let bomPos = 0; // how many BOM bytes matched so far at file start
  let filePos = 0; // absolute offset of buf[0]
  let inString = false;
  let escape = false;
  let depth = 0;
  let scalar = false;
  let elementStart = 0; // index in buf where the pending element began (0 when carried over)
  let carried: Buffer[] = []; // earlier chunks of the pending element
  let index = 0;

  const bad = (msg: string, at: number): VaultError => new VaultError('INVALID_ARGUMENT', `${path}: ${msg} (byte ${at})`);

  const finish = (endExclusive: number, startedAt: number): unknown => {
    const tail = buf.subarray(elementStart, endExclusive);
    const bytes = carried.length === 0 ? tail : Buffer.concat([...carried, tail]);
    carried = [];
    const text = bytes.toString('utf8');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw bad(`element ${index} is not valid JSON`, startedAt);
    }
  };

  try {
    for (;;) {
      let n: number;
      try {
        n = (await fh.read(buf, 0, CHUNK, null)).bytesRead;
      } catch (err) {
        throw new VaultError('IO', `cannot read ${path}: ${(err as Error).message}`);
      }
      if (n === 0) break;
      let i = 0;
      let elementAbs = 0;
      while (i < n) {
        const c = buf[i] as number;
        if (state === 'start') {
          if (bomPos < 3 && c === BOM[bomPos] && filePos + i === bomPos) {
            bomPos += 1;
            i += 1;
            continue;
          }
          bomPos = 3;
          if (isWs(c)) {
            i += 1;
            continue;
          }
          if (c !== 0x5b /* [ */) throw bad('not a top-level JSON array', filePos + i);
          state = 'between';
          i += 1;
          continue;
        }
        if (state === 'between') {
          if (isWs(c) || c === 0x2c /* , */) {
            i += 1;
            continue;
          }
          if (c === 0x5d /* ] */) {
            state = 'done';
            i += 1;
            continue;
          }
          state = 'element';
          elementStart = i;
          elementAbs = filePos + i;
          inString = false;
          escape = false;
          depth = 0;
          scalar = false;
          if (c === 0x22 /* " */) {
            inString = true;
          } else if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
            depth = 1;
          } else {
            scalar = true;
          }
          i += 1;
          continue;
        }
        if (state === 'element') {
          if (inString) {
            if (escape) escape = false;
            else if (c === 0x5c /* \ */) escape = true;
            else if (c === 0x22 /* " */) {
              inString = false;
              if (depth === 0) {
                const value = finish(i + 1, elementAbs);
                index += 1;
                state = 'between';
                i += 1;
                yield value;
                continue;
              }
            }
            i += 1;
            continue;
          }
          if (scalar) {
            if (isWs(c) || c === 0x2c || c === 0x5d) {
              const value = finish(i, elementAbs);
              index += 1;
              state = 'between';
              yield value; // the terminator is re-read in the 'between' state
              continue;
            }
            i += 1;
            continue;
          }
          if (c === 0x22) inString = true;
          else if (c === 0x7b || c === 0x5b) depth += 1;
          else if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
            depth -= 1;
            if (depth === 0) {
              const value = finish(i + 1, elementAbs);
              index += 1;
              state = 'between';
              i += 1;
              yield value;
              continue;
            }
          }
          i += 1;
          continue;
        }
        // done: anything after the closing bracket is ignored
        i = n;
      }
      if (state === 'element') {
        carried.push(Buffer.from(buf.subarray(elementStart, n)));
        elementStart = 0;
      }
      if (state === 'done') break;
      filePos += n;
    }
  } finally {
    await fh.close();
  }
  if (state === 'start') throw bad('not a top-level JSON array', filePos);
  if (state !== 'done') throw bad('unterminated JSON array', filePos);
}
