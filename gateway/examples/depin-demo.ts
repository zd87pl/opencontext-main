import { DePINRouter } from '../src/depin.js';

const PASSPORT_ID = process.env.PASSPORT_ID || 'demo-passport-depin';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3001';

async function demonstrateNodeDiscovery() {
  console.log('=== DePIN Node Discovery Demo ===');
  
  const router = new DePINRouter();
  
  const availableNodes = router.getAvailableNodes();
  console.log(`Found ${availableNodes.length} available compute nodes:`);
  
  availableNodes.forEach((node, i) => {
    console.log(`\n${i + 1}. ${node.id}`);
    console.log(`   Endpoint: ${node.endpoint}`);
    console.log(`   GPU: ${node.capabilities.gpu.join(', ')}`);
    console.log(`   Memory: ${node.capabilities.memory}GB`);
    console.log(`   Reputation: ${node.reputation.score}/100 (${node.reputation.totalJobs} jobs, ${Math.round(node.reputation.successRate * 100)}% success)`);
    console.log(`   Pricing: ${node.pricing.perSecond} wei/sec, ${node.pricing.perGPUHour} wei/GPU-hour`);
  });
  
  const availableModels = router.getAvailableModels();
  console.log(`\nAvailable AI models: ${availableModels.map(m => m.name).join(', ')}`);
}

async function demonstrateInferenceJob() {
  console.log('\n=== AI Inference Job Demo ===');
  
  const router = new DePINRouter();
  
  try {
    console.log('Submitting LLaMA-2 inference job...');
    
    const job = await router.submitInferenceJob(
      PASSPORT_ID,
      'llama2-7b',
      {
        prompt: 'Explain quantum computing in simple terms:',
        max_tokens: 100,
        temperature: 0.7
      },
      'cost' // Optimize for cost
    );
    
    console.log(`Job submitted: ${job.id}`);
    console.log(`Assigned to node: ${job.nodeId}`);
    console.log(`Estimated cost: ${job.cost} wei`);
    console.log(`Status: ${job.status}`);
    
    if (job.status === 'completed' && job.output) {
      console.log('\n=== Job Results ===');
      console.log('Output:', job.output);
      
      const runtime = job.endTime ? job.endTime - job.startTime : 0;
      console.log(`Runtime: ${runtime}ms`);
    } else if (job.status === 'failed') {
      console.log(`Job failed: ${job.error}`);
    }
    
  } catch (error) {
    console.error('Inference job error:', error);
  }
}

async function demonstrateNodeOptimization() {
  console.log('\n=== Node Selection Optimization Demo ===');
  
  const router = new DePINRouter();
  const modelName = 'stable-diffusion-xl';
  
  console.log(`Finding optimal nodes for ${modelName}:`);
  
  const costOptimal = router.findOptimalNode(modelName, 'cost');
  const speedOptimal = router.findOptimalNode(modelName, 'speed');
  const reliabilityOptimal = router.findOptimalNode(modelName, 'reliability');
  
  console.log(`\nCost-optimal: ${costOptimal?.id} (${costOptimal?.pricing.perSecond} wei/sec)`);
  console.log(`Speed-optimal: ${speedOptimal?.id} (${speedOptimal?.capabilities.vcpus} vCPUs)`);
  console.log(`Reliability-optimal: ${reliabilityOptimal?.id} (${reliabilityOptimal?.reputation.score}/100 score)`);
}

async function testGatewayDePINIntegration() {
  console.log('\n=== Testing Gateway DePIN Integration ===');
  
  try {
    const response = await fetch(`${GATEWAY_URL}/depin/nodes`, {
      headers: {
        'X-Passport-ID': PASSPORT_ID
      }
    });

    if (!response.ok) {
      throw new Error(`Gateway error: ${response.status}`);
    }

    const nodes = await response.json();
    console.log(`Gateway reports ${nodes.length} available nodes`);
    
    const jobResponse = await fetch(`${GATEWAY_URL}/depin/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Passport-ID': PASSPORT_ID
      },
      body: JSON.stringify({
        model: 'llama2-7b',
        input: {
          prompt: 'What is the future of decentralized AI?',
          max_tokens: 50
        },
        priority: 'cost'
      })
    });

    if (jobResponse.ok) {
      const job = await jobResponse.json();
      console.log(`Gateway job submitted: ${job.id}`);
      console.log(`Cost: ${job.cost} wei`);
      
      const meteringCost = jobResponse.headers.get('x-metering-cost');
      if (meteringCost) {
        console.log(`Gateway metering cost: ${meteringCost} wei`);
      }
    }
    
  } catch (error) {
    console.error('Gateway DePIN integration error:', error);
  }
}

async function demonstrateJobHistory() {
  console.log('\n=== Job History Demo ===');
  
  const router = new DePINRouter();
  
  const jobs = router.getJobsByPassport(PASSPORT_ID);
  console.log(`Found ${jobs.length} jobs for passport ${PASSPORT_ID}`);
  
  jobs.slice(0, 3).forEach((job, i) => {
    const duration = job.endTime ? job.endTime - job.startTime : 'N/A';
    console.log(`\n${i + 1}. ${job.id}`);
    console.log(`   Model: ${job.model}`);
    console.log(`   Status: ${job.status}`);
    console.log(`   Duration: ${duration}ms`);
    console.log(`   Cost: ${job.cost} wei`);
    
    if (job.status === 'failed') {
      console.log(`   Error: ${job.error}`);
    }
  });
  
  const totalCost = jobs.reduce((sum, job) => sum + BigInt(job.cost), 0n);
  console.log(`\nTotal compute spend: ${totalCost.toString()} wei`);
}

async function main() {
  await demonstrateNodeDiscovery();
  await demonstrateInferenceJob();
  await demonstrateNodeOptimization();
  await testGatewayDePINIntegration();
  await demonstrateJobHistory();
}

main().catch(console.error);