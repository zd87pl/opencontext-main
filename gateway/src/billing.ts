import { ethers } from 'ethers';
import { Framework } from '@superfluid-finance/sdk-core';
import { StreamingSession } from './types.js';

export class BillingService {
  private sf: Framework | null = null;
  private provider: ethers.Provider;
  private sessions: Map<string, StreamingSession> = new Map();

  constructor(rpcUrl: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.initializeSuperfluid();
  }

  private async initializeSuperfluid() {
    try {
      this.sf = await Framework.create({
        chainId: 8453, // Base mainnet
        provider: this.provider
      });
    } catch (error) {
      console.error('Failed to initialize Superfluid:', error);
    }
  }

  async startStream(
    passportId: string,
    partnerId: string,
    userAddress: string,
    recipientAddress: string,
    flowRate: string
  ): Promise<StreamingSession> {
    if (!this.sf) {
      throw new Error('Superfluid not initialized');
    }

    const sessionKey = `${passportId}:${partnerId}`;
    
    if (this.sessions.has(sessionKey)) {
      throw new Error('Stream already active for this passport/partner');
    }

    try {
      const usdcx = await this.sf.loadSuperToken('USDCx');
      
      const createFlowOperation = usdcx.createFlow({
        sender: userAddress,
        receiver: recipientAddress,
        flowRate: flowRate
      });

      const session: StreamingSession = {
        passportId,
        partnerId,
        flowRate,
        startTime: Date.now(),
        active: true
      };

      this.sessions.set(sessionKey, session);
      return session;

    } catch (error) {
      console.error('Failed to start stream:', error);
      throw error;
    }
  }

  async stopStream(
    passportId: string,
    partnerId: string,
    userAddress: string,
    recipientAddress: string
  ): Promise<void> {
    if (!this.sf) {
      throw new Error('Superfluid not initialized');
    }

    const sessionKey = `${passportId}:${partnerId}`;
    const session = this.sessions.get(sessionKey);

    if (!session || !session.active) {
      throw new Error('No active stream found');
    }

    try {
      const usdcx = await this.sf.loadSuperToken('USDCx');
      
      const deleteFlowOperation = usdcx.deleteFlow({
        sender: userAddress,
        receiver: recipientAddress
      });

      session.active = false;
      this.sessions.set(sessionKey, session);

    } catch (error) {
      console.error('Failed to stop stream:', error);
      throw error;
    }
  }

  getActiveStreams(passportId?: string): StreamingSession[] {
    const streams = Array.from(this.sessions.values());
    return streams
      .filter(s => s.active && (!passportId || s.passportId === passportId))
      .sort((a, b) => a.startTime - b.startTime);
  }

  calculateAccruedCost(session: StreamingSession): string {
    if (!session.active) {
      return '0';
    }

    const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
    const accrued = BigInt(session.flowRate) * BigInt(elapsed);
    return accrued.toString();
  }
}