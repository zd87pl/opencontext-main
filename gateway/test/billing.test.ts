import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  BASE_USDCX_ADDRESS,
  BillingService,
  CFA_V1_FORWARDER_ABI,
  CFA_V1_FORWARDER_ADDRESS,
  StreamNotActiveOnChainError,
  type FlowReader,
} from '../src/billing.js';
import { MemoryStorage } from '../src/storage.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/validation.js';

const SENDER = '0x1111111111111111111111111111111111111111';
const RECEIVER = '0x2222222222222222222222222222222222222222';
const iface = new ethers.Interface(CFA_V1_FORWARDER_ABI);

function fakeReader(rate: bigint | (() => Promise<bigint>)): FlowReader & { getFlowrate: ReturnType<typeof vi.fn> } {
  return {
    getFlowrate: vi.fn(typeof rate === 'bigint' ? async () => rate : rate),
  };
}

function service(reader: FlowReader = fakeReader(0n)): BillingService {
  return new BillingService({ storage: new MemoryStorage(), flowReader: reader });
}

describe('BillingService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('configuration', () => {
    it('defaults to USDCx on Base through the CFAv1Forwarder', () => {
      const billing = new BillingService();
      expect(billing.chainId).toBe(8453);
      expect(billing.superToken).toBe(ethers.getAddress(BASE_USDCX_ADDRESS));
      expect(billing.forwarder).toBe(ethers.getAddress(CFA_V1_FORWARDER_ADDRESS));
    });

    it('accepts a custom chain, token and forwarder', () => {
      const billing = new BillingService({ chainId: 84532, superToken: SENDER, forwarder: RECEIVER });
      expect(billing.chainId).toBe(84532);
      expect(billing.superToken).toBe(SENDER);
      expect(billing.forwarder).toBe(RECEIVER);
    });

    it('rejects malformed addresses', () => {
      expect(() => new BillingService({ superToken: '0x123' })).toThrow(ValidationError);
    });
  });

  describe('unsigned transactions', () => {
    it('encodes createFlow against the configured super token', () => {
      const billing = service();
      const tx = billing.buildCreateFlowTx(SENDER.toLowerCase(), RECEIVER, '1000');

      expect(tx.to).toBe(billing.forwarder);
      expect(tx.value).toBe('0');
      expect(tx.chainId).toBe(8453);

      const decoded = iface.decodeFunctionData('createFlow', tx.data);
      expect(decoded.token).toBe(billing.superToken);
      expect(decoded.sender).toBe(SENDER);
      expect(decoded.receiver).toBe(RECEIVER);
      expect(decoded.flowrate).toBe(1000n);
      expect(decoded.userData).toBe('0x');
    });

    it('encodes updateFlow and deleteFlow', () => {
      const billing = service();
      const update = iface.decodeFunctionData('updateFlow', billing.buildUpdateFlowTx(SENDER, RECEIVER, 5n).data);
      expect(update.flowrate).toBe(5n);
      const del = iface.decodeFunctionData('deleteFlow', billing.buildDeleteFlowTx(SENDER, RECEIVER).data);
      expect(del.sender).toBe(SENDER);
      expect(del.receiver).toBe(RECEIVER);
    });

    it('rejects invalid addresses and flow rates', () => {
      const billing = service();
      expect(() => billing.buildCreateFlowTx('nope', RECEIVER, '1')).toThrow(ValidationError);
      expect(() => billing.buildCreateFlowTx(SENDER, RECEIVER, '0')).toThrow(/between 1 and 2\^95-1/);
      expect(() => billing.buildCreateFlowTx(SENDER, RECEIVER, 'abc')).toThrow(ValidationError);
      expect(() => billing.buildCreateFlowTx(SENDER, RECEIVER, 1n << 95n)).toThrow(ValidationError);
      expect(() => billing.buildCreateFlowTx(SENDER, RECEIVER, (1n << 95n) - 1n)).not.toThrow();
    });
  });

  describe('stream registry', () => {
    it('registers a stream once the on-chain flow covers the requested rate', async () => {
      const reader = fakeReader(1000n);
      const billing = service(reader);

      const session = await billing.startStream('p1', 'github', SENDER, RECEIVER, '1000');
      expect(session).toMatchObject({
        passportId: 'p1',
        partnerId: 'github',
        sender: SENDER,
        receiver: RECEIVER,
        token: billing.superToken,
        flowRate: '1000',
        active: true,
      });
      expect(reader.getFlowrate).toHaveBeenCalledWith(billing.superToken, SENDER, RECEIVER);
      expect(await billing.getStream('p1', 'github')).toEqual(session);
    });

    it('refuses to register a stream the chain does not show', async () => {
      const billing = service(fakeReader(999n));
      const attempt = billing.startStream('p1', 'github', SENDER, RECEIVER, '1000');
      await expect(attempt).rejects.toBeInstanceOf(StreamNotActiveOnChainError);
      await expect(attempt).rejects.toBeInstanceOf(ConflictError);
      await attempt.catch((error: StreamNotActiveOnChainError) => {
        expect(error.onChainFlowRate).toBe(999n);
        expect(error.statusCode).toBe(409);
      });
      expect(await billing.getActiveStreams()).toHaveLength(0);
    });

    it('rejects a second active stream for the same passport and partner', async () => {
      const billing = service(fakeReader(1000n));
      await billing.startStream('p1', 'github', SENDER, RECEIVER, '1000');
      await expect(billing.startStream('p1', 'github', SENDER, RECEIVER, '1000')).rejects.toThrow(
        'Stream already active'
      );
    });

    it('lists active streams oldest first, per passport and globally', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const billing = service(fakeReader(1n << 40n));

      await billing.startStream('p1', 'github', SENDER, RECEIVER, '10');
      vi.setSystemTime(Date.now() + 1000);
      await billing.startStream('p2', 'newswire', SENDER, RECEIVER, '20');
      vi.setSystemTime(Date.now() + 1000);
      await billing.startStream('p1', 'satellite', SENDER, RECEIVER, '30');

      const all = await billing.getActiveStreams();
      expect(all.map((s) => s.flowRate)).toEqual(['10', '20', '30']);
      const p1 = await billing.getActiveStreams('p1');
      expect(p1.map((s) => s.partnerId)).toEqual(['github', 'satellite']);
      expect(await billing.getActiveStreams('nobody')).toEqual([]);
    });

    it('stops a stream, reports the on-chain rate and allows a restart', async () => {
      const reader = fakeReader(1000n);
      const billing = service(reader);
      await billing.startStream('p1', 'github', SENDER, RECEIVER, '1000');

      const { session, onChainFlowRate } = await billing.stopStream('p1', 'github');
      expect(session.active).toBe(false);
      expect(session.stopTime).toBeGreaterThan(0);
      expect(onChainFlowRate).toBe(1000n);
      expect(await billing.getActiveStreams('p1')).toHaveLength(0);

      await expect(billing.stopStream('p1', 'github')).rejects.toBeInstanceOf(NotFoundError);
      await expect(billing.stopStream('p1', 'nothing')).rejects.toThrow('No active stream');

      const restarted = await billing.startStream('p1', 'github', SENDER, RECEIVER, '500');
      expect(restarted.active).toBe(true);
      expect(restarted.flowRate).toBe('500');
    });

    it('propagates reader failures on start but tolerates them on stop', async () => {
      const reader = fakeReader(1000n);
      const billing = service(reader);
      await billing.startStream('p1', 'github', SENDER, RECEIVER, '1000');

      reader.getFlowrate.mockRejectedValue(new Error('rpc down'));
      await expect(billing.getFlowRate(SENDER, RECEIVER)).rejects.toThrow('rpc down');
      await expect(billing.startStream('p2', 'github', SENDER, RECEIVER, '1')).rejects.toThrow('rpc down');

      const { onChainFlowRate } = await billing.stopStream('p1', 'github');
      expect(onChainFlowRate).toBe(-1n);
    });

    it('validates addresses before touching the chain', async () => {
      const reader = fakeReader(1000n);
      const billing = service(reader);
      await expect(billing.startStream('p1', 'github', 'bad', RECEIVER, '1')).rejects.toBeInstanceOf(ValidationError);
      await expect(billing.getFlowRate(SENDER, 'bad')).rejects.toBeInstanceOf(ValidationError);
      expect(reader.getFlowrate).not.toHaveBeenCalled();
    });
  });

  describe('accrued cost', () => {
    it('grows with elapsed whole seconds while active and freezes once stopped', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const billing = service(fakeReader(1000n));
      const session = await billing.startStream('p1', 'github', SENDER, RECEIVER, '1000');

      expect(billing.calculateAccruedCost(session)).toBe('0');
      vi.setSystemTime(session.startTime + 10_500);
      expect(billing.calculateAccruedCost(session)).toBe('10000');

      const { session: stopped } = await billing.stopStream('p1', 'github');
      vi.setSystemTime(session.startTime + 60_000);
      expect(billing.calculateAccruedCost(stopped)).toBe('10000');
      expect(billing.calculateAccruedCost(session, session.startTime - 5000)).toBe('0');
    });
  });

  it('closes its storage', async () => {
    const storage = new MemoryStorage();
    const close = vi.spyOn(storage, 'close');
    await new BillingService({ storage }).close();
    expect(close).toHaveBeenCalled();
  });
});
