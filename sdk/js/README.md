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

// Stream USDCx to a data provider at a given throughput. Requires the
// flow-operator grant described under "Payments" first.
await client.streamPay('0xProvider', 1024n /* bytes per second */);
await client.stopPayment('0xProvider');
```

The lower-level wrappers are available as `client.passport`, `client.vault`
and `client.payments`, or can be constructed directly from an
`OpenContextConfig`.

## Payments

`PaymentStream` never holds funds. A stream is a Superfluid constant flow sent
from the **user's own wallet** to the provider's payout address; the contract
opens, re-prices and closes it as a Superfluid *flow operator* on the user's
behalf. Streams are keyed by `(user, provider)` wallet addresses.

### 1. Grant flow-operator permission (once per wallet)

Before the first `startStream`, the user must authorise the `PaymentStream`
contract on the Super Token it streams (`usdcx()`). The SDK does not bundle
Superfluid's `CFAv1Forwarder` ABI; the one fragment needed is:

```ts
import { ethers } from 'ethers';
import { CFA_V1_FORWARDER_ADDRESS } from '@opencontext/sdk';

const forwarder = new ethers.Contract(
  CFA_V1_FORWARDER_ADDRESS, // same address on every Superfluid network
  ['function grantPermissions(address token, address flowOperator) returns (bool)'],
  signer
);
await forwarder.grantPermissions(usdcxAddress, paymentStreamAddress);
```

`grantPermissions` gives create/update/delete rights with an unlimited
flow-rate allowance; use `updateFlowOperatorPermissions(token, operator, 7,
allowance)` to cap it, and `revokePermissions` to withdraw it. Without the
grant, `startStream` throws `OpenContextError` with code
`FLOW_OPERATOR_PERMISSION`.

### 2. Stream, read, stop

```ts
const payments = client.payments;

await payments.startStream('0xProvider', 1024n);          // needs a passport
const info = await payments.getStreamInfo(me, '0xProvider'); // { flowRate, receiver, active }
const full = await payments.getStream(me, '0xProvider');     // + bytesConsumed, startedAt
await payments.updateStream('0xProvider', 2048n);
await payments.stopStream('0xProvider');                  // works even while paused
```

Reads reflect the last state written through the contract, not the live
Superfluid flow.

### Providers and meters

```ts
await payments.registerProvider('0xPayout', ratePerByte); // rate in wei/byte, scaled by 1e18
await payments.updateProviderRate(newRate);              // live streams keep their rate
await payments.deregisterProvider();
```

Usage is reported by trusted **meters** (the metering gateway), enabled by the
contract owner with `payments.setMeter(address, true)`. A meter calls
`payments.recordConsumption(user, provider, bytes)`; providers cannot meter
their own streams (`SelfMetering`), and non-meters get `UNAUTHORIZED`.

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
`SDKError` enum (`NO_SIGNER`, `NO_PASSPORT`, `INVALID_ADDRESS`, `UNAUTHORIZED`,
`QUOTA_EXCEEDED`, `PROVIDER_NOT_ACTIVE`, `STREAM_NOT_ACTIVE`,
`STREAM_ALREADY_ACTIVE`, `INVALID_FLOW_RATE`, `FLOW_OPERATOR_PERMISSION`,
`STREAM_OPERATION_FAILED`, `NOT_CONFIGURED`, `ENCRYPTION_FAILED`,
`IPFS_ERROR`, `TRANSACTION_FAILED`).
Custom Solidity errors are decoded from the ABI and mapped to these codes;
`StreamOperationFailed(bytes reason)` is unwrapped to the Superfluid CFA error
it carries.

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

The hand-written ABIs in `src/constants.ts` are checked against a snapshot of
the compiled contracts (`test/compiled-abi.ts`). After changing a contract,
regenerate it with `node scripts/compiled-abi.mjs` (needs `forge`); the same
script refreshes the Python SDK's copy.
