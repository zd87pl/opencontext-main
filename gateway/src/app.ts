/**
 * The gateway HTTP application. `createApp` wires routes to services and returns a Fastify
 * instance without binding a port, so the same app runs in `proxy.ts`, in cluster workers and
 * in tests (via `app.inject`). Every service can be injected; omitted ones get in-memory defaults.
 */

import { STATUS_CODES } from 'node:http';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import cors, { type FastifyCorsOptions } from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { MeteringService } from './metering.js';
import { BillingService } from './billing.js';
import { AuthService, AuthNotConfiguredError, InvalidOAuthStateError } from './auth.js';
import { StreamingService } from './streaming.js';
import { DePINRouter, type InferenceJob } from './depin.js';
import {
  CircuitOpenError,
  ConnectionPool,
  UpstreamResponseTooLargeError,
  UpstreamTimeoutError,
  type PooledResponse,
  type UpstreamClient,
} from './connection-pool.js';
import { PassportRateLimiter } from './rate-limiter.js';
import { isProxyablePartner } from '../partners/index.js';
import {
  HOP_BY_HOP_HEADERS,
  MAX_PAYLOAD_SIZE,
  REQUEST_TIMEOUT,
  getSecurityHeaders,
  sanitizeHeaders,
  validatePayloadSize,
  validateProxyUrl,
} from './security.js';
import {
  AuthenticationError,
  ConflictError,
  DePINJobSchema,
  ExternalServiceError,
  GatewayError,
  GitHubCallbackSchema,
  GitHubLinkSchema,
  NotFoundError,
  PassportIdSchema,
  RateLimitError,
  ServiceUnavailableError,
  StreamPrepareSchema,
  StreamStartSchema,
  StreamStopSchema,
  StreamingSessionSchema,
  UsageQuerySchema,
  ValidationError,
  formatErrorResponse,
  validateRequest,
} from './validation.js';
import type { PartnerConfig, UpstreamAuth } from './types.js';

export const GATEWAY_VERSION = '0.2.0';
export const USER_AGENT = `OpenContext-Gateway/${GATEWAY_VERSION}`;

export interface AppServices {
  metering: MeteringService;
  billing: BillingService;
  streaming: StreamingService;
  depin: DePINRouter;
  auth: AuthService;
  upstream: UpstreamClient;
}

export interface AppOptions {
  /** Services to use; any omitted service is created with in-memory defaults and owned by the app. */
  services?: Partial<AppServices>;
  logger?: FastifyServerOptions['logger'];
  trustProxy?: boolean;
  cors?: FastifyCorsOptions | false;
  /** Per-client-IP limit (@fastify/rate-limit); `false` disables it. */
  ipRateLimit?: { max: number; timeWindow: string | number } | false;
  /** Per-passport limit; `false` disables it. */
  passportRateLimit?: { windowMs: number; max: number } | false;
  /** Where upstream partner credentials are read from (env var name -> value). Defaults to `process.env`. */
  credentials?: Record<string, string | undefined>;
  bodyLimit?: number;
  /** Upstream request timeout in milliseconds. */
  upstreamTimeoutMs?: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: AppServices;
  }
}

/** Response headers from the upstream that must not be relayed to the client. */
const DROPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-length',
  'set-cookie',
  'strict-transport-security',
]);

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requirePassport(request: FastifyRequest): string {
  const value = headerValue(request.headers['x-passport-id']);
  if (!value) {
    throw new AuthenticationError('Passport ID required in X-Passport-ID header');
  }
  return validateRequest(PassportIdSchema)(value);
}

function resolveUpstreamCredential(
  auth: UpstreamAuth | undefined,
  credentials: Record<string, string | undefined>
): { header: string; value: string } | undefined {
  const secret = auth ? credentials[auth.envVar] : undefined;
  if (!auth || !secret) return undefined;
  const value =
    auth.scheme === 'bearer'
      ? `Bearer ${secret}`
      : auth.scheme === 'basic'
        ? `Basic ${Buffer.from(`${secret}:`).toString('base64')}`
        : secret;
  return { header: auth.header.toLowerCase(), value };
}

function publicPartnerView(partner: PartnerConfig, credentials: Record<string, string | undefined>) {
  const { upstreamAuth, ...rest } = partner;
  return {
    ...rest,
    proxyable: isProxyablePartner(partner),
    upstreamAuth: upstreamAuth
      ? {
          header: upstreamAuth.header,
          scheme: upstreamAuth.scheme,
          configured: Boolean(credentials[upstreamAuth.envVar]),
        }
      : undefined,
  };
}

function bodyToBuffer(body: unknown): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const credentials = options.credentials ?? process.env;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? REQUEST_TIMEOUT;

  const provided = options.services ?? {};
  const services: AppServices = {
    metering: provided.metering ?? new MeteringService(),
    billing: provided.billing ?? new BillingService(),
    streaming: provided.streaming ?? new StreamingService(),
    depin: provided.depin ?? new DePINRouter(),
    auth: provided.auth ?? new AuthService(),
    upstream: provided.upstream ?? new ConnectionPool({ timeout: upstreamTimeoutMs }),
  };
  const { metering, billing, streaming, depin, auth, upstream } = services;

  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? false,
    bodyLimit: options.bodyLimit ?? MAX_PAYLOAD_SIZE,
  });
  app.decorate('services', services);

  // Non-JSON bodies (e.g. form posts or binary uploads bound for a partner) arrive as Buffers.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));

  await app.register(helmet, { contentSecurityPolicy: false, strictTransportSecurity: false });
  if (options.cors !== false) {
    await app.register(cors, options.cors ?? { origin: true });
  }
  if (options.ipRateLimit !== false) {
    await app.register(rateLimit, {
      max: options.ipRateLimit?.max ?? 100,
      timeWindow: options.ipRateLimit?.timeWindow ?? '1 minute',
    });
  }

  const passportLimiter =
    options.passportRateLimit === false
      ? null
      : new PassportRateLimiter(options.passportRateLimit ?? { windowMs: 60000, max: 1000 });

  app.addHook('onRequest', async (request, reply) => {
    const size = validatePayloadSize(headerValue(request.headers['content-length']));
    if (!size.valid) {
      throw new ValidationError(size.error ?? 'Invalid payload size', [
        { field: 'body', message: size.error ?? 'Invalid payload', code: 'payload_too_large' },
      ]);
    }

    if (passportLimiter) {
      const info = passportLimiter.checkLimit(request);
      reply.header('X-Passport-RateLimit-Limit', info.limit.toString());
      reply.header('X-Passport-RateLimit-Remaining', info.remaining.toString());
      reply.header('X-Passport-RateLimit-Reset', info.resetTime.toISOString());
      if (info.exceeded) {
        throw new RateLimitError(
          `Rate limit exceeded. Try again at ${info.resetTime.toISOString()}`,
          info.resetTime
        );
      }
    }
  });

  app.addHook('onSend', async (_request, reply) => {
    for (const [name, value] of Object.entries(getSecurityHeaders())) {
      reply.header(name, value);
    }
  });

  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    const fastifyStatus = (error as FastifyError).statusCode;
    const statusCode =
      error instanceof GatewayError
        ? error.statusCode
        : typeof fastifyStatus === 'number' && fastifyStatus >= 400
          ? fastifyStatus
          : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Request failed');
    }
    if (error instanceof RateLimitError && error.resetTime) {
      const seconds = Math.max(1, Math.ceil((error.resetTime.getTime() - Date.now()) / 1000));
      reply.header('Retry-After', seconds.toString());
    }

    const body = formatErrorResponse(error, statusCode);
    if (!(error instanceof GatewayError) && statusCode < 500) {
      body.error = STATUS_CODES[statusCode] ?? body.error;
    }
    return reply.code(statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new NotFoundError(`Route ${request.method} ${request.url} not found`);
    return reply.code(404).send(formatErrorResponse(error, 404));
  });

  app.addHook('onClose', async () => {
    const ownsStorage = (service: keyof AppServices) => provided[service] === undefined;
    if (ownsStorage('metering')) await metering.close();
    if (ownsStorage('streaming')) await streaming.close();
    if (ownsStorage('billing')) await billing.close();
    if (ownsStorage('upstream') && upstream instanceof ConnectionPool) upstream.destroy();
  });

  // ---- service discovery ------------------------------------------------------------------

  app.get('/health', async () => ({
    status: 'ok',
    version: GATEWAY_VERSION,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    storage: metering.storageKind,
    chainId: billing.chainId,
    superToken: billing.superToken,
    githubOAuth: auth.isGitHubConfigured(),
  }));

  app.get('/stats', async () => ({
    timestamp: new Date().toISOString(),
    upstream: upstream instanceof ConnectionPool ? upstream.getDetailedStats() : upstream.getStats(),
    passportRateLimiter: passportLimiter ? { trackedKeys: passportLimiter.trackedKeys } : null,
    streaming: await streaming.getStreamingStats(),
  }));

  app.get('/partners', async () =>
    metering.getAllPartners().map((partner) => publicPartnerView(partner, credentials))
  );

  // ---- usage ------------------------------------------------------------------------------

  app.get('/usage/:passportId', async (request) => {
    const { passportId: rawPassportId } = request.params as { passportId: string };
    const passportId = validateRequest(PassportIdSchema)(rawPassportId);
    const query = validateRequest(UsageQuerySchema)(request.query);

    const [usage, totalCost, totals] = await Promise.all([
      metering.getUsage(passportId, query.partnerId, query.since),
      metering.getTotalCost(passportId, query.partnerId, query.since),
      metering.getTotals(passportId, query.partnerId),
    ]);
    return { usage, totalCost, totals };
  });

  app.get('/usage/:passportId/analytics', async (request) => {
    const { passportId: rawPassportId } = request.params as { passportId: string };
    const passportId = validateRequest(PassportIdSchema)(rawPassportId);
    const { partnerId, days } = request.query as { partnerId?: string; days?: string };
    const window = Math.min(90, Math.max(1, Number(days) || 30));
    return metering.getAnalytics(passportId, partnerId, window);
  });

  // ---- payment streams --------------------------------------------------------------------

  app.get('/streams/:passportId', async (request) => {
    const { passportId: rawPassportId } = request.params as { passportId: string };
    const passportId = validateRequest(PassportIdSchema)(rawPassportId);
    const streams = await billing.getActiveStreams(passportId);
    return streams.map((session) => ({
      ...session,
      accruedCost: billing.calculateAccruedCost(session),
    }));
  });

  app.post('/stream/prepare', async (request) => {
    const body = validateRequest(StreamPrepareSchema)(request.body);
    return {
      chainId: billing.chainId,
      token: billing.superToken,
      forwarder: billing.forwarder,
      createFlow: billing.buildCreateFlowTx(body.sender, body.receiver, body.flowRate),
      updateFlow: billing.buildUpdateFlowTx(body.sender, body.receiver, body.flowRate),
      deleteFlow: billing.buildDeleteFlowTx(body.sender, body.receiver),
    };
  });

  app.post('/stream/start', async (request) => {
    const body = validateRequest(StreamStartSchema)(request.body);
    try {
      return await billing.startStream(
        body.passportId,
        body.partnerId,
        body.sender,
        body.receiver,
        body.flowRate
      );
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new ExternalServiceError(
        `Failed to verify the payment stream on-chain: ${(error as Error).message}`,
        'chain-rpc'
      );
    }
  });

  app.post('/stream/stop', async (request) => {
    const body = validateRequest(StreamStopSchema)(request.body);
    const { session, onChainFlowRate } = await billing.stopStream(body.passportId, body.partnerId);
    return {
      success: true,
      session,
      accruedCost: billing.calculateAccruedCost(session),
      onChainFlowRate: onChainFlowRate.toString(),
      note:
        onChainFlowRate > 0n
          ? 'The on-chain flow is still running; delete it from the sender wallet (see /stream/prepare).'
          : undefined,
    };
  });

  // ---- auth -------------------------------------------------------------------------------

  const withOAuthConfigured = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AuthNotConfiguredError) {
        throw new ServiceUnavailableError(error.message);
      }
      throw error;
    }
  };

  app.get('/auth/github/login', async () => ({
    url: await withOAuthConfigured(() => auth.initiateGitHubOAuth()),
  }));

  app.get('/auth/github/callback', async (request) => {
    const { code, state } = validateRequest(GitHubCallbackSchema)(request.query);
    const user = await withOAuthConfigured(async () => {
      try {
        return await auth.handleGitHubCallback(code, state);
      } catch (error) {
        if (error instanceof InvalidOAuthStateError) {
          throw new AuthenticationError(error.message);
        }
        if (error instanceof AuthNotConfiguredError) throw error;
        throw new ExternalServiceError((error as Error).message, 'github');
      }
    });
    return {
      user: { id: user.id, login: user.login, name: user.name, avatar_url: user.avatar_url },
      message: 'Sign the link message with your wallet and POST it to /auth/link-wallet',
      linkMessage: auth.buildLinkMessage(user.login, '<your wallet address>'),
    };
  });

  app.post('/auth/link-wallet', async (request) => {
    const body = validateRequest(GitHubLinkSchema)(request.body);
    const user = auth.getPendingGitHubUser(body.githubUserId);
    if (!user) {
      throw new AuthenticationError('Complete GitHub OAuth before linking a wallet');
    }
    let sessionToken: string;
    try {
      sessionToken = await auth.linkWalletToGitHub(body.walletAddress, body.signature, user);
    } catch {
      throw new AuthenticationError('Invalid signature for the link message');
    }
    const session = auth.validateSession(sessionToken);
    return { sessionToken, passportId: session?.passportId, expires: session?.expires };
  });

  const bearerToken = (request: FastifyRequest): string => {
    const header = headerValue(request.headers.authorization) ?? '';
    const match = header.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      throw new AuthenticationError('Bearer session token required');
    }
    return match[1];
  };

  app.get('/auth/session', async (request) => {
    const session = auth.validateSession(bearerToken(request));
    if (!session) {
      throw new AuthenticationError('Session is invalid or expired');
    }
    return session;
  });

  app.delete('/auth/session', async (request) => {
    auth.revokeSession(bearerToken(request));
    return { success: true };
  });

  // ---- chunked transfers ------------------------------------------------------------------

  app.post('/streaming/sessions', async (request, reply) => {
    const body = validateRequest(StreamingSessionSchema)(request.body);
    const session = await streaming.createSession(
      body.passportId,
      body.partnerId,
      body.totalSize,
      body.costPerByte,
      body.chunkSize
    );
    return reply.code(201).send(session);
  });

  app.get('/streaming/sessions/:sessionId', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = await streaming.getSession(sessionId);
    if (!session) {
      throw new NotFoundError(`Streaming session not found: ${sessionId}`);
    }
    return session;
  });

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/streaming/sessions/:sessionId/${action}`, async (request) => {
      const { sessionId } = request.params as { sessionId: string };
      const session = await streaming.getSession(sessionId);
      if (!session) {
        throw new NotFoundError(`Streaming session not found: ${sessionId}`);
      }
      const changed = await streaming[`${action}Session`](sessionId);
      if (!changed) {
        throw new ConflictError(`Cannot ${action} a session that is ${session.status}`);
      }
      return streaming.getSession(sessionId);
    });
  }

  // ---- DePIN compute ----------------------------------------------------------------------

  app.get('/depin/nodes', async () => depin.getAvailableNodes());
  app.get('/depin/models', async () => depin.getAvailableModels());

  app.post('/depin/jobs', async (request, reply) => {
    const passportId = requirePassport(request);
    const body = validateRequest(DePINJobSchema)(request.body);

    let job: InferenceJob;
    try {
      job = await depin.submitInferenceJob(passportId, body.model, body.input, body.priority);
    } catch (error) {
      const message = (error as Error).message ?? '';
      if (message.startsWith('Model not found')) {
        throw new ValidationError(message, [{ field: 'model', message, code: 'invalid_model' }]);
      }
      if (message.startsWith('No available nodes')) {
        throw new ServiceUnavailableError(message);
      }
      throw new ExternalServiceError(message || 'Failed to submit inference job', 'depin');
    }

    // Failed jobs are not billed: only completed work is metered (scheduling fee + node price).
    if (job.status === 'completed') {
      const record = await metering.recordUsage(passportId, 'compute', 0, {
        additionalCost: job.cost,
      });
      reply.header('x-metering-cost', record.cost);
    }
    return reply.code(job.status === 'failed' ? 502 : 201).send(job);
  });

  app.get('/depin/jobs/:jobId', async (request) => {
    const { jobId } = request.params as { jobId: string };
    const job = depin.getJob(jobId);
    if (!job) {
      throw new NotFoundError(`Job not found: ${jobId}`);
    }
    return job;
  });

  app.get('/depin/jobs', async (request) => depin.getJobsByPassport(requirePassport(request)));

  // ---- metered proxy ----------------------------------------------------------------------

  app.all('/proxy/:partnerId/*', async (request, reply) => {
    const { partnerId } = request.params as { partnerId: string };
    const partner = metering.getPartnerConfig(partnerId);
    if (!partner) {
      throw new NotFoundError(`Partner not found: ${partnerId}`);
    }
    if (!isProxyablePartner(partner)) {
      throw new NotFoundError(`Partner ${partnerId} is not reachable through the proxy`);
    }
    const passportId = requirePassport(request);

    const prefix = `/proxy/${partnerId}`;
    const suffix = request.url.startsWith(prefix) ? request.url.slice(prefix.length) : '/';
    const targetUrl = `${partner.baseUrl.replace(/\/+$/, '')}${suffix.startsWith('/') ? '' : '/'}${suffix}`;
    const urlCheck = validateProxyUrl(targetUrl, { baseUrl: partner.baseUrl });
    if (!urlCheck.valid) {
      throw new ValidationError(urlCheck.error ?? 'Invalid proxy URL', [
        { field: 'url', message: urlCheck.error ?? 'Invalid target URL', code: 'invalid_url' },
      ]);
    }

    const credential = resolveUpstreamCredential(partner.upstreamAuth, credentials);
    const headers = sanitizeHeaders(request.headers, { stripAuthorization: credential !== undefined });
    if (credential) headers[credential.header] = credential.value;
    headers['user-agent'] = USER_AGENT;
    headers['x-forwarded-for'] = request.ip;

    const body =
      request.method === 'GET' || request.method === 'HEAD' ? undefined : bodyToBuffer(request.body);

    const startedAt = Date.now();
    let response: PooledResponse;
    try {
      response = await upstream.requestWithCircuitBreaker({
        method: request.method,
        url: targetUrl,
        headers,
        body,
        timeout: upstreamTimeoutMs,
      });
    } catch (error) {
      request.log.warn({ err: error, partnerId, targetUrl }, 'Upstream request failed');
      if (error instanceof UpstreamTimeoutError) {
        throw new ExternalServiceError('Upstream request timed out', partnerId, 504);
      }
      if (error instanceof CircuitOpenError) {
        throw new ExternalServiceError('Partner is temporarily unavailable (circuit open)', partnerId, 503);
      }
      if (error instanceof UpstreamResponseTooLargeError) {
        throw new ExternalServiceError(error.message, partnerId, 502);
      }
      throw new ExternalServiceError(`Failed to reach ${partnerId}`, partnerId, 502);
    }

    const record = await metering.recordUsage(passportId, partnerId, response.body.length);

    for (const [name, value] of Object.entries(response.headers)) {
      if (!DROPPED_RESPONSE_HEADERS.has(name)) reply.header(name, value);
    }
    reply.header('x-metering-cost', record.cost);
    reply.header('x-metering-bytes', response.body.length.toString());
    reply.header('x-response-time', `${Date.now() - startedAt}ms`);
    return reply.code(response.status).send(response.body);
  });

  return app;
}
