import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { MeteringService } from './metering.js';
import { BillingService } from './billing.js';
import { AuthService } from './auth.js';
import { StreamingService } from './streaming.js';
import { DePINRouter } from './depin.js';
import gatewayConfig, { 
  getAuthConfig, 
  getFastifyConfig, 
  getCorsConfig, 
  getRateLimitConfig,
  isDevelopment 
} from './config.js';
import { 
  validateRequest,
  formatErrorResponse,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  ExternalServiceError,
  RateLimitError,
  UsageQuerySchema,
  StreamStartSchema,
  StreamStopSchema,
  StreamingSessionSchema,
  DePINJobSchema,
  GitHubLinkSchema,
  PassportIdSchema
} from './validation.js';

const fastify = Fastify(getFastifyConfig());

// Initialize services with configuration
const metering = new MeteringService();
const billing = new BillingService(gatewayConfig.RPC_URL);
const streaming = new StreamingService();
const depin = new DePINRouter();
const auth = new AuthService(getAuthConfig());

// Register plugins
await fastify.register(helmet, {
  contentSecurityPolicy: isDevelopment ? false : undefined,
});

await fastify.register(sensible);

await fastify.register(cors, getCorsConfig());

await fastify.register(rateLimit, getRateLimitConfig());

// Global error handler
fastify.setErrorHandler(async (error, request, reply) => {
  const errorResponse = formatErrorResponse(error);
  
  if (error instanceof ValidationError) {
    return reply.code(400).send(errorResponse);
  }
  
  if (error instanceof AuthenticationError) {
    return reply.code(401).send(errorResponse);
  }
  
  if (error instanceof AuthorizationError) {
    return reply.code(403).send(errorResponse);
  }
  
  if (error instanceof RateLimitError) {
    return reply.code(429).send(errorResponse);
  }
  
  if (error instanceof ExternalServiceError) {
    return reply.code(error.statusCode || 502).send(errorResponse);
  }
  
  // Log unexpected errors
  fastify.log.error(error, 'Unexpected error occurred');
  return reply.code(500).send(errorResponse);
});

fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.get('/partners', async () => {
  return metering.getAllPartners();
});

fastify.get('/usage/:passportId', async (request, reply) => {
  const { passportId } = request.params as { passportId: string };
  const query = validateRequest(UsageQuerySchema)(request.query);
  
  // Validate passport ID format
  const validatedPassportId = validateRequest(PassportIdSchema)(passportId);
  
  const usage = metering.getUsage(validatedPassportId, query.partnerId, query.since);
  const totalCost = metering.getTotalCost(validatedPassportId, query.partnerId, query.since);
  
  return { usage, totalCost };
});

fastify.get('/streams/:passportId', async (request) => {
  const { passportId } = request.params as { passportId: string };
  return billing.getActiveStreams(passportId);
});

fastify.post('/stream/start', async (request, reply) => {
  const body = validateRequest(StreamStartSchema)(request.body);

  try {
    const session = await billing.startStream(
      body.passportId,
      body.partnerId,
      body.userAddress,
      body.recipientAddress,
      body.flowRate
    );

    return session;
  } catch (error) {
    throw new ExternalServiceError(
      'Failed to start payment stream',
      'superfluid',
      500
    );
  }
});

fastify.post('/stream/stop', async (request, reply) => {
  const body = validateRequest(StreamStopSchema)(request.body);

  try {
    await billing.stopStream(
      body.passportId, 
      body.partnerId, 
      body.userAddress, 
      body.recipientAddress
    );
    return { success: true };
  } catch (error) {
    throw new ExternalServiceError(
      'Failed to stop payment stream',
      'superfluid',
      500
    );
  }
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

fastify.post('/streaming/sessions', async (request, reply) => {
  const body = validateRequest(StreamingSessionSchema)(request.body);

  const session = streaming.createSession(
    body.passportId, 
    body.partnerId, 
    body.totalSize, 
    body.costPerByte, 
    body.chunkSize
  );
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
    throw new AuthenticationError('Passport ID required in X-Passport-ID header');
  }

  // Validate passport ID format
  const validatedPassportId = validateRequest(PassportIdSchema)(passportId);
  const body = validateRequest(DePINJobSchema)(request.body);

  try {
    const job = await depin.submitInferenceJob(
      validatedPassportId, 
      body.model, 
      body.input, 
      body.priority
    );
    
    const record = metering.recordUsage(validatedPassportId, 'compute', 0);
    reply.header('x-metering-cost', record.cost);
    
    return job;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Model not found')) {
      throw new ValidationError('Invalid model specified', [
        { field: 'model', message: error.message, code: 'invalid_model' }
      ]);
    }
    throw new ExternalServiceError(
      'Failed to submit inference job',
      'depin',
      500
    );
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
    throw new ValidationError('Partner not found', [
      { field: 'partnerId', message: `Unknown partner: ${partnerId}`, code: 'unknown_partner' }
    ]);
  }

  const passportId = request.headers['x-passport-id'] as string;
  if (!passportId) {
    throw new AuthenticationError('Passport ID required in X-Passport-ID header');
  }

  // Validate passport ID format
  const validatedPassportId = validateRequest(PassportIdSchema)(passportId);

  const targetUrl = request.url.replace(`/proxy/${partnerId}`, '');
  const proxyUrl = `${partnerConfig.baseUrl}${targetUrl}`;

  // Validate proxy URL
  try {
    new URL(proxyUrl);
  } catch {
    throw new ValidationError('Invalid proxy URL constructed', [
      { field: 'url', message: 'Invalid target URL', code: 'invalid_url' }
    ]);
  }

  try {
    const startTime = Date.now();
    
    // Set timeout for external requests
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
    
    const response = await fetch(proxyUrl, {
      method: request.method,
      headers: {
        ...request.headers,
        'host': new URL(partnerConfig.baseUrl).host,
        'user-agent': 'OpenContext-Gateway/1.0',
      } as Record<string, string>,
      body: request.method !== 'GET' ? JSON.stringify(request.body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new ExternalServiceError(
        `Partner API returned ${response.status}`,
        partnerId,
        response.status
      );
    }

    const responseText = await response.text();
    const bytes = Buffer.byteLength(responseText, 'utf8');
    
    const record = metering.recordUsage(validatedPassportId, partnerId, bytes);
    
    reply.header('x-metering-cost', record.cost);
    reply.header('x-metering-bytes', bytes.toString());
    reply.header('x-response-time', `${Date.now() - startTime}ms`);
    reply.code(response.status);
    
    return response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(responseText)
      : responseText;

  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ExternalServiceError('Request timeout', partnerId, 408);
    }
    
    if (error instanceof ExternalServiceError) {
      throw error;
    }
    
    fastify.log.error({ error, partnerId, proxyUrl }, 'Proxy request failed');
    throw new ExternalServiceError(
      `Failed to proxy request to ${partnerId}`,
      partnerId,
      502
    );
  }
});

const start = async () => {
  try {
    await fastify.listen({ 
      port: gatewayConfig.PORT, 
      host: gatewayConfig.HOST 
    });
    
    fastify.log.info({
      port: gatewayConfig.PORT,
      host: gatewayConfig.HOST,
      environment: gatewayConfig.NODE_ENV,
    }, 'Gateway proxy server started');
    
    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      fastify.log.info(`Received ${signal}, shutting down gracefully`);
      await fastify.close();
      process.exit(0);
    };
    
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    
  } catch (err) {
    fastify.log.error(err, 'Error starting server');
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

start();