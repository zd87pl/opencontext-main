import { PartnerConfig } from '../types.js';

export const satelliteConfig: PartnerConfig = {
  id: 'satellite',
  name: 'Satellite Imagery API',
  baseUrl: 'https://api.planet.com/data/v1',
  costPerByte: '10000000000', // 10 gwei per byte (higher cost for imagery)
  costPerRequest: '1000000000000', // 1000 gwei per request
  authRequired: true,
  rateLimits: {
    requests: 100,
    window: 3600 // 1 hour
  }
};

export interface SatelliteImage {
  id: string;
  geometry: {
    type: string;
    coordinates: number[][][];
  };
  properties: {
    acquired: string;
    anomalous_pixels: number;
    clear_confidence_percent: number;
    clear_percent: number;
    cloud_cover: number;
    cloud_percent: number;
    ground_control: boolean;
    gsd: number;
    instrument: string;
    item_type: string;
    pixel_resolution: number;
    provider: string;
    published: string;
    quality_category: string;
    satellite_id: string;
    strip_id: string;
    sun_azimuth: number;
    sun_elevation: number;
    updated: string;
    view_angle: number;
    visible_confidence_percent: number;
    visible_percent: number;
  };
  links: {
    self: string;
    assets: string;
    thumbnail: string;
  };
}

export interface ImageAsset {
  [key: string]: {
    href: string;
    type: string;
    permissions: string[];
    expires_at?: string;
    status: 'active' | 'inactive';
  };
}

export interface SearchRequest {
  item_types: string[];
  filter: {
    type: string;
    config: {
      gte?: string;
      lte?: string;
      field_name?: string;
    }[];
  };
  bbox?: [number, number, number, number]; // [west, south, east, north]
  geometry?: {
    type: string;
    coordinates: number[][];
  };
}

export class SatelliteClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = satelliteConfig.baseUrl;
  }

  private async request(endpoint: string, options?: RequestInit): Promise<any> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Basic ${Buffer.from(this.apiKey + ':').toString('base64')}`,
        'Content-Type': 'application/json',
        ...options?.headers
      }
    });

    if (!response.ok) {
      throw new Error(`Satellite API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async searchImages(searchRequest: SearchRequest): Promise<{
    features: SatelliteImage[];
    links: { next?: string; prev?: string };
  }> {
    return this.request('/quick-search', {
      method: 'POST',
      body: JSON.stringify(searchRequest)
    });
  }

  async getImageAssets(imageId: string): Promise<ImageAsset> {
    return this.request(`/assets/${imageId}`);
  }

  async activateAsset(imageId: string, assetType: string): Promise<void> {
    await this.request(`/assets/${imageId}/${assetType}/activate`, {
      method: 'GET'
    });
  }

  async downloadAsset(
    imageId: string, 
    assetType: string
  ): Promise<{ url: string; headers: Record<string, string> }> {
    const assets = await this.getImageAssets(imageId);
    const asset = assets[assetType];
    
    if (!asset) {
      throw new Error(`Asset type ${assetType} not found for image ${imageId}`);
    }

    if (asset.status !== 'active') {
      await this.activateAsset(imageId, assetType);
      
      let attempts = 0;
      const maxAttempts = 30;
      
      while (attempts < maxAttempts) {
        const updatedAssets = await this.getImageAssets(imageId);
        if (updatedAssets[assetType].status === 'active') {
          break;
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;
      }
      
      if (attempts >= maxAttempts) {
        throw new Error(`Asset activation timeout for ${imageId}/${assetType}`);
      }
    }

    return {
      url: asset.href,
      headers: {
        'Authorization': `Basic ${Buffer.from(this.apiKey + ':').toString('base64')}`
      }
    };
  }

  async streamImageDownload(
    imageId: string,
    assetType: string = 'analytic'
  ): Promise<ReadableStream> {
    const { url, headers } = await this.downloadAsset(imageId, assetType);
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('No response body for image download');
    }

    return response.body;
  }

  createBboxFilter(west: number, south: number, east: number, north: number): SearchRequest {
    return {
      item_types: ['PSScene4Band'],
      bbox: [west, south, east, north],
      filter: {
        type: 'AndFilter',
        config: [
          {
            type: 'RangeFilter',
            field_name: 'clear_percent',
            config: { gte: '90' }
          },
          {
            type: 'RangeFilter', 
            field_name: 'cloud_cover',
            config: { lte: '10' }
          }
        ]
      }
    };
  }

  createDateRangeFilter(startDate: string, endDate: string): SearchRequest {
    return {
      item_types: ['PSScene4Band'],
      filter: {
        type: 'AndFilter',
        config: [
          {
            type: 'DateRangeFilter',
            field_name: 'acquired',
            config: { gte: startDate, lte: endDate }
          }
        ]
      }
    };
  }
}