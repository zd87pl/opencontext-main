import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { prisma } from '../common/prisma.js';
import { logger } from '../common/logger.js';
import { createManagedWallet } from '../wallets/wallet.service.js';

const GOOGLE_OAUTH_SCOPES = ['profile', 'email'];

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALLBACK_URL
  );
}

export function configurePassport(): void {
  if (isGoogleOAuthConfigured()) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          callbackURL: process.env.GOOGLE_CALLBACK_URL!,
          scope: GOOGLE_OAUTH_SCOPES
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            logger.info(`Google OAuth callback for user: ${profile.emails?.[0]?.value}`);

            const email = profile.emails?.[0]?.value;
            const googleId = profile.id;
            const name = profile.displayName;
            const avatar = profile.photos?.[0]?.value;

            if (!email) {
              return done(new Error('No email found in Google profile'));
            }

            let user = await prisma.user.findUnique({
              where: { email },
              include: { oauthAccounts: true, wallet: true }
            });

            if (!user) {
              // First login: create the user together with a platform-managed wallet.
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
                      scope: GOOGLE_OAUTH_SCOPES.join(' ')
                    }
                  }
                },
                include: { oauthAccounts: true, wallet: true }
              });

              logger.info(`Created new user: ${user.id} with wallet: ${wallet.address}`);
            } else {
              const googleAccount = user.oauthAccounts.find((acc) => acc.provider === 'google');

              if (!googleAccount) {
                await prisma.oAuthAccount.create({
                  data: {
                    userId: user.id,
                    provider: 'google',
                    providerAccountId: googleId,
                    accessToken,
                    refreshToken,
                    scope: GOOGLE_OAUTH_SCOPES.join(' ')
                  }
                });

                logger.info(`Linked Google account to existing user: ${user.id}`);
              } else {
                await prisma.oAuthAccount.update({
                  where: { id: googleAccount.id },
                  data: { accessToken, refreshToken }
                });
              }

              if ((name && name !== user.name) || (avatar && avatar !== user.avatar)) {
                user = await prisma.user.update({
                  where: { id: user.id },
                  data: {
                    name: name || user.name,
                    avatar: avatar || user.avatar
                  },
                  include: { oauthAccounts: true, wallet: true }
                });
              }
            }

            return done(null, user);
          } catch (error) {
            logger.error('Google OAuth error:', error);
            return done(error as Error);
          }
        }
      )
    );
  } else {
    logger.warn(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL not set: /auth/google is disabled'
    );
  }

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id },
        include: { wallet: true, oauthAccounts: true }
      });
      done(null, user);
    } catch (error) {
      done(error);
    }
  });
}
