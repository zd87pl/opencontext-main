import { PartnerConfig } from '../types.js';

export const githubConfig: PartnerConfig = {
  id: 'github',
  name: 'GitHub API',
  baseUrl: 'https://api.github.com',
  costPerByte: '500000000', // 0.5 gwei per byte
  costPerRequest: '50000000000', // 50 gwei per request
  authRequired: true,
  rateLimits: {
    requests: 5000,
    window: 3600 // 1 hour
  }
};

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  description: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  size: number;
  stargazers_count: number;
  watchers_count: number;
  language: string;
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
  name: string;
  company: string;
  blog: string;
  location: string;
  email: string;
  bio: string;
  public_repos: number;
  followers: number;
  following: number;
  created_at: string;
}

export class GitHubClient {
  private token: string;
  private baseUrl: string;

  constructor(token: string) {
    this.token = token;
    this.baseUrl = githubConfig.baseUrl;
  }

  private async request(endpoint: string, options?: RequestInit): Promise<any> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'OpenContext-Gateway/1.0',
        ...options?.headers
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async getUser(username?: string): Promise<GitHubUser> {
    const endpoint = username ? `/users/${username}` : '/user';
    return this.request(endpoint);
  }

  async getUserRepos(username?: string, params?: {
    type?: 'all' | 'owner' | 'public' | 'private' | 'member';
    sort?: 'created' | 'updated' | 'pushed' | 'full_name';
    direction?: 'asc' | 'desc';
    per_page?: number;
    page?: number;
  }): Promise<GitHubRepository[]> {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          searchParams.append(key, value.toString());
        }
      });
    }

    const endpoint = username 
      ? `/users/${username}/repos${searchParams.toString() ? '?' + searchParams : ''}`
      : `/user/repos${searchParams.toString() ? '?' + searchParams : ''}`;
    
    return this.request(endpoint);
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepository> {
    return this.request(`/repos/${owner}/${repo}`);
  }

  async getRepositoryContents(
    owner: string, 
    repo: string, 
    path: string = '',
    ref?: string
  ): Promise<any> {
    const params = new URLSearchParams();
    if (ref) params.append('ref', ref);
    
    const endpoint = `/repos/${owner}/${repo}/contents/${path}${params.toString() ? '?' + params : ''}`;
    return this.request(endpoint);
  }

  async searchRepositories(query: string, params?: {
    sort?: 'stars' | 'forks' | 'help-wanted-issues' | 'updated';
    order?: 'asc' | 'desc';
    per_page?: number;
    page?: number;
  }): Promise<{ total_count: number; items: GitHubRepository[] }> {
    const searchParams = new URLSearchParams();
    searchParams.append('q', query);
    
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          searchParams.append(key, value.toString());
        }
      });
    }

    return this.request(`/search/repositories?${searchParams}`);
  }

  async getRepositoryCommits(
    owner: string,
    repo: string,
    params?: {
      sha?: string;
      path?: string;
      author?: string;
      since?: string;
      until?: string;
      per_page?: number;
      page?: number;
    }
  ): Promise<any[]> {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          searchParams.append(key, value.toString());
        }
      });
    }

    const endpoint = `/repos/${owner}/${repo}/commits${searchParams.toString() ? '?' + searchParams : ''}`;
    return this.request(endpoint);
  }
}