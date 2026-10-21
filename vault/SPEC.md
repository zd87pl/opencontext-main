# OpenContext Vault — format specification (format 1)

**Package** `@opencontext/vault` 0.1.0 · **Status:** normative for format version 1 · **Audience:** anyone who wants to read a vault export or decrypt a vault directory without this package, in any language.

This document specifies two things:

- **Part A — the portable export** (`opencontext-vault-export` version 1): a plaintext JSON file with every memory and every source, readable with any JSON parser. A JSON Schema is checked in at `schema/opencontext-vault-export.v1.schema.json`.
- **Part B — the vault directory** (`opencontext-vault` version 1): the encrypted on-disk layout — manifest, key file, envelopes, authenticated data, journals, source bodies — with test vectors, so that a third party holding only the key file can decrypt everything.

`test/schema.test.ts` asserts that the checked-in schema equals the one generated from the code, that the example in A.5 validates and is identical to `test/fixtures/portable/export.json`, and that every vector in B.12 matches `test/vectors/envelope-vectors.json`. `test/roundtrip.test.ts` proves the round-trip rule in A.6.

Vocabulary used below:

| Term | Meaning |
|---|---|
| **IsoDate** | RFC 3339 UTC with millisecond precision and a trailing `Z`, e.g. `2026-10-20T10:00:00.000Z`. Writers MUST emit exactly this form; readers SHOULD accept any RFC 3339 offset form. |
| **hex** | lowercase hexadecimal. |
| **base64** | standard alphabet (`A–Z a–z 0–9 + /`) with `=` padding — what `Buffer.toString('base64')` emits. No URL-safe variant anywhere on disk. |
| **sha256Hex(x)** | lowercase hex SHA-256 of the UTF-8 bytes of `x`. |
| **canonicalJson(v)** | deterministic JSON used for hashing: object keys sorted by Unicode code point, no whitespace, arrays in order, properties whose value is `undefined` omitted. **Numbers**: parse as an IEEE-754 double first (integers beyond 2^53 lose precision: `12345678901234567890` → `12345678901234567000`), then format as ECMA-262 `Number::toString(10)`: the shortest digit string that round-trips; plain decimal when 10^-6 ≤ \|x\| < 10^21 with no trailing `.0` (`1.0` → `1`, `0.000001` stays); otherwise `d.ddde±N` with no leading zeros in the exponent (`1e21` → `1e+21`, `1e-7` → `1e-7`, never `1e-07`); `-0` → `0`; NaN/Infinity → `null`. **Strings**: escape only `"`, `\\`, U+0000–U+001F (`\b \t \n \f \r`, otherwise lowercase `\u00xx`) and lone surrogates (lowercase `\udxxx`); everything else, including U+007F, U+2028/2029 and all non-ASCII, is raw UTF-8. A stdlib serializer differs on exactly these points (Python's `json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)` writes `1e-07` and cannot encode a lone surrogate); `test/vectors/canonical-json-vectors.json` (B.12 V7) lets a port check itself and `examples/decrypt_vault.py` carries a working port. Used for `SourceMeta.sha256` only; the export file is pretty-printed, not canonical. |
| **ids** | `mem_`, `src_`, `grt_`, `aud_`, `ses_` + 16 hex chars. Imported sources get a deterministic id: `src_` + first 16 hex of `sha256(importer + "\0" + externalId)`. |

---

## Part A — Portable export: `opencontext-vault-export` version 1

### A.1 File encoding

- UTF-8, **no BOM**, Unix newlines.
- The file is exactly `JSON.stringify(object, null, 2) + "\n"`: two-space indentation, one trailing newline.
- Object keys appear in **schema order** (the order of the tables below). Optional keys are **omitted** when absent, never written as `null`.
- The reference writer streams the file one record at a time and is byte-identical to the in-memory `JSON.stringify` form (`test/exporters.test.ts` checks this). Readers MUST NOT rely on key order, indentation or record order; they MUST treat the file as JSON.
- Memories and sources are written oldest first (`createdAt` ascending, ties broken by `id`) so two exports of the same data are byte-identical.

### A.2 Top-level object

| Key | Type | Notes |
|---|---|---|
| `format` | `"opencontext-vault-export"` | constant |
| `version` | `1` | integer; see A.7 |
| `exportedAt` | IsoDate | when the file was written |
| `vaultId` | string (32 hex) | id of the vault that wrote it; informational — a reader never needs it |
| `generator` | string | e.g. `"@opencontext/vault 0.1.0"` |
| `memories` | `Memory[]` | **all** memories, active and superseded |
| `sources` | `Source[]` | **all** sources with full bodies, including `raw` unless the export was made with `--no-raw` |

An export **never** contains grants, tokens, token hashes, key material, passphrases or audit entries.

### A.3 `Memory`

| Key | Type | Constraints / meaning |
|---|---|---|
| `id` | string | `mem_` + 16 hex |
| `kind` | enum | `fact` · `preference` · `skill` · `goal` · `relationship` · `event` · `instruction` |
| `statement` | string | 1–500 chars, no `\n`/`\r`; one sentence, third person (“User prefers …”) |
| `subject` | string | 1–80 chars; `"user"`, a person's name, `"project:<name>"`, or a short noun phrase |
| `tags` | string[] | ≤ 10, each matching `^[a-z0-9][a-z0-9_.:-]{0,39}$` |
| `confidence` | enum | `stated` (the user said it in so many words) · `inferred` (an agent deduced it) |
| `validFrom`, `validUntil` | IsoDate | optional |
| `sources` | `SourceRef[]` | ≤ 20; provenance, may be empty |
| `createdAt`, `updatedAt` | IsoDate | |
| `createdBy` | string | grant label (`"claude-desktop"`), `"cli"` or `"import"` |
| `status` | enum | `active` · `superseded` |
| `supersedes` | memory id | optional; set on the newer record |
| `supersededBy` | memory id | optional; set on the older record |

`SourceRef`: `{ sourceId: src_…, turn?: integer ≥ 0, quote?: string (1–500), verified: boolean }`. `turn` is `Turn.i` inside a conversation source and is absent for documents. `verified` is **computed by the vault** on every write: `normalizeForQuote(quote)` is a substring of `normalizeForQuote(cited text)`, where `normalizeForQuote` = NFKC → collapse whitespace runs to one space → trim (case preserved). A reader may trust it as the exporting vault's verdict; an importing vault recomputes it.

### A.4 `Source`

A `Source` is a `SourceMeta` plus a `content` key.

| Key | Type | Constraints / meaning |
|---|---|---|
| `id` | string | `src_` + 16 hex |
| `type` | enum | `chatgpt` · `claude` · `gemini` · `markdown` · `text` · `agent` · `vault` |
| `kind` | enum | `conversation` · `document` |
| `title` | string | 1–300 chars |
| `origin.importer` | string | `"chatgpt@1"`, `"claude@1"`, `"claude-projects@1"`, `"gemini@1"`, `"document@1"`, `"agent@1"`, `"vault@1"` — name@version of what produced the record |
| `origin.path` | string | file path as given at import, or the grant label for agent-supplied sources; informational |
| `origin.externalId` | string | vendor conversation id / path relative to the import root / agent-provided id; with `importer`, drives the deterministic id |
| `origin.trust` | enum | `imported` (came from a file the owner imported) · `agent-supplied` (an MCP client wrote it; the vault cannot verify it) |
| `tags` | string[] | as for memories |
| `createdAt` | IsoDate | original timestamp when known, else `importedAt` |
| `updatedAt` | IsoDate | optional; the vendor's last-update time when the export carries one (ChatGPT `update_time`, Claude `updated_at`). A re-import whose record is older than the stored `updatedAt` is skipped, so an old export never rolls a conversation back |
| `importedAt` | IsoDate | |
| `sha256` | string (64 hex) | `sha256Hex(canonicalJson(content))` — the dedupe key and the body-integrity check |
| `bytes` | integer | UTF-8 byte length of `JSON.stringify(content)` |
| `turnCount` | integer | `turns.length` for conversations, `1` for documents |
| `hasRaw` | boolean | `content.raw !== undefined` |
| `notes` | string[] | importer notes, e.g. `"2 messages on abandoned branches kept only in raw"` |
| `review` | object | `{ status: unreviewed\|reviewed\|skipped, at?, by?, memoriesCreated?, note? }` |
| `content` | `SourceContent` | the body |

`SourceContent` is a discriminated union on `kind`:

- `{ "kind": "conversation", "turns": Turn[], "raw"?: any }`
- `{ "kind": "document", "mediaType": "text/markdown" | "text/plain", "text": string, "raw"?: any }`

`Turn`: `{ i: integer ≥ 0 (index, stable, cited by SourceRef.turn), role: user|assistant|system|tool, text: string ("" when the content was non-text), at?: IsoDate, omitted?: string[] }`. `omitted` names what could not be carried as text, e.g. `["image", "tool_use:dalle.text2im"]`.

`raw` is the **untouched vendor record** (the ChatGPT mapping tree with every branch, the Claude message array with its attachments, the group of Gemini Takeout activity records, …). It is arbitrary JSON and is the only place lossless vendor data survives: for ChatGPT, messages on abandoned branches exist **only** in `raw`.

### A.5 Example

One memory citing one ChatGPT conversation. This is `test/fixtures/portable/export.json`, byte for byte:

<!-- example:begin -->
```json
{
  "format": "opencontext-vault-export",
  "version": 1,
  "exportedAt": "2026-10-20T12:34:56.000Z",
  "vaultId": "b2b0a3f1c4d5e6f7a8b9c0d1e2f3a4b5",
  "generator": "@opencontext/vault 0.1.0",
  "memories": [
    {
      "id": "mem_3f9a1c77e02b4d10",
      "kind": "preference",
      "statement": "User prefers tabs over spaces in Go.",
      "subject": "user",
      "tags": [
        "coding",
        "go"
      ],
      "confidence": "stated",
      "sources": [
        {
          "sourceId": "src_7d2e0b1a9c3f4e55",
          "turn": 3,
          "quote": "I always use tabs in Go, fight me",
          "verified": true
        }
      ],
      "createdAt": "2026-10-20T11:00:00.000Z",
      "updatedAt": "2026-10-20T11:00:00.000Z",
      "createdBy": "claude-desktop",
      "status": "active"
    }
  ],
  "sources": [
    {
      "id": "src_7d2e0b1a9c3f4e55",
      "type": "chatgpt",
      "kind": "conversation",
      "title": "Go formatting",
      "origin": {
        "importer": "chatgpt@1",
        "path": "/Users/zed/Downloads/chatgpt/conversations.json",
        "externalId": "68a1f0c2-5d3e-4b7a-9c1d-2e3f4a5b6c7d",
        "trust": "imported"
      },
      "tags": [],
      "createdAt": "2025-03-02T09:12:44.000Z",
      "importedAt": "2026-10-20T10:30:00.000Z",
      "sha256": "1056f2f87d1cad280e833e6b46740eb50f25e0cd337838437076da049225100a",
      "bytes": 450,
      "turnCount": 4,
      "hasRaw": true,
      "notes": [
        "2 messages on abandoned branches kept only in raw"
      ],
      "review": {
        "status": "reviewed",
        "at": "2026-10-20T11:00:05.000Z",
        "by": "claude-desktop",
        "memoriesCreated": 1
      },
      "content": {
        "kind": "conversation",
        "turns": [
          {
            "i": 0,
            "role": "user",
            "text": "how should I format Go?",
            "at": "2025-03-02T09:12:44.000Z"
          },
          {
            "i": 1,
            "role": "assistant",
            "text": "gofmt uses tabs…",
            "at": "2025-03-02T09:12:50.000Z"
          },
          {
            "i": 2,
            "role": "user",
            "text": "ok",
            "at": "2025-03-02T09:13:01.000Z"
          },
          {
            "i": 3,
            "role": "user",
            "text": "I always use tabs in Go, fight me",
            "at": "2025-03-02T09:13:30.000Z"
          }
        ],
        "raw": {
          "title": "Go formatting",
          "mapping": {
            "…": "the untouched vendor record"
          }
        }
      }
    }
  ]
}
```
<!-- example:end -->

### A.6 Rules (normative)

1. **Completeness.** An export contains **all** memories (every status) and **all** sources with full bodies, including `raw` unless written with `--no-raw`. It never contains grants, tokens, token hashes, keys, passphrases or audit entries (`test/exporters.test.ts`, `test/canary.test.ts`).
2. **Round trip.** Importing an export into an empty vault and exporting again yields `memories` and `sources` arrays that are deep-equal under `canonicalJson`; only `exportedAt`, `vaultId` and `generator` differ (`test/roundtrip.test.ts`: 50 seeded random vaults plus the vendor fixtures).
3. **Import into a non-empty vault.** A record whose `id` already exists is **skipped** and counted; every other record is inserted with its original id, timestamps, `createdBy`, provenance and review state. Sources are imported before memories; each memory's `verified` flags are recomputed by the importing vault. The importing user's `--tags` are added to imported sources, never to memories.
4. **Versions.** Readers MUST reject a file whose `version` is not one they implement (the reference reader says `export written by format version N; this build reads 1`, error code `UNSUPPORTED`). Writers MUST NOT emit keys outside the schema; the reference reader is strict and rejects unknown keys (`INVALID_ARGUMENT`).
5. **`--no-raw` is lossy.** The writer drops `content.raw` from every source and recomputes `sha256`, `bytes` and `hasRaw` for the exported record, so the file still satisfies `sha256 = sha256Hex(canonicalJson(content))` and imports cleanly — but abandoned ChatGPT branches, attachment metadata and everything else only `raw` carried are gone for good.
6. **Size.** The reference importer parses a portable file whole (the documented practical limit is about 500 MB); vendor exports are streamed element by element instead. A line-delimited variant is a candidate for version 2.

### A.7 Versioning policy

- `version` is an integer. **Version 2 will be additive**: every version-1 key keeps its name, type and meaning; new keys are optional or carry defaults. Reading a version-2 file with a version-1 reader is refused (rule 4), never silently truncated.
- A release that introduces version 2 ships a migration (`import` of a version-1 file keeps working forever) and bumps this document.
- Breaking changes (renamed or retyped keys) require a new `format` string, not a version bump.

### A.8 JSON Schema

`schema/opencontext-vault-export.v1.schema.json` is JSON Schema draft 2020-12, generated by `z.toJSONSchema(PortableExportV1)` from `src/types.ts` via `npm run schema` (`scripts/gen-schema.mjs`). The zod type is the source of truth; `test/schema.test.ts` fails if the checked-in file drifts from it. Every object in the schema has `additionalProperties: false`.

---

## Part B — Vault directory: `opencontext-vault` version 1

### B.1 Layout

```
~/.opencontext/vault.key            key file (mode 0600) — a SIBLING of the vault dir, never inside it
~/.opencontext/vault.key.next       transient: the next key while `rekey` runs (B.6); present only during or after an interrupted rekey
~/.opencontext/vault/               mode 0700
  vault.json                        plaintext manifest (no secrets)
  memories.jsonl                    journal: Memory put/del
  sources.jsonl                     journal: SourceMeta put/del
  grants.jsonl                      journal: Grant put/del
  audit.jsonl                       journal: AuditEntry put — append-only, never compacted
  sources/<src_id>.enc              one envelope per source body (plaintext = SourceContent)
  sessions/<pid>.json               live server processes (plaintext: pid, session id, start time, grant label); not part of the format guarantees
  tmp/                              staging for atomic writes (same filesystem → rename is atomic)
  .lock                             transient; "<pid> <ms>\n"
```

The key file lives outside the directory so the directory can be backed up or synced as ciphertext. Everything that is plaintext (manifest, journal headers, record ids in envelope lines, file sizes and counts, session files) is deliberately free of memory content; see `SECURITY.md` for what that still leaks.

### B.2 Primitives

| Purpose | Primitive | Parameters |
|---|---|---|
| Encryption | **AES-256-GCM** | 32-byte key, 12-byte random IV, 16-byte tag, AAD as in B.4 |
| Hashing | **SHA-256** | hex output; used for `prev` chains, `keyId`, `SourceMeta.sha256`, deterministic ids, token hashes |
| Passphrase KDF | **scrypt** | `N = 131072` (2^17), `r = 8`, `p = 1`, 32-byte output, 16-byte random salt; the Node implementation passes `maxmem = 256 MiB` (anything ≥ 128 MiB works) |
| Binary encoding | **base64**, standard, padded | IV, ciphertext, tag, key bytes, salt |
| Hashing of bodies | **canonicalJson** | see Vocabulary |

Only `node:crypto` is used by the reference implementation; there are no custom constructions.

### B.3 Envelope

Every encrypted thing in a vault — a journal line, a source body, the manifest's key check, the key file's wrapped key — is one **envelope**, serialized as a single JSON line with the keys in exactly this order:

```json
{"v":1,"k":"memory","seq":17,"id":"mem_3f9a1c77e02b4d10","prev":"5e2c…(64 hex)","iv":"<base64 12 B>","ct":"<base64>","tag":"<base64 16 B>"}
```

| Key | Meaning |
|---|---|
| `v` | `1` |
| `k` | kind: `memory` · `source-meta` · `grant` · `audit` (journal lines) · `source-body` (bodies) · `check` (manifest) · `wrap` (key file) |
| `seq` | 1-based sequence within (journal, gen); `0` for non-journal envelopes |
| `id` | record id (`mem_…`, `src_…`, `grt_…`, `aud_…`); `""` for `check` and `wrap` |
| `prev` | hex sha256 of the **previous line's exact bytes** (without the trailing `\n`); `"genesis"` for `seq` 1; `""` for non-journal envelopes |
| `iv` | 12 random bytes, base64 |
| `ct` | AES-256-GCM ciphertext, base64 (may be `""`-length for empty plaintext, never omitted) |
| `tag` | 16-byte GCM authentication tag, base64 |

The key order matters because `prev` hashes the previous line's bytes: a re-serialization with different key order or whitespace breaks the chain. Readers MUST hash the line as stored, not as re-encoded.

**Plaintext by kind:**

| `k` | Plaintext (UTF-8 JSON unless noted) |
|---|---|
| `memory`, `source-meta`, `grant`, `audit` | a `JournalOp`: `{"op":"put","record":{…}}` or `{"op":"del","id":"…","at":"<IsoDate>"}` — `record` is a `Memory` / `SourceMeta` / `Grant` / `AuditEntry` (A.3, A.4, B.7) |
| `source-body` | a `SourceContent` (A.4) |
| `check` | the two ASCII bytes `ok` |
| `wrap` | the raw 32 data-key bytes (not JSON) |

### B.4 Authenticated data (AAD)

The AAD is the UTF-8 encoding of seven fields joined by `\n` (0x0A), with **no** trailing newline:

```
opencontext-vault/1\n<vaultId>\n<k>\n<gen>\n<seq>\n<id>\n<prev>
```

| Field | Journal line | Source body | `check` | `wrap` |
|---|---|---|---|---|
| prefix | `opencontext-vault/1` | same | same | same |
| `vaultId` | from the manifest | same | same | same (the key file's `vaultId`) |
| `k` | envelope kind | `source-body` | `check` | `wrap` |
| `gen` | the journal's current `gen` (from its header line) | `""` | `""` | `""` |
| `seq` | decimal, as in the envelope | `0` | `0` | `0` |
| `id` | the envelope's `id` | the source id (file name without `.enc`) | `""` | `""` |
| `prev` | the envelope's `prev` | `""` | `""` | `""` |

So the AAD of the manifest key check is exactly the 59 bytes `opencontext-vault/1\n<vaultId>\ncheck\n\n0\n\n` (two empty fields at the end).

**Why this binding matters.** A reader rebuilds the AAD from what it *expects* (the manifest's `vaultId`, the journal's header `gen`, the position it is at, the previous line's hash) rather than from the envelope's own plaintext fields. Therefore, without the key, a line cannot be moved to another journal (`k`), another vault (`vaultId`), another generation (`gen`), another position (`seq`), or made to follow a different line (`prev`); it cannot be replayed, duplicated or reordered, and deleting a line anywhere but at the tail breaks the next line's `prev`. The journal is **tamper-evident**, not tamper-proof: truncating the tail, or rolling back a journal together with `vault.json`, is not detectable without an external anchor (see B.13).

### B.5 Manifest `vault.json`

Pretty-printed JSON (two spaces, trailing newline), plaintext:

```json
{
  "format": "opencontext-vault",
  "version": 1,
  "vaultId": "b2b0a3f1c4d5e6f7a8b9c0d1e2f3a4b5",
  "createdAt": "2026-10-20T10:00:00.000Z",
  "keyId": "9f1c3a7b2e4d5c61",
  "keyCheck": { "v": 1, "k": "check", "seq": 0, "id": "", "prev": "", "iv": "…", "ct": "…", "tag": "…" },
  "gens": { "memories": "0123456789abcdef", "sources": "…", "grants": "…", "audit": "…" }
}
```

| Key | Meaning |
|---|---|
| `vaultId` | 32 hex; random at `init`; part of every AAD |
| `keyId` | first 16 hex of `sha256Hex(dataKey)`; lets a reader say "wrong key" before a GCM failure |
| `keyCheck` | envelope (`k:"check"`, gen `""`, seq `0`, id `""`, prev `""`) of the string `ok` under the data key |
| `gens` | the **current generation** of each journal (16 hex). A journal whose header `gen` is neither its entry here nor its entry in `pendingGens` is treated as rolled back or swapped (`CORRUPT`). |
| `pendingGens` | optional, `{ memories?, sources?, grants? }`: the gens a compaction is about to write. Written **before** the rewritten journals are renamed into place and removed by the manifest write that promotes them, so a crash between the two leaves a journal whose header carries its pending gen: a reader (any `opencontext-vault` command, under the lock) adopts that gen into `gens`, clears `pendingGens` and continues; a pending gen no journal reached is dropped. Absent when nothing is pending. |

The manifest is rewritten (atomically: `tmp/` + rename) twice by every compaction (pending, then promoted) and once by `rekey`.

### B.6 Key file `vault.key`

One JSON object on one line, mode `0600`, written atomically. Two forms, discriminated by `kdf`:

**`kdf: "none"`** — the data key in the clear (protect it with full-disk encryption):

```json
{"format":"opencontext-vault-key","version":1,"vaultId":"b2b0…","keyId":"9f1c3a7b2e4d5c61","kdf":"none","key":"<base64 32 bytes>"}
```

**`kdf: "scrypt"`** — the data key wrapped under a passphrase-derived key-encryption key (KEK):

```json
{"format":"opencontext-vault-key","version":1,"vaultId":"b2b0…","keyId":"9f1c…","kdf":"scrypt","salt":"<base64 16 B>","N":131072,"r":8,"p":1,"wrapped":{"v":1,"k":"wrap","seq":0,"id":"","prev":"","iv":"…","ct":"…","tag":"…"}}
```

Unwrapping:

1. `KEK = scrypt(passphrase (UTF-8), salt, N, r, p, dkLen = 32)`.
2. `dataKey = AES-256-GCM-decrypt(KEK, iv, ct, tag, AAD = "opencontext-vault/1\n<vaultId>\nwrap\n\n0\n\n")`, where `vaultId` is the key file's own `vaultId`.
3. Check `sha256Hex(dataKey)[0:16] === keyId`; the vault's `vault.json` must carry the same `keyId` and `vaultId`.

A wrong passphrase shows up as a GCM authentication failure in step 2. The parameters are stored in the file so they can be raised later without a format change; the reference implementation writes `N = 131072`, `r = 8`, `p = 1` (about 0.4 s on a 2026 laptop-class container; `test/crypto.test.ts` prints the measured time).

**`rekey`** generates a new data key and switches the vault to it in an order that leaves both keys on disk until the switch is complete, so no crash can leave a file that no key opens:

1. The current key file is proven (the passphrase, when scrypt, is resolved once and must unwrap it) and every source body is read with the current key; any failure here aborts with nothing changed.
2. The new key is written to `<key file>.next` in the same `kdf` mode and with the same scrypt parameters and passphrase as the current key file, and fsynced.
3. Every journal is rewritten under the new key (new gens) and every body is re-sealed.
4. `vault.json` is written with the new `keyId`, `keyCheck` and gens.
5. `<key file>.next` is renamed over the key file (or, for a passphrase change, the key file is rewritten under the new passphrase and `.next` is removed).

A reader that finds `<key file>.next` finishes the interrupted rekey under the lock before opening: if `vault.json` already names the staged key, the staged file is promoted (step 5); otherwise every journal is opened with whichever of the two keys its header gen says sealed it (the manifest's gen means the current key, any other gen means step 3 reached it), every body with whichever key authenticates it, anything still under the old key is re-sealed, and steps 4–5 run. A journal or body that opens under neither key, or a `.next` of another vault, is `CORRUPT` and nothing is deleted. The passphrase can only be changed by `rekey --new-passphrase` (or `--new-passphrase-file`), which applies the new passphrase at step 5: a resume after a crash before step 5 keeps the old passphrase. Setting `OPENCONTEXT_VAULT_PASSPHRASE` to a new value does not change it (the vault would not open).

### B.7 Journals (`*.jsonl`)

A journal is an append-only text file:

- **Line 1** (plaintext): the header `{"journal":"memories","v":1,"vaultId":"b2b0…","gen":"0123456789abcdef"}`. `journal` is one of `memories` · `sources` · `grants` · `audit`; `gen` is 16 hex and changes on every rewrite.
- **Every later line** is an envelope (B.3) whose `k` is fixed per journal: `memories → memory`, `sources → source-meta`, `grants → grant`, `audit → audit`. `seq` starts at 1 for each `gen` and increases by exactly 1 per line; `prev` is `"genesis"` on `seq` 1 and otherwise the hex sha256 of the previous line's bytes without its `\n`.
- Each line ends with `\n`. The file holds nothing else.

**Replay semantics.** Process lines in file order (writes are serialized by the directory lock). For each journal, the **last `put` or `del` per `id` wins**; a `del` removes the id. The `del` op's `id` must equal the envelope's `id`. For `memories`, a supersede is two `put`s under one lock — the old record (now `status:"superseded"`, `supersededBy`) first, then the new record (`supersedes`). For `audit`, there are only `put`s.

**Generations and compaction.** Compaction first rewrites `vault.json` with the fresh gens announced in `pendingGens` (B.5), then writes `<journal>.tmp` with the fresh `gen` and one `put` per live record (seq restarting at 1), fsyncs, renames over the old file, fsyncs the directory, and finally rewrites `vault.json` with the new `gens` and without `pendingGens`. `memories`, `sources` and `grants` are compacted after every delete (so revoked grants and forgotten memories leave the live file) and on `compact`. `audit.jsonl` is never compacted: the arguments of every logged call, including the statement or text a later `forget` removed from the other journals, stay in it for the key holder; `rekey` re-seals it in the same order under a new `gen`. Every write checks the byte count the kernel accepted (a short write on a full disk is an `IO` error, and an append puts the file back to its previous length), so a call that reports success has its whole line on disk.

**Reading rules.** A reader MUST: verify the header's `vaultId` equals the manifest's; verify `seq` contiguity from 1; verify each `prev`; verify `k`; decrypt with the AAD of B.4 using the header `gen`; verify the header `gen` equals `vault.json`'s entry for that journal, or its `pendingGens` entry (then finish the compaction as B.5 describes). Any failure is `CORRUPT`, **except** a torn write at the very end of the file: a last line that is missing its trailing `\n`, or a terminated last line that is not valid JSON or does not have the B.3 keys and types, is ignored (reported once to stderr) and truncated by the next writer under the lock. A last line that **is** a well-formed envelope but fails the `seq`, `prev`, `k`, `iv`/`tag` length or GCM check is `CORRUPT` like any other line: "undecodable" means the bytes are not an envelope, never that they do not decrypt.

**Record schemas** inside the plaintext `put` ops: `Memory` and `SourceMeta` are A.3 and A.4 (without `content`). `Grant` is `{ id: grt_…, label (^[a-z0-9][a-z0-9-]{0,39}$), tokenHash: sha256Hex("opencontext-vault-token/1|" + token), scopes: (read|write|sources|forget|instruct)[] (≥ 1), tags?: string[] (≥ 1, ≤ 10), createdAt, note? (≤ 200) }` — the token itself is never stored. `AuditEntry` is `{ id: aud_…, at, pid, session: ses_…, grant: { id, label } | null, client: { name, version, title? } | null, event: session_start|session_end|tool|resource|prompt|cli, name, args (JSON with vault tokens replaced by `ocv_[redacted]` before it is truncated to 1024 chars with the suffix "…[truncated]"), outcome: ok|denied|error, error?, ms, result?: { count?, ids? (≤ 50) } }`. The reference writer clips each `client` field to 200 chars (plus the truncation suffix) before the entry is written; the schema itself does not bound them.

### B.8 Source bodies `sources/<src_id>.enc`

One envelope line (plus `\n`) per source: `k = "source-body"`, `gen = ""`, `seq = 0`, `id = <src_id>`, `prev = ""`; plaintext = the `SourceContent` JSON. The body file is written (`tmp/` + fsync + rename) **before** the `put` of its `SourceMeta` is appended, so a meta never references a missing body. Integrity against rollback comes from `SourceMeta.sha256 = sha256Hex(canonicalJson(content))` inside the seq-bound sources journal: after decrypting a body, recompute the hash and compare (`CORRUPT: body does not match its record` otherwise). Deleting a source appends `del`, compacts the journal and unlinks the body.

### B.9 Files outside the format guarantees

`sessions/<pid>.json`, `.lock` and `tmp/` are plaintext operational files for coordination between processes; their content may change between releases and a reader needs none of them.

### B.10 Decrypting a vault with only the key

Given `vault.key` and the vault directory:

1. Obtain the 32-byte data key: `kdf:"none"` → base64-decode `key`; `kdf:"scrypt"` → B.6 steps 1–2.
2. Read `vault.json`; check `keyId`; optionally decrypt `keyCheck` (AAD `opencontext-vault/1\n<vaultId>\ncheck\n\n0\n\n`) and expect `ok`.
3. For each journal: read line 1 → `gen` (it must equal `vault.json`'s `gens` entry or its `pendingGens` entry); then for each line `n ≥ 2` with `seq = n − 1`: parse the envelope; AAD = `opencontext-vault/1\n<vaultId>\n<k>\n<gen>\n<seq>\n<id>\n<prev>` with `k` the kind the journal must carry (B.7), not whatever the line says; decrypt; apply the `put`/`del` to a map keyed by `id`. Check `prev` against the sha256 of the previous line's bytes as you go. Ignore only a torn last line as B.7 defines it.
4. For each live `SourceMeta`, read `sources/<id>.enc`, decrypt with AAD `opencontext-vault/1\n<vaultId>\nsource-body\n\n0\n<id>\n`, parse `SourceContent`, verify `sha256` (computed with canonicalJson exactly as the Vocabulary specifies).
5. You now hold exactly what `opencontext-vault export` would write (Part A), plus grants and the audit log.

`examples/decrypt_vault.py` does all of this in about 400 lines of Python (stdlib plus `cryptography`), written from this document and the vectors alone, and `--dump` writes what `export` would.

### B.11 Reference snippets

Node.js (built-ins only):

```js
import { createDecipheriv, createHash } from 'node:crypto';
function aad(vaultId, k, gen, seq, id, prev) {
  return Buffer.from(`opencontext-vault/1\n${vaultId}\n${k}\n${gen}\n${seq}\n${id}\n${prev}`, 'utf8');
}
function open(key, env, vaultId, gen) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'), { authTagLength: 16 });
  d.setAAD(aad(vaultId, env.k, gen, env.seq, env.id, env.prev));
  d.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]); // throws on a wrong key or tampering
}
const lineHash = (line) => createHash('sha256').update(line, 'utf8').digest('hex'); // `line` without its "\n"
```

Python (`pip install cryptography`):

```python
# Journals only; bodies additionally need canonicalJson as the Vocabulary specifies it (json.dumps(sort_keys=True,
# separators=(',', ':'), ensure_ascii=False) matches except for exponent-form numbers such as 1e-07 and lone
# surrogates). examples/decrypt_vault.py has a complete port and verifies bodies.
import base64, hashlib, json
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def aad(vault_id, k, gen, seq, id_, prev):
    return f"opencontext-vault/1\n{vault_id}\n{k}\n{gen}\n{seq}\n{id_}\n{prev}".encode()

def open_envelope(key: bytes, env: dict, vault_id: str, gen: str) -> bytes:
    ct_and_tag = base64.b64decode(env["ct"]) + base64.b64decode(env["tag"])
    return AESGCM(key).decrypt(base64.b64decode(env["iv"]), ct_and_tag, aad(vault_id, env["k"], gen, env["seq"], env["id"], env["prev"]))

def unwrap(passphrase: str, keyfile: dict) -> bytes:
    kek = hashlib.scrypt(passphrase.encode(), salt=base64.b64decode(keyfile["salt"]), n=keyfile["N"], r=keyfile["r"], p=keyfile["p"], dklen=32, maxmem=256 * 1024 * 1024)
    return open_envelope(kek, keyfile["wrapped"], keyfile["vaultId"], "")

def read_journal(key: bytes, path: str, vault_id: str) -> dict:
    live, prev = {}, "genesis"
    with open(path, "rb") as f:
        header = json.loads(f.readline())
        for seq, raw in enumerate(f, start=1):
            line = raw.rstrip(b"\n")
            env = json.loads(line)
            assert env["seq"] == seq and env["prev"] == prev
            op = json.loads(open_envelope(key, env, vault_id, header["gen"]))
            if op["op"] == "put": live[env["id"]] = op["record"]
            else: live.pop(env["id"], None)
            prev = hashlib.sha256(line).hexdigest()
    return live
```

### B.12 Test vectors

All vectors below are `test/vectors/envelope-vectors.json`, produced by `test/crypto.test.ts` and re-checked on every run. The AAD column shows `\n` for 0x0A; `aadHex` is the exact byte string.

**Key** (hex): `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` → **keyId** `630dcd2966c43366`
**vaultId**: `b2b0a3f1c4d5e6f7a8b9c0d1e2f3a4b5`

#### V1 — manifest key check (`k:"check"`, gen `""`, seq `0`, id `""`, prev `""`)

| | |
|---|---|
| AAD | `opencontext-vault/1\nb2b0a3f1c4d5e6f7a8b9c0d1e2f3a4b5\ncheck\n\n0\n\n` |
| aadHex | `6f70656e636f6e746578742d7661756c742f310a62326230613366316334643565366637613862396330643165326633613462350a636865636b0a0a300a0a` |
| IV (hex) | `0f0e0d0c0b0a090807060504` |
| plaintext | `ok` |
| ct (base64) | `y1s=` |
| tag (base64) | `ajkjUH9l+vb1uBNdBbqPzQ==` |
| line | `{"v":1,"k":"check","seq":0,"id":"","prev":"","iv":"Dw4NDAsKCQgHBgUE","ct":"y1s=","tag":"ajkjUH9l+vb1uBNdBbqPzQ=="}` |
| sha256(line) | `954541bacc6152ccffd49a0bbda45f237582887b0deecec0cfa3fb05f4d40ba7` |

#### V2 — memories journal, seq 1 (`k:"memory"`, gen `0123456789abcdef`, id `mem_3f9a1c77e02b4d10`, prev `genesis`)

| | |
|---|---|
| AAD | `opencontext-vault/1\nb2b0a3f1c4d5e6f7a8b9c0d1e2f3a4b5\nmemory\n0123456789abcdef\n1\nmem_3f9a1c77e02b4d10\ngenesis` |
| aadHex | `6f70656e636f6e746578742d7661756c742f310a62326230613366316334643565366637613862396330643165326633613462350a6d656d6f72790a303132333435363738396162636465660a310a6d656d5f336639613163373765303262346431300a67656e65736973` |
| IV (hex) | `000000000000000000000001` |
| plaintext | `{"op":"put","record":{"id":"mem_3f9a1c77e02b4d10","kind":"preference","statement":"User prefers tabs over spaces in Go.","subject":"user","tags":["coding","go"],"confidence":"stated","sources":[],"createdAt":"2026-10-20T11:00:00.000Z","updatedAt":"2026-10-20T11:00:00.000Z","createdBy":"claude-desktop","status":"active"}}` |
| ct (base64) | `bvTQjGbOEm57WnMVztRflHrteHZeyXbtFyI5+0tVHgEJ8F6QGU+zCzzv8WNYgDYDDDpx+ZSAeWWEN20XPdP+emEfBp8zZb+1vspA1C1c9p32n/hCBzvyOLOLqAZRLhspOJbDSXy0gKB0wgPoWolqBGNzZW8zO8Ze+pBxuat7LAY4kBF4TGC+vSVbBR3xzpVY6PscuscoAuNIGzxFjSMymoBSmj9zgZTsA5+OU36bfeGCqqaE1L95Z5cNSJ5yVh0cRdxbN24SgoBumbvEBvF7n9Yx7he6DnN3uSmV7x84btLITxmGiAu2LfpvkH48gVxeV3cH2VKFQMR6OiYs4efA6upZSgg7z0nduElzelUloB6a43AyCP9TYk9SieX8cjK/+xEHrOYiAsrmMo+ldmRDrDrJE7n+0EuQ/KLJhCcTGanu2g==` |
| tag (base64) | `4qGamAOWt6+SkvSQgZCkHA==` |
| line | `{"v":1,"k":"memory","seq":1,"id":"mem_3f9a1c77e02b4d10","prev":"genesis","iv":"AAAAAAAAAAAAAAAB","ct":"bvTQjGbOEm57WnMVztRflHrteHZeyXbtFyI5+0tVHgEJ8F6QGU+zCzzv8WNYgDYDDDpx+ZSAeWWEN20XPdP+emEfBp8zZb+1vspA1C1c9p32n/hCBzvyOLOLqAZRLhspOJbDSXy0gKB0wgPoWolqBGNzZW8zO8Ze+pBxuat7LAY4kBF4TGC+vSVbBR3xzpVY6PscuscoAuNIGzxFjSMymoBSmj9zgZTsA5+OU36bfeGCqqaE1L95Z5cNSJ5yVh0cRdxbN24SgoBumbvEBvF7n9Yx7he6DnN3uSmV7x84btLITxmGiAu2LfpvkH48gVxeV3cH2VKFQMR6OiYs4efA6upZSgg7z0nduElzelUloB6a43AyCP9TYk9SieX8cjK/+xEHrOYiAsrmMo+ldmRDrDrJE7n+0EuQ/KLJhCcTGanu2g==","tag":"4qGamAOWt6+SkvSQgZCkHA=="}` |
| sha256(line) | `15282203565131d5248382eda74162b2f652ee2cb0f1981aff3900198e69a0e5` ← this is the next line's `prev` |

#### V3 — memories journal, seq 2 (a `del`; prev = sha256 of the V2 line)

| | |
|---|---|
| AAD | `opencontext-vault/1\nb2b0a3f1c4d5e6f7a8b9c0d1e2f3a4b5\nmemory\n0123456789abcdef\n2\nmem_3f9a1c77e02b4d10\n15282203565131d5248382eda74162b2f652ee2cb0f1981aff3900198e69a0e5` |
| aadHex | `6f70656e636f6e746578742d7661756c742f310a62326230613366316334643565366637613862396330643165326633613462350a6d656d6f72790a303132333435363738396162636465660a320a6d656d5f336639613163373765303262346431300a31353238323230333536353133316435323438333832656461373431363262326636353265653263623066313938316166663339303031393865363961306535` |
| IV (hex) | `000000000000000000000002` |
| plaintext | `{"op":"del","id":"mem_3f9a1c77e02b4d10","at":"2026-10-20T12:00:00.000Z"}` |
| ct (base64) | `slNBDZZx+LXcYR49VSiPrrw1WLWD9jzJtxxjWUbsPrTWQc2rF1EKyDuqlhKoQaiSSDE8KJCtgBWl7bEaIFNN2rtoZOHDQ9Rd` |
| tag (base64) | `kSF+Awlte5zFJGMWd2VPuw==` |
| line | `{"v":1,"k":"memory","seq":2,"id":"mem_3f9a1c77e02b4d10","prev":"15282203565131d5248382eda74162b2f652ee2cb0f1981aff3900198e69a0e5","iv":"AAAAAAAAAAAAAAAC","ct":"slNBDZZx+LXcYR49VSiPrrw1WLWD9jzJtxxjWUbsPrTWQc2rF1EKyDuqlhKoQaiSSDE8KJCtgBWl7bEaIFNN2rtoZOHDQ9Rd","tag":"kSF+Awlte5zFJGMWd2VPuw=="}` |
| sha256(line) | `0241c925639daba8a125b424351ea427f1b6a78fccccbbff97b54eec6db5ba82` |

#### V4 — source body (`k:"source-body"`, gen `""`, seq `0`, id `src_7d2e0b1a9c3f4e55`, prev `""`)

| | |
|---|---|
| AAD | `opencontext-vault/1\nb2b0a3f1c4d5e6f7a8b9c0d1e2f3a4b5\nsource-body\n\n0\nsrc_7d2e0b1a9c3f4e55\n` |
| aadHex | `6f70656e636f6e746578742d7661756c742f310a62326230613366316334643565366637613862396330643165326633613462350a736f757263652d626f64790a0a300a7372635f376432653062316139633366346535350a` |
| IV (hex) | `a1a2a3a4a5a6a7a8a9aaabac` |
| plaintext | `{"kind":"document","mediaType":"text/plain","text":"Hello 世界"}` |
| ct (base64) | `Xc3sBpoxHFWsGt0TIa+pHRa1Bg0aIDDug8tOIAE6XfRn4d6PzAEkjrsd1dv9EzGJwBK4jSAOhoRYvqHMdNHswdFY` |
| tag (base64) | `sdsVwZMYu4iF4lyE9m5zDQ==` |
| line | `{"v":1,"k":"source-body","seq":0,"id":"src_7d2e0b1a9c3f4e55","prev":"","iv":"oaKjpKWmp6ipqqus","ct":"Xc3sBpoxHFWsGt0TIa+pHRa1Bg0aIDDug8tOIAE6XfRn4d6PzAEkjrsd1dv9EzGJwBK4jSAOhoRYvqHMdNHswdFY","tag":"sdsVwZMYu4iF4lyE9m5zDQ=="}` |
| sha256(line) | `d4cc6c2a0b1d4c0dd098881dacb9897a6c0bcd926563c33f07997104dc481a2e` |

#### V5 — key wrap (`k:"wrap"`; the vector key above plays the KEK; plaintext = 32 data-key bytes)

| | |
|---|---|
| AAD | `opencontext-vault/1\nb2b0a3f1c4d5e6f7a8b9c0d1e2f3a4b5\nwrap\n\n0\n\n` |
| aadHex | `6f70656e636f6e746578742d7661756c742f310a62326230613366316334643565366637613862396330643165326633613462350a777261700a0a300a0a` |
| IV (hex) | `ffeeddccbbaa998877665544` |
| plaintext (hex) | `202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f` |
| ct (base64) | `/mcqKGnQxuQhRUdmHbGMDvvet1UMVjswlhj/j1itpwc=` |
| tag (base64) | `dlxY/S7dtFVhRCYYsULIfA==` |
| line | `{"v":1,"k":"wrap","seq":0,"id":"","prev":"","iv":"/+7dzLuqmYh3ZlVE","ct":"/mcqKGnQxuQhRUdmHbGMDvvet1UMVjswlhj/j1itpwc=","tag":"dlxY/S7dtFVhRCYYsULIfA=="}` |
| sha256(line) | `1f4a33fd151415c353f0c5a9aa8f6b2e11701f8039471f2f201ce154acdc8e4c` |

#### V6 — scrypt KEK derivation (checked by `test/schema.test.ts` against `crypto.scryptSync`)

<!-- scrypt-vector: passphrase="correct horse battery staple" saltHex=000102030405060708090a0b0c0d0e0f N=131072 r=8 p=1 dkLen=32 kekHex=1b2946da71f41179e83b99dc33842d15741b87c4121c8c7f3781c1df864fb58b -->

| | |
|---|---|
| passphrase (UTF-8) | `correct horse battery staple` |
| salt (hex) | `000102030405060708090a0b0c0d0e0f` |
| N, r, p, dkLen | `131072`, `8`, `1`, `32` |
| KEK (hex) | `1b2946da71f41179e83b99dc33842d15741b87c4121c8c7f3781c1df864fb58b` |

#### V7 — canonicalJson (`test/vectors/canonical-json-vectors.json`, checked by `test/util.test.ts`; `value` as a JSON parser reads it, then the canonical bytes and their sha256; `\ud800` is a lone surrogate)

| case | value | canonicalJson | sha256 |
|---|---|---|---|
| numbers | `{"n1": 1, "n2": 1e+21, "n3": 1e-07, "n4": 12345678901234567000, "n5": 0, "n6": 5e-324, "n7": 1e-06, "n8": 1.5e-07, "n9": 0.1, "n10": 100000000000000000000, "n11": 123.456, "n12": 1709370764.123456}` | `{"n1":1,"n10":100000000000000000000,"n11":123.456,"n12":1709370764.123456,"n2":1e+21,"n3":1e-7,"n4":12345678901234567000,"n5":0,"n6":5e-324,"n7":0.000001,"n8":1.5e-7,"n9":0.1}` | `0d93662717f1fc86f156bcde3a8acf52537ed5e5abb6163c349306d79c51f762` |
| strings | `{"s1": "é 世界 😀", "s2": "tab\tnl\ncr\rbs\bff\fquote\"back\\slash", "s3": "\u0001\u001f  ", "s4": "lone\ud800surrogate", "s5": ""}` | `{"s1":"é 世界 😀","s2":"tab\tnl\ncr\rbs\bff\fquote\"back\\slash","s3":"\u0001\u001f  ","s4":"lone\ud800surrogate","s5":""}` | `a7a1473ff1a07dab97926f4f5ec88b4e80066b4aa187a093148ad32e368ee3cc` |
| key order across the surrogate gap | `{"😀": 1, "Ａ": 2, "a": 3, "": 4, "￿": 5, "Z": 6, "": 7}` | `{"":7,"Z":6,"a":3,"":4,"Ａ":2,"￿":5,"😀":1}` | `4caf001f9b3ad3d4bf1dcc89721d39c37ae4e0caa684938c6ee9c91345441a92` |
| nesting, undefined dropped, null kept | `{"b": [1, null, {"z": null, "y": [true, false]}], "a": {}, "c": []}` | `{"a":{},"b":[1,null,{"y":[true,false],"z":null}],"c":[]}` | `fd5f90a41ebb64039a0c2f8488bc38972f414991bd278e3ac10cef3da9563ec0` |

### B.13 Integrity: what the format guarantees and what it cannot

- **Detected without the key** (`opencontext-vault verify`): a broken `prev` chain, a gap or repeat in `seq`, a line of the wrong `k`, a journal whose header `gen` is neither the one `vault.json` records nor the one it has pending, a malformed envelope anywhere but at the tail (a malformed **last** line is a torn write and is tolerated, B.7).
- **Detected with the key**: any modified, replayed, reordered, moved or swapped-in line (GCM + AAD), a body that does not hash to its `SourceMeta.sha256`, a wrong or foreign key (`keyId`, `keyCheck`).
- **Not detectable** by the format alone: truncating a journal at its tail, and rolling back a journal together with `vault.json` to an older consistent state. Keep an external anchor (a copy of `vault.json` plus the line counts, or a backup) if that matters to you. Plaintext metadata — ids, counts, file sizes, timestamps, session files — is visible to anyone who can read the directory.
- No independent security review of this format has been performed. It uses only `node:crypto` primitives (AES-256-GCM, scrypt, SHA-256). See `SECURITY.md` for the threat model.
