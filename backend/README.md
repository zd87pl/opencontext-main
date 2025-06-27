# OpenContext Backend API

Backend API for OpenContext's mainstream user onboarding with OAuth integration and managed wallets.

## PoC Week 1-2 Features ✅

- [x] Google OAuth integration for seamless signup
- [x] Session-based authentication with Redis
- [x] Managed wallet creation on signup
- [x] PostgreSQL database with Prisma ORM
- [x] TypeScript + Express.js setup
- [x] JWT tokens for API access
- [x] User profile management

## Quick Start

1. **Install dependencies:**
```bash
cd backend
npm install
```

2. **Set up environment variables:**
```bash
cp .env.example .env
# Edit .env with your configuration
```

3. **Set up PostgreSQL database:**
```bash
# Make sure PostgreSQL is running
createdb opencontext

# Run Prisma migrations
npm run db:push
```

4. **Set up Redis:**
```bash
# Make sure Redis is running
redis-server
```

5. **Configure Google OAuth:**
   - Go to [Google Cloud Console](https://console.cloud.google.com)
   - Create a new project or select existing
   - Enable Google+ API
   - Create OAuth 2.0 credentials
   - Add authorized redirect URI: `http://localhost:3000/auth/google/callback`
   - Copy Client ID and Client Secret to .env

6. **Start development server:**
```bash
npm run dev
```

## API Endpoints

### Authentication
- `GET /auth/google` - Initiate Google OAuth flow
- `GET /auth/google/callback` - OAuth callback (handled by Google)
- `POST /auth/logout` - Logout user
- `GET /auth/me` - Get current user info
- `GET /auth/status` - Check authentication status

### User Management
- `GET /api/users/profile` - Get user profile
- `PATCH /api/users/profile` - Update user profile
- `GET /api/users/purchases` - Get user's purchased content
- `GET /api/users/content` - Get user's created content

## Database Schema

See `prisma/schema.prisma` for the complete database schema including:
- Users with OAuth accounts
- Managed wallets
- Content and purchases
- Session management

## Architecture

```
backend/
├── src/
│   ├── auth/          # OAuth and authentication
│   ├── users/         # User management
│   ├── wallets/       # Managed wallet service
│   ├── common/        # Shared utilities
│   └── index.ts       # Express server setup
├── prisma/
│   └── schema.prisma  # Database schema
└── package.json
```

## Security Features

- Encrypted wallet private keys
- Session-based authentication with Redis
- JWT tokens for API access
- CORS protection
- Rate limiting ready
- Helmet.js security headers

## Next Steps (Week 3-4)

- [ ] Stripe payment integration
- [ ] Client-side encryption implementation
- [ ] Session-based auto-decryption
- [ ] Content management endpoints

## Environment Variables

See `.env.example` for all required environment variables.

Key variables:
- `GOOGLE_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `SESSION_SECRET` - Express session secret
- `JWT_SECRET` - JWT signing secret