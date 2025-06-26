import { NewswireClient } from '../partners/newswire.js';

const NEWSWIRE_API_KEY = process.env.NEWSWIRE_API_KEY;
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3001';
const PASSPORT_ID = process.env.PASSPORT_ID || 'demo-passport-123';

if (!NEWSWIRE_API_KEY) {
  console.error('NEWSWIRE_API_KEY environment variable required');
  process.exit(1);
}

async function testDirectAPI() {
  console.log('=== Testing Direct Newswire API ===');
  
  const client = new NewswireClient(NEWSWIRE_API_KEY);
  
  try {
    const headlines = await client.getTopHeadlines('us', 'technology', undefined, undefined, 5);
    console.log(`Found ${headlines.totalResults} articles`);
    console.log('Sample headlines:');
    headlines.articles.slice(0, 3).forEach((article, i) => {
      console.log(`${i + 1}. ${article.title}`);
    });
  } catch (error) {
    console.error('Direct API error:', error);
  }
}

async function testGatewayProxy() {
  console.log('\n=== Testing Gateway Proxy ===');
  
  try {
    const response = await fetch(`${GATEWAY_URL}/proxy/newswire/top-headlines?country=us&category=technology&apiKey=${NEWSWIRE_API_KEY}`, {
      headers: {
        'X-Passport-ID': PASSPORT_ID
      }
    });

    if (!response.ok) {
      throw new Error(`Gateway error: ${response.status} ${response.statusText}`);
    }

    const meteringCost = response.headers.get('x-metering-cost');
    const meteringBytes = response.headers.get('x-metering-bytes');
    
    console.log(`Metering - Cost: ${meteringCost} wei, Bytes: ${meteringBytes}`);

    const data = await response.json();
    console.log(`Proxied ${data.totalResults} articles through gateway`);
    
  } catch (error) {
    console.error('Gateway proxy error:', error);
  }
}

async function checkUsage() {
  console.log('\n=== Checking Usage Statistics ===');
  
  try {
    const response = await fetch(`${GATEWAY_URL}/usage/${PASSPORT_ID}?partnerId=newswire`);
    const { usage, totalCost } = await response.json();
    
    console.log(`Total requests: ${usage.length}`);
    console.log(`Total cost: ${totalCost} wei`);
    
    if (usage.length > 0) {
      const latest = usage[usage.length - 1];
      console.log(`Latest request: ${latest.bytes} bytes, ${latest.cost} wei`);
    }
    
  } catch (error) {
    console.error('Usage check error:', error);
  }
}

async function main() {
  await testDirectAPI();
  await testGatewayProxy();
  await checkUsage();
}

main().catch(console.error);