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
import { configurePassport } from './auth/passport.config.js';
import { setupAutoDecryption, autoDecryptContent } from './content/auto-decrypt.middleware.js';

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Redis client for session storage
const redisClient = createClient({
  url: process.env.REDIS_URL
});

redisClient.on('error', (err) => logger.error('Redis Client Error', err));

// Initialize Redis connection with error handling
try {
  await redisClient.connect();
  logger.info('Redis connected successfully');
} catch (error) {
  logger.error('Failed to connect to Redis:', error);
  logger.warn('Continuing without Redis - sessions will be memory-only');
}

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Validate session secret
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  logger.error('SESSION_SECRET environment variable is required');
  process.exit(1);
}

// Session configuration with Redis store
app.use(session({
  store: new RedisStore({
    client: redisClient,
    prefix: 'opencontext:sess:'
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Passport middleware
app.use(passport.initialize());
app.use(passport.session());

// Configure Passport strategies
configurePassport();

// Auto-decryption middleware (after authentication)
app.use(setupAutoDecryption);
app.use(autoDecryptContent);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// API Routes
app.use('/auth', authRouter);
app.use('/api/users', userRouter);
app.use('/api/payments', paymentRouter);
app.use('/api/content', contentRouter);

// Error handling middleware (must be last)
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  logger.info(`OpenContext Backend running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
  logger.info(`OAuth ready: Google Client ID configured: ${!!process.env.GOOGLE_CLIENT_ID}`);
});