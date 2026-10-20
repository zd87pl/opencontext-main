/**
 * Environment configuration. Every variable has a default or is optional so that `npm start`
 * works on a fresh checkout; see `.env.example` for the full list.
 */

import { z } from 'zod';
import type { FastifyCorsOptions } from '@fastify/cors';
import type { FastifyServerOptions } from 'fastify';
import type { AuthConfig } from './auth.js';
import { BASE_CHAIN_ID, BASE_USDCX_ADDRESS, CFA_V1_FORWARDER_ADDRESS } from './billing.js';

/** `z.coerce.boolean()` treats the string "false" as true; parse the usual spellings instead. */
const boolish = z.preprocess((value) => {
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return value;
}, z.boolean());

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');

const gatewayEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  REDIS_URL: z.string().url().optional(),

  RPC_URL: z.string().url().default('https://mainnet.base.org'),
  CHAIN_ID: z.coerce.number().int().positive().default(BASE_CHAIN_ID),
  SUPER_TOKEN_ADDRESS: address.default(BASE_USDCX_ADDRESS),
  CFA_FORWARDER_ADDRESS: address.default(CFA_V1_FORWARDER_ADDRESS),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_REDIRECT_URI: z.string().url().default('http://localhost:3001/auth/github/callback'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  PASSPORT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(1000),
  SKIP_RATE_LIMITING: boolish.default(false),

  CORS_ORIGIN: z.string().default('*'),
  CORS_CREDENTIALS: boolish.default(false),
});

export type GatewayConfig = z.infer<typeof gatewayEnvSchema>;

export class GatewayConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Gateway environment validation failed:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'GatewayConfigError';
  }
}

/** Parse configuration from an environment. Empty strings count as unset. */
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== '')
  );
  const result = gatewayEnvSchema.safeParse(present);
  if (!result.success) {
    throw new GatewayConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    );
  }

  const config = result.data;
  if (config.NODE_ENV === 'production' && !config.REDIS_URL) {
    console.warn('REDIS_URL is not set: metering data lives in process memory and is lost on restart.');
  }
  return config;
}

export const isDevelopment = (config: GatewayConfig): boolean => config.NODE_ENV === 'development';
export const isProduction = (config: GatewayConfig): boolean => config.NODE_ENV === 'production';

export function getAuthConfig(config: GatewayConfig): AuthConfig {
  if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) {
    return {};
  }
  return {
    github: {
      clientId: config.GITHUB_CLIENT_ID,
      clientSecret: config.GITHUB_CLIENT_SECRET,
      redirectUri: config.GITHUB_REDIRECT_URI,
    },
  };
}

export function getLoggerConfig(config: GatewayConfig): FastifyServerOptions['logger'] {
  return {
    level: config.LOG_LEVEL,
    transport: isDevelopment(config)
      ? {
          target: 'pino-pretty',
          options: { colorize: true, ignore: 'pid,hostname', translateTime: 'HH:MM:ss' },
        }
      : undefined,
  };
}

export function getCorsConfig(config: GatewayConfig): FastifyCorsOptions {
  return {
    origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: config.CORS_CREDENTIALS,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Passport-ID'],
    exposedHeaders: [
      'X-Metering-Cost',
      'X-Metering-Bytes',
      'X-Response-Time',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
  };
}
