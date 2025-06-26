import { AuthService } from '../src/auth.js';
import { ethers } from 'ethers';

const authConfig = {
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    redirectUri: process.env.GITHUB_REDIRECT_URI || 'http://localhost:3001/auth/github/callback'
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'demo-secret',
    expiresIn: '24h'
  }
};

const authService = new AuthService(authConfig);

async function demoOAuthFlow() {
  console.log('=== GitHub OAuth → Wallet Demo ===');

  const wallet = ethers.Wallet.createRandom();
  console.log(`Demo wallet: ${wallet.address}`);

  try {
    const oauthUrl = await authService.initiateGitHubOAuth();
    console.log(`\n1. Visit this URL to authorize GitHub:\n${oauthUrl}`);
    
    console.log('\n2. After authorization, you\'ll be redirected with a code parameter');
    console.log('   Example: http://localhost:3001/auth/github/callback?code=abc123&state=xyz789');
    
    console.log('\n3. Use the code to complete the OAuth flow (demo simulation):');
    
    const mockGitHubUser = {
      id: 12345,
      login: 'demo-user',
      name: 'Demo User', 
      email: 'demo@example.com',
      avatar_url: 'https://github.com/images/error/octocat_happy.gif'
    };

    const message = `Link GitHub account ${mockGitHubUser.login} to wallet ${wallet.address}`;
    const signature = await wallet.signMessage(message);
    
    console.log(`\n4. Signed message: "${message}"`);
    console.log(`   Signature: ${signature}`);

    const sessionToken = await authService.linkWalletToGitHub(
      wallet.address,
      signature,
      mockGitHubUser
    );

    console.log(`\n5. Session created! Token: ${sessionToken}`);

    const session = authService.validateSession(sessionToken);
    if (session) {
      console.log(`\n6. Session validated:`);
      console.log(`   Passport ID: ${session.passportId}`);
      console.log(`   Wallet: ${session.walletAddress}`);
      console.log(`   GitHub: ${session.githubUser?.login}`);
      console.log(`   Expires: ${new Date(session.expires).toISOString()}`);
    }

    console.log('\n✅ OAuth flow completed successfully!');
    console.log('\nThis session can now be used to authenticate API requests:');
    console.log('  Authorization: Bearer ' + sessionToken);
    console.log('  X-Passport-ID: ' + session?.passportId);

  } catch (error) {
    console.error('OAuth flow error:', error);
  }
}

async function testGitHubProxyWithAuth() {
  console.log('\n=== Testing GitHub Proxy with Authentication ===');
  
  const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3001';
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  
  if (!GITHUB_TOKEN) {
    console.log('GITHUB_TOKEN not set, skipping proxy test');
    return;
  }

  try {
    const response = await fetch(`${GATEWAY_URL}/proxy/github/user`, {
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'X-Passport-ID': 'demo-passport-github-123'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub proxy error: ${response.status}`);
    }

    const meteringCost = response.headers.get('x-metering-cost');
    const meteringBytes = response.headers.get('x-metering-bytes');
    
    console.log(`Metering - Cost: ${meteringCost} wei, Bytes: ${meteringBytes}`);

    const user = await response.json();
    console.log(`GitHub user: ${user.login} (${user.name})`);
    console.log(`Public repos: ${user.public_repos}`);
    
  } catch (error) {
    console.error('GitHub proxy test error:', error);
  }
}

async function main() {
  await demoOAuthFlow();
  await testGitHubProxyWithAuth();
}

main().catch(console.error);