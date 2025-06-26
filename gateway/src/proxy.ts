import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { MeteringService } from './metering.js';
import { BillingService } from './billing.js';
import { AuthService } from './auth.js';
import { StreamingService } from './streaming.js';
import { DePINRouter } from './depin.js';

const fastify = Fastify({ logger: true });

const metering = new MeteringService();
const billing = new BillingService(process.env.RPC_URL || 'https://mainnet.base.org');
const streaming = new StreamingService();
const depin = new DePINRouter();

const authConfig = {
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    redirectUri: process.env.GITHUB_REDIRECT_URI || 'http://localhost:3001/auth/github/callback'
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'demo-secret',
    expiresIn: '24h'
  }
};
const auth = new AuthService(authConfig);

await fastify.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE']
});

await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute'
});

fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.get('/partners', async () => {
  return metering.getAllPartners();
});

fastify.get('/usage/:passportId', async (request) => {
  const { passportId } = request.params as { passportId: string };
  const { partnerId, since } = request.query as { partnerId?: string; since?: string };
  
  const sinceTime = since ? parseInt(since) : undefined;
  const usage = metering.getUsage(passportId, partnerId, sinceTime);
  const totalCost = metering.getTotalCost(passportId, partnerId, sinceTime);
  
  return { usage, totalCost };
});

fastify.get('/streams/:passportId', async (request) => {
  const { passportId } = request.params as { passportId: string };
  return billing.getActiveStreams(passportId);
});

fastify.post('/stream/start', async (request) => {
  const { passportId, partnerId, userAddress, recipientAddress, flowRate } = request.body as {
    passportId: string;
    partnerId: string;
    userAddress: string;
    recipientAddress: string;
    flowRate: string;
  };

  const session = await billing.startStream(
    passportId,
    partnerId,
    userAddress,
    recipientAddress,
    flowRate
  );

  return session;
});

fastify.post('/stream/stop', async (request) => {
  const { passportId, partnerId, userAddress, recipientAddress } = request.body as {
    passportId: string;
    partnerId: string;
    userAddress: string;
    recipientAddress: string;
  };

  await billing.stopStream(passportId, partnerId, userAddress, recipientAddress);
  return { success: true };
});

fastify.get('/auth/github/login', async () => {
  const oauthUrl = await auth.initiateGitHubOAuth();
  return { url: oauthUrl };
});

fastify.get('/auth/github/callback', async (request, reply) => {
  const { code, state } = request.query as { code: string; state: string };
  
  try {
    const githubUser = await auth.handleGitHubCallback(code, state);
    return { user: githubUser, message: 'Sign a message with your wallet to complete linking' };
  } catch (error) {
    return reply.code(400).send({ error: 'OAuth callback failed' });
  }
});

fastify.post('/auth/link-wallet', async (request, reply) => {
  const { walletAddress, signature, githubUserId } = request.body as {
    walletAddress: string;
    signature: string;
    githubUserId: number;
  };

  try {
    const sessionToken = await auth.linkWalletToGitHub(
      walletAddress,
      signature,
      { id: githubUserId } as any
    );
    
    return { sessionToken };
  } catch (error) {
    return reply.code(400).send({ error: 'Wallet linking failed' });
  }
});

fastify.post('/streaming/sessions', async (request) => {
  const { passportId, partnerId, totalSize, costPerByte, chunkSize } = request.body as {
    passportId: string;
    partnerId: string;
    totalSize: number;
    costPerByte: string;
    chunkSize?: number;
  };

  const session = streaming.createSession(passportId, partnerId, totalSize, costPerByte, chunkSize);
  return session;
});

fastify.get('/streaming/sessions/:sessionId', async (request) => {
  const { sessionId } = request.params as { sessionId: string };
  const session = streaming.getSession(sessionId);
  
  if (!session) {
    return { error: 'Session not found' };
  }
  
  return session;
});

fastify.get('/depin/nodes', async () => {
  return depin.getAvailableNodes();
});

fastify.get('/depin/models', async () => {
  return depin.getAvailableModels();
});

fastify.post('/depin/jobs', async (request, reply) => {
  const passportId = request.headers['x-passport-id'] as string;
  if (!passportId) {
    return reply.code(401).send({ error: 'Passport ID required' });
  }

  const { model, input, priority } = request.body as {
    model: string;
    input: any;
    priority?: 'cost' | 'speed' | 'reliability';
  };

  try {
    const job = await depin.submitInferenceJob(passportId, model, input, priority);
    
    const record = metering.recordUsage(passportId, 'compute', 0);
    reply.header('x-metering-cost', record.cost);
    
    return job;
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : 'Job submission failed' });
  }
});

fastify.get('/depin/jobs/:jobId', async (request) => {
  const { jobId } = request.params as { jobId: string };
  const job = depin.getJob(jobId);
  
  if (!job) {
    return { error: 'Job not found' };
  }
  
  return job;
});

fastify.get('/depin/jobs', async (request) => {
  const passportId = request.headers['x-passport-id'] as string;
  if (!passportId) {
    return { error: 'Passport ID required' };
  }
  
  return depin.getJobsByPassport(passportId);
});

fastify.all('/proxy/:partnerId/*', async (request, reply) => {
  const { partnerId } = request.params as { partnerId: string };
  const partnerConfig = metering.getPartnerConfig(partnerId);
  
  if (!partnerConfig) {
    return reply.code(404).send({ error: 'Partner not found' });
  }

  const passportId = request.headers['x-passport-id'] as string;
  if (!passportId) {
    return reply.code(401).send({ error: 'Passport ID required' });
  }

  const targetUrl = request.url.replace(`/proxy/${partnerId}`, '');
  const proxyUrl = `${partnerConfig.baseUrl}${targetUrl}`;

  try {
    const startTime = Date.now();
    
    const response = await fetch(proxyUrl, {
      method: request.method,
      headers: {
        ...request.headers,
        'host': new URL(partnerConfig.baseUrl).host
      } as Record<string, string>,
      body: request.method !== 'GET' ? JSON.stringify(request.body) : undefined
    });

    const responseText = await response.text();
    const bytes = Buffer.byteLength(responseText, 'utf8');
    
    const record = metering.recordUsage(passportId, partnerId, bytes);
    
    reply.header('x-metering-cost', record.cost);
    reply.header('x-metering-bytes', bytes.toString());
    reply.code(response.status);
    
    return response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(responseText)
      : responseText;

  } catch (error) {
    console.error('Proxy error:', error);
    return reply.code(500).send({ error: 'Proxy request failed' });
  }
});

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3001');
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Gateway proxy running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();