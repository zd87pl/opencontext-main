/**
 * Newswire demo: call NewsAPI directly, then through the metered gateway, then read the usage.
 *
 *   NEWSAPI_KEY=... npx tsx examples/newswire-demo.ts
 *
 * The gateway must be running (`npm start`). If the gateway itself has NEWSAPI_KEY set it injects
 * the key; otherwise the client's `X-Api-Key` header is forwarded unchanged.
 */

import { NewswireClient } from '../partners/newswire.js';
import type { MeteringRecord } from '../src/types.js';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3001';
const PASSPORT_ID = process.env.PASSPORT_ID ?? 'demo-passport-123';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} environment variable required`);
    process.exit(1);
  }
  return value;
}

const NEWSAPI_KEY = requireEnv('NEWSAPI_KEY');

async function testDirectAPI(): Promise<void> {
  console.log('=== Direct Newswire API ===');
  const client = new NewswireClient(NEWSAPI_KEY);
  const headlines = await client.getTopHeadlines({ country: 'us', category: 'technology', pageSize: 5 });
  console.log(`Found ${headlines.totalResults} articles`);
  headlines.articles.slice(0, 3).forEach((article, i) => console.log(`${i + 1}. ${article.title}`));
}

async function testGatewayProxy(): Promise<void> {
  console.log('\n=== Gateway proxy ===');
  const response = await fetch(
    `${GATEWAY_URL}/proxy/newswire/top-headlines?country=us&category=technology&pageSize=5`,
    { headers: { 'X-Passport-ID': PASSPORT_ID, 'X-Api-Key': NEWSAPI_KEY } }
  );
  if (!response.ok) {
    throw new Error(`Gateway error: ${response.status} ${await response.text()}`);
  }
  console.log(
    `Metering - cost: ${response.headers.get('x-metering-cost')} wei, ` +
      `bytes: ${response.headers.get('x-metering-bytes')}, ` +
      `upstream time: ${response.headers.get('x-response-time')}`
  );
  const data = (await response.json()) as { totalResults: number };
  console.log(`Proxied ${data.totalResults} articles through the gateway`);
}

async function checkUsage(): Promise<void> {
  console.log('\n=== Usage ===');
  const response = await fetch(`${GATEWAY_URL}/usage/${PASSPORT_ID}?partnerId=newswire`);
  const { usage, totalCost } = (await response.json()) as {
    usage: MeteringRecord[];
    totalCost: string;
  };
  console.log(`Requests: ${usage.length}, lifetime cost: ${totalCost} wei`);
  const latest = usage.at(-1);
  if (latest) console.log(`Latest request: ${latest.bytes} bytes, ${latest.cost} wei`);
}

async function main(): Promise<void> {
  await testDirectAPI();
  await testGatewayProxy();
  await checkUsage();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
