/**
 * GitHub OAuth plus wallet linking.
 *
 * Flow: `initiateGitHubOAuth` issues a one-time `state`; GitHub redirects back and
 * `handleGitHubCallback` exchanges the code (rejecting unknown or replayed states); the user then
 * signs a link message with their wallet and `linkWalletToGitHub` verifies it and opens a session.
 *
 * TODO(op-context): sessions, OAuth states and pending links live in process memory. That is
 * fine for a single worker; multi-worker deployments need them in the shared StorageAdapter.
 */

import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AuthConfig {
  /** Omit to run without GitHub OAuth; the OAuth methods then throw `AuthNotConfiguredError`. */
  github?: GitHubOAuthConfig;
  /** Session lifetime in milliseconds (default 24h). */
  sessionTtlMs?: number;
  /** How long an issued OAuth state or a pending link stays valid (default 10 minutes). */
  pendingTtlMs?: number;
}

export interface GitHubOAuthUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

export interface AuthSession {
  passportId: string;
  walletAddress: string;
  githubUser?: GitHubOAuthUser;
  expires: number;
}

export class AuthNotConfiguredError extends Error {
  constructor() {
    super('GitHub OAuth is not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET)');
    this.name = 'AuthNotConfiguredError';
  }
}

export class InvalidOAuthStateError extends Error {
  constructor() {
    super('Invalid or expired OAuth state');
    this.name = 'InvalidOAuthStateError';
  }
}

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000;

export class AuthService {
  private readonly sessions = new Map<string, AuthSession>();
  private readonly pendingStates = new Map<string, number>();
  private readonly pendingLinks = new Map<number, { user: GitHubOAuthUser; expires: number }>();
  private readonly config: AuthConfig;

  constructor(config: AuthConfig = {}) {
    this.config = config;
  }

  isGitHubConfigured(): boolean {
    return Boolean(this.config.github?.clientId && this.config.github?.clientSecret);
  }

  private requireGitHub(): GitHubOAuthConfig {
    if (!this.config.github || !this.isGitHubConfigured()) {
      throw new AuthNotConfiguredError();
    }
    return this.config.github;
  }

  /** The GitHub authorization URL for a fresh, single-use `state`. */
  async initiateGitHubOAuth(): Promise<string> {
    const github = this.requireGitHub();
    const state = ethers.hexlify(randomBytes(32));
    this.pendingStates.set(state, Date.now() + (this.config.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS));
    this.pruneExpired();

    const params = new URLSearchParams({
      client_id: github.clientId,
      redirect_uri: github.redirectUri,
      scope: 'read:user user:email',
      state,
      allow_signup: 'true',
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  }

  /** Consume the OAuth state, exchange the code and remember the user for wallet linking. */
  async handleGitHubCallback(code: string, state: string): Promise<GitHubOAuthUser> {
    const github = this.requireGitHub();

    const stateExpires = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    if (stateExpires === undefined || stateExpires < Date.now()) {
      throw new InvalidOAuthStateError();
    }

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: github.clientId,
        client_secret: github.clientSecret,
        code,
        redirect_uri: github.redirectUri,
      }),
    });
    if (!tokenResponse.ok) {
      throw new Error('Failed to exchange code for token');
    }
    const { access_token: accessToken } = (await tokenResponse.json()) as { access_token?: string };
    if (!accessToken) {
      throw new Error('GitHub did not return an access token');
    }

    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    if (!userResponse.ok) {
      throw new Error('Failed to fetch user info');
    }

    const user = (await userResponse.json()) as GitHubOAuthUser;
    this.pendingLinks.set(user.id, {
      user,
      expires: Date.now() + (this.config.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS),
    });
    return user;
  }

  /** A GitHub user who completed OAuth recently and has not linked a wallet yet. */
  getPendingGitHubUser(githubUserId: number): GitHubOAuthUser | undefined {
    const pending = this.pendingLinks.get(githubUserId);
    if (!pending) return undefined;
    if (pending.expires < Date.now()) {
      this.pendingLinks.delete(githubUserId);
      return undefined;
    }
    return pending.user;
  }

  /** The exact message a wallet must sign to link to a GitHub login. */
  buildLinkMessage(githubLogin: string, walletAddress: string): string {
    return `Link GitHub account ${githubLogin} to wallet ${walletAddress}`;
  }

  async linkWalletToGitHub(
    walletAddress: string,
    signature: string,
    githubUser: GitHubOAuthUser
  ): Promise<string> {
    const message = this.buildLinkMessage(githubUser.login, walletAddress);

    let recoveredAddress: string;
    try {
      recoveredAddress = ethers.verifyMessage(message, signature);
    } catch {
      // Malformed signatures (wrong length, bad recovery id) are as invalid as mismatching ones.
      throw new Error('Invalid signature');
    }
    if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error('Invalid signature');
    }

    const sessionToken = ethers.hexlify(randomBytes(32));
    this.sessions.set(sessionToken, {
      passportId: `github:${githubUser.id}:${walletAddress}`,
      walletAddress,
      githubUser,
      expires: Date.now() + (this.config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS),
    });
    this.pendingLinks.delete(githubUser.id);
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
    for (const [token, session] of this.sessions) {
      if (session.expires > now) {
        active.push(session);
      } else {
        this.sessions.delete(token);
      }
    }
    return active;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [state, expires] of this.pendingStates) {
      if (expires < now) this.pendingStates.delete(state);
    }
    for (const [id, pending] of this.pendingLinks) {
      if (pending.expires < now) this.pendingLinks.delete(id);
    }
  }
}
