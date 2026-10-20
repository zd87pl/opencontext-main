import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import passport from 'passport';
import RedisStore from 'connect-redis';
import { createClient } from 'redis';
import dotenv from 'dotenv';
import { logger } from './common/logger.js';
import { errorHandler } from './common/middleware/error-handler.js';
import { authRouter } from './auth/auth.router.js';
import { userRouter } from './users/user.router.js';
import { paymentRouter } from './payments/payment.router.js';
import { contentRouter } from './content/content.router.js';
import { mcpRouter } from './mcp/server.js';
import { aiAgentRouter } from './mcp/ai-agent.router.js';
import { configurePassport } from './auth/passport.config.js';
import { setupAutoDecryption, autoDecryptContent } from './content/auto-decrypt.middleware.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  logger.error('SESSION_SECRET environment variable is required');
  process.exit(1);
}

// Session store: Redis when reachable, otherwise express-session's in-memory
// store (single process, sessions lost on restart).
async function createSessionStore(): Promise<session.Store | undefined> {
  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set: sessions are memory-only');
    return undefined;
  }

  const redisClient = createClient({
    url: process.env.REDIS_URL,
    socket: { connectTimeout: 2000, reconnectStrategy: (retries) => (retries >= 3 ? false : 250) }
  });
  redisClient.on('error', (err) => logger.error('Redis Client Error', err));

  try {
    await redisClient.connect();
    logger.info('Redis connected successfully');
    return new RedisStore({ client: redisClient, prefix: 'opencontext:sess:' });
  } catch (error) {
    logger.error('Failed to connect to Redis:', error);
    logger.warn('Continuing without Redis: sessions are memory-only');
    return undefined;
  }
}

const sessionStore = await createSessionStore();

app.use(helmet());
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
    credentials: true
  })
);

// Stripe signs the raw body, so this route must not go through the JSON parser.
app.use('/api/payments/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
  })
);

app.use(passport.initialize());
app.use(passport.session());
configurePassport();

// Auto-decryption middleware (after authentication)
app.use(setupAutoDecryption);
app.use(autoDecryptContent);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

app.use('/auth', authRouter);
app.use('/api/users', userRouter);
app.use('/api/payments', paymentRouter);
app.use('/api/content', contentRouter);
app.use('/mcp', mcpRouter);
app.use('/api/ai-agents', aiAgentRouter);

// Error handling middleware (must be last)
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`OpenContext Backend running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
  logger.info(`Google OAuth configured: ${!!process.env.GOOGLE_CLIENT_ID}`);
});
