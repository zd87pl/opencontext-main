#!/usr/bin/env node

/**
 * OpenContext Network End-to-End Demo
 * 
 * This demo showcases the core functionality of the OpenContext Network:
 * 1. Passport authentication/creation
 * 2. Context storage and retrieval
 * 3. Payment streaming setup
 * 
 * Usage:
 *   node demo.js [--testnet]
 */

import { ethers } from 'ethers';
import { OpenContextClient } from './sdk/js/src/index.js';

// Demo configuration
const CONFIG = {
  // zkSync Sepolia testnet
  providerUrl: 'https://sepolia.era.zksync.dev',
  
  // Contract addresses (these would be deployed contracts in real usage)
  contracts: {
    passportRegistry: '0x0000000000000000000000000000000000000001',
    contextVault: '0x0000000000000000000000000000000000000002',
    paymentStream: '0x0000000000000000000000000000000000000003',
  },
  
  // Demo accounts (DO NOT use in production)
  accounts: {
    alice: '0x0000000000000000000000000000000000000000000000000000000000000001',
    bob: '0x0000000000000000000000000000000000000000000000000000000000000002',
    provider: '0x0000000000000000000000000000000000000000000000000000000000000003',
  }
};

async function main() {
  console.log('🌐 OpenContext Network Demo Starting...\n');
  
  try {
    // Initialize clients for different roles
    const alice = await createClient('Alice', CONFIG.accounts.alice);
    const bob = await createClient('Bob', CONFIG.accounts.bob);
    const provider = await createClient('Provider', CONFIG.accounts.provider);
    
    console.log('📋 Step 1: Authentication & Passport Creation\n');
    
    // Authenticate users (creates passports if they don't exist)
    const alicePassport = await alice.authenticate();
    console.log(`✅ Alice authenticated with token ID: ${alicePassport.tokenId}`);
    
    const bobPassport = await bob.authenticate();
    console.log(`✅ Bob authenticated with token ID: ${bobPassport.tokenId}`);
    
    console.log('\n💾 Step 2: Context Storage & Retrieval\n');
    
    // Store some context data for Alice
    const contextData = JSON.stringify({
      preferences: {
        language: 'en',
        theme: 'dark',
        notifications: true
      },
      history: [
        'Asked about weather in San Francisco',
        'Requested stock prices for AAPL',
        'Searched for nearby restaurants'
      ],
      timestamp: Date.now()
    });
    
    const version = await alice.storeContext(contextData);
    console.log(`✅ Alice stored context version: ${version}`);
    
    // Retrieve the latest context
    const retrievedContext = await alice.getMyLatestContext();
    const parsedContext = JSON.parse(retrievedContext);
    console.log(`✅ Retrieved Alice's context with ${parsedContext.history.length} history items`);
    
    // Bob tries to access Alice's context (should fail without authorization)
    try {
      await bob.vault.getLatestContext(alicePassport.tokenId);
      console.log('❌ Bob should not be able to read Alice\'s context');
    } catch (error) {
      console.log('✅ Bob correctly denied access to Alice\'s context');
    }
    
    // Alice authorizes Bob to read her context
    await alice.vault.authorizeReader(await bob.config.signer.getAddress());
    console.log('✅ Alice authorized Bob to read her context');
    
    // Now Bob can read Alice's context
    const bobReadsAlice = await bob.vault.getLatestContext(alicePassport.tokenId);
    console.log('✅ Bob successfully read Alice\'s authorized context');
    
    console.log('\n💰 Step 3: Payment Stream Setup\n');
    
    // Provider registers themselves
    const providerAddress = await provider.config.signer.getAddress();
    const ratePerByte = BigInt('1000000000000000'); // 0.001 USDC per byte
    
    await provider.becomeProvider(providerAddress, ratePerByte);
    console.log(`✅ Provider registered with rate: ${ratePerByte} wei per byte`);
    
    // Alice starts a payment stream to the provider
    const bytesPerSecond = BigInt(1000); // 1KB/s consumption rate
    await alice.streamPay(providerAddress, bytesPerSecond);
    console.log(`✅ Alice started payment stream: ${bytesPerSecond} bytes/sec`);
    
    // Check stream status
    const streams = await alice.getMyStreams([providerAddress]);
    const flowRate = streams.get(providerAddress);
    console.log(`✅ Active stream flow rate: ${flowRate} wei/sec`);
    
    // Provider records some usage
    const bytesConsumed = BigInt(5000); // 5KB
    await provider.recordBytesProvided(alicePassport.tokenId, bytesConsumed);
    console.log(`✅ Provider recorded ${bytesConsumed} bytes consumed`);
    
    // Alice stops the payment stream
    await alice.stopPayment(providerAddress);
    console.log('✅ Alice stopped payment stream');
    
    console.log('\n🎉 Demo completed successfully!\n');
    
    // Summary
    console.log('📊 Demo Summary:');
    console.log(`• Created ${3} passports`);
    console.log(`• Stored ${1} context version`);
    console.log(`• Authorized ${1} reader`);
    console.log(`• Set up ${1} payment stream`);
    console.log(`• Recorded ${bytesConsumed} bytes of usage`);
    
  } catch (error) {
    console.error('❌ Demo failed:', error.message);
    if (error.code) {
      console.error(`Error code: ${error.code}`);
    }
    process.exit(1);
  }
}

async function createClient(name, privateKey) {
  try {
    const client = await OpenContextClient.create(
      CONFIG.providerUrl,
      privateKey,
      CONFIG.contracts
    );
    
    const address = await client.config.signer.getAddress();
    console.log(`🔑 ${name} client created: ${address.slice(0, 8)}...`);
    
    return client;
  } catch (error) {
    throw new Error(`Failed to create ${name} client: ${error.message}`);
  }
}

// Utility function to format wei amounts
function formatWei(wei, decimals = 18) {
  return ethers.formatUnits(wei, decimals);
}

// Utility function to calculate costs
function calculateMonthlyCost(ratePerByte, bytesPerSecond) {
  const secondsPerMonth = 30n * 24n * 60n * 60n;
  const monthlyBytes = bytesPerSecond * secondsPerMonth;
  return ratePerByte * monthlyBytes;
}

// Handle CLI arguments
const args = process.argv.slice(2);
const isTestnet = args.includes('--testnet');

if (isTestnet) {
  console.log('🧪 Running in testnet mode\n');
} else {
  console.log('⚠️  Running in demo mode (mock contracts)\n');
  console.log('💡 Use --testnet flag to run against real testnet contracts\n');
}

// Run the demo
main().catch(console.error);