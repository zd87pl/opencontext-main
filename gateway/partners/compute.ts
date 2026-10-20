import type { PartnerConfig } from '../src/types.js';

/**
 * DePIN compute is metered like a partner but is not proxied: jobs are routed by `DePINRouter`
 * and the selected node's per-second price is added to the metering record as an additional cost.
 */
export const computeConfig: PartnerConfig = {
  id: 'compute',
  name: 'DePIN Compute',
  baseUrl: 'internal://depin',
  costPerByte: '0',
  costPerRequest: '10000000000', // 10 gwei scheduling fee per job
  authRequired: true,
};
