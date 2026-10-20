/**
 * Shared domain types for the gateway.
 *
 * Monetary amounts are wei-denominated strings of the gateway's Super Token (USDCx on Base by
 * default). They are strings rather than numbers because wei values routinely exceed
 * `Number.MAX_SAFE_INTEGER`; callers convert with `BigInt()`.
 */

/** A single metered request against a partner. */
export interface MeteringRecord {
  /** Unique record id. */
  id: string;
  /** Monotonic sequence number; orders records created within the same millisecond. */
  sequence: number;
  passportId: string;
  partnerId: string;
  /** Unix epoch milliseconds. */
  timestamp: number;
  bytes: number;
  requests: number;
  /** Total cost of this record in wei. */
  cost: string;
}

/** How the gateway authenticates to an upstream partner on the client's behalf. */
export interface UpstreamAuth {
  /** Header to set on the proxied request, e.g. `Authorization` or `X-Api-Key`. */
  header: string;
  /** `bearer` => `Bearer <cred>`, `basic` => `Basic base64(<cred>:)`, `raw` => `<cred>`. */
  scheme: 'bearer' | 'basic' | 'raw';
  /** Environment variable on the gateway host that holds the credential. */
  envVar: string;
}

export interface PartnerConfig {
  id: string;
  name: string;
  /**
   * Upstream origin plus base path. Partners whose base URL is not http(s) (e.g. `internal://depin`)
   * are metered but cannot be reached through `/proxy`.
   */
  baseUrl: string;
  /** Wei per response byte. */
  costPerByte: string;
  /** Wei per request. */
  costPerRequest: string;
  authRequired: boolean;
  rateLimits?: {
    requests: number;
    /** Window length in seconds. */
    window: number;
  };
  upstreamAuth?: UpstreamAuth;
}

/** A Superfluid constant-flow payment stream registered with the gateway. */
export interface PaymentStreamSession {
  passportId: string;
  partnerId: string;
  /** Flow sender (the paying wallet). */
  sender: string;
  /** Flow receiver (the partner's payout address). */
  receiver: string;
  /** Super Token streamed. */
  token: string;
  /** Wei per second. */
  flowRate: string;
  /** Unix epoch milliseconds at which the gateway verified and registered the flow. */
  startTime: number;
  active: boolean;
  stopTime?: number;
}

/** Metadata about one chunk of a chunked transfer. Chunk payloads are stored separately. */
export interface ChunkRecord {
  index: number;
  size: number;
  /** Wei charged for this chunk. */
  cost: string;
  /** keccak256 of the chunk payload. */
  checksum: string;
  processedAt: number;
}

export type StreamingSessionStatus = 'active' | 'paused' | 'completed' | 'cancelled' | 'failed';

/** A chunked, per-byte-metered large-file transfer. */
export interface StreamingSession {
  id: string;
  passportId: string;
  partnerId: string;
  /** Declared size of the transfer in bytes. */
  totalSize: number;
  chunkSize: number;
  /** Wei per byte. */
  costPerByte: string;
  /** Quoted cost for the whole transfer: `totalSize * costPerByte`. */
  totalCost: string;
  /** Cost accrued so far from processed chunks. */
  accruedCost: string;
  downloadedBytes: number;
  status: StreamingSessionStatus;
  startTime: number;
  endTime?: number;
  /** Sessions are garbage-collected after this time. */
  expiresAt: number;
  pausedAt?: number;
  resumedAt?: number;
  cancelledAt?: number;
  error?: string;
  chunks: ChunkRecord[];
}
