# Gateway Proxy System

Phase 2 gateway proxy infrastructure for metering API calls and managing streaming payments.

## Architecture

- `proxy.ts` - Main HTTP proxy server with request metering
- `metering.ts` - Tracks usage by passport/wallet and calculates costs  
- `billing.ts` - Manages streaming payments via Superfluid
- `partners/` - Partner-specific integration modules

## Usage

```bash
npm run gateway:start
```

## Partner Integrations

- Newswire API - News/RSS feed metering
- GitHub API - Code repository access
- Satellite imagery - Large blob streaming
- Compute DePIN - AI inference routing