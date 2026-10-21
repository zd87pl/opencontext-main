/**
 * Builds a fully configured gateway from the environment and starts listening. Shared by the
 * single-process entry (`proxy.ts`) and cluster workers (`worker.ts`).
 */

import 'dotenv/config';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { AuthService } from './auth.js';
import { BillingService } from './billing.js';
import {
  getAuthConfig,
  getCorsConfig,
  getLoggerConfig,
  isProduction,
  loadGatewayConfig,
  type GatewayConfig,
} from './config.js';
import { ConnectionPool } from './connection-pool.js';
import { DePINRouter } from './depin.js';
import { MeteringService } from './metering.js';
import { createStorageAdapter } from './storage.js';
import { StreamingService } from './streaming.js';

export async function startServer(
  config: GatewayConfig = loadGatewayConfig()
): Promise<FastifyInstance> {
  const storage = createStorageAdapter(
    config.REDIS_URL ? { redis: { url: config.REDIS_URL }, keyPrefix: 'opencontext' } : undefined
  );
  const upstream = new ConnectionPool({ maxSockets: 100, maxFreeSockets: 20 });

  const app = await createApp({
    services: {
      metering: new MeteringService({ storage }),
      streaming: new StreamingService({ storage }),
      billing: new BillingService({
        rpcUrl: config.RPC_URL,
        chainId: config.CHAIN_ID,
        superToken: config.SUPER_TOKEN_ADDRESS,
        forwarder: config.CFA_FORWARDER_ADDRESS,
        storage,
      }),
      auth: new AuthService(getAuthConfig(config)),
      depin: new DePINRouter(),
      upstream,
    },
    logger: getLoggerConfig(config),
    trustProxy: isProduction(config),
    cors: getCorsConfig(config),
    ipRateLimit: config.SKIP_RATE_LIMITING
      ? false
      : { max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW },
    passportRateLimit: config.SKIP_RATE_LIMITING
      ? false
      : { windowMs: 60000, max: config.PASSPORT_RATE_LIMIT_MAX },
  });

  // The services were created here, so their resources are released here too.
  app.addHook('onClose', async () => {
    upstream.destroy();
    await storage.close();
  });

  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(
    {
      host: config.HOST,
      port: config.PORT,
      environment: config.NODE_ENV,
      storage: storage.kind,
      chainId: config.CHAIN_ID,
      rateLimiting: !config.SKIP_RATE_LIMITING,
      githubOAuth: Boolean(config.GITHUB_CLIENT_ID),
    },
    'Gateway started'
  );

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'Shutdown failed');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  return app;
}
