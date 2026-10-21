import type { PartnerConfig } from '../src/types.js';

export const githubConfig: PartnerConfig = {
  id: 'github',
  name: 'GitHub API',
  baseUrl: 'https://api.github.com',
  costPerByte: '500000000', // 0.5 gwei per byte
  costPerRequest: '50000000000', // 50 gwei per request
  authRequired: true,
  rateLimits: {
    requests: 5000,
    window: 3600, // 1 hour
  },
  upstreamAuth: { header: 'Authorization', scheme: 'bearer', envVar: 'GITHUB_TOKEN' },
};

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  size: number;
  stargazers_count: number;
  watchers_count: number;
  language: string | null;
  forks_count: number;
  created_at: string;
  updated_at: string;
  pushed_at: string;
}

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
  name: string | null;
  company: string | null;
  blog: string | null;
  location: string | null;
  email: string | null;
  bio: string | null;
  public_repos: number;
  followers: number;
  following: number;
  created_at: string;
}

export interface GitHubContent {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string | null;
  download_url: string | null;
  content?: string;
  encoding?: string;
}

export interface GitHubCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string } | null;
    committer: { name: string; email: string; date: string } | null;
  };
}

export interface RepoListParams {
  type?: 'all' | 'owner' | 'public' | 'private' | 'member';
  sort?: 'created' | 'updated' | 'pushed' | 'full_name';
  direction?: 'asc' | 'desc';
  per_page?: number;
  page?: number;
}

export interface RepoSearchParams {
  sort?: 'stars' | 'forks' | 'help-wanted-issues' | 'updated';
  order?: 'asc' | 'desc';
  per_page?: number;
  page?: number;
}

export interface CommitListParams {
  sha?: string;
  path?: string;
  author?: string;
  since?: string;
  until?: string;
  per_page?: number;
  page?: number;
}

function withQuery(path: string, params: Record<string, string | number | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.append(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/** Direct GitHub REST client (used by the examples; the gateway proxies GitHub for agents). */
export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string = githubConfig.baseUrl
  ) {}

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'OpenContext-Gateway/0.2',
        ...(options.headers as Record<string, string> | undefined),
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  getUser(username?: string): Promise<GitHubUser> {
    return this.request(username ? `/users/${username}` : '/user');
  }

  getUserRepos(username?: string, params: RepoListParams = {}): Promise<GitHubRepository[]> {
    const path = username ? `/users/${username}/repos` : '/user/repos';
    return this.request(withQuery(path, { ...params }));
  }

  getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    return this.request(`/repos/${owner}/${repo}`);
  }

  getRepositoryContents(
    owner: string,
    repo: string,
    path = '',
    ref?: string
  ): Promise<GitHubContent | GitHubContent[]> {
    return this.request(withQuery(`/repos/${owner}/${repo}/contents/${path}`, { ref }));
  }

  searchRepositories(
    query: string,
    params: RepoSearchParams = {}
  ): Promise<{ total_count: number; items: GitHubRepository[] }> {
    return this.request(withQuery('/search/repositories', { q: query, ...params }));
  }

  getRepositoryCommits(
    owner: string,
    repo: string,
    params: CommitListParams = {}
  ): Promise<GitHubCommit[]> {
    return this.request(withQuery(`/repos/${owner}/${repo}/commits`, { ...params }));
  }
}
