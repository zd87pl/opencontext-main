#!/usr/bin/env python3

"""
OpenContext Network End-to-End Demo (Python)

This demo showcases the core functionality of the OpenContext Network:
1. Passport authentication/creation
2. Context storage and retrieval  
3. Payment streaming setup

Usage:
    python demo.py [--testnet]

Contract addresses are read from the environment (same names as .env.example):
    PASSPORT_REGISTRY_ADDRESS, CONTEXT_VAULT_ADDRESS, PAYMENT_STREAM_ADDRESS
When unset they fall back to the placeholder addresses 0x…01/02/03 below.
Nothing is deployed at those placeholders: the script prints a warning and
every on-chain call will fail until real addresses are supplied.
"""

import asyncio
import json
import os
import sys
import time
from typing import Dict, List

from opencontext import OpenContextClient


# Placeholder contract addresses used when the environment variables are unset.
# Nothing is deployed at them; they only keep the script runnable.
PLACEHOLDER_CONTRACTS = {
    "passport_registry": "0x0000000000000000000000000000000000000001",
    "context_vault": "0x0000000000000000000000000000000000000002",
    "payment_stream": "0x0000000000000000000000000000000000000003",
}

# Demo configuration
CONFIG = {
    # zkSync Sepolia testnet
    "provider_url": "https://sepolia.era.zksync.dev",

    # Contract addresses, from the environment or the placeholders above
    "contracts": {
        "passport_registry": os.environ.get("PASSPORT_REGISTRY_ADDRESS")
        or PLACEHOLDER_CONTRACTS["passport_registry"],
        "context_vault": os.environ.get("CONTEXT_VAULT_ADDRESS")
        or PLACEHOLDER_CONTRACTS["context_vault"],
        "payment_stream": os.environ.get("PAYMENT_STREAM_ADDRESS")
        or PLACEHOLDER_CONTRACTS["payment_stream"],
    },

    # Demo accounts (DO NOT use in production)
    "accounts": {
        "alice": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "bob": "0x0000000000000000000000000000000000000000000000000000000000000002",
        "provider": "0x0000000000000000000000000000000000000000000000000000000000000003",
        # Metering account; must be enabled by the PaymentStream owner via set_meter
        "meter": "0x0000000000000000000000000000000000000000000000000000000000000004",
    }
}


async def main() -> None:
    """Run the OpenContext demo."""
    print("🌐 OpenContext Network Demo Starting...\n")
    
    try:
        # Initialize clients for different roles
        alice = await create_client("Alice", CONFIG["accounts"]["alice"])
        bob = await create_client("Bob", CONFIG["accounts"]["bob"])
        provider = await create_client("Provider", CONFIG["accounts"]["provider"])
        meter = await create_client("Meter", CONFIG["accounts"]["meter"])

        print("📋 Step 1: Authentication & Passport Creation\n")
        
        # Authenticate users (creates passports if they don't exist)
        alice_passport = await with_retry(lambda: async_wrapper(alice, 'authenticate', 'passport authentication'))
        print(f"✅ Alice authenticated with token ID: {alice_passport.token_id}")
        
        bob_passport = await with_retry(lambda: async_wrapper(bob, 'authenticate', 'passport authentication'))
        print(f"✅ Bob authenticated with token ID: {bob_passport.token_id}")
        
        print("\n💾 Step 2: Context Storage & Retrieval\n")
        
        # Store some context data for Alice
        context_data = json.dumps({
            "preferences": {
                "language": "en",
                "theme": "dark", 
                "notifications": True
            },
            "history": [
                "Asked about weather in San Francisco",
                "Requested stock prices for AAPL",
                "Searched for nearby restaurants"
            ],
            "timestamp": int(time.time())
        })
        
        version = await with_retry(lambda: async_wrapper(alice, 'store_context', 'context storage', context_data))
        print(f"✅ Alice stored context version: {version}")
        
        # Retrieve the latest context
        retrieved_context = await alice.get_my_latest_context()
        parsed_context = json.loads(retrieved_context)
        print(f"✅ Retrieved Alice's context with {len(parsed_context['history'])} history items")
        
        # Bob tries to access Alice's context (should fail without authorization)
        try:
            await bob.vault.get_latest_context(alice_passport.token_id)
            print("❌ Bob should not be able to read Alice's context")
        except Exception:
            print("✅ Bob correctly denied access to Alice's context")
        
        # Alice authorizes Bob to read her context
        await alice.vault.authorize_reader(bob.config.account)
        print("✅ Alice authorized Bob to read her context")
        
        # Now Bob can read Alice's context
        bob_reads_alice = await bob.vault.get_latest_context(alice_passport.token_id)
        print("✅ Bob successfully read Alice's authorized context")
        
        print("\n💰 Step 3: Payment Stream Setup\n")
        
        # Provider registers themselves
        provider_address = provider.config.account
        rate_per_byte = 1000000000000000  # 0.001 USDC per byte
        
        await provider.become_provider(provider_address, rate_per_byte)
        print(f"✅ Provider registered with rate: {rate_per_byte} wei per byte")
        
        # Alice starts a payment stream to the provider
        bytes_per_second = 1000  # 1KB/s consumption rate
        
        # Validate rate limits and cost estimates
        cost_analysis = validate_stream_rates(bytes_per_second, rate_per_byte)
        print(f"💡 Stream cost analysis: {format_wei(cost_analysis['monthly_cost'])} ETH/month")
        
        await with_retry(lambda: async_wrapper(alice, 'stream_pay', 'payment stream setup', provider_address, bytes_per_second))
        print(f"✅ Alice started payment stream: {bytes_per_second} bytes/sec")
        
        # Check stream status
        streams = await alice.get_my_streams([provider_address])
        flow_rate = streams.get(provider_address, 0)
        print(f"✅ Active stream flow rate: {flow_rate} wei/sec")
        
        # Usage is attributed to Alice's stream by an enabled meter (normally the
        # metering gateway); the contract rejects a provider metering itself.
        bytes_consumed = 5000  # 5KB
        await meter.record_consumption(alice.config.account, provider_address, bytes_consumed)
        print(f"✅ Meter recorded {bytes_consumed} bytes consumed")
        
        # Alice stops the payment stream
        await alice.stop_payment(provider_address)
        print("✅ Alice stopped payment stream")
        
        print("\n🎉 Demo completed successfully!\n")
        
        # Summary
        print("📊 Demo Summary:")
        print(f"• Created {3} passports")
        print(f"• Stored {1} context version")
        print(f"• Authorized {1} reader")
        print(f"• Set up {1} payment stream")
        print(f"• Recorded {bytes_consumed} bytes of usage")
        
    except Exception as error:
        print(f"❌ Demo failed: {error}")
        if hasattr(error, 'code'):
            print(f"Error code: {error.code}")
        sys.exit(1)


async def async_wrapper(client: OpenContextClient, method: str, operation: str, *args):
    """Wrapper to add gas estimation to client method calls."""
    await estimate_gas_costs(client, operation)
    method_func = getattr(client, method)
    if args:
        return await method_func(*args)
    else:
        return await method_func()


async def create_client(name: str, private_key: str) -> OpenContextClient:
    """Create an OpenContext client."""
    try:
        client = await OpenContextClient.create(
            CONFIG["provider_url"],
            private_key,
            CONFIG["contracts"]
        )
        
        address = client.config.account
        print(f"🔑 {name} client created: {address[:10]}...")
        
        return client
    except Exception as error:
        raise Exception(f"Failed to create {name} client: {error}")


def format_wei(wei: int, decimals: int = 18) -> str:
    """Format wei amount to human readable."""
    return str(wei / (10 ** decimals))


def calculate_monthly_cost(rate_per_byte: int, bytes_per_second: int) -> int:
    """Calculate monthly cost for streaming."""
    seconds_per_month = 30 * 24 * 60 * 60
    monthly_bytes = bytes_per_second * seconds_per_month
    return rate_per_byte * monthly_bytes


async def estimate_gas_costs(client: OpenContextClient, operation: str) -> int | None:
    """Estimate gas costs for an operation."""
    try:
        # Mock gas estimation - in real implementation would use web3.py
        estimated_gas = 21000  # Base transaction gas
        gas_price = 20_000_000_000  # 20 gwei
        estimated_cost = estimated_gas * gas_price
        print(f"⛽ Estimated gas for {operation}: {format_wei(estimated_cost)} ETH")
        return estimated_cost
    except Exception as error:
        print(f"⚠️ Could not estimate gas for {operation}: {error}")
        return None


async def with_retry(operation, max_retries: int = 3, delay_ms: int = 1000):
    """Retry utility for network operations."""
    for attempt in range(1, max_retries + 1):
        try:
            return await operation()
        except Exception as error:
            if attempt == max_retries:
                raise error
            print(f"⚠️ Attempt {attempt} failed, retrying in {delay_ms}ms: {error}")
            await asyncio.sleep(delay_ms / 1000)
            delay_ms *= 2  # Exponential backoff


def validate_stream_rates(bytes_per_second: int, rate_per_byte: int, max_monthly_spend: int = 100 * 10**18) -> Dict:
    """Rate limiting validator."""
    monthly_cost = calculate_monthly_cost(rate_per_byte, bytes_per_second)
    monthly_spend_eth = format_wei(monthly_cost)
    
    print(f"💰 Monthly cost estimate: {monthly_spend_eth} ETH")
    
    if monthly_cost > max_monthly_spend:
        raise Exception(f"Monthly cost ({monthly_spend_eth} ETH) exceeds limit ({format_wei(max_monthly_spend)} ETH)")
    
    max_recommended_rate = 10000  # 10KB/s recommended max
    if bytes_per_second > max_recommended_rate:
        print(f"⚠️ High consumption rate: {bytes_per_second} bytes/sec (recommended max: {max_recommended_rate})")
    
    return {"monthly_cost": monthly_cost, "is_within_limits": True}


if __name__ == "__main__":
    # Handle CLI arguments
    args = sys.argv[1:]
    is_testnet = "--testnet" in args
    
    if is_testnet:
        print("🧪 Running in testnet mode\n")
    else:
        print("⚠️  Running in demo mode (mock contracts)\n")
        print("💡 Use --testnet flag to run against real testnet contracts\n")

    placeholder_contracts = [
        name
        for name, address in CONFIG["contracts"].items()
        if address == PLACEHOLDER_CONTRACTS[name]
    ]
    if placeholder_contracts:
        print(f"⚠️  Using placeholder contract addresses for: {', '.join(placeholder_contracts)}")
        print(
            "   Nothing is deployed there. Set PASSPORT_REGISTRY_ADDRESS, "
            "CONTEXT_VAULT_ADDRESS and PAYMENT_STREAM_ADDRESS.\n"
        )

    # Run the demo
    asyncio.run(main())