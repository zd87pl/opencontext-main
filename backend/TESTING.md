# Backend testing

```bash
cd backend
npm ci
npm test              # vitest run
npm run test:coverage # with v8 coverage
npm run typecheck     # tsc over src/, tests included
```

The suite runs offline. Nothing in it connects to PostgreSQL, Redis, Stripe or
an RPC node:

- **Prisma** is replaced per test file with `vi.mock('../common/prisma.js', ...)`
  and a hoisted object of `vi.fn()`s. Tests assert on the exact query shapes.
- **Stripe** is replaced with a mock client; `new Stripe(...)` returns it.
- **Redis** is never created: `src/__tests__/setup.ts` unsets `REDIS_URL`, so
  the session-key store keeps keys in `globalThis.sessionKeys` (reset before
  every test).
- **Wallet/RPC** calls are mocked in the payment tests.

`setup.ts` also sets the env vars the services read, clears mocks before each
test and resets mock implementations after each, so every `describe` arms the
mocks it needs in its own `beforeEach`.

## Layout

```
src/
├── __tests__/
│   ├── setup.ts                   # env + mock hygiene (vitest setupFiles)
│   ├── fixtures.ts                # fakeUser()
│   └── integration.test.ts        # create -> pay -> escrow -> retrieve -> decrypt, real services, mocked edges
├── auth/__tests__/auth.middleware.test.ts
├── content/__tests__/
│   ├── encryption.service.test.ts
│   ├── key-escrow.service.test.ts
│   ├── auto-decrypt.middleware.test.ts
│   └── content.router.test.ts     # supertest against the router + errorHandler
└── payments/__tests__/payment.service.test.ts
```

## Conventions

- Test files are ESM like the source. Use `vi.hoisted()` for anything a
  `vi.mock` factory references (the factory runs before top-level `const`s are
  initialised) and import the mocked functions instead of `require()`, which
  cannot resolve the `.js` -> `.ts` import convention.
- Mock the module that owns a function. The content-access check lives in
  `payments/access.service.ts`, so tests mock that path, not `payment.service.ts`.
- Express 4 does not catch rejected promises from async middleware. Middleware
  reports failures with `next(err)`, and tests assert on what `next` received.
- Keep the Prisma client generated (`npm run db:generate`); `typecheck` needs
  its types even though the tests never instantiate it.

## Not covered

- `src/index.ts` (server wiring), `src/users`, `src/wallets` and most of
  `src/mcp` have no unit tests yet.
- There are no tests against a real database; `prisma/schema.prisma` is only
  exercised through `prisma generate`.
