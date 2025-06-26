import { PartnerConfig } from '../types.js';

export const newswireConfig: PartnerConfig = {
  id: 'newswire',
  name: 'Newswire API',
  baseUrl: 'https://newsapi.org/v2',
  costPerByte: '1000000000', // 1 gwei per byte
  costPerRequest: '100000000000', // 100 gwei per request
  authRequired: true,
  rateLimits: {
    requests: 1000,
    window: 3600 // 1 hour
  }
};

export interface NewsResponse {
  status: string;
  totalResults: number;
  articles: Article[];
}

export interface Article {
  source: {
    id: string | null;
    name: string;
  };
  author: string | null;
  title: string;
  description: string;
  url: string;
  urlToImage: string | null;
  publishedAt: string;
  content: string;
}

export class NewswireClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = newswireConfig.baseUrl;
  }

  async getTopHeadlines(
    country?: string,
    category?: string,
    sources?: string,
    q?: string,
    pageSize?: number,
    page?: number
  ): Promise<NewsResponse> {
    const params = new URLSearchParams();
    
    if (country) params.append('country', country);
    if (category) params.append('category', category);
    if (sources) params.append('sources', sources);
    if (q) params.append('q', q);
    if (pageSize) params.append('pageSize', pageSize.toString());
    if (page) params.append('page', page.toString());
    
    params.append('apiKey', this.apiKey);

    const response = await fetch(`${this.baseUrl}/top-headlines?${params}`);
    
    if (!response.ok) {
      throw new Error(`Newswire API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async searchArticles(
    q: string,
    sources?: string,
    domains?: string,
    excludeDomains?: string,
    from?: string,
    to?: string,
    language?: string,
    sortBy?: 'relevancy' | 'popularity' | 'publishedAt',
    pageSize?: number,
    page?: number
  ): Promise<NewsResponse> {
    const params = new URLSearchParams();
    
    params.append('q', q);
    if (sources) params.append('sources', sources);
    if (domains) params.append('domains', domains);
    if (excludeDomains) params.append('excludeDomains', excludeDomains);
    if (from) params.append('from', from);
    if (to) params.append('to', to);
    if (language) params.append('language', language);
    if (sortBy) params.append('sortBy', sortBy);
    if (pageSize) params.append('pageSize', pageSize.toString());
    if (page) params.append('page', page.toString());
    
    params.append('apiKey', this.apiKey);

    const response = await fetch(`${this.baseUrl}/everything?${params}`);
    
    if (!response.ok) {
      throw new Error(`Newswire API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async getSources(
    category?: string,
    language?: string,
    country?: string
  ): Promise<{ status: string; sources: any[] }> {
    const params = new URLSearchParams();
    
    if (category) params.append('category', category);
    if (language) params.append('language', language);
    if (country) params.append('country', country);
    
    params.append('apiKey', this.apiKey);

    const response = await fetch(`${this.baseUrl}/sources?${params}`);
    
    if (!response.ok) {
      throw new Error(`Newswire API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }
}