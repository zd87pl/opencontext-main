/**
 * GitHub OAuth -> wallet linking demo.
 *
 * Shows the link message a wallet signs and how the gateway verifies it. The GitHub user is
 * simulated here; in the real flow it comes from `GET /auth/github/callback` after the user
 * authorises the OAuth app (`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` on the gateway).
 *
 *   npx tsx examples/github-oauth-demo.ts
 *   GITHUB_TOKEN=... npx tsx examples/github-oauth-demo.ts   # also exercises the GitHub proxy
 */

import { ethers } from 'ethers';
import { AuthService, type GitHubOAuthUser } from '../src/auth.js';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3001';

async function demoWalletLinking(): Promise<void> {
  console.log('=== GitHub OAuth -> wallet linking ===');

  const authService = new AuthService({
    github: {
      clientId: process.env.GITHUB_CLIENT_ID ?? 'demo-client-id',
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? 'demo-client-secret',
      redirectUri: process.env.GITHUB_REDIRECT_URI ?? 'http://localhost:3001/auth/github/callback',
    },
  });

  const oauthUrl = await authService.initiateGitHubOAuth();
  console.log(`\n1. The user authorises the app at:\n   ${oauthUrl}`);
  console.log('2. GitHub redirects to /auth/github/callback?code=...&state=... (state is single-use)');

  const githubUser: GitHubOAuthUser = {
    id: 12345,
    login: 'demo-user',
    name: 'Demo User',
    email: 'demo@example.com',
    avatar_url: 'https://github.com/images/error/octocat_happy.gif',
  };

  const wallet = ethers.Wallet.createRandom();
  const message = authService.buildLinkMessage(githubUser.login, wallet.address);
  const signature = await wallet.signMessage(message);
  console.log(`\n3. The wallet ${wallet.address} signs:\n   "${message}"`);
  console.log(`   Signature: ${signature}`);

  const sessionToken = await authService.linkWalletToGitHub(wallet.address, signature, githubUser);
  const session = authService.validateSession(sessionToken);
  console.log(`\n4. Session created: ${sessionToken}`);
  console.log(`   Passport ID: ${session?.passportId}`);
  console.log(`   Expires:     ${session ? new Date(session.expires).toISOString() : 'n/a'}`);
  console.log('\nUse it as:  Authorization: Bearer <token>   and   X-Passport-ID: <passportId>');
}

async function testGitHubProxy(): Promise<void> {
  console.log('\n=== GitHub proxy through the gateway ===');
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('GITHUB_TOKEN not set, skipping proxy test');
    return;
  }

  const response = await fetch(`${GATEWAY_URL}/proxy/github/user`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Passport-ID': 'demo-passport-github-123' },
  });
  if (!response.ok) {
    throw new Error(`GitHub proxy error: ${response.status} ${await response.text()}`);
  }
  console.log(
    `Metering - cost: ${response.headers.get('x-metering-cost')} wei, bytes: ${response.headers.get('x-metering-bytes')}`
  );
  const user = (await response.json()) as { login: string; name: string | null; public_repos: number };
  console.log(`GitHub user: ${user.login} (${user.name ?? 'no name'}), public repos: ${user.public_repos}`);
}

async function main(): Promise<void> {
  await demoWalletLinking();
  await testGitHubProxy();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
