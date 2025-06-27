import { Router } from 'express';
import passport from 'passport';
import jwt from 'jsonwebtoken';
import { logger } from '../common/logger.js';

export const authRouter = Router();

// Initiate Google OAuth flow
authRouter.get('/google', 
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Google OAuth callback
authRouter.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth/failure' }),
  async (req, res) => {
    try {
      // Successful authentication
      const user = req.user as any;
      
      // Generate JWT token for API access
      const token = jwt.sign(
        { 
          userId: user.id, 
          email: user.email,
          walletAddress: user.wallet?.address 
        },
        process.env.JWT_SECRET!,
        { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
      );
      
      // Log successful login
      logger.info(`User ${user.email} logged in successfully`);
      
      // Redirect to frontend with token
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
      res.redirect(`${frontendUrl}/auth/success?token=${token}`);
    } catch (error) {
      logger.error('Error in OAuth callback:', error);
      res.redirect('/auth/failure');
    }
  }
);

// Authentication failure
authRouter.get('/failure', (req, res) => {
  res.status(401).json({
    error: 'Authentication failed',
    message: 'Failed to authenticate with Google'
  });
});

// Logout endpoint
authRouter.post('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      logger.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    
    // Destroy session
    req.session.destroy((err) => {
      if (err) {
        logger.error('Session destruction error:', err);
      }
      res.json({ message: 'Logged out successfully' });
    });
  });
});

// Get current user
authRouter.get('/me', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const user = req.user as any;
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatar,
    walletAddress: user.wallet?.address,
    providers: user.oauthAccounts?.map((acc: any) => acc.provider)
  });
});

// Check authentication status
authRouter.get('/status', (req, res) => {
  res.json({
    authenticated: req.isAuthenticated(),
    user: req.isAuthenticated() ? {
      id: (req.user as any).id,
      email: (req.user as any).email
    } : null
  });
});