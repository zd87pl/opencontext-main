import { z } from 'zod';
import { config } from 'dotenv';
import { join } from 'path';

// Load environment variables
config({ path: join(process.cwd(), '.env') });

// Environment validation schema
const envSchema = z.object({
  // Core Configuration
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),

  // Blockchain Configuration
  ETH_RPC_URL: z.string().url().optional(),
  BASE_RPC_URL: z.string().url().default('https://mainnet.base.org'),
  ZKSYNC_SEPOLIA_RPC_URL: z.string().url().default('https://sepolia.era.zksync.dev'),
  ZKSYNC_MAINNET_RPC_URL: z.string().url().default('https://mainnet.era.zksync.io'),

  // Private Keys (validate format but allow test keys)
  DEPLOYER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  TREASURY_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),

  // Contract Addresses (optional, filled after deployment)
  PASSPORT_REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  CONTEXT_VAULT_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  PAYMENT_STREAM_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),

  // API Keys
  ETHERSCAN_API_KEY: z.string().min(1).optional(),
  BASESCAN_API_KEY: z.string().min(1).optional(),

  // Authentication & Security
  JWT_SECRET: z.string().min(32, 'JWT secret must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('24h'),
  SESSION_SECRET: z.string().min(32, 'Session secret must be at least 32 characters'),

  // Third-party Integrations
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  GITHUB_REDIRECT_URI: z.string().url().optional(),
  NEWSAPI_KEY: z.string().min(1).optional(),
  SATELLITE_API_KEY: z.string().min(1).optional(),

  // Database Configuration
  DATABASE_URL: z.string().url().optional(),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string().default('opencontext'),
  DB_USER: z.string().default('opencontext_user'),
  DB_PASSWORD: z.string().min(1).optional(),

  // Redis Configuration
  REDIS_URL: z.string().url().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  // Monitoring & Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  METRICS_ENABLED: z.coerce.boolean().default(true),
  PROMETHEUS_PORT: z.coerce.number().default(9090),
  SENTRY_DSN: z.string().url().optional(),

  // Superfluid Configuration
  SUPERFLUID_HOST_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  SUPERFLUID_CFA_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  USDCX_TOKEN_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),

  // Development Configuration
  TEST_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  TEST_MNEMONIC: z.string().optional(),
  ENABLE_DEBUG_ROUTES: z.coerce.boolean().default(false),
  MOCK_EXTERNAL_APIS: z.coerce.boolean().default(false),
  SKIP_RATE_LIMITING: z.coerce.boolean().default(false),
});

// Parse and validate environment variables
let env: z.infer<typeof envSchema>;

try {
  env = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    const missingVars = error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    throw new Error(
      `❌ Invalid environment configuration:\n${missingVars.join('\n')}\n\n` +
      `Please check your .env file and ensure all required variables are set.\n` +
      `See .env.example for reference.`
    );
  }
  throw error;
}

// Production-specific validations
if (env.NODE_ENV === 'production') {
  const requiredForProduction = [
    'JWT_SECRET',
    'SESSION_SECRET',
    'DATABASE_URL',
    'ETH_RPC_URL'
  ];

  const missing = requiredForProduction.filter(key => !env[key as keyof typeof env]);
  if (missing.length > 0) {
    throw new Error(
      `❌ Missing required environment variables for production:\n${missing.join(', ')}\n\n` +
      `Please set these variables in your .env file.`
    );
  }

  // Warn about development keys in production
  if (env.DEPLOYER_PRIVATE_KEY?.includes('test') || 
      env.JWT_SECRET.includes('demo') ||
      env.SESSION_SECRET.includes('demo')) {
    console.warn('⚠️  WARNING: Using development keys in production environment!');
  }
}

// Helper functions for common configurations
export const isDevelopment = env.NODE_ENV === 'development';
export const isProduction = env.NODE_ENV === 'production';
export const isTest = process.env.NODE_ENV === 'test';

export const getChainConfig = (chainName: 'mainnet' | 'base' | 'zksync_sepolia' | 'zksync_mainnet') => {
  const configs = {
    mainnet: { rpcUrl: env.ETH_RPC_URL, chainId: 1 },
    base: { rpcUrl: env.BASE_RPC_URL, chainId: 8453 },
    zksync_sepolia: { rpcUrl: env.ZKSYNC_SEPOLIA_RPC_URL, chainId: 300 },
    zksync_mainnet: { rpcUrl: env.ZKSYNC_MAINNET_RPC_URL, chainId: 324 },
  };
  
  return configs[chainName];
};

export const getDatabaseConfig = () => {
  if (env.DATABASE_URL) {
    return { url: env.DATABASE_URL };
  }
  
  return {
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
  };
};

export const getRedisConfig = () => {
  if (env.REDIS_URL) {
    return { url: env.REDIS_URL };
  }
  
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
  };
};

export default env;