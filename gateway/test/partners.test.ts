import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARTNERS, GitHubClient, NewswireClient, SatelliteClient, isProxyablePartner } from '../partners/index.js';

const fetchMock = vi.fn();
global.fetch = fetchMock;

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  });
}

function lastCall(): [string, RequestInit] {
  return fetchMock.mock.calls.at(-1) as [string, RequestInit];
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('partner registry', () => {
  it('lists every partner once with pricing and marks which can be proxied', () => {
    const ids = DEFAULT_PARTNERS.map((p) => p.id);
    expect(ids).toEqual(['newswire', 'github', 'satellite', 'compute']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const partner of DEFAULT_PARTNERS) {
      expect(BigInt(partner.costPerByte)).toBeGreaterThanOrEqual(0n);
      expect(BigInt(partner.costPerRequest)).toBeGreaterThanOrEqual(0n);
    }
    expect(DEFAULT_PARTNERS.filter(isProxyablePartner).map((p) => p.id)).toEqual(['newswire', 'github', 'satellite']);
  });
});

describe('NewswireClient', () => {
  it('sends the key as a header and encodes query options', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ status: 'ok', totalResults: 1, articles: [] }));
    const client = new NewswireClient('news-key');

    const headlines = await client.getTopHeadlines({ country: 'us', pageSize: 5 });
    expect(headlines.totalResults).toBe(1);
    const [url, init] = lastCall();
    expect(url).toBe('https://newsapi.org/v2/top-headlines?country=us&pageSize=5');
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('news-key');
    expect(url).not.toContain('news-key');

    await client.searchArticles('ai agents', { sortBy: 'popularity' });
    expect(lastCall()[0]).toBe('https://newsapi.org/v2/everything?q=ai+agents&sortBy=popularity');

    await client.getSources();
    expect(lastCall()[0]).toBe('https://newsapi.org/v2/top-headlines/sources');
  });

  it('raises on upstream errors', async () => {
    fetchMock.mockImplementation(() => jsonResponse({}, 429));
    await expect(new NewswireClient('k').getTopHeadlines()).rejects.toThrow('Newswire API error: 429');
  });
});

describe('GitHubClient', () => {
  it('authenticates with a bearer token and builds endpoints', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ login: 'octocat' }));
    const client = new GitHubClient('gh-token');

    expect((await client.getUser()).login).toBe('octocat');
    expect(lastCall()[0]).toBe('https://api.github.com/user');
    expect((lastCall()[1].headers as Record<string, string>).Authorization).toBe('Bearer gh-token');

    await client.getUser('torvalds');
    expect(lastCall()[0]).toBe('https://api.github.com/users/torvalds');
    await client.getUserRepos('torvalds', { sort: 'updated', per_page: 2 });
    expect(lastCall()[0]).toBe('https://api.github.com/users/torvalds/repos?sort=updated&per_page=2');
    await client.getUserRepos();
    expect(lastCall()[0]).toBe('https://api.github.com/user/repos');
    await client.getRepository('o', 'r');
    expect(lastCall()[0]).toBe('https://api.github.com/repos/o/r');
    await client.getRepositoryContents('o', 'r', 'src', 'main');
    expect(lastCall()[0]).toBe('https://api.github.com/repos/o/r/contents/src?ref=main');
    await client.searchRepositories('gateway', { sort: 'stars' });
    expect(lastCall()[0]).toBe('https://api.github.com/search/repositories?q=gateway&sort=stars');
    await client.getRepositoryCommits('o', 'r', { per_page: 1 });
    expect(lastCall()[0]).toBe('https://api.github.com/repos/o/r/commits?per_page=1');
  });

  it('raises on upstream errors', async () => {
    fetchMock.mockImplementation(() => jsonResponse({}, 404));
    await expect(new GitHubClient('t').getRepository('o', 'missing')).rejects.toThrow('GitHub API error: 404');
  });
});

describe('SatelliteClient', () => {
  const basic = `Basic ${Buffer.from('planet-key:').toString('base64')}`;

  it('searches with basic auth and well-formed Planet filters', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ features: [], _links: {} }));
    const client = new SatelliteClient('planet-key');
    const request = client.createBboxFilter(-122.5, 37.7, -122.3, 37.8);
    expect(request.item_types).toEqual(['PSScene']);
    expect(request.filter.type).toBe('AndFilter');

    await client.searchImages(request);
    const [url, init] = lastCall();
    expect(url).toBe('https://api.planet.com/data/v1/quick-search');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(basic);
    expect(JSON.parse(init.body as string)).toEqual(request);

    const dateFilter = client.createDateRangeFilter('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
    expect(dateFilter.filter.config).toHaveLength(1);
  });

  it('activates inactive assets and polls until they are ready', async () => {
    const inactive = { analytic: { type: 'analytic', status: 'inactive', _permissions: [], _links: { _self: '', activate: 'https://api.planet.com/data/v1/activate/1', type: '' } } };
    const active = { analytic: { ...inactive.analytic, status: 'active', location: 'https://download.example/file.tif' } };
    fetchMock
      .mockImplementationOnce(() => jsonResponse(inactive)) // first assets lookup
      .mockImplementationOnce(() => jsonResponse({}, 204)) // activation call
      .mockImplementationOnce(() => jsonResponse(inactive)) // poll 1
      .mockImplementationOnce(() => jsonResponse(active)); // poll 2

    const client = new SatelliteClient('planet-key', undefined, 0);
    const download = await client.downloadAsset('PSScene', 'img-1', 'analytic');
    expect(download.url).toBe('https://download.example/file.tif');
    expect(download.headers.Authorization).toBe(basic);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.planet.com/data/v1/activate/1');
  });

  it('fails clearly for unknown assets and activation timeouts', async () => {
    fetchMock.mockImplementation(() => jsonResponse({}));
    const client = new SatelliteClient('planet-key', undefined, 0);
    await expect(client.downloadAsset('PSScene', 'img', 'nope')).rejects.toThrow('Asset type nope not found');

    const inactive = { analytic: { type: 'analytic', status: 'inactive', _permissions: [], _links: { _self: '', activate: 'https://api.planet.com/data/v1/activate/1', type: '' } } };
    fetchMock.mockImplementation(() => jsonResponse(inactive));
    await expect(client.downloadAsset('PSScene', 'img', 'analytic', 2)).rejects.toThrow('Asset activation timeout');
  });

  it('streams the download body', async () => {
    const active = { analytic: { type: 'analytic', status: 'active', location: 'https://download.example/f', _permissions: [], _links: { _self: '', activate: '', type: '' } } };
    const body = new ReadableStream<Uint8Array>();
    fetchMock
      .mockImplementationOnce(() => jsonResponse(active))
      .mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200, body }));
    const stream = await new SatelliteClient('planet-key').streamImageDownload('PSScene', 'img', 'analytic');
    expect(stream).toBe(body);
    expect(fetchMock.mock.calls[1][0]).toBe('https://download.example/f');
  });
});
