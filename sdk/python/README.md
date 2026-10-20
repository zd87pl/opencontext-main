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
