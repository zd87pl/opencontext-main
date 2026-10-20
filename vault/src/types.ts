import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const VAULT_FORMAT = 'opencontext-vault' as const;
export const VAULT_VERSION = 1 as const;
export const EXPORT_FORMAT = 'opencontext-vault-export' as const;
export const EXPORT_VERSION = 1 as const;
export const KEY_FORMAT = 'opencontext-vault-key' as const;
/** First line of every AAD string; bump with VAULT_VERSION. */
export const AAD_PREFIX = 'opencontext-vault/1' as const;
export const TOKEN_PREFIX = 'ocv_' as const;
export const TOKEN_HASH_DOMAIN = 'opencontext-vault-token/1|' as const;

/** Hard limits enforced server-side regardless of grant. */
export const LIMITS = {
  statement: 500,
  subject: 80,
  tags: 10,
  tagLength: 40,
  quote: 500,
  sourceRefs: 20,
  title: 300,
  note: 500,
  label: 40,
  auditArgsChars: 1024,
  searchLimit: 50,
  searchDefault: 10,
  standingLimit: 10,
  sourceListLimit: 100,
  sourceSearchLimit: 25,
  sourceReadCharsMin: 500,
  sourceReadCharsMax: 20_000,
  sourceReadCharsDefault: 8_000,
  forgetIds: 50,
  addSourceChars: 2_000_000,
  addSourceTurns: 2_000,
  profileChars: 12_000,
  bodyCache: 32,
} as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
/** RFC 3339 UTC with millisecond precision and trailing Z, e.g. 2026-10-20T10:00:00.000Z. Writers MUST emit this form. */
export const IsoDate = z.iso.datetime({ offset: true });
export const MemoryId = z.string().regex(/^mem_[0-9a-f]{16}$/);
export const SourceId = z.string().regex(/^src_[0-9a-f]{16}$/);
export const GrantId = z.string().regex(/^grt_[0-9a-f]{16}$/);
export const AuditId = z.string().regex(/^aud_[0-9a-f]{16}$/);
export const SessionId = z.string().regex(/^ses_[0-9a-f]{16}$/);
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export const Tag = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,39}$/);
export const Label = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

export const Scope = z.enum(['read', 'write', 'sources', 'forget', 'instruct']);
export type Scope = z.infer<typeof Scope>;
export const ALL_SCOPES: readonly Scope[] = Scope.options;

// ---------------------------------------------------------------------------
// Memories (structured, fixed schema)
// ---------------------------------------------------------------------------
export const MemoryKind = z.enum([
  'fact', // "User's name is Zed." / "Project opencontext uses Foundry."
  'preference', // "User prefers tabs over spaces in Go."
  'skill', // "User is fluent in Rust and Solidity."
  'goal', // "User wants to ship the vault by November."
  'relationship', // "Alice is user's co-founder."
  'event', // "User moved to Lisbon in March 2026."
  'instruction', // "Always answer in British English." — standing order; needs the `instruct` scope to write
]);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const Confidence = z.enum(['stated', 'inferred']);
export type Confidence = z.infer<typeof Confidence>;

export const SourceRef = z.strictObject({
  sourceId: SourceId,
  /** Turn index (Turn.i) within a conversation source. Absent for documents. */
  turn: z.number().int().nonnegative().optional(),
  /** Verbatim excerpt supporting the memory. */
  quote: z.string().min(1).max(LIMITS.quote).optional(),
  /** Set by the store, never by the caller: quote found verbatim in the cited turn/document (see normalizeForQuote). */
  verified: z.boolean(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const MemoryStatus = z.enum(['active', 'superseded']);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

export const Memory = z.strictObject({
  id: MemoryId,
  kind: MemoryKind,
  /** One sentence, third person ("User prefers …"), no newlines. */
  statement: z.string().min(1).max(LIMITS.statement).regex(/^[^\n\r]*$/),
  /** "user" (default) | a person's name | "project:<name>" | any short noun phrase. */
  subject: z.string().min(1).max(LIMITS.subject),
  tags: z.array(Tag).max(LIMITS.tags),
  /** stated = the user said it in so many words; inferred = an agent deduced it. */
  confidence: Confidence,
  validFrom: IsoDate.optional(),
  validUntil: IsoDate.optional(),
  /** Provenance. May be empty for things the user told the agent directly. */
  sources: z.array(SourceRef).max(LIMITS.sourceRefs),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  /** Grant label ("claude-desktop"), or "cli", or "import". */
  createdBy: z.string().min(1).max(LIMITS.subject),
  status: MemoryStatus,
  /** Previous version of this memory (set on the new record). */
  supersedes: MemoryId.optional(),
  /** Next version (set on the old record when superseded). */
  supersededBy: MemoryId.optional(),
});
export type Memory = z.infer<typeof Memory>;

// ---------------------------------------------------------------------------
// Sources (raw, verbatim)
// ---------------------------------------------------------------------------
export const TurnRole = z.enum(['user', 'assistant', 'system', 'tool']);
export type TurnRole = z.infer<typeof TurnRole>;

export const Turn = z.strictObject({
  /** Index within the source; stable; referenced by SourceRef.turn. */
  i: z.number().int().nonnegative(),
  role: TurnRole,
  /** Verbatim text; "" when the content was non-text. */
  text: z.string(),
  at: IsoDate.optional(),
  /** What could not be carried as text, e.g. ["image", "tool_use:dalle"]. */
  omitted: z.array(z.string()).optional(),
});
export type Turn = z.infer<typeof Turn>;

export const MediaType = z.enum(['text/markdown', 'text/plain']);

/** Plaintext of sources/<id>.enc. `raw` is the untouched vendor record (omitted with --no-raw). */
export const SourceContent = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('conversation'), turns: z.array(Turn), raw: z.unknown().optional() }),
  z.strictObject({ kind: z.literal('document'), mediaType: MediaType, text: z.string(), raw: z.unknown().optional() }),
]);
export type SourceContent = z.infer<typeof SourceContent>;

export const SourceType = z.enum(['chatgpt', 'claude', 'gemini', 'markdown', 'text', 'agent', 'vault']);
export type SourceType = z.infer<typeof SourceType>;

export const SourceTrust = z.enum(['imported', 'agent-supplied']);
export type SourceTrust = z.infer<typeof SourceTrust>;

export const ReviewStatus = z.enum(['unreviewed', 'reviewed', 'skipped']);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export const SourceMeta = z.strictObject({
  id: SourceId,
  type: SourceType,
  kind: z.enum(['conversation', 'document']),
  title: z.string().min(1).max(LIMITS.title),
  origin: z.strictObject({
    /** Importer name@version, e.g. "chatgpt@1", "document@1", "agent@1", "vault@1". */
    importer: z.string().min(1),
    /** File path as given at import, or the grant label for agent-supplied sources. Informational. */
    path: z.string(),
    /** Vendor conversation id / relative file path / agent-provided id. Drives the deterministic SourceId. */
    externalId: z.string().min(1),
    /** imported = came from a file the owner imported; agent-supplied = an MCP client wrote it. */
    trust: SourceTrust,
  }),
  tags: z.array(Tag).max(LIMITS.tags),
  /** Original timestamp when known, else importedAt. */
  createdAt: IsoDate,
  importedAt: IsoDate,
  /** sha256 of canonicalJson(content) — the dedupe key and the body-integrity check. */
  sha256: Sha256Hex,
  /** UTF-8 byte length of JSON.stringify(content). */
  bytes: z.number().int().nonnegative(),
  /** turns.length for conversations, 1 for documents. */
  turnCount: z.number().int().nonnegative(),
  hasRaw: z.boolean(),
  /** Importer notes, e.g. "3 messages on abandoned branches kept only in raw". */
  notes: z.array(z.string()),
  review: z.strictObject({
    status: ReviewStatus,
    at: IsoDate.optional(),
    by: z.string().optional(),
    memoriesCreated: z.number().int().nonnegative().optional(),
    note: z.string().max(LIMITS.note).optional(),
  }),
});
export type SourceMeta = z.infer<typeof SourceMeta>;

export const Source = SourceMeta.extend({ content: SourceContent });
export type Source = z.infer<typeof Source>;

// ---------------------------------------------------------------------------
// Grants (access control)
// ---------------------------------------------------------------------------
export const Grant = z.strictObject({
  id: GrantId,
  label: Label,
  /** sha256Hex(TOKEN_HASH_DOMAIN + token). The token itself is never stored. */
  tokenHash: Sha256Hex,
  scopes: z.array(Scope).min(1),
  /** If set: the client sees only records carrying ≥ 1 of these tags, and its writes are tagged with them. */
  tags: z.array(Tag).min(1).max(LIMITS.tags).optional(),
  createdAt: IsoDate,
  note: z.string().max(200).optional(),
});
export type Grant = z.infer<typeof Grant>;

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
export const ClientInfo = z.strictObject({
  name: z.string(),
  version: z.string(),
  title: z.string().optional(),
});
export type ClientInfo = z.infer<typeof ClientInfo>;

export const AuditEvent = z.enum(['session_start', 'session_end', 'tool', 'resource', 'prompt', 'cli']);
export type AuditEvent = z.infer<typeof AuditEvent>;
export const AuditOutcome = z.enum(['ok', 'denied', 'error']);
export type AuditOutcome = z.infer<typeof AuditOutcome>;

export const AuditEntry = z.strictObject({
  id: AuditId,
  at: IsoDate,
  pid: z.number().int(),
  /** One per server process / CLI invocation. */
  session: SessionId,
  /** null = unauthenticated caller (no or unknown token). */
  grant: z.strictObject({ id: GrantId, label: Label }).nullable(),
  /** Self-asserted by the client in the MCP initialize handshake. Informational only. */
  client: ClientInfo.nullable(),
  event: AuditEvent,
  /** Tool / resource URI / prompt name, or CLI command. */
  name: z.string(),
  /** Full arguments as JSON, truncated to LIMITS.auditArgsChars (suffix "…[truncated]"). Never tokens or keys. */
  args: z.unknown(),
  outcome: AuditOutcome,
  /** VaultErrorCode when outcome !== 'ok'. */
  error: z.string().optional(),
  ms: z.number().int().nonnegative(),
  result: z
    .strictObject({ count: z.number().int().optional(), ids: z.array(z.string()).max(50).optional() })
    .optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// ---------------------------------------------------------------------------
// Journal payloads (plaintext inside envelopes)
// ---------------------------------------------------------------------------
export const JournalOp = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('put'), record: z.unknown() }), // validated by the collection's schema
  z.strictObject({ op: z.literal('del'), id: z.string(), at: IsoDate }),
]);
export type JournalOp = z.infer<typeof JournalOp>;

export const JournalName = z.enum(['memories', 'sources', 'grants', 'audit']);
export type JournalName = z.infer<typeof JournalName>;

export const EnvelopeKind = z.enum(['memory', 'source-meta', 'source-body', 'grant', 'audit', 'check', 'wrap']);
export type EnvelopeKind = z.infer<typeof EnvelopeKind>;

/** One encrypted line (journals) or file (bodies, manifest check, key wrap). */
export const Envelope = z.strictObject({
  v: z.literal(1),
  k: EnvelopeKind,
  /** Sequence within (journal, gen); 1-based. 0 for non-journal envelopes. */
  seq: z.number().int().nonnegative(),
  /** Record id; "" for check/wrap. */
  id: z.string(),
  /** sha256Hex of the previous line's exact bytes; "genesis" for seq 1; "" for non-journal envelopes. */
  prev: z.string(),
  iv: z.string(), // base64 (standard, padded), 12 bytes
  ct: z.string(), // base64, ciphertext
  tag: z.string(), // base64, 16 bytes
});
export type Envelope = z.infer<typeof Envelope>;

export const JournalHeader = z.strictObject({
  journal: JournalName,
  v: z.literal(1),
  vaultId: z.string(),
  /** 16 hex chars; changes on every compaction. */
  gen: z.string().regex(/^[0-9a-f]{16}$/),
});
export type JournalHeader = z.infer<typeof JournalHeader>;

export const Manifest = z.strictObject({
  format: z.literal(VAULT_FORMAT),
  version: z.literal(VAULT_VERSION),
  vaultId: z.string().regex(/^[0-9a-f]{32}$/),
  createdAt: IsoDate,
  /** First 16 hex of sha256Hex(dataKey). Lets the CLI say "key does not match" before a GCM failure. */
  keyId: z.string().regex(/^[0-9a-f]{16}$/),
  /** Envelope (k:"check") of the UTF-8 string "ok" under the data key. */
  keyCheck: Envelope,
  /** Current gen of each journal; a journal whose header gen differs is treated as rolled back / corrupt. */
  gens: z.strictObject({
    memories: z.string(),
    sources: z.string(),
    grants: z.string(),
    audit: z.string(),
  }),
});
export type Manifest = z.infer<typeof Manifest>;

export const KeyFile = z.discriminatedUnion('kdf', [
  z.strictObject({
    format: z.literal(KEY_FORMAT),
    version: z.literal(1),
    vaultId: z.string(),
    keyId: z.string(),
    kdf: z.literal('none'),
    key: z.string(), // base64, 32 bytes
  }),
  z.strictObject({
    format: z.literal(KEY_FORMAT),
    version: z.literal(1),
    vaultId: z.string(),
    keyId: z.string(),
    kdf: z.literal('scrypt'),
    salt: z.string(), // base64, 16 bytes
    N: z.number().int(),
    r: z.number().int(),
    p: z.number().int(),
    /** Envelope (k:"wrap") of the 32-byte data key under the scrypt-derived KEK. */
    wrapped: Envelope,
  }),
]);
export type KeyFile = z.infer<typeof KeyFile>;

// ---------------------------------------------------------------------------
// Portable export (SPEC.md)
// ---------------------------------------------------------------------------
export const PortableExportV1 = z.strictObject({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  exportedAt: IsoDate,
  vaultId: z.string(),
  /** "@opencontext/vault 0.1.0" */
  generator: z.string(),
  memories: z.array(Memory), // all statuses
  sources: z.array(Source), // full bodies incl. raw
});
export type PortableExportV1 = z.infer<typeof PortableExportV1>;

// ---------------------------------------------------------------------------
// Cross-module runtime types
// ---------------------------------------------------------------------------
/** What VaultStore.refresh() applied since the last call. */
export interface ChangeSet {
  memoriesPut: Memory[];
  memoriesDeleted: string[];
  sourcesPut: SourceMeta[];
  sourcesDeleted: string[];
  grantsChanged: boolean;
  /** A full reload happened (compaction/rekey elsewhere); indexes must rebuild. */
  reloaded: boolean;
}

export interface MemoryFilter {
  kind?: MemoryKind;
  tags?: string[]; // any-of
  subject?: string; // exact, case-insensitive
  createdBy?: string;
  status?: MemoryStatus | 'all'; // default 'active'
  since?: string; // updatedAt >= since
}

export interface SourceFilter {
  type?: SourceType;
  tags?: string[]; // any-of
  review?: ReviewStatus | 'all'; // default 'all'
  since?: string; // createdAt >= since
}

export interface VaultStats {
  memories: number;
  activeMemories: number;
  sources: number;
  unreviewedSources: number;
  sourceBytes: number;
  grants: number;
  auditEntries: number;
  diskBytes: number;
}

export type Caller =
  | { kind: 'granted'; grant: Grant }
  | { kind: 'anonymous'; reason: 'no-token' | 'unknown-token' };

/** A memory as returned by vault_search / vault://profile. */
export interface MemoryHit extends Omit<Memory, 'sources'> {
  score: number;
  provenance: Array<{
    sourceId: string;
    /** null when the source was forgotten. */
    title: string | null;
    trust: SourceTrust | null;
    turn?: number;
    quote?: string;
    verified: boolean;
    /** true when the citing grant also authored the source (agent-supplied). */
    selfAttested: boolean;
  }>;
}
