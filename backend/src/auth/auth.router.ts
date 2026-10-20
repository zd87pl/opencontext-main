import { Router, Request, Response, NextFunction } from 'express';
import passport from 'passport';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { logger } from '../common/logger.js';
import { AppError } from '../common/middleware/error-handler.js';
import { isGoogleOAuthConfigured } from './passport.config.js';

export const authRouter = Router();

/** JWT_EXPIRES_IN accepts a number of seconds or anything `ms` understands ("24h", "7d"). */
function jwtExpiresIn(): NonNullable<SignOptions['expiresIn']> {
  const raw = process.env.JWT_EXPIRES_IN ?? '24h';
  return /^\d+$/.test(raw) ? Number(raw) : (raw as NonNullable<SignOptions['expiresIn']>);
}

function requireGoogleOAuth(_req: Request, _res: Response, next: NextFunction): void {
  if (!isGoogleOAuthConfigured()) {
    next(new AppError(503, 'Google OAuth is not configured on this server'));
    return;
  }
  next();
}

// Initiate Google OAuth flow
authRouter.get('/google', requireGoogleOAuth, passport.authenticate('google', { scope: ['profile', 'email'] }));

// Google OAuth callback
authRouter.get(
  '/google/callback',
  requireGoogleOAuth,
  passport.authenticate('google', { failureRedirect: '/auth/failure' }),
  (req, res) => {
    try {
      const user = req.user;
      const jwtSecret = process.env.JWT_SECRET;
      if (!user || !jwtSecret) {
        throw new Error(user ? 'JWT_SECRET not configured' : 'OAuth callback without user');
      }

      // Issue a JWT so the frontend can call the API without the session cookie.
      const token = jwt.sign(
        { userId: user.id, email: user.email, walletAddress: user.wallet?.address },
        jwtSecret,
        { expiresIn: jwtExpiresIn() }
      );

      logger.info(`User ${user.email} logged in successfully`);

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
      res.redirect(`${frontendUrl}/auth/success?token=${encodeURIComponent(token)}`);
    } catch (error) {
      logger.error('Error in OAuth callback:', error);
      res.redirect('/auth/failure');
    }
  }
);

// Authentication failure
authRouter.get('/failure', (_req, res) => {
  res.status(401).json({
    error: 'Authentication failed',
    message: 'Failed to authenticate with Google'
  });
});

// Logout endpoint
authRouter.post('/logout', (req, res) => {
  req.logout((logoutError) => {
    if (logoutError) {
      logger.error('Logout error:', logoutError);
      res.status(500).json({ error: 'Logout failed' });
      return;
    }

    req.session.destroy((sessionError) => {
      if (sessionError) {
        logger.error('Session destruction error:', sessionError);
      }
      res.json({ message: 'Logged out successfully' });
    });
  });
});

// Get current user
authRouter.get('/me', (req, res) => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const user = req.user;
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatar,
    walletAddress: user.wallet?.address,
    providers: user.oauthAccounts?.map((account) => account.provider)
  });
});

// Check authentication status
authRouter.get('/status', (req, res) => {
  const authenticated = req.isAuthenticated();
  res.json({
    authenticated,
    user: authenticated ? { id: req.user.id, email: req.user.email } : null
  });
});
