import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentStream } from '../src/payments.js';
import { SDKError } from '../src/types.js';
import { expectCode } from './helpers.js';

// Streams are keyed by (user, provider) since PaymentStream.sol c4f2afd; the
// user is a wallet address, not a passport token id.
const USER = '0x1111111111111111111111111111111111111111';
const PROVIDER = '0x2222222222222222222222222222222222222222';
const RECEIVER = '0x3333333333333333333333333333333333333333';
const METER = '0x4444444444444444444444444444444444444444';
const ZERO = '0x0000000000000000000000000000000000000000';

// 4-byte selectors as listed in Superfluid's IConstantFlowAgreementV1.sol.
const CFA_ACL_OPERATOR_NO_CREATE_PERMISSIONS = '0xa3eab6ac';
const CFA_ACL_FLOW_RATE_ALLOWANCE_EXCEEDED = '0xa0645c1f';
const CFA_FLOW_ALREADY_EXISTS = '0x801b6863';
const CFA_INSUFFICIENT_BALANCE = '0xea76c9b3';

function tx() {
  return { wait: vi.fn().mockResolvedValue({ logs: [] }) };
}

/** An ethers v6 CALL_EXCEPTION for a custom error the ABI let it decode. */
function decodedRevert(name: string, args: unknown[] = []) {
  return Object.assign(new Error('execution reverted (unknown custom error)'), {
    code: 'CALL_EXCEPTION',
    reason: name,
    revert: { name, signature: `${name}(${args.length ? 'bytes' : ''})`, args },
  });
}

describe('PaymentStream', () => {
  let payments: PaymentStream;
  let mockContract: any;
  let mockConfig: any;

  beforeEach(() => {
    mockContract = {
      registerProvider: vi.fn(),
      updateProviderRate: vi.fn(),
      deregisterProvider: vi.fn(),
      setMeter: vi.fn(),
      startStream: vi.fn(),
      updateStream: vi.fn(),
      stopStream: vi.fn(),
      recordConsumption: vi.fn(),
      getStreamInfo: vi.fn(),
      dataProviders: vi.fn(),
      // Replaces the pre-c4f2afd `activeStreams(uint256,address)` getter.
      streams: vi.fn(),
      meters: vi.fn(),
    };

    mockConfig = {
      passportRegistryAddress: '0x1234567890123456789012345678901234567890',
      contextVaultAddress: '0x1234567890123456789012345678901234567891',
      paymentStreamAddress: '0x1234567890123456789012345678901234567892',
      provider: {},
      signer: {
        getAddress: vi.fn().mockResolvedValue(USER),
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

    it('maps InvalidProvider (zero receiver)', async () => {
      mockContract.registerProvider.mockRejectedValue(decodedRevert('InvalidProvider'));

      await expectCode(payments.registerProvider(ZERO, 5n), SDKError.INVALID_ADDRESS);
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
      mockContract.updateProviderRate.mockRejectedValue(decodedRevert('ProviderNotActive'));

      await expectCode(payments.updateProviderRate(9n), SDKError.PROVIDER_NOT_ACTIVE);
    });

    it('requires a signer', async () => {
      const readOnly = new PaymentStream({ ...mockConfig, signer: undefined });

      await expectCode(readOnly.updateProviderRate(9n), SDKError.NO_SIGNER);
    });
  });

  describe('deregisterProvider', () => {
    it('deregisters the signer', async () => {
      mockContract.deregisterProvider.mockResolvedValue(tx());

      await payments.deregisterProvider();

      expect(mockContract.deregisterProvider).toHaveBeenCalledWith();
    });

    it('maps ProviderNotActive', async () => {
      mockContract.deregisterProvider.mockRejectedValue(decodedRevert('ProviderNotActive'));

      await expectCode(payments.deregisterProvider(), SDKError.PROVIDER_NOT_ACTIVE);
    });

    it('wraps unknown failures', async () => {
      mockContract.deregisterProvider.mockRejectedValue(new Error('boom'));

      await expect(payments.deregisterProvider()).rejects.toThrow(
        'Deregister provider failed: boom'
      );
    });

    it('requires a signer', async () => {
      const readOnly = new PaymentStream({ ...mockConfig, signer: undefined });

      await expectCode(readOnly.deregisterProvider(), SDKError.NO_SIGNER);
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
      ['StreamAlreadyActive', SDKError.STREAM_ALREADY_ACTIVE],
      ['InvalidFlowRate', SDKError.INVALID_FLOW_RATE],
      ['FlowRateOverflow', SDKError.INVALID_FLOW_RATE],
    ])('maps %s', async (revertName, code) => {
      mockContract.startStream.mockRejectedValue(new Error(revertName));

      await expectCode(payments.startStream(PROVIDER, 1024n), code);
    });

    it.each([
      ['CFA_ACL_OPERATOR_NO_CREATE_PERMISSIONS', CFA_ACL_OPERATOR_NO_CREATE_PERMISSIONS],
      ['CFA_ACL_FLOW_RATE_ALLOWANCE_EXCEEDED', CFA_ACL_FLOW_RATE_ALLOWANCE_EXCEEDED],
    ])(
      'maps StreamOperationFailed wrapping %s to FLOW_OPERATOR_PERMISSION',
      async (cfaName, selector) => {
        mockContract.startStream.mockRejectedValue(
          decodedRevert('StreamOperationFailed', [selector])
        );

        const error = await expectCode(
          payments.startStream(PROVIDER, 1024n),
          SDKError.FLOW_OPERATOR_PERMISSION
        );
        expect(error.message).toContain(cfaName);
        expect(error.message).toContain('grantPermissions');
      }
    );

    it.each([
      ['CFA_FLOW_ALREADY_EXISTS', CFA_FLOW_ALREADY_EXISTS],
      ['CFA_INSUFFICIENT_BALANCE', CFA_INSUFFICIENT_BALANCE],
    ])('names the CFA reason for StreamOperationFailed wrapping %s', async (cfaName, selector) => {
      mockContract.startStream.mockRejectedValue(
        decodedRevert('StreamOperationFailed', [selector])
      );

      const error = await expectCode(
        payments.startStream(PROVIDER, 1024n),
        SDKError.STREAM_OPERATION_FAILED
      );
      expect(error.message).toBe(
        `Start stream failed: Superfluid rejected the flow operation (${cfaName})`
      );
    });

    it('reports an unknown StreamOperationFailed reason verbatim', async () => {
      mockContract.startStream.mockRejectedValue(
        decodedRevert('StreamOperationFailed', ['0xdeadbeef'])
      );

      const error = await expectCode(
        payments.startStream(PROVIDER, 1024n),
        SDKError.STREAM_OPERATION_FAILED
      );
      expect(error.message).toContain('0xdeadbeef');
    });

    it('still maps StreamOperationFailed when only the name is known', async () => {
      mockContract.startStream.mockRejectedValue(new Error('StreamOperationFailed'));

      await expectCode(payments.startStream(PROVIDER, 1024n), SDKError.STREAM_OPERATION_FAILED);
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
      ['StreamNotActive', SDKError.STREAM_NOT_ACTIVE],
      ['ProviderNotActive', SDKError.PROVIDER_NOT_ACTIVE],
      ['InvalidFlowRate', SDKError.INVALID_FLOW_RATE],
      ['FlowRateOverflow', SDKError.INVALID_FLOW_RATE],
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

    // Pre-c4f2afd this asserted NotPassportHolder -> NO_PASSPORT. stopStream no
    // longer requires a passport; a missing stream now reverts StreamNotActive.
    it('maps StreamNotActive', async () => {
      mockContract.stopStream.mockRejectedValue(decodedRevert('StreamNotActive'));

      await expectCode(payments.stopStream(PROVIDER), SDKError.STREAM_NOT_ACTIVE);
    });

    it('maps a Superfluid delete-permission failure', async () => {
      mockContract.stopStream.mockRejectedValue(
        decodedRevert('StreamOperationFailed', ['0xe30f1bff']) // CFA_ACL_OPERATOR_NO_DELETE_PERMISSIONS
      );

      await expectCode(payments.stopStream(PROVIDER), SDKError.FLOW_OPERATOR_PERMISSION);
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
    // Pre-c4f2afd the call was recordConsumption(tokenId, bytes); it now takes
    // (user, provider, bytes) and is restricted to enabled meters.
    it('records consumption for a (user, provider) stream', async () => {
      mockContract.recordConsumption.mockResolvedValue(tx());

      await payments.recordConsumption(USER, PROVIDER, 4096n);

      expect(mockContract.recordConsumption).toHaveBeenCalledWith(USER, PROVIDER, 4096n);
    });

    // Replaces the old ProviderNotActive case: recordConsumption no longer
    // checks the provider record, it checks the caller's meter role and the stream.
    it.each([
      ['NotMeter', SDKError.UNAUTHORIZED],
      ['SelfMetering', SDKError.UNAUTHORIZED],
      ['StreamNotActive', SDKError.STREAM_NOT_ACTIVE],
    ])('maps %s', async (revertName, code) => {
      mockContract.recordConsumption.mockRejectedValue(decodedRevert(revertName));

      await expectCode(payments.recordConsumption(USER, PROVIDER, 4096n), code);
    });

    it('wraps unknown failures', async () => {
      mockContract.recordConsumption.mockRejectedValue(new Error('reverted'));

      await expectCode(
        payments.recordConsumption(USER, PROVIDER, 4096n),
        SDKError.TRANSACTION_FAILED
      );
    });

    it('requires a signer', async () => {
      const readOnly = new PaymentStream({ ...mockConfig, signer: undefined });

      await expectCode(readOnly.recordConsumption(USER, PROVIDER, 4096n), SDKError.NO_SIGNER);
    });
  });

  describe('setMeter / isMeter', () => {
    it('enables a meter', async () => {
      mockContract.setMeter.mockResolvedValue(tx());

      await payments.setMeter(METER, true);

      expect(mockContract.setMeter).toHaveBeenCalledWith(METER, true);
    });

    it('maps InvalidProvider (zero meter)', async () => {
      mockContract.setMeter.mockRejectedValue(decodedRevert('InvalidProvider'));

      await expectCode(payments.setMeter(ZERO, true), SDKError.INVALID_ADDRESS);
    });

    it('wraps unknown failures (e.g. not the owner)', async () => {
      mockContract.setMeter.mockRejectedValue(new Error('Ownable: caller is not the owner'));

      await expectCode(payments.setMeter(METER, true), SDKError.TRANSACTION_FAILED);
    });

    it('requires a signer', async () => {
      const readOnly = new PaymentStream({ ...mockConfig, signer: undefined });

      await expectCode(readOnly.setMeter(METER, true), SDKError.NO_SIGNER);
    });

    it('reads the meter flag', async () => {
      mockContract.meters.mockResolvedValue(true);

      await expect(payments.isMeter(METER)).resolves.toBe(true);
      expect(mockContract.meters).toHaveBeenCalledWith(METER);
    });

    it('wraps call failures', async () => {
      mockContract.meters.mockRejectedValue(new Error('network down'));

      await expectCode(payments.isMeter(METER), SDKError.TRANSACTION_FAILED);
    });
  });

  describe('getStreamInfo', () => {
    // Pre-c4f2afd the lookup key was (tokenId, provider); it is now (user, provider).
    it('reports an active stream', async () => {
      mockContract.getStreamInfo.mockResolvedValue([100n, RECEIVER]);

      await expect(payments.getStreamInfo(USER, PROVIDER)).resolves.toEqual({
        flowRate: 100n,
        receiver: RECEIVER,
        active: true,
      });
      expect(mockContract.getStreamInfo).toHaveBeenCalledWith(USER, PROVIDER);
    });

    it('reports an inactive stream', async () => {
      mockContract.getStreamInfo.mockResolvedValue([0n, ZERO]);

      await expect(payments.getStreamInfo(USER, PROVIDER)).resolves.toEqual({
        flowRate: 0n,
        receiver: ZERO,
        active: false,
      });
    });

    it('wraps call failures', async () => {
      mockContract.getStreamInfo.mockRejectedValue(new Error('network down'));

      await expectCode(payments.getStreamInfo(USER, PROVIDER), SDKError.TRANSACTION_FAILED);
    });
  });

  describe('getStream', () => {
    it('decodes the streams(user, provider) struct', async () => {
      mockContract.streams.mockResolvedValue([RECEIVER, 100n, 4096n, 1700000000n]);

      await expect(payments.getStream(USER, PROVIDER)).resolves.toEqual({
        receiver: RECEIVER,
        flowRate: 100n,
        bytesConsumed: 4096n,
        startedAt: 1700000000n,
        active: true,
      });
      expect(mockContract.streams).toHaveBeenCalledWith(USER, PROVIDER);
    });

    it('reports an empty record as inactive', async () => {
      mockContract.streams.mockResolvedValue([ZERO, 0n, 0n, 0n]);

      const stream = await payments.getStream(USER, PROVIDER);

      expect(stream.active).toBe(false);
      expect(stream.flowRate).toBe(0n);
    });

    it('wraps call failures', async () => {
      mockContract.streams.mockRejectedValue(new Error('network down'));

      await expectCode(payments.getStream(USER, PROVIDER), SDKError.TRANSACTION_FAILED);
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
    // Pre-c4f2afd this read activeStreams(tokenId, provider); the contract now
    // exposes streams(user, provider) and the flow rate is its second field.
    it('returns the flow rate from the streams getter', async () => {
      mockContract.streams.mockResolvedValue([RECEIVER, 42n, 0n, 1n]);

      await expect(payments.getActiveFlowRate(USER, PROVIDER)).resolves.toBe(42n);
      expect(mockContract.streams).toHaveBeenCalledWith(USER, PROVIDER);
    });

    it('wraps call failures', async () => {
      mockContract.streams.mockRejectedValue(new Error('network down'));

      await expectCode(payments.getActiveFlowRate(USER, PROVIDER), SDKError.TRANSACTION_FAILED);
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
