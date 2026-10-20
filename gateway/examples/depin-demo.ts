/**
 * DePIN compute demo: node discovery, priority-based routing and job submission, in-process and
 * through the gateway (`npm start` must be running for the gateway part).
 *
 * The bundled nodes are placeholders whose endpoints do not resolve, so jobs submitted to them
 * end in `failed` with a DNS error; register a real node to see a completed job.
 *
 *   npx tsx examples/depin-demo.ts
 */

import { DePINRouter, type ComputeNode, type InferenceJob } from '../src/depin.js';

const PASSPORT_ID = process.env.PASSPORT_ID ?? 'demo-passport-depin';
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3001';

function describeNode(node: ComputeNode, index: number): void {
  console.log(`\n${index + 1}. ${node.id}`);
  console.log(`   Endpoint:   ${node.endpoint}`);
  console.log(`   GPU:        ${node.capabilities.gpu.join(', ')}, ${node.capabilities.memory} GB RAM`);
  console.log(
    `   Reputation: ${node.reputation.score}/100 (${node.reputation.totalJobs} jobs, ${Math.round(node.reputation.successRate * 100)}% success)`
  );
  console.log(`   Pricing:    ${node.pricing.perSecond} wei/s, ${node.pricing.perGPUHour} wei/GPU-hour`);
}

async function demonstrateRouting(router: DePINRouter): Promise<void> {
  console.log('=== Node discovery ===');
  router.getAvailableNodes().forEach(describeNode);
  console.log(`\nModels: ${router.getAvailableModels().map((m) => m.name).join(', ')}`);

  console.log('\n=== Node selection by priority (stable-diffusion-xl) ===');
  for (const priority of ['cost', 'speed', 'reliability'] as const) {
    const node = router.findOptimalNode('stable-diffusion-xl', priority);
    console.log(`${priority.padEnd(12)} -> ${node?.id ?? 'none'} (${node?.pricing.perSecond} wei/s)`);
  }
}

async function demonstrateJob(router: DePINRouter): Promise<void> {
  console.log('\n=== Inference job ===');
  const job = await router.submitInferenceJob(
    PASSPORT_ID,
    'llama2-7b',
    { prompt: 'Explain quantum computing in simple terms:', max_tokens: 100, temperature: 0.7 },
    'cost'
  );
  console.log(`Job ${job.id} on ${job.nodeId}: ${job.status}, quoted ${job.cost} wei`);
  if (job.status === 'completed') {
    console.log('Output:', JSON.stringify(job.output));
  } else {
    console.log(`Error: ${job.error}`);
  }

  const jobs = router.getJobsByPassport(PASSPORT_ID);
  const quoted = jobs.reduce((sum, j) => sum + BigInt(j.cost), 0n);
  console.log(`History: ${jobs.length} job(s), ${quoted} wei quoted`);
}

async function testGateway(): Promise<void> {
  console.log('\n=== Gateway DePIN API ===');
  const nodesResponse = await fetch(`${GATEWAY_URL}/depin/nodes`);
  if (!nodesResponse.ok) {
    throw new Error(`Gateway error: ${nodesResponse.status}`);
  }
  const nodes = (await nodesResponse.json()) as ComputeNode[];
  console.log(`Gateway reports ${nodes.length} available node(s)`);

  const jobResponse = await fetch(`${GATEWAY_URL}/depin/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Passport-ID': PASSPORT_ID },
    body: JSON.stringify({
      model: 'llama2-7b',
      input: { prompt: 'What is the future of decentralized AI?', max_tokens: 50 },
      priority: 'cost',
    }),
  });
  const job = (await jobResponse.json()) as InferenceJob;
  console.log(`Gateway job ${job.id}: HTTP ${jobResponse.status}, status ${job.status}`);
  const metered = jobResponse.headers.get('x-metering-cost');
  console.log(metered ? `Metered cost: ${metered} wei` : 'Not billed (job did not complete)');
}

async function main(): Promise<void> {
  const router = new DePINRouter();
  await demonstrateRouting(router);
  await demonstrateJob(router);
  await testGateway().catch((error: unknown) => {
    console.error('Gateway not reachable:', error instanceof Error ? error.message : error);
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
