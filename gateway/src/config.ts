import { z } from 'zod';
import { config } from 'dotenv';

// Load environment variables
config();

// Gateway-specific environment schema
const gatewayEnvSchema = z.object({
  // Core Configuration
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),

  // Security
  JWT_SECRET: z.string().min(32, 'JWT secret must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('24h'),

  // Blockchain
  RPC_URL: z.string().url().default('https://mainnet.base.org'),
  
  // GitHub OAuth
  GITHUB_CLIENT_ID: z.string().min(1, 'GitHub client ID is required'),
  GITHUB_CLIENT_SECRET: z.string().min(1, 'GitHub client secret is required'),
  GITHUB_REDIRECT_URI: z.string().url().default('http://localhost:3001/auth/github/callback'),

  // API Keys (optional for development)
  NEWSAPI_KEY: z.string().optional(),
  SATELLITE_API_KEY: z.string().optional(),

  // Rate Limiting
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),

  // CORS
  CORS_ORIGIN: z.string().default('*'),
  CORS_CREDENTIALS: z.coerce.boolean().default(false),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // Development flags
  ENABLE_DEBUG_ROUTES: z.coerce.boolean().default(false),
  MOCK_EXTERNAL_APIS: z.coerce.boolean().default(false),
  SKIP_RATE_LIMITING: z.coerce.boolean().default(false),
});

// Validate environment
let gatewayConfig: z.infer<typeof gatewayEnvSchema>;

try {
  gatewayConfig = gatewayEnvSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    const issues = error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
    throw new Error(
      `❌ Gateway environment validation failed:\n${issues.join('\n')}\n\n` +
      `Please check your .env file. Required variables:\n` +
      `- JWT_SECRET (min 32 chars)\n` +
      `- GITHUB_CLIENT_ID\n` +
      `- GITHUB_CLIENT_SECRET\n`
    );
  }
  throw error;
}

// Production-specific validations
if (gatewayConfig.NODE_ENV === 'production') {
  const productionWarnings: string[] = [];

  // Check for development secrets
  if (gatewayConfig.JWT_SECRET.includes('demo') || 
      gatewayConfig.JWT_SECRET === 'demo-secret') {
    productionWarnings.push('JWT_SECRET appears to be a development value');
  }

  if (gatewayConfig.GITHUB_CLIENT_ID.includes('test') ||
      gatewayConfig.GITHUB_CLIENT_SECRET.includes('test')) {
    productionWarnings.push('GitHub OAuth credentials appear to be test values');
  }

  if (productionWarnings.length > 0) {
    console.warn('⚠️  Production environment warnings:');
    productionWarnings.forEach(warning => console.warn(`   - ${warning}`));
  }

  // Require API keys in production
  if (!gatewayConfig.NEWSAPI_KEY && !gatewayConfig.MOCK_EXTERNAL_APIS) {
    console.warn('⚠️  NEWSAPI_KEY not set in production. Newswire features will be limited.');
  }
}

// Helper functions
export const isDevelopment = gatewayConfig.NODE_ENV === 'development';
export const isProduction = gatewayConfig.NODE_ENV === 'production';

export const getAuthConfig = () => ({
  github: {
    clientId: gatewayConfig.GITHUB_CLIENT_ID,
    clientSecret: gatewayConfig.GITHUB_CLIENT_SECRET,
    redirectUri: gatewayConfig.GITHUB_REDIRECT_URI,
  },
  jwt: {
    secret: gatewayConfig.JWT_SECRET,
    expiresIn: gatewayConfig.JWT_EXPIRES_IN,
  },
});

export const getFastifyConfig = () => ({
  logger: {
    level: gatewayConfig.LOG_LEVEL,
    transport: isDevelopment ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        ignore: 'pid,hostname',
        translateTime: 'HH:MM:ss',
      }
    } : undefined,
  },
  trustProxy: isProduction,
});

export const getCorsConfig = () => ({
  origin: gatewayConfig.CORS_ORIGIN === '*' ? true : gatewayConfig.CORS_ORIGIN,
  credentials: gatewayConfig.CORS_CREDENTIALS,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Passport-ID'],
});

export const getRateLimitConfig = () => ({
  max: gatewayConfig.SKIP_RATE_LIMITING ? 0 : gatewayConfig.RATE_LIMIT_MAX,
  timeWindow: gatewayConfig.RATE_LIMIT_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
});

export default gatewayConfig;