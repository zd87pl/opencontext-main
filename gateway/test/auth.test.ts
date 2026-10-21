import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { AuthService, type GitHubOAuthUser } from '../src/auth.js';

// Mock fetch globally
global.fetch = vi.fn();

/** Start an OAuth flow and return the single-use state the callback must present. */
async function issueState(auth: AuthService): Promise<string> {
  const state = new URL(await auth.initiateGitHubOAuth()).searchParams.get('state');
  if (!state) throw new Error('OAuth URL has no state');
  return state;
}

describe('AuthService', () => {
  let authService: AuthService;
  const mockConfig = {
    github: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'http://localhost:3001/auth/github/callback',
    },
  };
  const mockGitHubUser: GitHubOAuthUser = {
    id: 12345,
    login: 'testuser',
    name: 'Test User',
    email: 'test@example.com',
    avatar_url: 'https://github.com/images/error/octocat_happy.gif',
  };

  beforeEach(() => {
    authService = new AuthService(mockConfig);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('GitHub OAuth Initiation', () => {
    it('should generate correct OAuth URL', async () => {
      const oauthUrl = await authService.initiateGitHubOAuth();

      expect(oauthUrl).toContain('https://github.com/login/oauth/authorize');
      expect(oauthUrl).toContain(`client_id=${mockConfig.github.clientId}`);
      expect(oauthUrl).toContain(`redirect_uri=${encodeURIComponent(mockConfig.github.redirectUri)}`);
      expect(oauthUrl).toContain('scope=read%3Auser+user%3Aemail');
      expect(oauthUrl).toContain('state=');
      expect(oauthUrl).toContain('allow_signup=true');
    });

    it('should generate unique state parameters', async () => {
      const url1 = await authService.initiateGitHubOAuth();
      const url2 = await authService.initiateGitHubOAuth();

      const state1 = new URL(url1).searchParams.get('state');
      const state2 = new URL(url2).searchParams.get('state');

      expect(state1).not.toBe(state2);
      expect(state1).toHaveLength(66); // 32 bytes = 64 hex chars + 0x prefix
      expect(state2).toHaveLength(66);
    });

    it('should report and enforce missing OAuth configuration', async () => {
      const unconfigured = new AuthService();
      expect(unconfigured.isGitHubConfigured()).toBe(false);
      expect(authService.isGitHubConfigured()).toBe(true);
      await expect(unconfigured.initiateGitHubOAuth()).rejects.toThrow(/not configured/);
      await expect(unconfigured.handleGitHubCallback('code', 'state')).rejects.toThrow(/not configured/);
    });
  });

  describe('GitHub OAuth Callback', () => {
    beforeEach(() => {
      // Mock successful token exchange
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
        if (url === 'https://github.com/login/oauth/access_token') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ access_token: 'test-token' }),
          });
        }
        if (url === 'https://api.github.com/user') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockGitHubUser),
          });
        }
        return Promise.reject(new Error('Unexpected URL'));
      });
    });

    it('should handle successful OAuth callback', async () => {
      const state = await issueState(authService);
      const user = await authService.handleGitHubCallback('test-code', state);

      expect(user).toEqual(mockGitHubUser);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(authService.getPendingGitHubUser(mockGitHubUser.id)).toEqual(mockGitHubUser);
    });

    it('should make correct token exchange request', async () => {
      await authService.handleGitHubCallback('test-code', await issueState(authService));

      expect(global.fetch).toHaveBeenCalledWith(
        'https://github.com/login/oauth/access_token',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: mockConfig.github.clientId,
            client_secret: mockConfig.github.clientSecret,
            code: 'test-code',
            redirect_uri: mockConfig.github.redirectUri,
          }),
        })
      );
    });

    it('should make correct user info request', async () => {
      await authService.handleGitHubCallback('test-code', await issueState(authService));

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.github.com/user',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer test-token',
            Accept: 'application/vnd.github.v3+json',
          },
        })
      );
    });

    it('should reject a state that was never issued (CSRF)', async () => {
      await expect(authService.handleGitHubCallback('test-code', 'forged-state')).rejects.toThrow(
        /Invalid or expired OAuth state/
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should reject a replayed state', async () => {
      const state = await issueState(authService);
      await authService.handleGitHubCallback('test-code', state);
      await expect(authService.handleGitHubCallback('test-code', state)).rejects.toThrow(
        /Invalid or expired OAuth state/
      );
    });

    it('should reject an expired state', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const state = await issueState(authService);
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      await expect(authService.handleGitHubCallback('test-code', state)).rejects.toThrow(
        /Invalid or expired OAuth state/
      );
    });

    it('should handle token exchange failure', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
        Promise.resolve({ ok: false })
      );

      await expect(
        authService.handleGitHubCallback('test-code', await issueState(authService))
      ).rejects.toThrow('Failed to exchange code for token');
    });

    it('should handle a token response without an access token', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ error: 'bad_verification_code' }) })
      );

      await expect(
        authService.handleGitHubCallback('test-code', await issueState(authService))
      ).rejects.toThrow('GitHub did not return an access token');
    });

    it('should handle user info fetch failure', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
        if (url === 'https://github.com/login/oauth/access_token') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ access_token: 'test-token' }),
          });
        }
        return Promise.resolve({ ok: false });
      });

      await expect(
        authService.handleGitHubCallback('test-code', await issueState(authService))
      ).rejects.toThrow('Failed to fetch user info');
    });

    it('should expire pending links', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await authService.handleGitHubCallback('test-code', await issueState(authService));
      expect(authService.getPendingGitHubUser(mockGitHubUser.id)).toBeDefined();

      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      expect(authService.getPendingGitHubUser(mockGitHubUser.id)).toBeUndefined();
    });
  });

  describe('Wallet Linking', () => {
    const mockWallet = ethers.Wallet.createRandom();

    it('should successfully link wallet to GitHub user', async () => {
      const message = authService.buildLinkMessage(mockGitHubUser.login, mockWallet.address);
      expect(message).toBe(`Link GitHub account ${mockGitHubUser.login} to wallet ${mockWallet.address}`);
      const signature = await mockWallet.signMessage(message);

      const sessionToken = await authService.linkWalletToGitHub(
        mockWallet.address,
        signature,
        mockGitHubUser
      );

      expect(sessionToken).toBeDefined();
      expect(typeof sessionToken).toBe('string');
      expect(sessionToken).toHaveLength(66); // 32 bytes = 64 hex chars + 0x prefix
    });

    it('should reject invalid signature', async () => {
      const invalidSignature = '0x1234567890abcdef';

      await expect(
        authService.linkWalletToGitHub(mockWallet.address, invalidSignature, mockGitHubUser)
      ).rejects.toThrow('Invalid signature');
    });

    it('should reject signature from wrong wallet', async () => {
      const wrongWallet = ethers.Wallet.createRandom();
      const message = `Link GitHub account ${mockGitHubUser.login} to wallet ${mockWallet.address}`;
      const signature = await wrongWallet.signMessage(message);

      await expect(
        authService.linkWalletToGitHub(mockWallet.address, signature, mockGitHubUser)
      ).rejects.toThrow('Invalid signature');
    });

    it('should create correct passport ID format', async () => {
      const message = `Link GitHub account ${mockGitHubUser.login} to wallet ${mockWallet.address}`;
      const signature = await mockWallet.signMessage(message);

      const sessionToken = await authService.linkWalletToGitHub(
        mockWallet.address,
        signature,
        mockGitHubUser
      );

      const session = authService.validateSession(sessionToken);
      expect(session?.passportId).toBe(`github:${mockGitHubUser.id}:${mockWallet.address}`);
    });
  });

  describe('Session Management', () => {
    let sessionToken: string;
    const mockWallet = ethers.Wallet.createRandom();

    beforeEach(async () => {
      const message = `Link GitHub account ${mockGitHubUser.login} to wallet ${mockWallet.address}`;
      const signature = await mockWallet.signMessage(message);

      sessionToken = await authService.linkWalletToGitHub(
        mockWallet.address,
        signature,
        mockGitHubUser
      );
    });

    it('should validate active session', () => {
      const session = authService.validateSession(sessionToken);

      expect(session).toBeDefined();
      expect(session?.passportId).toBe(`github:${mockGitHubUser.id}:${mockWallet.address}`);
      expect(session?.walletAddress).toBe(mockWallet.address);
      expect(session?.githubUser).toEqual(mockGitHubUser);
      expect(session?.expires).toBeGreaterThan(Date.now());
    });

    it('should reject invalid session token', () => {
      const session = authService.validateSession('invalid-token');
      expect(session).toBeNull();
    });

    it('should reject expired session', () => {
      // Fast-forward time to expire the session
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000); // 25 hours

      const session = authService.validateSession(sessionToken);
      expect(session).toBeNull();
    });

    it('should revoke session', () => {
      authService.revokeSession(sessionToken);
      const session = authService.validateSession(sessionToken);
      expect(session).toBeNull();
    });

    it('should list active sessions', () => {
      const activeSessions = authService.getActiveSessions();
      expect(activeSessions).toHaveLength(1);
      expect(activeSessions[0].passportId).toBe(`github:${mockGitHubUser.id}:${mockWallet.address}`);
    });

    it('should clean up expired sessions when listing active sessions', () => {
      // Fast-forward time to expire the session
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000); // 25 hours

      const activeSessions = authService.getActiveSessions();
      expect(activeSessions).toHaveLength(0);

      // Session should also be removed from internal storage
      const session = authService.validateSession(sessionToken);
      expect(session).toBeNull();
    });

    it('should honour a custom session TTL', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const shortLived = new AuthService({ ...mockConfig, sessionTtlMs: 1000 });
      const message = shortLived.buildLinkMessage(mockGitHubUser.login, mockWallet.address);
      const token = await shortLived.linkWalletToGitHub(
        mockWallet.address,
        await mockWallet.signMessage(message),
        mockGitHubUser
      );
      expect(shortLived.validateSession(token)).not.toBeNull();
      vi.setSystemTime(Date.now() + 1001);
      expect(shortLived.validateSession(token)).toBeNull();
    });
  });

  describe('Multiple Sessions', () => {
    it('should handle multiple concurrent sessions', async () => {
      const sessions: string[] = [];

      for (let i = 0; i < 3; i++) {
        const wallet = ethers.Wallet.createRandom();
        const githubUser: GitHubOAuthUser = {
          id: 12345 + i,
          login: `testuser${i}`,
          name: `Test User ${i}`,
          email: `test${i}@example.com`,
          avatar_url: 'https://github.com/images/error/octocat_happy.gif',
        };

        const message = `Link GitHub account ${githubUser.login} to wallet ${wallet.address}`;
        const signature = await wallet.signMessage(message);

        const sessionToken = await authService.linkWalletToGitHub(wallet.address, signature, githubUser);

        sessions.push(sessionToken);
      }

      expect(sessions).toHaveLength(3);

      const activeSessions = authService.getActiveSessions();
      expect(activeSessions).toHaveLength(3);

      // Each session should be valid
      sessions.forEach((token) => {
        const session = authService.validateSession(token);
        expect(session).toBeDefined();
      });
    });
  });
});
