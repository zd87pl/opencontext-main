import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentStream } from '../src/payments.js';
import { SDKError } from '../src/types.js';
import { expectCode } from './helpers.js';

const PROVIDER = '0x2222222222222222222222222222222222222222';
const RECEIVER = '0x3333333333333333333333333333333333333333';
const ZERO = '0x0000000000000000000000000000000000000000';

function tx() {
  return { wait: vi.fn().mockResolvedValue({ logs: [] }) };
}

describe('PaymentStream', () => {
  let payments: PaymentStream;
  let mockContract: any;
  let mockConfig: any;

  beforeEach(() => {
    mockContract = {
      registerProvider: vi.fn(),
      updateProviderRate: vi.fn(),
      startStream: vi.fn(),
      updateStream: vi.fn(),
      stopStream: vi.fn(),
      recordConsumption: vi.fn(),
      getStreamInfo: vi.fn(),
      dataProviders: vi.fn(),
      activeStreams: vi.fn(),
    };

    mockConfig = {
      passportRegistryAddress: '0x1234567890123456789012345678901234567890',
      contextVaultAddress: '0x1234567890123456789012345678901234567891',
      paymentStreamAddress: '0x1234567890123456789012345678901234567892',
      provider: {},
      signer: {
        getAddress: vi.fn().mockResolvedValue('0x1111111111111111111111111111111111111111'),
      },
    };

    payments = new PaymentStream(mockConfig);
    (payments as any).contract = mockContract;
  });

  describe('registerProvider', () => {
    it('registers a provider', async () => {
      mockContract.registerProvider.mockResolvedValue(tx());

      await payments.registerProvider(RECEIVER, 5n);

      expect(mockContract.registerProvider).toHaveBeenCalledWith(RECEIVER, 5n);
    });

    it('requires a signer', async () => {
      const readOnly = new PaymentStream({ ...mockConfig, signer: undefined });

      await expectCode(readOnly.registerProvider(RECEIVER, 5n), SDKError.NO_SIGNER);
    });

    it('wraps transaction failures', async () => {
      mockContract.registerProvider.mockRejectedValue(new Error('boom'));

      await expect(payments.registerProvider(RECEIVER, 5n)).rejects.toThrow(
        'Register provider failed: boom'
      );
    });
  });

  describe('updateProviderRate', () => {
    it('updates the rate', async () => {
      mockContract.updateProviderRate.mockResolvedValue(tx());

      await payments.updateProviderRate(9n);

      expect(mockContract.updateProviderRate).toHaveBeenCalledWith(9n);
    });

    it('maps ProviderNotActive', async () => {
      mockContract.updateProviderRate.mockRejectedValue(new Error('ProviderNotActive'));

      await expectCode(payments.updateProviderRate(9n), SDKError.PROVIDER_NOT_ACTIVE);
    });

    it('maps custom errors that ethers decoded by name', async () => {
      const revert = Object.assign(new Error('execution reverted (unknown custom error)'), {
        code: 'CALL_EXCEPTION',
        reason: 'ProviderNotActive',
        revert: { name: 'ProviderNotActive', signature: 'ProviderNotActive()', args: [] },
      });
      mockContract.updateProviderRate.mockRejectedValue(revert);

      await expectCode(payments.updateProviderRate(9n), SDKError.PROVIDER_NOT_ACTIVE);
    });

    it('requires a signer', async () => {
      const readOnly = new PaymentStream({ ...mockConfig, signer: undefined });

      await expectCode(readOnly.updateProviderRate(9n), SDKError.NO_SIGNER);
    });
  });

  describe('startStream', () => {
    it('starts a stream', async () => {
      mockContract.startStream.mockResolvedValue(tx());

      await payments.startStream(PROVIDER, 1024n);

      expect(mockContract.startStream).toHaveBeenCalledWith(PROVIDER, 1024n);
    });

    it('requires a signer', async () => {
      const readOnly = new PaymentStream({ ...mockConfig, signer: undefined });

      await expectCode(readOnly.startStream(PROVIDER, 1024n), SDKError.NO_SIGNER);
    });

    it.each([
      ['NotPassportHolder', SDKError.NO_PASSPORT],
      ['ProviderNotActive', SDKError.PROVIDER_NOT_ACTIVE],
      ['InvalidFlowRate', SDKError.INVALID_FLOW_RATE],
    ])('maps %s', async (revertName, code) => {
      mockContract.startStream.mockRejectedValue(new Error(revertName));

      await expectCode(payments.startStream(PROVIDER, 1024n), code);
    });

    it('wraps unknown failures', async () => {
      mockContract.startStream.mockRejectedValue(new Error('insufficient funds'));

      const error = await expectCode(
        payments.startStream(PROVIDER, 1024n),
        SDKError.TRANSACTION_FAILED
      );
      expect(error.message).toBe('Start stream failed: insufficient funds');
    });
  });

  describe('updateStream', () => {
    it('updates a stream', async () => {
      mockContract.updateStream.mockResolvedValue(tx());

      await payments.updateStream(PROVIDER, 2048n);

      expect(mockContract.updateStream).toHaveBeenCalledWith(PROVIDER, 2048n);
    });

    it.each([
      ['NotPassportHolder', SDKError.NO_PASSPORT],
      ['ProviderNotActive', SDKError.PROVIDER_NOT_ACTIVE],
      ['InvalidFlowRate', SDKError.INVALID_FLOW_RATE],
    ])('maps %s', async (revertName, code) => {
      mockContract.updateStream.mockRejectedValue(new Error(revertName));

      await expectCode(payments.updateStream(PROVIDER, 2048n), code);
    });

    it('requires a signer', async () => {
      const readOnly = new PaymentStream({ ...mockConfig, signer: undefined });

      await expectCode(readOnly.updateStream(PROVIDER, 2048n), SDKError.NO_SIGNER);
    });
  });

  describe('stopStream', () => {
    it('stops a stream', async () => {
      mockContract.stopStream.mockResolvedValue(tx());

      await payments.stopStream(PROVIDER);

      expect(mockContract.stopStream).toHaveBeenCalledWith(PROVIDER);
    });

    it('maps NotPassportHolder', async () => {
      mockContract.stopStream.mockRejectedValue(new Error('NotPassportHolder'));

      await expectCode(payments.stopStream(PROVIDER), SDKError.NO_PASSPORT);
    });

    it('wraps unknown failures', async () => {
      mockContract.stopStream.mockRejectedValue(new Error('nonce too low'));

      await expect(payments.stopStream(PROVIDER)).rejects.toThrow('Stop stream failed: nonce too low');
    });

    it('requires a signer', async () => {
      const readOnly = new PaymentStream({ ...mockConfig, signer: undefined });

      await expectCode(readOnly.stopStream(PROVIDER), SDKError.NO_SIGNER);
    });
  });

  describe('recordConsumption', () => {
    it('records consumption', async () => {
      mockContract.recordConsumption.mockResolvedValue(tx());

      await payments.recordConsumption(1n, 4096n);

      expect(mockContract.recordConsumption).toHaveBeenCalledWith(1n, 4096n);
    });

    it('maps ProviderNotActive', async () => {
      mockContract.recordConsumption.mockRejectedValue(new Error('ProviderNotActive'));

      await expectCode(payments.recordConsumption(1n, 4096n), SDKError.PROVIDER_NOT_ACTIVE);
    });

    it('wraps unknown failures', async () => {
      mockContract.recordConsumption.mockRejectedValue(new Error('reverted'));

      await expectCode(payments.recordConsumption(1n, 4096n), SDKError.TRANSACTION_FAILED);
    });

    it('requires a signer', async () => {
      const readOnly = new PaymentStream({ ...mockConfig, signer: undefined });

      await expectCode(readOnly.recordConsumption(1n, 4096n), SDKError.NO_SIGNER);
    });
  });

  describe('getStreamInfo', () => {
    it('reports an active stream', async () => {
      mockContract.getStreamInfo.mockResolvedValue([100n, RECEIVER]);

      await expect(payments.getStreamInfo(1n, PROVIDER)).resolves.toEqual({
        flowRate: 100n,
        receiver: RECEIVER,
        active: true,
      });
    });

    it('reports an inactive stream', async () => {
      mockContract.getStreamInfo.mockResolvedValue([0n, ZERO]);

      await expect(payments.getStreamInfo(1n, PROVIDER)).resolves.toEqual({
        flowRate: 0n,
        receiver: ZERO,
        active: false,
      });
    });

    it('wraps call failures', async () => {
      mockContract.getStreamInfo.mockRejectedValue(new Error('network down'));

      await expectCode(payments.getStreamInfo(1n, PROVIDER), SDKError.TRANSACTION_FAILED);
    });
  });

  describe('getProvider', () => {
    it('returns an active provider', async () => {
      mockContract.dataProviders.mockResolvedValue([RECEIVER, 5n, 123n, true]);

      await expect(payments.getProvider(PROVIDER)).resolves.toEqual({
        receiver: RECEIVER,
        ratePerByte: 5n,
        totalBytesServed: 123n,
        active: true,
      });
    });

    it('returns null for an unregistered or inactive provider', async () => {
      mockContract.dataProviders.mockResolvedValue([ZERO, 0n, 0n, false]);

      await expect(payments.getProvider(PROVIDER)).resolves.toBeNull();
    });

    it('wraps call failures', async () => {
      mockContract.dataProviders.mockRejectedValue(new Error('network down'));

      await expectCode(payments.getProvider(PROVIDER), SDKError.TRANSACTION_FAILED);
    });
  });

  describe('getActiveFlowRate', () => {
    it('returns the flow rate as a bigint', async () => {
      mockContract.activeStreams.mockResolvedValue(42n);

      await expect(payments.getActiveFlowRate(1n, PROVIDER)).resolves.toBe(42n);
      expect(mockContract.activeStreams).toHaveBeenCalledWith(1n, PROVIDER);
    });

    it('wraps call failures', async () => {
      mockContract.activeStreams.mockRejectedValue(new Error('network down'));

      await expectCode(payments.getActiveFlowRate(1n, PROVIDER), SDKError.TRANSACTION_FAILED);
    });
  });

  describe('rate maths', () => {
    const ONE = 10n ** 18n;

    it('scales ratePerByte by 1e18 like the contract', () => {
      expect(payments.calculateFlowRate(ONE, 1000n)).toBe(1000n);
      expect(payments.calculateFlowRate(ONE / 2n, 1000n)).toBe(500n);
    });

    it('truncates sub-unit flow rates', () => {
      expect(payments.calculateFlowRate(1n, 1n)).toBe(0n);
    });

    it('prices a 30-day month', () => {
      expect(payments.calculateMonthlyCost(ONE, 1n)).toBe(30n * 24n * 60n * 60n);
    });
  });
});
