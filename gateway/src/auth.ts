import { ethers } from 'ethers';

export interface AuthConfig {
  github: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
}

export interface GitHubOAuthUser {
  id: number;
  login: string;
  name: string;
  email: string;
  avatar_url: string;
}

export interface AuthSession {
  passportId: string;
  walletAddress: string;
  githubUser?: GitHubOAuthUser;
  expires: number;
}

export class AuthService {
  private sessions: Map<string, AuthSession> = new Map();
  private config: AuthConfig;

  constructor(config: AuthConfig) {
    this.config = config;
  }

  async initiateGitHubOAuth(): Promise<string> {
    const state = ethers.hexlify(ethers.randomBytes(32));
    const params = new URLSearchParams({
      client_id: this.config.github.clientId,
      redirect_uri: this.config.github.redirectUri,
      scope: 'read:user user:email',
      state,
      allow_signup: 'true'
    });

    return `https://github.com/login/oauth/authorize?${params}`;
  }

  async handleGitHubCallback(code: string, state: string): Promise<GitHubOAuthUser> {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: this.config.github.clientId,
        client_secret: this.config.github.clientSecret,
        code,
        redirect_uri: this.config.github.redirectUri
      })
    });

    if (!tokenResponse.ok) {
      throw new Error('Failed to exchange code for token');
    }

    const { access_token } = await tokenResponse.json();

    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!userResponse.ok) {
      throw new Error('Failed to fetch user info');
    }

    return userResponse.json();
  }

  async linkWalletToGitHub(
    walletAddress: string,
    signature: string,
    githubUser: GitHubOAuthUser
  ): Promise<string> {
    const message = `Link GitHub account ${githubUser.login} to wallet ${walletAddress}`;
    const messageHash = ethers.hashMessage(message);
    const recoveredAddress = ethers.verifyMessage(message, signature);

    if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error('Invalid signature');
    }

    const passportId = `github:${githubUser.id}:${walletAddress}`;
    const sessionToken = ethers.hexlify(ethers.randomBytes(32));
    
    const session: AuthSession = {
      passportId,
      walletAddress,
      githubUser,
      expires: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
    };

    this.sessions.set(sessionToken, session);
    return sessionToken;
  }

  validateSession(token: string): AuthSession | null {
    const session = this.sessions.get(token);
    
    if (!session) {
      return null;
    }

    if (Date.now() > session.expires) {
      this.sessions.delete(token);
      return null;
    }

    return session;
  }

  revokeSession(token: string): void {
    this.sessions.delete(token);
  }

  getActiveSessions(): AuthSession[] {
    const now = Date.now();
    const active: AuthSession[] = [];

    for (const [token, session] of this.sessions.entries()) {
      if (session.expires > now) {
        active.push(session);
      } else {
        this.sessions.delete(token);
      }
    }

    return active;
  }
}