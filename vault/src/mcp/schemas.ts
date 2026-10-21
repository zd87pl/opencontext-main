import { z } from 'zod';
import {
  ClientInfo,
  Confidence,
  IsoDate,
  LIMITS,
  Label,
  Memory,
  MemoryId,
  MemoryKind,
  ReviewStatus,
  Scope,
  SourceId,
  SourceMeta,
  SourceTrust,
  SourceType,
  Tag,
  Turn,
  TurnRole,
} from '../types.js';

/*
 * Raw zod shapes (not z.object instances) for every tool input and output, exactly as §5.2 lists them. They are
 * raw shapes because McpServer.registerTool wants shapes; they live in one file so the README/test can enumerate
 * the surface and so tools.ts stays about behaviour. Tags come in loose (TagsIn) and are normalized by the handler.
 */

/** Free-form tag strings; the handler lowercases/validates them with normalizeTags so a model's "Coding" still works. */
export const TagsIn = z.array(z.string().min(1).max(LIMITS.tagLength)).max(LIMITS.tags);

/** One provenance line of a hit: the source may be forgotten (title/trust null) and the citing grant may have authored it (selfAttested). */
export const ProvenanceOut = z.strictObject({
  sourceId: z.string(),
  title: z.string().nullable(),
  trust: SourceTrust.nullable(),
  turn: z.number().int().optional(),
  quote: z.string().optional(),
  verified: z.boolean(),
  selfAttested: z.boolean(),
});

/** A memory as returned by vault_search: the raw SourceRefs are replaced by resolved provenance. */
export const MemoryHitOut = Memory.omit({ sources: true }).extend({ score: z.number(), provenance: z.array(ProvenanceOut) });

/** vault_status takes no arguments; the empty shape still yields a proper `{type:"object"}` input schema for hosts. */
export const VaultStatusInput = {};
/** vault_status: anonymous callers get only authorized/version/client/howToGrant, so nothing about the vault leaks before a grant exists. */
export const VaultStatusOutput = {
  authorized: z.boolean(),
  version: z.string(),
  client: ClientInfo.nullable(),
  grant: z.strictObject({ label: Label, scopes: z.array(Scope), tags: z.array(Tag).optional() }).optional(),
  counts: z.strictObject({ memories: z.number().int(), sources: z.number().int(), unreviewedSources: z.number().int() }).optional(),
  sourceIndexReady: z.boolean().optional(),
  howToGrant: z.string().optional(),
};

/** vault_search: an empty query lists recent memories; filters narrow `memories` only, never `standing`. */
export const VaultSearchInput = {
  query: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(LIMITS.searchLimit).default(LIMITS.searchDefault),
  kind: MemoryKind.optional(),
  tags: TagsIn.optional(),
  subject: z.string().max(LIMITS.subject).optional(),
  includeSuperseded: z.boolean().default(false),
  since: IsoDate.optional(),
};
/** vault_search: `standing` (active instructions) is always returned so one call gives a model both facts and standing orders. */
export const VaultSearchOutput = {
  mode: z.enum(['search', 'recent']),
  total: z.number().int(),
  standing: z.array(MemoryHitOut),
  memories: z.array(MemoryHitOut),
  notice: z.string(),
};

/** vault_remember: quotes are capped so provenance stays an excerpt, not a copy of the source. */
export const VaultRememberInput = {
  statement: z.string().min(1).max(LIMITS.statement),
  kind: MemoryKind,
  subject: z.string().min(1).max(LIMITS.subject).default('user'),
  tags: TagsIn.default([]),
  confidence: Confidence,
  validFrom: IsoDate.optional(),
  validUntil: IsoDate.optional(),
  sources: z
    .array(
      z.strictObject({
        sourceId: SourceId,
        turn: z.number().int().nonnegative().optional(),
        quote: z.string().min(1).max(LIMITS.quote).optional(),
      }),
    )
    .max(LIMITS.sourceRefs)
    .default([]),
  supersedes: MemoryId.optional(),
};
/** vault_remember: the stored record plus what the vault could not confirm (unverified quotes, self-attested sources). */
export const VaultRememberOutput = {
  memory: Memory,
  deduplicated: z.boolean(),
  supersededId: MemoryId.optional(),
  unverifiedQuotes: z.number().int(),
  selfAttestedSources: z.number().int(),
  warnings: z.array(z.string()),
};

/** vault_forget: both memory and source ids, bounded so one call cannot wipe a vault silently. */
export const VaultForgetInput = {
  ids: z.array(z.string().regex(/^(mem|src)_[0-9a-f]{16}$/)).min(1).max(LIMITS.forgetIds),
  reason: z.string().max(200).optional(),
};
/** vault_forget: invisible ids are reported as notFound rather than denied, so a tag-restricted grant learns nothing about them. */
export const VaultForgetOutput = {
  forgotten: z.array(z.string()),
  notFound: z.array(z.string()),
};

/** vault_source_list: offset paging over metadata (bodies are never listed). */
export const VaultSourceListInput = {
  limit: z.number().int().min(1).max(LIMITS.sourceListLimit).default(20),
  offset: z.number().int().nonnegative().default(0),
  type: SourceType.optional(),
  tags: TagsIn.optional(),
  review: ReviewStatus.optional(),
  since: IsoDate.optional(),
};
/** vault_source_list: nextOffset is present only when more pages exist. */
export const VaultSourceListOutput = {
  sources: z.array(SourceMeta),
  total: z.number().int(),
  nextOffset: z.number().int().optional(),
};

/** vault_source_search: full-text over bodies, few hits by default because each carries a snippet. */
export const VaultSourceSearchInput = {
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(LIMITS.sourceSearchLimit).default(5),
  type: SourceType.optional(),
};
/** vault_source_search: indexReady tells the model whether the background index is complete. */
export const VaultSourceSearchOutput = {
  indexReady: z.boolean(),
  hits: z.array(
    z.strictObject({
      sourceId: SourceId,
      title: z.string(),
      type: SourceType,
      trust: SourceTrust,
      createdAt: IsoDate,
      turnCount: z.number().int(),
      score: z.number(),
      snippet: z.string(),
      turn: z.number().int().optional(),
    }),
  ),
};

/** vault_source_read: paging bounds keep one read within a model-friendly size; maxChars has a floor so paging always progresses. */
export const VaultSourceReadInput = {
  id: SourceId,
  fromTurn: z.number().int().nonnegative().default(0),
  fromOffset: z.number().int().nonnegative().default(0),
  maxChars: z.number().int().min(LIMITS.sourceReadCharsMin).max(LIMITS.sourceReadCharsMax).default(LIMITS.sourceReadCharsDefault),
};
/** vault_source_read: turns for conversations, text for documents; `raw` vendor records are never part of it. */
export const VaultSourceReadOutput = {
  notice: z.string(),
  source: SourceMeta,
  turns: z.array(Turn).optional(),
  text: z.string().optional(),
  nextTurn: z.number().int().optional(),
  nextOffset: z.number().int().optional(),
  done: z.boolean(),
};

/** vault_source_add: verbatim turns or a document; the size caps stop an agent from filling the vault. */
export const VaultSourceAddInput = {
  title: z.string().min(1).max(LIMITS.title),
  kind: z.enum(['conversation', 'document']).default('conversation'),
  turns: z
    .array(z.strictObject({ role: TurnRole, text: z.string().max(LIMITS.addSourceChars), at: IsoDate.optional() }))
    .max(LIMITS.addSourceTurns)
    .optional(),
  text: z.string().max(LIMITS.addSourceChars).optional(),
  externalId: z.string().max(200).optional(),
  tags: TagsIn.default([]),
};
/** vault_source_add: identical content is deduplicated by deterministic id. */
export const VaultSourceAddOutput = {
  source: SourceMeta,
  deduplicated: z.boolean(),
};

/** vault_source_review: closes the distill loop so the source stops showing as unreviewed. */
export const VaultSourceReviewInput = {
  id: SourceId,
  status: ReviewStatus.default('reviewed'),
  memoriesCreated: z.number().int().nonnegative().optional(),
  note: z.string().max(LIMITS.note).optional(),
};
/** vault_source_review: the updated metadata. */
export const VaultSourceReviewOutput = {
  source: SourceMeta,
};

/** Prompt arguments are strings over MCP, so numeric options arrive as text and are parsed by the prompt. */
export const DistillArgs = { sourceId: z.string().optional(), maxMemories: z.string().optional() };
export const CaptureArgs = { title: z.string().optional() };
