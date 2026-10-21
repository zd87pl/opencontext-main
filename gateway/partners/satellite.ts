import type { PartnerConfig } from '../src/types.js';

export const satelliteConfig: PartnerConfig = {
  id: 'satellite',
  name: 'Satellite Imagery API',
  baseUrl: 'https://api.planet.com/data/v1',
  costPerByte: '10000000000', // 10 gwei per byte (imagery is large and expensive)
  costPerRequest: '1000000000000', // 1000 gwei per request
  authRequired: true,
  rateLimits: {
    requests: 100,
    window: 3600, // 1 hour
  },
  // Planet authenticates with HTTP Basic using the API key as the username and an empty password.
  upstreamAuth: { header: 'Authorization', scheme: 'basic', envVar: 'SATELLITE_API_KEY' },
};

export interface SatelliteImage {
  id: string;
  geometry: {
    type: string;
    coordinates: number[][][];
  };
  properties: {
    acquired: string;
    cloud_cover: number;
    clear_percent?: number;
    gsd: number;
    instrument: string;
    item_type: string;
    pixel_resolution: number;
    provider: string;
    published: string;
    quality_category: string;
    satellite_id: string;
    sun_azimuth: number;
    sun_elevation: number;
    updated: string;
    view_angle: number;
  };
  _links: {
    _self: string;
    assets: string;
    thumbnail: string;
  };
}

export interface ImageAsset {
  type: string;
  status: 'active' | 'inactive' | 'activating';
  location?: string;
  expires_at?: string;
  _permissions: string[];
  _links: { _self: string; activate: string; type: string };
}

export type ImageAssets = Record<string, ImageAsset>;

/** Planet Data API filter tree. */
export interface PlanetFilter {
  type: string;
  field_name?: string;
  config: PlanetFilter[] | { gte?: string | number; lte?: string | number } | Record<string, unknown>;
}

export interface SearchRequest {
  item_types: string[];
  filter: PlanetFilter;
}

export interface SearchResponse {
  features: SatelliteImage[];
  _links: { _next?: string; _prev?: string };
}

/** Planet's current PlanetScope item type (PSScene4Band was retired in 2023). */
const DEFAULT_ITEM_TYPE = 'PSScene';

/** Direct Planet Data API client. */
export class SatelliteClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = satelliteConfig.baseUrl,
    /** Delay between activation polls, in milliseconds. */
    private readonly pollIntervalMs = 2000
  ) {}

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = /^https?:\/\//.test(endpoint) ? endpoint : `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> | undefined),
      },
    });
    if (!response.ok) {
      throw new Error(`Satellite API error: ${response.status} ${response.statusText}`);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  searchImages(searchRequest: SearchRequest): Promise<SearchResponse> {
    return this.request('/quick-search', { method: 'POST', body: JSON.stringify(searchRequest) });
  }

  getImageAssets(itemType: string, imageId: string): Promise<ImageAssets> {
    return this.request(`/item-types/${itemType}/items/${imageId}/assets`);
  }

  /** Asset activation is asynchronous on Planet's side; this polls until the download is ready. */
  async downloadAsset(
    itemType: string,
    imageId: string,
    assetType: string,
    maxAttempts = 30
  ): Promise<{ url: string; headers: Record<string, string> }> {
    let assets = await this.getImageAssets(itemType, imageId);
    let asset = assets[assetType];
    if (!asset) {
      throw new Error(`Asset type ${assetType} not found for image ${imageId}`);
    }

    if (asset.status !== 'active') {
      await this.request(asset._links.activate, { method: 'GET' }).catch(() => undefined);
      for (let attempt = 0; attempt < maxAttempts && asset.status !== 'active'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        assets = await this.getImageAssets(itemType, imageId);
        asset = assets[assetType];
      }
    }
    if (asset.status !== 'active' || !asset.location) {
      throw new Error(`Asset activation timeout for ${imageId}/${assetType}`);
    }

    return { url: asset.location, headers: { Authorization: this.authHeader() } };
  }

  async streamImageDownload(
    itemType: string,
    imageId: string,
    assetType = 'ortho_analytic_4b'
  ): Promise<ReadableStream<Uint8Array>> {
    const { url, headers } = await this.downloadAsset(itemType, imageId, assetType);
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error('No response body for image download');
    }
    return response.body;
  }

  /** Clear-sky scenes inside a bounding box ([west, south, east, north]). */
  createBboxFilter(west: number, south: number, east: number, north: number): SearchRequest {
    return {
      item_types: [DEFAULT_ITEM_TYPE],
      filter: {
        type: 'AndFilter',
        config: [
          {
            type: 'GeometryFilter',
            field_name: 'geometry',
            config: {
              type: 'Polygon',
              coordinates: [
                [
                  [west, south],
                  [east, south],
                  [east, north],
                  [west, north],
                  [west, south],
                ],
              ],
            },
          },
          { type: 'RangeFilter', field_name: 'cloud_cover', config: { lte: 0.1 } },
        ],
      },
    };
  }

  createDateRangeFilter(startDate: string, endDate: string): SearchRequest {
    return {
      item_types: [DEFAULT_ITEM_TYPE],
      filter: {
        type: 'AndFilter',
        config: [
          { type: 'DateRangeFilter', field_name: 'acquired', config: { gte: startDate, lte: endDate } },
        ],
      },
    };
  }
}
