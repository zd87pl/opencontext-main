import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { prisma } from '../common/prisma.js';
import { logger } from '../common/logger.js';
import { createManagedWallet } from '../wallets/wallet.service.js';

export function configurePassport() {
  // Google OAuth Strategy
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    callbackURL: process.env.GOOGLE_CALLBACK_URL!,
    scope: ['profile', 'email']
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      logger.info(`Google OAuth callback for user: ${profile.emails?.[0]?.value}`);
      
      // Extract user data from Google profile
      const email = profile.emails?.[0]?.value;
      const googleId = profile.id;
      const name = profile.displayName;
      const avatar = profile.photos?.[0]?.value;
      
      if (!email) {
        return done(new Error('No email found in Google profile'));
      }
      
      // Check if user exists
      let user = await prisma.user.findUnique({
        where: { email },
        include: {
          oauthAccounts: true,
          wallet: true
        }
      });
      
      if (!user) {
        // Create new user with managed wallet
        const wallet = await createManagedWallet();
        
        user = await prisma.user.create({
          data: {
            email,
            name,
            avatar,
            emailVerified: true, // Google emails are pre-verified
            wallet: {
              create: {
                address: wallet.address,
                encryptedPrivateKey: wallet.encryptedPrivateKey,
                type: 'MANAGED'
              }
            },
            oauthAccounts: {
              create: {
                provider: 'google',
                providerAccountId: googleId,
                accessToken,
                refreshToken,
                scope: profile._json.scope || 'profile email'
              }
            }
          },
          include: {
            oauthAccounts: true,
            wallet: true
          }
        });
        
        logger.info(`Created new user: ${user.id} with wallet: ${wallet.address}`);
      } else {
        // Check if Google account is linked
        const googleAccount = user.oauthAccounts.find(acc => acc.provider === 'google');
        
        if (!googleAccount) {
          // Link Google account to existing user
          await prisma.oAuthAccount.create({
            data: {
              userId: user.id,
              provider: 'google',
              providerAccountId: googleId,
              accessToken,
              refreshToken,
              scope: profile._json.scope || 'profile email'
            }
          });
          
          logger.info(`Linked Google account to existing user: ${user.id}`);
        } else {
          // Update tokens
          await prisma.oAuthAccount.update({
            where: { id: googleAccount.id },
            data: {
              accessToken,
              refreshToken
            }
          });
        }
        
        // Update user profile if needed
        if ((name && name !== user.name) || (avatar && avatar !== user.avatar)) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: {
              name: name || user.name,
              avatar: avatar || user.avatar
            },
            include: {
              oauthAccounts: true,
              wallet: true
            }
          });
        }
      }
      
      return done(null, user);
    } catch (error) {
      logger.error('Google OAuth error:', error);
      return done(error as Error);
    }
  }));
  
  // Serialize user for session
  passport.serializeUser((user: any, done) => {
    done(null, user.id);
  });
  
  // Deserialize user from session
  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id },
        include: {
          wallet: true,
          oauthAccounts: true
        }
      });
      done(null, user);
    } catch (error) {
      done(error);
    }
  });
}