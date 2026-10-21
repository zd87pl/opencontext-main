# OpenContext Backend API

Express + Prisma backend for the OpenContext proof of concept: Google OAuth
sign-up with a platform-managed wallet, encrypted content with purchase-gated
decryption, Stripe payment intents, and a JSON-RPC-style HTTP endpoint for AI
agents.

This is PoC code. The section [What is real and what is stubbed](#what-is-real-and-what-is-stubbed)
is the honest map of which parts do what they claim.

## Quick start

Requirements: Node 20+, PostgreSQL. Redis is optional (sessions and session keys
fall back to process memory without it).

```bash
cd backend
npm ci                 # also runs `prisma generate` via @prisma/client's postinstall
cp .env.example .env   # fill in DATABASE_URL and SESSION_SECRET at minimum
npm run db:push        # create the schema in your database
npm run dev            # http://localhost:3000/health
```

Google OAuth is optional at boot: without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_CALLBACK_URL`
the server starts and `/auth/google` answers 503. To enable it, create OAuth 2.0
credentials in the Google Cloud Console with the redirect URI
`http://localhost:3000/auth/google/callback` and put them in `.env`.

## Verify

```bash
npm test            # vitest, runs offline (database/Stripe/Redis are mocked at the module boundary)
npm run typecheck   # tsc --noEmit over src/ including tests
npm run lint        # eslint
npm run build       # compiles src/ (tests excluded) to dist/
```

`npm test` and `npm run typecheck` need the generated Prisma client, which
`npm ci` produces; run `npm run db:generate` if you installed with scripts disabled.
See [TESTING.md](./TESTING.md) for how the suite is structured.

## API

### Authentication (`/auth`)
- `GET /auth/google` - start the Google OAuth flow (503 when OAuth is not configured)
- `GET /auth/google/callback` - OAuth callback; redirects to `FRONTEND_URL/auth/success?token=<jwt>`
- `POST /auth/logout`, `GET /auth/me`, `GET /auth/status` - session endpoints

API routes accept either the session cookie or `Authorization: Bearer <jwt>`.

### Users (`/api/users`)
- `GET /api/users/profile`, `PATCH /api/users/profile`
- `GET /api/users/purchases`, `GET /api/users/content`

### Content (`/api/content`)
- `POST /api/content/create` - encrypts the submitted content server-side and stores it
- `GET /api/content/:contentId?decrypt=true` - public metadata; decrypted body when the caller has purchased it
- `GET /api/content/search?q=&platform=&minPrice=&maxPrice=&limit=`
- `GET /api/content/user/:userId`, `GET /api/content/my/accessible`
- `GET /api/content/lib/encryption.js` - reference browser-side encryption helper (see below)

### Payments (`/api/payments`)
- `POST /api/payments/intent` - create a Stripe PaymentIntent for a content item
- `POST /api/payments/confirm` - complete a purchase once the intent has succeeded
- `POST /api/payments/webhook/stripe` - Stripe webhook (raw body, signature verified)
- `GET /api/payments/access/:contentId`, `GET /api/payments/purchases`
- `POST /api/payments/instant-purchase` - PoC shortcut, see below

### AI agents (`/mcp`, `/api/ai-agents`)
- `POST /mcp/tools/call` - JSON-RPC-shaped tool calls (`search_premium_content`, `get_content`, ...)
- `GET /mcp/info`, `GET /mcp/tools/schema`, `GET /mcp/health`
- `/api/ai-agents` - create and manage agent API keys

## What is real and what is stubbed

| Area | Status |
| --- | --- |
| Google OAuth, sessions, JWT issuance | Implemented |
| Managed wallet creation (ethers, AES-256-GCM encrypted private key) | Implemented; the key is derived from `SESSION_SECRET` unless `WALLET_ENCRYPTION_KEY` is set. Use a KMS before holding real funds |
| Content encryption (AES-256-GCM) and purchase-gated decryption | Implemented |
| "Client-side" encryption | Not yet. `POST /api/content/create` receives plaintext and encrypts on the server. The served `encryption.js` is a reference helper whose output format the server does not accept |
| Key escrow | Implemented, with a known flaw: content keys are wrapped with a 24-hour session key, while escrow rows live for a year, so rows become undecryptable after the session key rotates. Tracked as `TODO(op-context)` in `key-escrow.service.ts` |
| Stripe PaymentIntents and webhooks | Implemented against the Stripe API; `instant-purchase` "confirms" without charging a payment method, so it only works with test keys |
| USD to USDC transfer to the creator | Stubbed. `processBlockchainPayment` returns a keccak256 hash; no funds move |
| On-chain contracts (PassportRegistry, ContextVault, PaymentStream) | Not called from this service. `deployUserContracts` returns addresses from the environment |
| `/mcp` endpoint | Custom JSON-RPC-over-HTTP with API-key auth and rate limiting. It is **not** the Model Context Protocol: no initialize handshake, no MCP transport, our own message shapes. An MCP client cannot connect to it without an adapter |
| Redis | Optional. Sessions and session keys use Redis when `REDIS_URL` is set and reachable, otherwise process memory (single instance only) |

## Architecture

```
backend/
├── src/
│   ├── auth/            # Passport (Google), JWT middleware, session helpers
│   ├── users/           # Profile, purchases, created content
│   ├── content/         # Encryption, key escrow, session-key store, auto-decrypt middleware
│   ├── payments/        # Stripe intents/webhooks, access checks
│   ├── wallets/         # Managed wallet creation and decryption
│   ├── mcp/             # AI-agent HTTP API (see table above)
│   ├── common/          # Prisma client, logger, error handler
│   └── index.ts         # Express app
├── prisma/schema.prisma # Database schema
└── package.json
```

## Environment variables

See `.env.example`. Required to boot: `SESSION_SECRET`, `DATABASE_URL`.
Required for the corresponding feature: `JWT_SECRET` (API tokens),
`GOOGLE_*` (OAuth), `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` (payments),
`BLOCKCHAIN_RPC_URL` (wallet balance lookups), `REDIS_URL` (shared sessions).
