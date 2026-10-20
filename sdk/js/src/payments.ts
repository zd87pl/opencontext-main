import { ethers } from 'ethers';
import { PAYMENT_STREAM_ABI } from './constants.js';
import { getErrorMessage, getRevertArg, isRevertError } from './errors.js';
import {
  OpenContextError,
  SDKError,
  type OpenContextConfig,
  type StreamInfo,
  type Stream,
  type DataProvider,
} from './types.js';

/** Fixed-point scale used by `PaymentStream.sol` for `ratePerByte`. */
const RATE_PRECISION = 10n ** 18n;
const SECONDS_PER_MONTH = 30n * 24n * 60n * 60n;

/**
 * Superfluid CFA errors that `StreamOperationFailed(bytes reason)` can wrap,
 * keyed by 4-byte selector (`IConstantFlowAgreementV1.sol`). Only the ones a
 * PaymentStream user can run into are listed; anything else is reported raw.
 */
const CFA_ERRORS: ReadonlyMap<string, string> = new Map(
  [
    'CFA_ACL_OPERATOR_NO_CREATE_PERMISSIONS',
    'CFA_ACL_OPERATOR_NO_UPDATE_PERMISSIONS',
    'CFA_ACL_OPERATOR_NO_DELETE_PERMISSIONS',
    'CFA_ACL_FLOW_RATE_ALLOWANCE_EXCEEDED',
    'CFA_ACL_NO_SENDER_FLOW_OPERATOR',
    'CFA_FLOW_ALREADY_EXISTS',
    'CFA_FLOW_DOES_NOT_EXIST',
    'CFA_INSUFFICIENT_BALANCE',
    'CFA_INVALID_FLOW_RATE',
    'CFA_FLOW_RATE_TOO_BIG',
    'CFA_DEPOSIT_TOO_BIG',
    'CFA_NO_SELF_FLOW',
  ].map((name) => [ethers.id(`${name}()`).slice(0, 10), name])
);

/** CFA errors that mean the user has not (sufficiently) authorised the contract as flow operator. */
const CFA_PERMISSION_ERRORS: ReadonlySet<string> = new Set([
  'CFA_ACL_OPERATOR_NO_CREATE_PERMISSIONS',
  'CFA_ACL_OPERATOR_NO_UPDATE_PERMISSIONS',
  'CFA_ACL_OPERATOR_NO_DELETE_PERMISSIONS',
  'CFA_ACL_FLOW_RATE_ALLOWANCE_EXCEEDED',
  'CFA_ACL_NO_SENDER_FLOW_OPERATOR',
]);

/**
 * Wrapper around `PaymentStream.sol`, the Superfluid-backed streaming payment
 * contract.
 *
 * Streams are keyed by `(user, provider)`: `user` is the wallet that pays and
 * `provider` the address registered through {@link registerProvider}. The
 * contract never holds funds. Each stream is a Superfluid constant flow whose
 * *sender is the user's own wallet* and whose receiver is the provider's payout
 * address; the contract merely opens, re-prices and closes that flow as a
 * Superfluid *flow operator* on the user's behalf.
 *
 * ## Flow-operator permission (required before `startStream`)
 *
 * The user must first authorise the `PaymentStream` contract address as a flow
 * operator on the Super Token the contract streams (`usdcx()`), with create,
 * update and delete permission. The usual way is Superfluid's `CFAv1Forwarder`
 * ({@link CFA_V1_FORWARDER_ADDRESS}, the same on every network):
 *
 * ```ts
 * const forwarder = new ethers.Contract(
 *   CFA_V1_FORWARDER_ADDRESS,
 *   ['function grantPermissions(address token, address flowOperator) returns (bool)'],
 *   signer
 * );
 * await forwarder.grantPermissions(usdcxAddress, paymentStreamAddress);
 * ```
 *
 * `grantPermissions` gives full control with an unlimited flow-rate allowance.
 * To cap what the contract may stream, call
 * `updateFlowOperatorPermissions(token, flowOperator, permissions, flowRateAllowance)`
 * instead (permissions bitmask: create = 1, update = 2, delete = 4; use 7).
 * The user can revoke the grant at any time with `revokePermissions`. Without
 * it, {@link startStream} fails with {@link SDKError.FLOW_OPERATOR_PERMISSION}.
 *
 * This SDK does not bundle the forwarder ABI, so the grant is left to the
 * caller; the one-line fragment above is all that is needed.
 *
 * ## Metering
 *
 * {@link recordConsumption} may only be called by addresses the contract owner
 * enabled through {@link setMeter} (the metering gateway), never by a provider
 * for its own record. Reads through {@link getStreamInfo} / {@link getStream}
 * reflect the last state written through the contract, not the live Superfluid
 * flow: a flow the user deleted directly, or that was liquidated, still shows
 * as active until {@link stopStream} reconciles it.
 */
export class PaymentStream {
  private contract: ethers.Contract;
  private config: OpenContextConfig;

  constructor(config: OpenContextConfig) {
    this.config = config;
    this.contract = new ethers.Contract(
      config.paymentStreamAddress,
      PAYMENT_STREAM_ABI,
      config.signer || config.provider
    );
  }

  /**
   * Register the signer as a data provider paid at `receiver`, or update an
   * existing registration. `ratePerByte` is in Super Token wei per byte scaled
   * by 1e18 (`RATE_PRECISION`).
   */
  async registerProvider(receiver: string, ratePerByte: bigint): Promise<void> {
    this.requireSigner('registration');

    try {
      const tx = await this.contract.registerProvider(receiver, ratePerByte);
      await tx.wait();
    } catch (error) {
      if (isRevertError(error, 'InvalidProvider')) {
        throw new OpenContextError(
          SDKError.INVALID_ADDRESS,
          'Receiver must not be the zero address'
        );
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Register provider failed: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * Change the signer's price per byte. Existing streams keep their flow rate
   * until the user calls {@link updateStream}.
   */
  async updateProviderRate(newRate: bigint): Promise<void> {
    this.requireSigner('update');

    try {
      const tx = await this.contract.updateProviderRate(newRate);
      await tx.wait();
    } catch (error) {
      if (isRevertError(error, 'ProviderNotActive')) {
        throw new OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, 'Provider not active');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Update rate failed: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * Deactivate the signer's provider record. No new streams can be opened to
   * it; users with live streams can still stop them.
   */
  async deregisterProvider(): Promise<void> {
    this.requireSigner('deregistration');

    try {
      const tx = await this.contract.deregisterProvider();
      await tx.wait();
    } catch (error) {
      if (isRevertError(error, 'ProviderNotActive')) {
        throw new OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, 'Provider not active');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Deregister provider failed: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * Open a stream from the signer to `provider` at the provider's current rate
   * for `bytesPerSecond` of expected throughput. The signer needs a passport
   * and must have granted the contract flow-operator permission (see the
   * class docs).
   */
  async startStream(provider: string, bytesPerSecond: bigint): Promise<void> {
    this.requireSigner('streaming');

    try {
      const tx = await this.contract.startStream(provider, bytesPerSecond);
      await tx.wait();
    } catch (error) {
      throw this.mapStreamError(error, 'Start stream failed');
    }
  }

  /**
   * Re-price the signer's stream to `provider` at the provider's current rate
   * for a new expected throughput.
   */
  async updateStream(provider: string, newBytesPerSecond: bigint): Promise<void> {
    this.requireSigner('update');

    try {
      const tx = await this.contract.updateStream(provider, newBytesPerSecond);
      await tx.wait();
    } catch (error) {
      throw this.mapStreamError(error, 'Update stream failed');
    }
  }

  /**
   * Close the signer's stream to `provider`. Allowed even while the contract is
   * paused or after the passport was revoked. If the flow was already removed
   * in Superfluid, only the contract's record is cleared.
   */
  async stopStream(provider: string): Promise<void> {
    this.requireSigner('stopping');

    try {
      const tx = await this.contract.stopStream(provider);
      await tx.wait();
    } catch (error) {
      throw this.mapStreamError(error, 'Stop stream failed');
    }
  }

  /**
   * Attribute `bytesConsumed` served by `provider` to `user`'s open stream.
   * The signer must be an enabled meter (see {@link setMeter}) and may not be
   * `provider` itself.
   */
  async recordConsumption(user: string, provider: string, bytesConsumed: bigint): Promise<void> {
    this.requireSigner('recording');

    try {
      const tx = await this.contract.recordConsumption(user, provider, bytesConsumed);
      await tx.wait();
    } catch (error) {
      throw this.mapStreamError(error, 'Record consumption failed');
    }
  }

  /**
   * Enable or disable `meter` for {@link recordConsumption}. Owner only.
   */
  async setMeter(meter: string, allowed: boolean): Promise<void> {
    this.requireSigner('meter update');

    try {
      const tx = await this.contract.setMeter(meter, allowed);
      await tx.wait();
    } catch (error) {
      if (isRevertError(error, 'InvalidProvider')) {
        throw new OpenContextError(SDKError.INVALID_ADDRESS, 'Meter must not be the zero address');
      }
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Set meter failed: ${getErrorMessage(error)}`
      );
    }
  }

  async isMeter(address: string): Promise<boolean> {
    try {
      return await this.contract.meters(address);
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Check meter failed: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * Flow rate and receiver last written through the contract for the
   * `(user, provider)` stream.
   */
  async getStreamInfo(user: string, provider: string): Promise<StreamInfo> {
    try {
      const [rawFlowRate, receiver] = await this.contract.getStreamInfo(user, provider);
      const flowRate = BigInt(rawFlowRate);

      return {
        flowRate,
        receiver,
        active: flowRate > 0n,
      };
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get stream info failed: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * The full `(user, provider)` stream record, including metered bytes and
   * the start timestamp.
   */
  async getStream(user: string, provider: string): Promise<Stream> {
    try {
      const [receiver, rawFlowRate, bytesConsumed, startedAt] = await this.contract.streams(
        user,
        provider
      );
      const flowRate = BigInt(rawFlowRate);

      return {
        receiver,
        flowRate,
        bytesConsumed: BigInt(bytesConsumed),
        startedAt: BigInt(startedAt),
        active: flowRate > 0n,
      };
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get stream failed: ${getErrorMessage(error)}`
      );
    }
  }

  async getProvider(address: string): Promise<DataProvider | null> {
    try {
      const [receiver, ratePerByte, totalBytesServed, active] =
        await this.contract.dataProviders(address);

      if (!active) {
        return null;
      }

      return {
        receiver,
        ratePerByte: BigInt(ratePerByte),
        totalBytesServed: BigInt(totalBytesServed),
        active: true,
      };
    } catch (error) {
      throw new OpenContextError(
        SDKError.TRANSACTION_FAILED,
        `Get provider failed: ${getErrorMessage(error)}`
      );
    }
  }

  /**
   * Flow rate of the `(user, provider)` stream in Super Token wei per second,
   * or 0 when there is none.
   */
  async getActiveFlowRate(user: string, provider: string): Promise<bigint> {
    return (await this.getStream(user, provider)).flowRate;
  }

  /**
   * Flow rate (token units per second) for a provider rate and throughput,
   * using the same integer arithmetic as the contract. The contract reverts
   * with `FlowRateOverflow` above `int96.max` instead of truncating.
   */
  calculateFlowRate(ratePerByte: bigint, bytesPerSecond: bigint): bigint {
    return (ratePerByte * bytesPerSecond) / RATE_PRECISION;
  }

  /**
   * Cost of a stream over a 30-day month at the given throughput.
   */
  calculateMonthlyCost(ratePerByte: bigint, bytesPerSecond: bigint): bigint {
    return this.calculateFlowRate(ratePerByte, bytesPerSecond) * SECONDS_PER_MONTH;
  }

  private requireSigner(action: string): void {
    if (!this.config.signer) {
      throw new OpenContextError(SDKError.NO_SIGNER, `Signer required for ${action}`);
    }
  }

  /**
   * Map the contract's stream and metering errors to SDK codes. Every stream
   * operation shares this so a given revert always maps to the same code.
   */
  private mapStreamError(error: unknown, prefix: string): OpenContextError {
    if (isRevertError(error, 'NotPassportHolder')) {
      return new OpenContextError(SDKError.NO_PASSPORT, 'No passport found for address');
    }
    if (isRevertError(error, 'ProviderNotActive')) {
      return new OpenContextError(SDKError.PROVIDER_NOT_ACTIVE, 'Provider not active');
    }
    if (isRevertError(error, 'StreamAlreadyActive')) {
      return new OpenContextError(
        SDKError.STREAM_ALREADY_ACTIVE,
        'A stream to this provider is already open'
      );
    }
    if (isRevertError(error, 'StreamNotActive')) {
      return new OpenContextError(SDKError.STREAM_NOT_ACTIVE, 'No open stream to this provider');
    }
    if (isRevertError(error, 'InvalidFlowRate')) {
      return new OpenContextError(
        SDKError.INVALID_FLOW_RATE,
        'Flow rate rounds to zero: raise bytesPerSecond or the provider rate'
      );
    }
    if (isRevertError(error, 'FlowRateOverflow')) {
      return new OpenContextError(
        SDKError.INVALID_FLOW_RATE,
        'Flow rate exceeds the int96 range Superfluid supports'
      );
    }
    if (isRevertError(error, 'NotMeter')) {
      return new OpenContextError(SDKError.UNAUTHORIZED, 'Signer is not an enabled meter');
    }
    if (isRevertError(error, 'SelfMetering')) {
      return new OpenContextError(
        SDKError.UNAUTHORIZED,
        'A meter cannot record consumption for its own provider record'
      );
    }
    if (isRevertError(error, 'StreamOperationFailed')) {
      return this.mapSuperfluidFailure(error, prefix);
    }
    return new OpenContextError(
      SDKError.TRANSACTION_FAILED,
      `${prefix}: ${getErrorMessage(error)}`
    );
  }

  /**
   * `StreamOperationFailed(bytes reason)` carries the Superfluid host's revert
   * data; when it is a known CFA error selector, name it and single out the
   * missing-permission case callers must fix on the user's side.
   */
  private mapSuperfluidFailure(error: unknown, prefix: string): OpenContextError {
    const reason = getRevertArg(error);
    const selector =
      typeof reason === 'string' && reason.length >= 10
        ? reason.slice(0, 10).toLowerCase()
        : undefined;
    const cfaError = selector ? CFA_ERRORS.get(selector) : undefined;

    if (cfaError && CFA_PERMISSION_ERRORS.has(cfaError)) {
      return new OpenContextError(
        SDKError.FLOW_OPERATOR_PERMISSION,
        `${prefix}: ${cfaError}. Grant the PaymentStream contract flow-operator permission ` +
          'on the Super Token (CFAv1Forwarder.grantPermissions) with a sufficient allowance first'
      );
    }
    const detail = cfaError ?? (typeof reason === 'string' ? reason : getErrorMessage(error));
    return new OpenContextError(
      SDKError.STREAM_OPERATION_FAILED,
      `${prefix}: Superfluid rejected the flow operation (${detail})`
    );
  }
}
