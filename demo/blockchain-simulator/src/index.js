const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 8545;

app.use(cors());
app.use(express.json());

// Simulated blockchain state
const blockchain = {
  blocks: [],
  transactions: [],
  accounts: new Map(),
  contracts: new Map(),
  currentBlockNumber: 0,
  networkId: process.env.NETWORK_ID || 280,
  chainName: process.env.CHAIN_NAME || 'zkSync Era Testnet'
};

// Initialize with genesis block
blockchain.blocks.push({
  number: 0,
  hash: '0x0000000000000000000000000000000000000000000000000000000000000000',
  parentHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
  timestamp: Math.floor(Date.now() / 1000),
  transactions: []
});

// Mock contract addresses
const MOCK_CONTRACTS = {
  PassportRegistry: '0x1234567890123456789012345678901234567890',
  ContextVault: '0x2345678901234567890123456789012345678901',
  PaymentStream: '0x3456789012345678901234567890123456789012'
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    network: blockchain.chainName,
    blockNumber: blockchain.currentBlockNumber,
    timestamp: new Date().toISOString()
  });
});

// JSON-RPC endpoint
app.post('/', (req, res) => {
  const { method, params, id } = req.body;
  
  console.log(`RPC Call: ${method}`, params);
  
  try {
    const result = handleRPCMethod(method, params);
    res.json({
      jsonrpc: '2.0',
      id,
      result
    });
  } catch (error) {
    res.json({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: error.message
      }
    });
  }
});

function handleRPCMethod(method, params) {
  switch (method) {
    case 'eth_chainId':
      return `0x${blockchain.networkId.toString(16)}`;
      
    case 'eth_blockNumber':
      return `0x${blockchain.currentBlockNumber.toString(16)}`;
      
    case 'eth_getBalance':
      const [address] = params;
      return blockchain.accounts.get(address) || '0x56bc75e2d630fffff'; // ~100 ETH
      
    case 'eth_getBlockByNumber':
      const [blockNumber] = params;
      const blockNum = blockNumber === 'latest' ? blockchain.currentBlockNumber : parseInt(blockNumber, 16);
      return blockchain.blocks[blockNum] || null;
      
    case 'eth_sendTransaction':
    case 'eth_sendRawTransaction':
      return simulateTransaction(params[0]);
      
    case 'eth_call':
      return simulateContractCall(params[0]);
      
    case 'eth_estimateGas':
      return '0x5208'; // 21000 gas
      
    case 'eth_gasPrice':
      return '0x3b9aca00'; // 1 gwei
      
    case 'net_version':
      return blockchain.networkId.toString();
      
    case 'eth_accounts':
      return Array.from(blockchain.accounts.keys());
      
    default:
      throw new Error(`Method ${method} not supported`);
  }
}

function simulateTransaction(txData) {
  const txHash = '0x' + Array.from({length: 64}, () => Math.floor(Math.random() * 16).toString(16)).join('');
  
  const transaction = {
    hash: txHash,
    from: txData.from,
    to: txData.to,
    value: txData.value || '0x0',
    data: txData.data || '0x',
    gasLimit: txData.gas || '0x5208',
    gasPrice: txData.gasPrice || '0x3b9aca00',
    nonce: '0x0',
    blockNumber: blockchain.currentBlockNumber + 1,
    timestamp: Math.floor(Date.now() / 1000)
  };
  
  blockchain.transactions.push(transaction);
  
  // Auto-mine if enabled
  if (process.env.AUTO_MINE === 'true') {
    setTimeout(() => mineBlock(), 1000);
  }
  
  console.log(`Transaction simulated: ${txHash}`);
  return txHash;
}

function simulateContractCall(callData) {
  const { to, data } = callData;
  
  // Simulate contract responses
  if (to === MOCK_CONTRACTS.PassportRegistry) {
    // Mock passport registry responses
    if (data.startsWith('0x70a08231')) { // balanceOf
      return '0x0000000000000000000000000000000000000000000000000000000000000001';
    }
  }
  
  if (to === MOCK_CONTRACTS.ContextVault) {
    // Mock context vault responses
    if (data.startsWith('0x8129fc1c')) { // getContext
      return '0x0000000000000000000000000000000000000000000000000000000000000020';
    }
  }
  
  return '0x';
}

function mineBlock() {
  const newBlock = {
    number: blockchain.currentBlockNumber + 1,
    hash: '0x' + Array.from({length: 64}, () => Math.floor(Math.random() * 16).toString(16)).join(''),
    parentHash: blockchain.blocks[blockchain.currentBlockNumber].hash,
    timestamp: Math.floor(Date.now() / 1000),
    transactions: blockchain.transactions.slice()
  };
  
  blockchain.blocks.push(newBlock);
  blockchain.currentBlockNumber++;
  blockchain.transactions = []; // Clear pending transactions
  
  console.log(`Block mined: ${newBlock.number} (${newBlock.hash})`);
}

// Demo contracts deployment
if (process.env.DEMO_CONTRACTS === 'true') {
  Object.entries(MOCK_CONTRACTS).forEach(([name, address]) => {
    blockchain.contracts.set(address, {
      name,
      deployed: true,
      code: '0x608060405234801561001057600080fd5b50600080fd5b'
    });
    console.log(`Demo contract ${name} deployed at ${address}`);
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`🔗 Blockchain Simulator running on port ${PORT}`);
  console.log(`📊 Network: ${blockchain.chainName} (ID: ${blockchain.networkId})`);
  console.log(`⛏️  Auto-mine: ${process.env.AUTO_MINE === 'true' ? 'enabled' : 'disabled'}`);
  
  if (process.env.DEMO_CONTRACTS === 'true') {
    console.log('📜 Demo contracts deployed:');
    Object.entries(MOCK_CONTRACTS).forEach(([name, address]) => {
      console.log(`   ${name}: ${address}`);
    });
  }
});