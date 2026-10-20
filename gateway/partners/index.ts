import type { PartnerConfig } from '../src/types.js';
import { newswireConfig } from './newswire.js';
import { githubConfig } from './github.js';
import { satelliteConfig } from './satellite.js';
import { computeConfig } from './compute.js';

export { newswireConfig, NewswireClient } from './newswire.js';
export { githubConfig, GitHubClient } from './github.js';
export { satelliteConfig, SatelliteClient } from './satellite.js';
export { computeConfig } from './compute.js';

/** Single source of truth for partner pricing and upstream configuration. */
export const DEFAULT_PARTNERS: readonly PartnerConfig[] = Object.freeze([
  newswireConfig,
  githubConfig,
  satelliteConfig,
  computeConfig,
]);

/** Whether `/proxy/:partnerId/*` can forward requests to this partner. */
export function isProxyablePartner(partner: PartnerConfig): boolean {
  return /^https?:\/\//i.test(partner.baseUrl);
}
