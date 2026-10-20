import { describe, expect, it } from 'vitest';
import {
  GatewayConfigError,
  getAuthConfig,
  getCorsConfig,
  getLoggerConfig,
  isDevelopment,
  isProduction,
  loadGatewayConfig,
} from '../src/config.js';
import { BASE_USDCX_ADDRESS, CFA_V1_FORWARDER_ADDRESS } from '../src/billing.js';

describe('loadGatewayConfig', () => {
  it('works with an empty environment', () => {
    const config = loadGatewayConfig({});
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3001,
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      RPC_URL: 'https://mainnet.base.org',
      CHAIN_ID: 8453,
      SUPER_TOKEN_ADDRESS: BASE_USDCX_ADDRESS,
      CFA_FORWARDER_ADDRESS: CFA_V1_FORWARDER_ADDRESS,
      RATE_LIMIT_MAX: 100,
      PASSPORT_RATE_LIMIT_MAX: 1000,
      SKIP_RATE_LIMITING: false,
      CORS_ORIGIN: '*',
      CORS_CREDENTIALS: false,
    });
    expect(config.REDIS_URL).toBeUndefined();
    expect(config.GITHUB_CLIENT_ID).toBeUndefined();
  });

  it('parses booleans the way people write them in .env files', () => {
    expect(loadGatewayConfig({ SKIP_RATE_LIMITING: 'false' }).SKIP_RATE_LIMITING).toBe(false);
    expect(loadGatewayConfig({ SKIP_RATE_LIMITING: '0' }).SKIP_RATE_LIMITING).toBe(false);
    expect(loadGatewayConfig({ SKIP_RATE_LIMITING: 'true' }).SKIP_RATE_LIMITING).toBe(true);
    expect(loadGatewayConfig({ CORS_CREDENTIALS: 'YES' }).CORS_CREDENTIALS).toBe(true);
    expect(loadGatewayConfig({ CORS_CREDENTIALS: 'on' }).CORS_CREDENTIALS).toBe(true);
  });

  it('treats empty strings as unset', () => {
    const config = loadGatewayConfig({ REDIS_URL: '', GITHUB_CLIENT_ID: '', PORT: '' });
    expect(config.REDIS_URL).toBeUndefined();
    expect(config.GITHUB_CLIENT_ID).toBeUndefined();
    expect(config.PORT).toBe(3001);
  });

  it('coerces and validates numbers, URLs and addresses', () => {
    expect(loadGatewayConfig({ PORT: '8080', CHAIN_ID: '84532' })).toMatchObject({ PORT: 8080, CHAIN_ID: 84532 });
    expect(() => loadGatewayConfig({ PORT: 'eighty' })).toThrow(GatewayConfigError);
    expect(() => loadGatewayConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadGatewayConfig({ RPC_URL: 'not a url' })).toThrow(/RPC_URL/);
    expect(() => loadGatewayConfig({ SUPER_TOKEN_ADDRESS: '0x123' })).toThrow(/SUPER_TOKEN_ADDRESS/);
    expect(() => loadGatewayConfig({ NODE_ENV: 'qa' })).toThrow(/NODE_ENV/);
    expect(loadGatewayConfig({ REDIS_URL: 'redis://cache:6379' }).REDIS_URL).toBe('redis://cache:6379');
  });

  it('lists every problem in one error', () => {
    try {
      loadGatewayConfig({ PORT: 'x', LOG_LEVEL: 'loud' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayConfigError);
      expect((error as GatewayConfigError).issues).toHaveLength(2);
      expect((error as Error).message).toContain('PORT');
      expect((error as Error).message).toContain('LOG_LEVEL');
    }
  });

  it('distinguishes environments', () => {
    expect(isDevelopment(loadGatewayConfig({}))).toBe(true);
    expect(isProduction(loadGatewayConfig({ NODE_ENV: 'production' }))).toBe(true);
    expect(isDevelopment(loadGatewayConfig({ NODE_ENV: 'production' }))).toBe(false);
  });
});

describe('derived configuration', () => {
  it('enables GitHub OAuth only when both credentials are present', () => {
    expect(getAuthConfig(loadGatewayConfig({}))).toEqual({});
    expect(getAuthConfig(loadGatewayConfig({ GITHUB_CLIENT_ID: 'id' }))).toEqual({});
    expect(
      getAuthConfig(loadGatewayConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's' }))
    ).toEqual({
      github: { clientId: 'id', clientSecret: 's', redirectUri: 'http://localhost:3001/auth/github/callback' },
    });
  });

  it('builds CORS options from a wildcard or a list', () => {
    expect(getCorsConfig(loadGatewayConfig({})).origin).toBe(true);
    expect(getCorsConfig(loadGatewayConfig({ CORS_ORIGIN: 'https://a.com, https://b.com' })).origin).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
    expect(getCorsConfig(loadGatewayConfig({})).exposedHeaders).toContain('X-Metering-Cost');
  });

  it('pretty-prints logs in development only', () => {
    const dev = getLoggerConfig(loadGatewayConfig({})) as { level: string; transport?: { target: string } };
    expect(dev.level).toBe('info');
    expect(dev.transport?.target).toBe('pino-pretty');
    const prod = getLoggerConfig(loadGatewayConfig({ NODE_ENV: 'production', LOG_LEVEL: 'warn' })) as {
      level: string;
      transport?: unknown;
    };
    expect(prod.level).toBe('warn');
    expect(prod.transport).toBeUndefined();
  });
});
