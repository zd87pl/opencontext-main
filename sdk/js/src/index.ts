import { OpenContextClient } from './client.js';

export { OpenContextClient };
export { PassportRegistry } from './passport.js';
export { ContextVault } from './vault.js';
export { PaymentStream } from './payments.js';
export { ContextCrypto } from './crypto.js';
export { IPFSService } from './ipfs.js';
export type { IPFSConfig, IPFSMetadata, IPFSStats, ChunkManifest } from './ipfs.js';
export * from './types.js';
export * from './constants.js';

/**
 * Functional shortcuts over {@link OpenContextClient} for callers that prefer
 * free functions to methods.
 */
export const authenticate = async (client: OpenContextClient) => {
  return client.authenticate();
};

export const storeContext = async (client: OpenContextClient, data: string) => {
  return client.storeContext(data);
};

export const getLatestContext = async (client: OpenContextClient) => {
  return client.getMyLatestContext();
};

export const streamPay = async (
  client: OpenContextClient,
  provider: string,
  bytesPerSecond: bigint
) => {
  return client.streamPay(provider, bytesPerSecond);
};
