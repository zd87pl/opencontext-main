import type { PartnerConfig } from '../src/types.js';

export const newswireConfig: PartnerConfig = {
  id: 'newswire',
  name: 'Newswire API',
  baseUrl: 'https://newsapi.org/v2',
  costPerByte: '1000000000', // 1 gwei per byte
  costPerRequest: '100000000000', // 100 gwei per request
  authRequired: true,
  rateLimits: {
    requests: 1000,
    window: 3600, // 1 hour
  },
  // NewsAPI accepts the key either as `X-Api-Key` or as an `apiKey` query parameter.
  upstreamAuth: { header: 'X-Api-Key', scheme: 'raw', envVar: 'NEWSAPI_KEY' },
};

export interface Article {
  source: {
    id: string | null;
    name: string;
  };
  author: string | null;
  title: string;
  description: string | null;
  url: string;
  urlToImage: string | null;
  publishedAt: string;
  content: string | null;
}

export interface NewsResponse {
  status: string;
  totalResults: number;
  articles: Article[];
}

export interface NewsSource {
  id: string;
  name: string;
  description: string;
  url: string;
  category: string;
  language: string;
  country: string;
}

export interface NewsSourcesResponse {
  status: string;
  sources: NewsSource[];
}

export interface HeadlinesOptions {
  country?: string;
  category?: string;
  sources?: string;
  q?: string;
  pageSize?: number;
  page?: number;
}

export interface SearchOptions {
  sources?: string;
  domains?: string;
  excludeDomains?: string;
  from?: string;
  to?: string;
  language?: string;
  sortBy?: 'relevancy' | 'popularity' | 'publishedAt';
  pageSize?: number;
  page?: number;
}

export interface SourcesOptions {
  category?: string;
  language?: string;
  country?: string;
}

function toParams(values: Record<string, string | number | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.append(key, String(value));
  }
  return params;
}

/** Direct NewsAPI client. The key is sent as a header so it never appears in URLs or logs. */
export class NewswireClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = newswireConfig.baseUrl
  ) {}

  private async request<T>(path: string, params: URLSearchParams): Promise<T> {
    const query = params.toString();
    const response = await fetch(`${this.baseUrl}${path}${query ? `?${query}` : ''}`, {
      headers: { 'X-Api-Key': this.apiKey, 'User-Agent': 'OpenContext-Gateway/0.2' },
    });
    if (!response.ok) {
      throw new Error(`Newswire API error: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  getTopHeadlines(options: HeadlinesOptions = {}): Promise<NewsResponse> {
    return this.request('/top-headlines', toParams({ ...options }));
  }

  searchArticles(q: string, options: SearchOptions = {}): Promise<NewsResponse> {
    return this.request('/everything', toParams({ q, ...options }));
  }

  getSources(options: SourcesOptions = {}): Promise<NewsSourcesResponse> {
    return this.request('/top-headlines/sources', toParams({ ...options }));
  }
}
