# OpenContext Python SDK

Python client for the OpenContext Network contracts: the `PassportRegistry`
soulbound identity token, the `ContextVault` encrypted context store, and the
`PaymentStream` Superfluid micropayment rails.

The SDK is fully async (built on `web3.py`'s `AsyncWeb3`) and ships with
`py.typed` so it type-checks under `mypy --strict`.

## Requirements

- Python 3.11, 3.12 or 3.13
- [Poetry](https://python-poetry.org/) for development
- On Python 3.13 a C compiler (`gcc`/`clang` plus Python headers): web3 v6 depends on
  `lru-dict`, which has no 3.13 wheel and is built from source. 3.11 and 3.12 install
  from wheels only.

## Install

```bash
cd sdk/python
poetry install
```

## Quick start

```python
import asyncio

from opencontext import OpenContextClient


async def main() -> None:
    client = await OpenContextClient.create(
        provider_url="https://sepolia.era.zksync.dev",
        private_key="0x...",
        addresses={
            "passport_registry": "0x...",
            "context_vault": "0x...",
            "payment_stream": "0x...",
        },
    )

    # Mint a passport for this account if it does not already have one.
    passport = await client.authenticate()
    print("passport token id:", passport.token_id)

    # Encrypt (AES-256-GCM, scrypt-derived key) and store a context blob.
    version = await client.store_context('{"preferences": {"theme": "dark"}}')
    print("stored context version:", version)

    # Read it back and decrypt it.
    latest = await client.get_my_latest_context()
    print("latest context:", latest)


asyncio.run(main())
```

## Payments

`PaymentStream` never holds funds. A stream is a Superfluid constant flow sent
from the **user's own wallet** to the provider's payout address; the contract
opens, re-prices and closes it as a Superfluid *flow operator* on the user's
behalf. Streams are keyed by `(user, provider)` wallet addresses.

### 1. Grant flow-operator permission (once per wallet)

Before the first `start_stream`, the user must authorise the `PaymentStream`
contract on the Super Token it streams (`usdcx()`). The SDK does not bundle
Superfluid's `CFAv1Forwarder` ABI; the one function needed is:

```python
from opencontext.constants import CFA_V1_FORWARDER_ADDRESS  # same on every network

GRANT_PERMISSIONS_ABI = [
    {
        "name": "grantPermissions",
        "type": "function",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "token", "type": "address"},
            {"name": "flowOperator", "type": "address"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    }
]

forwarder = client.config.web3.eth.contract(
    address=CFA_V1_FORWARDER_ADDRESS, abi=GRANT_PERMISSIONS_ABI
)
tx = await forwarder.functions.grantPermissions(
    usdcx_address, client.config.payment_stream_address
).build_transaction({"from": client.config.account, "nonce": nonce})
# sign and send `tx` as usual
```

`grantPermissions` gives create/update/delete rights with an unlimited
flow-rate allowance; `updateFlowOperatorPermissions(token, operator, 7,
allowance)` caps it and `revokePermissions` withdraws it. Without the grant,
`start_stream` raises `OpenContextError` with code `FLOW_OPERATOR_PERMISSION`.

### 2. Stream, read, stop

```python
payments = client.payments

await payments.start_stream(provider, 1024)            # needs a passport
info = await payments.get_stream_info(me, provider)    # StreamInfo(flow_rate, receiver, active)
full = await payments.get_stream(me, provider)         # Stream(+ bytes_consumed, started_at)
await payments.update_stream(provider, 2048)
await payments.stop_stream(provider)                   # works even while paused
```

Reads reflect the last state written through the contract, not the live
Superfluid flow.

### Providers and meters

```python
await payments.register_provider(payout_address, rate_per_byte)  # wei/byte, scaled by 1e18
await payments.update_provider_rate(new_rate)                    # live streams keep their rate
await payments.deregister_provider()
```

Usage is reported by trusted **meters** (the metering gateway), enabled by the
contract owner with `payments.set_meter(address, True)`. A meter calls
`payments.record_consumption(user, provider, bytes)`; providers cannot meter
their own streams (`SelfMetering`), and non-meters get `UNAUTHORIZED`.

### Errors

Every failure is an `OpenContextError` whose `code` is an `SDKError`:
`NO_ACCOUNT`, `NO_PASSPORT`, `INVALID_ADDRESS`, `UNAUTHORIZED`,
`QUOTA_EXCEEDED`, `PROVIDER_NOT_ACTIVE`, `STREAM_NOT_ACTIVE`,
`STREAM_ALREADY_ACTIVE`, `INVALID_FLOW_RATE`, `FLOW_OPERATOR_PERMISSION`,
`STREAM_OPERATION_FAILED`, `ENCRYPTION_FAILED`, `TRANSACTION_FAILED`. Custom
Solidity reverts are recognised by name or by 4-byte selector (web3's
`ContractCustomError` carries only the encoded data), and
`StreamOperationFailed(bytes reason)` is unwrapped to the Superfluid CFA error
it carries.

## Encryption format

`ContextCrypto.encrypt()` produces a base64 string laid out as

```
salt (32 bytes) || iv (16 bytes) || GCM tag (16 bytes) || ciphertext
```

The AES-256 key is derived from the password with scrypt using
`N=2**14, r=8, p=1`, the same parameters Node's `crypto.scrypt` uses by
default, so ciphertext produced by this SDK and by the TypeScript SDK's
`ContextCrypto` is interchangeable when the same password is used.

`derive_password_from_private_key()` never uses the signing key directly as a
password. It runs HKDF-SHA256 over the 32 key bytes with an empty salt and the
domain-separation label `opencontext/context-encryption/v1`, matching the
TypeScript SDK, so a wallet gets the same context password from either SDK.
Pass an explicit password via `client.set_encryption_password()` if you want
to decouple context encryption from the wallet key.

## Development

```bash
poetry run pytest -q                 # unit tests
poetry run mypy --strict opencontext # type checking
poetry run black --check .           # formatting
poetry run ruff check .              # linting
```

Tests are offline: contract calls are mocked, and the crypto tests exercise
the real `cryptography` primitives.

The hand-written ABIs in `opencontext/constants.py` are checked against a
snapshot of the compiled contracts (`tests/compiled_abi.py`). After changing a
contract, regenerate it with `node sdk/js/scripts/compiled-abi.mjs` (needs
`forge` and the JS SDK's `node_modules`); the script refreshes both SDKs' copies.
