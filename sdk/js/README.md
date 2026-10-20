# @opencontext/sdk

TypeScript client for the OpenContext Network contracts: the soulbound
passport (`PassportRegistry`), the encrypted context vault (`ContextVault` /
`ContextVaultIPFS`) and Superfluid-backed streaming payments (`PaymentStream`).

Pure ESM, Node 20+, built on [ethers v6](https://docs.ethers.org/v6/).

## Status

Pre-release (`0.1.0`), not yet published to npm. The contracts are deployed to
testnets only. Build from this directory and consume it with `npm link` or
`npm pack`.

## Install

```bash
cd sdk/js
npm ci
npm run build   # emits dist/index.js + dist/index.d.ts
```

## Quick start

```ts
import { OpenContextClient } from '@opencontext/sdk';

const client = await OpenContextClient.create(
  'https://sepolia.era.zksync.dev',
  process.env.PRIVATE_KEY!,
  {
    passportRegistry: '0x...',
    contextVault: '0x...',
    paymentStream: '0x...',
  }
);

// Soulbound identity (minting requires an authorized minter).
const passport = await client.authenticate();

// Context is AES-256-GCM encrypted client-side before it goes on-chain.
const version = await client.storeContext(JSON.stringify({ preferences: { lang: 'en' } }));
const latest = await client.getMyLatestContext();

// Stream USDCx to a data provider at a given throughput.
await client.streamPay('0xProvider', 1024n /* bytes per second */);
await client.stopPayment('0xProvider');
```

The lower-level wrappers are available as `client.passport`, `client.vault`
and `client.payments`, or can be constructed directly from an
`OpenContextConfig`.

## Encryption

- Payloads are encrypted with AES-256-GCM. The key is derived from the
  encryption password with scrypt and a random 32-byte salt per message.
  Wire format (base64): `salt(32) || iv(16) || tag(16) || ciphertext`.
- With a private-key signer (`ethers.Wallet`) the password is derived from the
  key via HKDF-SHA256 with a domain-separation label. Any other signer
  (browser wallets, remote signers) must call `setEncryptionPassword()` or
  `generateEncryptionPassword()` first; the client refuses to store plaintext.
- A wrong password fails GCM authentication and throws
  `OpenContextError` with code `ENCRYPTION_FAILED`.

## IPFS

`ContextVault` and `OpenContextClient` accept an optional `IPFSConfig`. When
given, the vault targets a `ContextVaultIPFS` deployment, stores payloads on
IPFS through the Kubo HTTP RPC API (`kubo-rpc-client`) and records only the
CID on-chain. The default endpoint is a local node at `http://127.0.0.1:5001`.

## Errors

Every failure is thrown as `OpenContextError` with a `code` from the
`SDKError` enum (`NO_SIGNER`, `NO_PASSPORT`, `UNAUTHORIZED`,
`QUOTA_EXCEEDED`, `PROVIDER_NOT_ACTIVE`, `INVALID_FLOW_RATE`,
`NOT_CONFIGURED`, `ENCRYPTION_FAILED`, `IPFS_ERROR`, `TRANSACTION_FAILED`).
Custom Solidity errors are decoded from the ABI and mapped to these codes.

## Development

```bash
npm ci
npm test            # vitest, single run
npm run test:watch
npm run test:coverage
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (flat config)
npm run build       # tsup
```

Tests mock the contract and the IPFS node; no network access is needed.
