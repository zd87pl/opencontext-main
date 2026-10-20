/**
 * HTTP-level behaviour of the app that the integration suite does not cover: proxy security
 * (SSRF, base-path escapes, header hygiene, credential injection), upstream failure mapping,
 * rate limiting, payment-stream routes, auth routes and the error envelope.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { ethers } from 'ethers';
import { createApp, type AppOptions } from '../src/app.js';
import { BillingService, CFA_V1_FORWARDER_ABI } from '../src/billing.js';
import { MeteringService } from '../src/metering.js';
import { AuthService } from '../src/auth.js';
import { MemoryStorage } from '../src/storage.js';
import { CircuitOpenError, UpstreamTimeoutError } from '../src/connection-pool.js';
import { FakeUpstream } from './helpers.js';
import type { MeteringRecord, PaymentStreamSession } from '../src/types.js';

const PASSPORT = { 'X-Passport-ID': 'app-test-passport' };
const SENDER = '0x1111111111111111111111111111111111111111';
const RECEIVER = '0x2222222222222222222222222222222222222222';

describe('Gateway app', () => {
  const apps: FastifyInstance[] = [];

  async function build(options: AppOptions = {}): Promise<{ app: FastifyInstance; upstream: FakeUpstream }> {
    const upstream = new FakeUpstream();
    const app = await createApp({
      ipRateLimit: false,
      passportRateLimit: false,
      credentials: {},
      ...options,
      services: { upstream, ...options.services },
    });
    await app.ready();
    apps.push(app);
    return { app, upstream };
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  describe('proxy security', () => {
    it('blocks partners whose base URL points at internal addresses (SSRF)', async () => {
      const metering = new MeteringService();
      metering.registerPartner({
        id: 'internal',
        name: 'Internal',
        baseUrl: 'http://169.254.169.254/latest',
        costPerByte: '0',
        costPerRequest: '0',
        authRequired: false,
      });
      const { app, upstream } = await build({ services: { metering } });

      const response = await app.inject({ method: 'GET', url: '/proxy/internal/meta-data', headers: PASSPORT });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ message: string }>().message).toContain('internal resources');
      expect(upstream.requests).toHaveLength(0);
    });

    it('rejects paths that escape the partner base path', async () => {
      // `inject` normalises dot segments before routing, so send the raw request line over TCP
      // the way a real client would.
      const { app, upstream } = await build();
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;

      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: '/proxy/newswire/x/../../v1/other', headers: PASSPORT },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          }
        );
        req.on('error', reject);
        req.end();
      });

      expect(response.status).toBe(400);
      expect(JSON.parse(response.body).message).toContain('escapes the partner base path');
      expect(upstream.requests).toHaveLength(0);
    });

    it('strips hop-by-hop, cookie and gateway headers but forwards the rest', async () => {
      const { app, upstream } = await build();
      await app.inject({
        method: 'GET',
        url: '/proxy/github/user',
        headers: {
          ...PASSPORT,
          cookie: 'session=abc',
          connection: 'keep-alive',
          'x-forwarded-for': '1.2.3.4',
          accept: 'application/vnd.github+json',
          'x-api-key': 'client-key',
        },
      });
      const headers = upstream.requests[0].headers!;
      expect(headers.cookie).toBeUndefined();
      expect(headers.connection).toBeUndefined();
      expect(headers['x-passport-id']).toBeUndefined();
      expect(headers.host).toBeUndefined();
      expect(headers.accept).toBe('application/vnd.github+json');
      expect(headers['x-api-key']).toBe('client-key');
      expect(headers['x-forwarded-for']).toBe('127.0.0.1');
    });

    it('forwards the client Authorization header when the gateway has no credential', async () => {
      const { app, upstream } = await build();
      await app.inject({
        method: 'GET',
        url: '/proxy/github/user',
        headers: { ...PASSPORT, authorization: 'Bearer client-token' },
      });
      expect(upstream.requests[0].headers?.authorization).toBe('Bearer client-token');
    });

    it('injects the gateway credential and drops the client Authorization header', async () => {
      const { app, upstream } = await build({
        credentials: { GITHUB_TOKEN: 'gateway-token', NEWSAPI_KEY: 'news-key', SATELLITE_API_KEY: 'planet-key' },
      });

      await app.inject({ method: 'GET', url: '/proxy/github/user', headers: { ...PASSPORT, authorization: 'Bearer client' } });
      expect(upstream.requests[0].headers?.authorization).toBe('Bearer gateway-token');

      await app.inject({ method: 'GET', url: '/proxy/newswire/top-headlines', headers: PASSPORT });
      expect(upstream.requests[1].headers?.['x-api-key']).toBe('news-key');

      await app.inject({ method: 'GET', url: '/proxy/satellite/quick-search', headers: PASSPORT });
      expect(upstream.requests[2].headers?.authorization).toBe(
        `Basic ${Buffer.from('planet-key:').toString('base64')}`
      );

      const partners = await app.inject({ method: 'GET', url: '/partners' });
      const github = partners.json<Array<{ id: string; upstreamAuth?: { configured: boolean } }>>().find((p) => p.id === 'github');
      expect(github?.upstreamAuth?.configured).toBe(true);
    });

    it('forwards JSON and binary request bodies', async () => {
      const { app, upstream } = await build();
      await app.inject({
        method: 'POST',
        url: '/proxy/github/repos/o/r/issues',
        headers: PASSPORT,
        payload: { title: 'Hello <b>world</b>' },
      });
      expect(upstream.requests[0].method).toBe('POST');
      expect(upstream.requests[0].body?.toString()).toBe('{"title":"Hello <b>world</b>"}');

      await app.inject({
        method: 'PUT',
        url: '/proxy/satellite/upload',
        headers: { ...PASSPORT, 'content-type': 'application/octet-stream' },
        payload: Buffer.from([1, 2, 3]),
      });
      expect(Buffer.isBuffer(upstream.requests[1].body)).toBe(true);
      expect((upstream.requests[1].body as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true);
    });
  });

  describe('proxy responses', () => {
    it('relays upstream status, body and content headers and meters every byte', async () => {
      const metering = new MeteringService();
      const { app, upstream } = await build({ services: { metering } });
      upstream.respond = () => ({
        status: 404,
        statusText: 'Not Found',
        headers: { 'content-type': 'text/plain', etag: '"abc"', 'set-cookie': 'a=b', 'transfer-encoding': 'chunked' },
        body: Buffer.from('nope'),
      });

      const response = await app.inject({ method: 'GET', url: '/proxy/github/missing', headers: PASSPORT });
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe('nope');
      expect(response.headers['content-type']).toBe('text/plain');
      expect(response.headers.etag).toBe('"abc"');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['x-metering-bytes']).toBe('4');

      const usage = await metering.getUsage('app-test-passport', 'github');
      expect(usage).toHaveLength(1);
      expect(usage[0].bytes).toBe(4);
    });

    it('maps upstream timeouts to 504 and open circuits to 503 without metering', async () => {
      const metering = new MeteringService();
      const { app, upstream } = await build({ services: { metering } });

      upstream.respond = () => {
        throw new UpstreamTimeoutError('https://api.github.com/user', 10);
      };
      let response = await app.inject({ method: 'GET', url: '/proxy/github/user', headers: PASSPORT });
      expect(response.statusCode).toBe(504);
      expect(response.json<{ error: string; service: string }>()).toMatchObject({
        error: 'External Service Error',
        service: 'github',
      });

      upstream.respond = () => {
        throw new CircuitOpenError('api.github.com');
      };
      response = await app.inject({ method: 'GET', url: '/proxy/github/user', headers: PASSPORT });
      expect(response.statusCode).toBe(503);

      upstream.respond = () => {
        throw new Error('ECONNRESET');
      };
      response = await app.inject({ method: 'GET', url: '/proxy/github/user', headers: PASSPORT });
      expect(response.statusCode).toBe(502);

      expect(await metering.getUsage('app-test-passport')).toHaveLength(0);
    });

    it('rejects malformed passport IDs', async () => {
      const { app } = await build();
      const response = await app.inject({
        method: 'GET',
        url: '/proxy/github/user',
        headers: { 'X-Passport-ID': 'bad passport/id' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('rate limiting', () => {
    it('limits per passport and sets Retry-After', async () => {
      const { app } = await build({ passportRateLimit: { windowMs: 60000, max: 2 } });
      const request = () => app.inject({ method: 'GET', url: '/health', headers: PASSPORT });

      const first = await request();
      expect(first.statusCode).toBe(200);
      expect(first.headers['x-passport-ratelimit-remaining']).toBe('1');
      await request();
      const third = await request();
      expect(third.statusCode).toBe(429);
      expect(third.json<{ error: string }>().error).toBe('Rate Limit Exceeded');
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);

      // Another passport has its own budget.
      const other = await app.inject({ method: 'GET', url: '/health', headers: { 'X-Passport-ID': 'other' } });
      expect(other.statusCode).toBe(200);
    });

    it('limits per client IP', async () => {
      const { app } = await build({ ipRateLimit: { max: 2, timeWindow: '1 minute' } });
      await app.inject({ method: 'GET', url: '/health' });
      await app.inject({ method: 'GET', url: '/health' });
      const third = await app.inject({ method: 'GET', url: '/health' });
      expect(third.statusCode).toBe(429);
      expect(third.json<{ error: string; statusCode: number }>()).toMatchObject({
        error: 'Too Many Requests',
        statusCode: 429,
      });
    });
  });

  describe('payment streams', () => {
    it('prepares unsigned CFAv1Forwarder transactions', async () => {
      const { app } = await build();
      const response = await app.inject({
        method: 'POST',
        url: '/stream/prepare',
        payload: { sender: SENDER, receiver: RECEIVER, flowRate: '385802469135802' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ createFlow: { to: string; data: string; chainId: number }; deleteFlow: { data: string } }>();
      const iface = new ethers.Interface(CFA_V1_FORWARDER_ABI);
      expect(body.createFlow.data.startsWith(iface.getFunction('createFlow')!.selector)).toBe(true);
      expect(body.deleteFlow.data.startsWith(iface.getFunction('deleteFlow')!.selector)).toBe(true);
      expect(body.createFlow.chainId).toBe(8453);
    });

    it('verifies the flow on-chain before registering a stream', async () => {
      const getFlowrate = vi.fn().mockResolvedValue(0n);
      const billing = new BillingService({ storage: new MemoryStorage(), flowReader: { getFlowrate } });
      const { app } = await build({ services: { billing } });
      const payload = { passportId: 'p1', partnerId: 'github', sender: SENDER, receiver: RECEIVER, flowRate: '1000' };

      let response = await app.inject({ method: 'POST', url: '/stream/start', payload });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ message: string }>().message).toContain('below the requested');

      getFlowrate.mockResolvedValue(1000n);
      response = await app.inject({ method: 'POST', url: '/stream/start', payload });
      expect(response.statusCode).toBe(200);
      const session = response.json<PaymentStreamSession>();
      expect(session.active).toBe(true);
      expect(session.flowRate).toBe('1000');
      expect(getFlowrate).toHaveBeenLastCalledWith(billing.superToken, SENDER, RECEIVER);

      response = await app.inject({ method: 'POST', url: '/stream/start', payload });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ message: string }>().message).toContain('already active');

      const listed = await app.inject({ method: 'GET', url: '/streams/p1' });
      expect(listed.json<Array<{ partnerId: string; accruedCost: string }>>()).toHaveLength(1);

      response = await app.inject({ method: 'POST', url: '/stream/stop', payload: { passportId: 'p1', partnerId: 'github' } });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ success: boolean; onChainFlowRate: string; note?: string }>()).toMatchObject({
        success: true,
        onChainFlowRate: '1000',
      });
      expect(response.json<{ note?: string }>().note).toContain('still running');

      response = await app.inject({ method: 'POST', url: '/stream/stop', payload: { passportId: 'p1', partnerId: 'github' } });
      expect(response.statusCode).toBe(404);
    });

    it('reports RPC failures as upstream errors', async () => {
      const billing = new BillingService({
        storage: new MemoryStorage(),
        flowReader: { getFlowrate: async () => Promise.reject(new Error('rpc down')) },
      });
      const { app } = await build({ services: { billing } });
      const response = await app.inject({
        method: 'POST',
        url: '/stream/start',
        payload: { passportId: 'p1', partnerId: 'github', sender: SENDER, receiver: RECEIVER, flowRate: '1' },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json<{ service: string }>().service).toBe('chain-rpc');
    });

    it('validates stream payloads', async () => {
      const { app } = await build();
      const response = await app.inject({
        method: 'POST',
        url: '/stream/prepare',
        payload: { sender: 'not-an-address', receiver: RECEIVER, flowRate: '0' },
      });
      expect(response.statusCode).toBe(400);
      const fields = response.json<{ issues: Array<{ field: string }> }>().issues.map((i) => i.field);
      expect(fields).toEqual(expect.arrayContaining(['sender', 'flowRate']));
    });
  });

  describe('auth routes', () => {
    it('returns 503 when GitHub OAuth is not configured', async () => {
      const { app } = await build();
      const response = await app.inject({ method: 'GET', url: '/auth/github/login' });
      expect(response.statusCode).toBe(503);
      expect(response.json<{ error: string }>().error).toBe('Service Unavailable');
    });

    it('rejects forged OAuth states and requires OAuth before wallet linking', async () => {
      const auth = new AuthService({
        github: { clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost/cb' },
      });
      const { app } = await build({ services: { auth } });

      const login = await app.inject({ method: 'GET', url: '/auth/github/login' });
      expect(login.statusCode).toBe(200);
      expect(login.json<{ url: string }>().url).toContain('github.com/login/oauth/authorize');

      const callback = await app.inject({ method: 'GET', url: '/auth/github/callback?code=abc&state=forged' });
      expect(callback.statusCode).toBe(401);

      const wallet = ethers.Wallet.createRandom();
      const link = await app.inject({
        method: 'POST',
        url: '/auth/link-wallet',
        payload: {
          walletAddress: wallet.address,
          signature: await wallet.signMessage('anything'),
          githubUserId: 42,
        },
      });
      expect(link.statusCode).toBe(401);
      expect(link.json<{ message: string }>().message).toContain('Complete GitHub OAuth');
    });

    it('serves and revokes sessions by bearer token', async () => {
      const auth = new AuthService();
      const wallet = ethers.Wallet.createRandom();
      const user = { id: 7, login: 'octo', name: null, email: null, avatar_url: '' };
      const token = await auth.linkWalletToGitHub(
        wallet.address,
        await wallet.signMessage(auth.buildLinkMessage(user.login, wallet.address)),
        user
      );
      const { app } = await build({ services: { auth } });

      const missing = await app.inject({ method: 'GET', url: '/auth/session' });
      expect(missing.statusCode).toBe(401);

      const session = await app.inject({ method: 'GET', url: '/auth/session', headers: { authorization: `Bearer ${token}` } });
      expect(session.statusCode).toBe(200);
      expect(session.json<{ passportId: string }>().passportId).toBe(`github:7:${wallet.address}`);

      const revoked = await app.inject({ method: 'DELETE', url: '/auth/session', headers: { authorization: `Bearer ${token}` } });
      expect(revoked.statusCode).toBe(200);
      const after = await app.inject({ method: 'GET', url: '/auth/session', headers: { authorization: `Bearer ${token}` } });
      expect(after.statusCode).toBe(401);
    });
  });

  describe('streaming session lifecycle', () => {
    it('pauses, resumes and cancels through the API', async () => {
      const { app } = await build();
      const created = await app.inject({
        method: 'POST',
        url: '/streaming/sessions',
        payload: { passportId: 'p', partnerId: 'satellite', totalSize: 10, costPerByte: '1' },
      });
      const id = created.json<{ id: string }>().id;

      expect((await app.inject({ method: 'POST', url: `/streaming/sessions/${id}/resume` })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: `/streaming/sessions/${id}/pause` })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/streaming/sessions/${id}/resume` })).statusCode).toBe(200);
      const cancelled = await app.inject({ method: 'POST', url: `/streaming/sessions/${id}/cancel` });
      expect(cancelled.json<{ status: string }>().status).toBe('cancelled');
      expect((await app.inject({ method: 'POST', url: '/streaming/sessions/missing/pause' })).statusCode).toBe(404);
    });
  });

  describe('usage routes', () => {
    it('serves per-passport analytics and totals', async () => {
      const metering = new MeteringService();
      await metering.recordUsage('analytics-passport', 'github', 123);
      const { app } = await build({ services: { metering } });

      const usage = await app.inject({ method: 'GET', url: '/usage/analytics-passport' });
      const body = usage.json<{ usage: MeteringRecord[]; totals: { bytes: string; requests: number } }>();
      expect(body.usage).toHaveLength(1);
      expect(body.totals).toMatchObject({ bytes: '123', requests: 1 });

      const analytics = await app.inject({ method: 'GET', url: '/usage/analytics-passport/analytics?days=2' });
      expect(analytics.statusCode).toBe(200);
      expect(analytics.json<{ totalBytes: string; dailyBreakdown: unknown[] }>()).toMatchObject({ totalBytes: '123' });
      expect(analytics.json<{ dailyBreakdown: unknown[] }>().dailyBreakdown).toHaveLength(2);

      const bad = await app.inject({ method: 'GET', url: '/usage/analytics-passport?since=soon' });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('error envelope', () => {
    it('hides internal error details in production', async () => {
      const metering = new MeteringService();
      vi.spyOn(metering, 'getAllPartners').mockImplementation(() => {
        throw new Error('database exploded');
      });
      const { app } = await build({ services: { metering } });

      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const response = await app.inject({ method: 'GET', url: '/partners' });
        expect(response.statusCode).toBe(500);
        expect(response.json<{ error: string; message: string }>()).toMatchObject({
          error: 'Internal Server Error',
          message: 'An unexpected error occurred',
        });
      } finally {
        process.env.NODE_ENV = previous;
      }

      const dev = await app.inject({ method: 'GET', url: '/partners' });
      expect(dev.json<{ message: string }>().message).toBe('database exploded');
    });

    it('sets API security headers on every response', async () => {
      const { app } = await build();
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });
});
