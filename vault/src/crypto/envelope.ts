import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { VaultError } from '../errors.js';
import { AAD_PREFIX, Envelope, type EnvelopeKind } from '../types.js';
import { b64, unb64 } from '../util/b64.js';
import { sha256Hex } from '../util/canonical-json.js';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Position of an envelope: journal gen/seq/prev chain for journal lines; "" / 0 / "" for standalone envelopes. */
export interface EnvelopePos {
  gen: string;
  seq: number;
  id: string;
  prev: string;
}

/** The exact AAD bytes. Documented in SPEC.md so a third party can decrypt a vault with only the key. Binding gen, seq and prev is what makes a journal line unmovable without the key. */
export function aad(vaultId: string, k: EnvelopeKind, gen: string, seq: number, id: string, prev: string): Buffer {
  return Buffer.from(`${AAD_PREFIX}\n${vaultId}\n${k}\n${gen}\n${seq}\n${id}\n${prev}`, 'utf8');
}

/**
 * AES-256-GCM sealer bound to one vault id. All encryption in the vault goes through this class so the
 * IV size, tag size and AAD layout cannot drift between journals, bodies, the manifest check and the key wrap.
 */
export class Sealer {
  private readonly key: Buffer;
  private readonly id: string;
  private destroyed = false;

  /** key: 32 bytes (copied; the caller should zero its own copy). The Sealer never logs or exposes the key; `destroy()` zero-fills it (best effort in a GC'd runtime). */
  constructor(key: Buffer, public readonly vaultId: string) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
      throw new VaultError('BAD_KEY', `data key must be ${KEY_BYTES} bytes`);
    }
    this.key = Buffer.from(key);
    this.id = sha256Hex(this.key).slice(0, 16);
  }

  private assertLive(): void {
    if (this.destroyed) throw new VaultError('IO', 'sealer has been destroyed');
  }

  /** Random 12-byte IV, AES-256-GCM, 16-byte tag. For non-journal envelopes pass gen "", seq 0, prev "". */
  seal(k: EnvelopeKind, plaintext: Uint8Array | string, pos: EnvelopePos): Envelope {
    this.assertLive();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(this.vaultId, k, pos.gen, pos.seq, pos.id, pos.prev));
    const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const ct = Buffer.concat([cipher.update(input), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { v: 1, k, seq: pos.seq, id: pos.id, prev: pos.prev, iv: b64(iv), ct: b64(ct), tag: b64(tag) };
  }

  /**
   * Throws VaultError('BAD_KEY') on auth failure (wrong key or tampered), 'CORRUPT' on malformed fields or when the
   * envelope's `k` is not the kind the reader expects. The AAD is rebuilt from `k` and `pos` (what the reader
   * expects), never from the envelope's own plaintext fields, so a body sealed as one kind can never be presented as
   * another even to a reader holding the key (SPEC.md B.4).
   */
  open(env: Envelope, k: EnvelopeKind, pos: EnvelopePos): Buffer {
    this.assertLive();
    const parsed = Envelope.safeParse(env);
    if (!parsed.success) throw new VaultError('CORRUPT', 'malformed envelope');
    if (parsed.data.k !== k) throw new VaultError('CORRUPT', `expected a "${k}" envelope, found "${parsed.data.k}"`);
    const iv = unb64(parsed.data.iv);
    const ct = unb64(parsed.data.ct);
    const tag = unb64(parsed.data.tag);
    if (iv.length !== IV_BYTES) throw new VaultError('CORRUPT', `envelope iv must be ${IV_BYTES} bytes`);
    if (tag.length !== TAG_BYTES) throw new VaultError('CORRUPT', `envelope tag must be ${TAG_BYTES} bytes`);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(this.vaultId, k, pos.gen, pos.seq, pos.id, pos.prev));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new VaultError('BAD_KEY', 'envelope failed authentication (wrong key or tampered data)');
    }
  }

  /** First 16 hex of sha256Hex(key); stored in manifest and key file so a mismatch is reported before any GCM failure. */
  get keyId(): string {
    return this.id;
  }

  /** Zero-fills the key copy; later seal/open calls throw. Best effort: V8 may hold other copies. */
  destroy(): void {
    this.key.fill(0);
    this.destroyed = true;
  }
}

/** Serialize an Envelope as one JSON line with keys in exactly this order: v,k,seq,id,prev,iv,ct,tag (byte-stable for prev-hash chains). */
export function envelopeToLine(env: Envelope): string {
  return JSON.stringify({
    v: env.v,
    k: env.k,
    seq: env.seq,
    id: env.id,
    prev: env.prev,
    iv: env.iv,
    ct: env.ct,
    tag: env.tag,
  });
}

/** Parse one journal/body line into a zod-validated Envelope; throws VaultError('CORRUPT') because a line that is not an envelope is on-disk damage, never user input. */
export function lineToEnvelope(line: string): Envelope {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new VaultError('CORRUPT', 'envelope line is not valid JSON');
  }
  const parsed = Envelope.safeParse(raw);
  if (!parsed.success) throw new VaultError('CORRUPT', 'envelope line has an invalid shape');
  return parsed.data;
}
