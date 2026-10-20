# OpenContext Gateway

A metered HTTP proxy for AI agents. Agents call partner APIs (news, GitHub, satellite imagery, DePIN compute) through the gateway with an `X-Passport-ID`; the gateway meters every byte and request, prices it in wei of a Super Token, and verifies that the agent's wallet is streaming payment on-chain through [Superfluid](https://www.superfluid.finance/) before serving metered traffic.

```
agent ──X-Passport-ID──▶ gateway ──credential injected──▶ partner API
                            │
                            ├─ meters bytes/requests per passport (memory or Redis)
                            └─ verifies USDCx flow agent → partner on Base (CFAv1Forwarder)
```

## Status

What is real and tested:

- **Metered proxy** (`/proxy/:partnerId/*`): keep-alive connection pool, per-host circuit breaker, SSRF protection, header hygiene, server-side credential injection, per-IP and per-passport rate limits.
- **Metering**: per-record ledger plus atomic running totals (lifetime and per UTC day) in memory or Redis.
- **Payment streams**: unsigned `CFAv1Forwarder` calldata for the client to sign, on-chain flow verification via ethers v6 before a stream is registered, accrued-cost tracking.
- **Chunked transfers**: fixed-size chunking with keccak256 checksums, per-byte charging, truncation detection and reconstruction.
- **DePIN routing**: node selection by cost / speed / reliability, reputation tracking, job history.
- **GitHub OAuth → wallet linking** with single-use `state` and signed link messages.

What is a placeholder:

- The two bundled compute nodes have endpoints that do not resolve; register real nodes with `DePINRouter.registerNode`.
- Auth sessions, OAuth states and pending links live in process memory (single worker only; see `TODO(op-context)` in `src/auth.ts`).
- Nothing here holds user keys or submits transactions. The agent signs; the gateway verifies.

## Quick start

```bash
cd gateway
npm ci
npm start            # http://0.0.0.0:3001, in-memory storage, no credentials needed
```

```bash
curl -s localhost:3001/health
curl -s localhost:3001/partners | jq '.[].id'

# Proxy a GitHub call (your own token is forwarded when the gateway has none configured)
curl -si -H 'X-Passport-ID: demo' -H "Authorization: Bearer $GITHUB_TOKEN" \
     localhost:3001/proxy/github/user | grep -i '^x-metering'

curl -s localhost:3001/usage/demo | jq '.totals'
```

Copy `.env.example` to `.env` to configure Redis, partner credentials, GitHub OAuth or a different chain. Every variable is optional.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness, version, storage kind, chain |
| GET | `/stats` | Connection pool, circuit breakers, rate limiter, streaming stats |
| GET | `/partners` | Partner pricing and whether a server-side credential is configured |
| ALL | `/proxy/:partnerId/*` | Metered proxy. Requires `X-Passport-ID`. Adds `X-Metering-Cost`, `X-Metering-Bytes`, `X-Response-Time` |
| GET | `/usage/:passportId?partnerId=&since=` | Retained records and totals for a passport |
| GET | `/usage/:passportId/analytics?days=` | Daily breakdown |
| POST | `/stream/prepare` | Unsigned `createFlow` / `updateFlow` / `deleteFlow` transactions for `{sender, receiver, flowRate}` |
| POST | `/stream/start` | Verify the flow on-chain and register `{passportId, partnerId, sender, receiver, flowRate}` |
| POST | `/stream/stop` | Deregister a stream (the on-chain flow is the sender's to delete) |
| GET | `/streams/:passportId` | Active streams with accrued cost |
| POST | `/streaming/sessions` | Quote a chunked transfer `{passportId, partnerId, totalSize, costPerByte, chunkSize?}` |
| GET | `/streaming/sessions/:id` | Session ledger and status |
| POST | `/streaming/sessions/:id/pause\|resume\|cancel` | Lifecycle |
| GET | `/depin/nodes`, `/depin/models` | Available compute |
| POST | `/depin/jobs` | Submit an inference job `{model, input, priority?}` (requires `X-Passport-ID`; failed jobs are not billed) |
| GET | `/depin/jobs`, `/depin/jobs/:id` | Job history |
| GET | `/auth/github/login`, `/auth/github/callback` | GitHub OAuth (503 until `GITHUB_CLIENT_ID/SECRET` are set) |
| POST | `/auth/link-wallet` | Link a wallet to the OAuth user with a signed message |
| GET/DELETE | `/auth/session` | Inspect or revoke a session (`Authorization: Bearer <token>`) |

Errors always have the shape `{ error, message, statusCode, timestamp, issues? }`.

## Payment flow

1. The agent asks `POST /stream/prepare` for calldata to open a USDCx flow to the partner's payout address.
2. The agent signs and broadcasts it from its own wallet (any Superfluid-aware wallet or the `@opencontext/sdk`).
3. `POST /stream/start` reads `getFlowrate(token, sender, receiver)` from the `CFAv1Forwarder` and registers the stream only if the on-chain rate covers the requested one (`409` otherwise).
4. Metered usage accrues per passport; `/streams/:passportId` shows what the stream has paid so far.

Defaults: Base mainnet (`8453`), Super USDC `0xD04383398dD2426297da660F9CCA3d439AF9ce1b`, forwarder `0xcfA132E353cB4E398080B9700609bb008eceB125` (both from Superfluid's published metadata). Override with `CHAIN_ID`, `SUPER_TOKEN_ADDRESS`, `CFA_FORWARDER_ADDRESS`, `RPC_URL`.

## Upstream credentials

Partners declare how the gateway authenticates on the agent's behalf (`partners/*.ts`). When the matching environment variable is set (`NEWSAPI_KEY`, `GITHUB_TOKEN`, `SATELLITE_API_KEY`) the gateway injects it and drops any client `Authorization` header; when it is not set, the client's own header is forwarded unchanged. `/partners` reports which credentials are configured without revealing them.

## Security model

- Upstream URLs are validated before every proxied request: http(s) only, no credentials in the URL, no loopback / link-local / private / CGNAT / multicast targets (IPv4, IPv6 and IPv4-mapped), no `..` escaping the partner's base path, no CR/LF/NUL in the path.
- Hop-by-hop, `Cookie`, `Host`, `X-Forwarded-*` and gateway headers are never forwarded; only printable ASCII header values are relayed.
- Bodies are forwarded verbatim (no content rewriting), capped at 10 MB; upstream responses are capped at 50 MB.
- Rate limits: per client IP (`RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW`) and per passport (`PASSPORT_RATE_LIMIT_MAX` per minute).
- Responses carry `X-Content-Type-Options`, `X-Frame-Options`, a deny-all CSP and `Cache-Control: no-store`.

## Storage

`StorageAdapter` (`src/storage.ts`) has two implementations: in-memory (default; lazy TTL expiry, no timers) and Redis (`REDIS_URL`). Running totals use atomic increments (`HINCRBY` on Redis), so concurrent requests never lose updates. Multi-worker deployments must use Redis.

## Running

```bash
npm start                 # single process (tsx)
npm run dev               # watch mode
npm run start:cluster     # one worker per CPU (WORKER_COUNT to override), rolling restart on SIGUSR2,
                          # management API on 127.0.0.1:${CLUSTER_MANAGEMENT_PORT:-3002}/cluster/status
npm run build && node dist/proxy.js
```

## Development

```bash
npm test                  # vitest run (unit + integration through fastify.inject, no network)
npm run test:coverage     # thresholds: 80% statements/lines/functions, 75% branches
npm run typecheck         # tsc --noEmit over src, partners, examples and tests
npm run lint              # eslint (typescript-eslint, no `any`)
npx tsx examples/newswire-demo.ts   # needs NEWSAPI_KEY and a running gateway
```

### Layout

```
src/app.ts             createApp(): routes, hooks, error envelope (injectable services)
src/bootstrap.ts       startServer(): config → services → listen;  src/proxy.ts is the `npm start` entry
src/server.ts          cluster primary; src/worker.ts cluster worker; src/cluster.ts supervision
src/metering.ts        usage ledger and totals          src/billing.ts     Superfluid flows (ethers v6)
src/streaming.ts       chunked transfers                src/depin.ts       compute routing
src/connection-pool.ts upstream HTTP client             src/security.ts    SSRF / header rules
src/storage.ts         memory + Redis adapters          src/validation.ts  zod schemas, typed errors
src/auth.ts            GitHub OAuth + wallet linking    src/config.ts      environment schema
partners/              pricing + upstream auth per partner, plus direct API clients used by examples/
```
