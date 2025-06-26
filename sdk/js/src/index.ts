export { OpenContextClient } from './client.js';
export { PassportRegistry } from './passport.js';
export { ContextVault } from './vault.js';
export { PaymentStream } from './payments.js';
export * from './types.js';
export * from './constants.js';

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