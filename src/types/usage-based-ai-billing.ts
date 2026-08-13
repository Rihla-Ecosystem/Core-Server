import type { AIBillingOperationStatus } from '@prisma/client';
import type { UsageBasedAIFeature } from '../config/ai-runtime-routing.js';
import type { ChatLimitsConfig } from '../config/chat-limits.js';
import type { WalletPolicyConfig } from '../config/wallet-policy.js';
import type { BusinessConsumptionSource } from '../services/business-token-consumption.service.js';
import type {
  CreateAIBillingOperationInput,
  CreateAIBillingOperationResult,
  MarkAIBillingOperationReleasedInput,
  MarkAIBillingOperationReleasedResult,
  MarkAIBillingOperationSettledInput,
  MarkAIBillingOperationSettledResult,
  RecordAIBillingOperationExecutionSuccessInput,
  RecordAIBillingOperationExecutionSuccessResult,
  RecordAIBillingOperationFailureInput,
  RecordAIBillingOperationFailureResult,
  RecordAIBillingOperationPricingInput,
  RecordAIBillingOperationPricingResult,
  AIBillingOperationEvidenceResult,
} from './ai-billing-operation.js';
import type { AIExecutionOutcome } from './ai-execution.js';
import type {
  ReserveBusinessTokensForAmountInput,
  ReserveBusinessTokensResult,
  SettleBusinessTokenReservationForAmountInput,
  SettleBusinessTokenReservationResult,
  ReleaseBusinessTokenReservationInput,
  ReleaseBusinessTokenReservationResult,
} from '../services/token-reservation.service.js';
import type { ProviderRateCard, ShadowPricingInput, ShadowPricingResult } from './provider-pricing.js';
import type { WalletChargeComputation, WalletConversionConfig } from '../utils/wallet-conversion.js';
import type { AIExecutionBudget } from '../config/ai-execution-budget.js';

/**
 * Phase 2G-A usage-based AI Wallet billing coordinator contracts.
 *
 * The coordinator reuses the durable TokenReservation / AIBillingOperation /
 * recovery primitives (no parallel durable architecture) and prices the actual
 * `providerCalls[]` via the existing provider-pricing engine, converting the
 * priced nano-USD cost to Wallet Tokens exactly once.
 */

export type UsageBasedBillingStage =
  | 'PREFLIGHT'
  | 'QUOTE'
  | 'RESERVATION'
  | 'OPERATION_CREATION'
  | 'EXECUTION'
  | 'EXECUTION_EVIDENCE'
  | 'USAGE_VALIDATION'
  | 'PRICING'
  | 'PRICING_EVIDENCE'
  | 'SETTLEMENT'
  | 'SETTLED_EVIDENCE'
  | 'FAILURE_EVIDENCE'
  | 'RELEASE'
  | 'RELEASED_EVIDENCE';

export type UsageBasedBillingReasonCode =
  | 'INVALID_OPERATION_ID'
  | 'INVALID_USER_ID'
  | 'INVALID_FEATURE'
  | 'INVALID_SOURCE'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'INVALID_REQUESTED_IDENTITY'
  | 'OPERATION_LOOKUP_FAILED'
  | 'OPERATION_REPLAY_REQUIRES_RECOVERY'
  | 'OPERATION_CREATE_REPLAY'
  | 'OPERATION_CREATE_FAILED'
  | 'OPERATION_SNAPSHOT_MISMATCH'
  | 'QUOTE_FAILED'
  | 'RESERVATION_FAILED'
  | 'EXECUTION_EVIDENCE_FAILED'
  | 'USAGE_LIMITS_EXCEEDED'
  | 'PRICING_FAILED'
  | 'PRICING_LIMITS_EXCEEDED'
  | 'UNPRICED_PROVIDER_CALLS'
  | 'PRICING_EVIDENCE_FAILED'
  | 'SETTLEMENT_FAILED'
  | 'SETTLED_EVIDENCE_FAILED'
  | 'FAILURE_EVIDENCE_FAILED'
  | 'RELEASE_FAILED'
  | 'RELEASED_EVIDENCE_FAILED'
  | 'INDETERMINATE_EXECUTION'
  | 'EXECUTOR_THROWN_DISPATCH_UNKNOWN'
  | 'EXECUTION_OUTCOME_INVALID';

export interface UsageBasedBillingExecutionContext {
  operationId: string;
  reservationId: string;
  executionBudget: AIExecutionBudget;
}

export interface UsageBasedBillingInput<T = unknown> {
  /** Stable operation id; also the replay idempotency key. */
  operationId: string;
  userId: string;
  feature: UsageBasedAIFeature;
  source: BusinessConsumptionSource;
  idempotencyKey: string;

  /** Admin-exempt users execute normally but never reserve or consume tokens. */
  adminExempt: boolean;

  provider?: string;
  model?: string;

  chatLimits: ChatLimitsConfig;
  executionBudget: AIExecutionBudget;
  estimatedInputTokens: number;
  /** Optional Chat history included in the estimate and reducible for affordability. */
  optionalHistoryInputTokens?: number;
  /** Authoritative provider rate card used to price providerCalls[]. */
  rateCard: ProviderRateCard;
  walletPolicy: WalletPolicyConfig;

  /**
   * Authoritative billing rate-card source that produced `rateCard`
   * (STATIC / DATABASE_SHADOW / DATABASE_PRIMARY). Recorded on the durable
   * reservation metadata for audit and recovery.
   */
  pricingSource?: 'STATIC' | 'DATABASE_SHADOW' | 'DATABASE_PRIMARY';

  /**
   * Extract the `providerCalls` payload from the executed feature result.
   * Defaults to reading `data.providerCalls`.
   */
  providerCallsOf?: (data: T) => unknown;

  /** Extract diagnostic physical provider attempts; never used for Wallet pricing. */
  providerAttemptsOf?: (data: T) => unknown;

  execute: (context: UsageBasedBillingExecutionContext) => Promise<unknown>;
}

export interface UsageBasedBillingSettledBilling {
  reservationId: string;
  reservedTokens: number;
  actualTokens: number;
  releasedTokens: number;
  /** Wallet Tokens actually consumed (equals actualTokens). */
  consumedTokens: number;
  requestedMode: 'USAGE_BASED';
  provider?: string;
  model?: string;
  rateCardVersion?: string;
  walletPolicyVersion?: string;
  pricedCostNanoUsd?: string;
  markedUpNanoUsd?: string;
  consumeTransactionId: string;
}

export type UsageBasedBillingResult<T = unknown> =
  | {
      outcome: 'SETTLED';
      operationId: string;
      reservationId: string;
      data: T;
      actualWalletTokens: number;
      adminExempt: false;
      billing: UsageBasedBillingSettledBilling;
      recoveryRequired: false;
    }
  | {
      outcome: 'ADMIN_EXEMPT';
      data: T;
      actualWalletTokens: 0;
      adminExempt: true;
      recoveryRequired: false;
    }
  | {
      outcome: 'RELEASED';
      operationId: string;
      reservationId: string;
      failureCode: string;
      adminExempt: boolean;
      recoveryRequired: false;
    }
  | {
      outcome: 'RESERVATION_DENIED';
      reason:
        | 'INSUFFICIENT_BALANCE'
        | 'WALLET_NOT_ACTIVE'
        | 'WALLET_NOT_FOUND'
        | 'INVALID_FEATURE'
        | 'INVALID_SOURCE'
        | 'INVALID_IDEMPOTENCY'
        | 'UNKNOWN';
      httpStatus: number;
      recoveryRequired: false;
    }
  | {
      outcome: 'RECOVERY_REQUIRED';
      operationId: string;
      reservationId?: string;
      operationStatus?: AIBillingOperationStatus;
      stage: UsageBasedBillingStage;
      reasonCode: UsageBasedBillingReasonCode;
      recoveryRequired: true;
    };

export interface UsageBasedBillingExposure {
  reservationId: string;
  pricedCallCount?: number;
  unpricedCallCount?: number;
  pricedCostNanoUsd?: string;
  markedUpNanoUsd?: string;
  walletTokens?: string;
  providerAttemptExposure?: unknown;
}

export interface UsageBasedBillingDependencies {
  reserveForAmount: (
    input: ReserveBusinessTokensForAmountInput,
  ) => Promise<ReserveBusinessTokensResult>;
  getAIBillingOperationByOperationId: (input: {
    operationId: string;
  }) => Promise<AIBillingOperationEvidenceResult | null>;
  createAIBillingOperation: (
    input: CreateAIBillingOperationInput,
  ) => Promise<CreateAIBillingOperationResult>;
  recordAIBillingOperationExecutionSuccess: (
    input: RecordAIBillingOperationExecutionSuccessInput,
  ) => Promise<RecordAIBillingOperationExecutionSuccessResult>;
  recordAIBillingOperationPricing: (
    input: RecordAIBillingOperationPricingInput,
  ) => Promise<RecordAIBillingOperationPricingResult>;
  recordAIBillingOperationFailure: (
    input: RecordAIBillingOperationFailureInput,
  ) => Promise<RecordAIBillingOperationFailureResult>;
  markAIBillingOperationSettled: (
    input: MarkAIBillingOperationSettledInput,
  ) => Promise<MarkAIBillingOperationSettledResult>;
  markAIBillingOperationReleased: (
    input: MarkAIBillingOperationReleasedInput,
  ) => Promise<MarkAIBillingOperationReleasedResult>;
  parseAIExecutionOutcome: <TData>(raw: unknown) => AIExecutionOutcome<TData>;
  aggregateProviderCalls: (input: ShadowPricingInput) => ShadowPricingResult;
  computeWalletCharge: (
    pricing: ShadowPricingResult,
    config: WalletConversionConfig,
  ) => WalletChargeComputation;
  settleForAmount: (
    input: SettleBusinessTokenReservationForAmountInput,
  ) => Promise<SettleBusinessTokenReservationResult>;
  releaseReservation: (
    input: ReleaseBusinessTokenReservationInput,
  ) => Promise<ReleaseBusinessTokenReservationResult>;
  /** Persist unpriced-call and physical-attempt exposure (reservation metadata). */
  recordUnresolvedExposure: (exposure: UsageBasedBillingExposure) => Promise<void>;
}
