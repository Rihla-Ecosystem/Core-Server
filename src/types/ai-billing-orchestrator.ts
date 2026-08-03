import type { AIBillingOperationStatus } from '@prisma/client';
import type { AIExecutionOutcome } from './ai-execution.js';
import type {
  AIBillingOperationEvidenceResult,
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
} from './ai-billing-operation.js';
import type {
  AIProviderTokenRate,
  AIUsagePricingFallbackReason,
  AIUsagePricingInput,
  AIUsagePricingMode,
  AIUsagePricingResult,
  AIWalletPricingPolicy,
} from './ai-pricing.js';
import type {
  AIReservationQuoteInput,
  AIReservationQuoteResult,
} from './ai-reservation-quote.js';
import type { ChatLimitsConfig } from '../config/chat-limits.js';
import type { BusinessTokenFeature } from '../config/business-token-features.js';
import type { BusinessConsumptionSource } from '../services/business-token-consumption.service.js';
import type {
  ReleaseBusinessTokenReservationInput,
  ReleaseBusinessTokenReservationResult,
  ReserveBusinessTokensForAmountInput,
  ReserveBusinessTokensResult,
  SettleBusinessTokenReservationForAmountInput,
  SettleBusinessTokenReservationResult,
} from '../services/token-reservation.service.js';

export type AIBillingOrchestratorStage =
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

export type AIBillingOrchestratorReasonCode =
  | 'INVALID_OPERATION_ID'
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
  | 'PRICING_EVIDENCE_FAILED'
  | 'SETTLEMENT_FAILED'
  | 'SETTLED_EVIDENCE_FAILED'
  | 'FAILURE_EVIDENCE_FAILED'
  | 'RELEASE_FAILED'
  | 'RELEASED_EVIDENCE_FAILED'
  | 'INDETERMINATE_EXECUTION'
  | 'EXECUTOR_THROWN_DISPATCH_UNKNOWN'
  | 'EXECUTION_OUTCOME_INVALID';

export interface AIBillingExecutionContext {
  operationId: string;
  reservationId: string;
}

export interface AIBillingOrchestratorInput<T = unknown> {
  operationId: string;
  userId: string;
  feature: BusinessTokenFeature;
  source: BusinessConsumptionSource;
  idempotencyKey: string;

  requestedMode: AIUsagePricingMode;

  provider?: string;
  model?: string;

  chatLimits: ChatLimitsConfig;
  rateCard: readonly AIProviderTokenRate[];
  walletPolicy: AIWalletPricingPolicy;

  execute: (context: AIBillingExecutionContext) => Promise<unknown>;
}

export type AIBillingReservationMetadata = {
  aiBilling: {
    schemaVersion: 1;
    requestedMode: AIUsagePricingMode;
    quoteAppliedMode: AIUsagePricingMode;
    quotedTokens: number;
    fixedFallbackTokens: number;
    maximumUsageWalletTokens?: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    provider?: string;
    model?: string;
    billingCurrency?: string;
    rateCardVersion?: string;
    walletPolicyVersion?: string;
  };
};

export interface AIBillingOrchestratorDependencies {
  calculateQuote: (input: AIReservationQuoteInput) => AIReservationQuoteResult;
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
  calculateActualPrice: (input: AIUsagePricingInput) => AIUsagePricingResult;
  settleForAmount: (
    input: SettleBusinessTokenReservationForAmountInput,
  ) => Promise<SettleBusinessTokenReservationResult>;
  releaseReservation: (
    input: ReleaseBusinessTokenReservationInput,
  ) => Promise<ReleaseBusinessTokenReservationResult>;
}

export interface AIBillingOrchestratorBilling {
  reservationId: string;
  reservedTokens: number;
  actualTokens: number;
  releasedTokens: number;

  requestedMode: AIUsagePricingMode;
  appliedMode: AIUsagePricingMode;

  fallbackReason?: AIUsagePricingFallbackReason;

  provider?: string;
  model?: string;
  billingCurrency?: string;

  rateCardVersion?: string;
  walletPolicyVersion?: string;

  consumeTransactionId: string;
}

export interface AIBillingOrchestratorResult<T> {
  outcome: 'SETTLED';
  operationId: string;
  reservationId: string;

  data: T;
  actualWalletTokens: number;

  settlement: {
    consumeTransactionId: string;
    reservedTokens: number;
    actualTokens: number;
    releasedTokens: number;
    settledAt: Date;
  };

  quote: AIReservationQuoteResult;
  billing: AIBillingOrchestratorBilling;

  recoveryRequired: false;
}

export interface AIBillingOrchestratorReleasedResult {
  outcome: 'RELEASED';
  operationId: string;
  reservationId: string;
  failureCode: string;
  recoveryRequired: false;
}

export interface AIBillingOrchestratorRecoveryResult {
  outcome: 'RECOVERY_REQUIRED';
  operationId: string;
  reservationId?: string;
  operationStatus?: AIBillingOperationStatus;
  stage: AIBillingOrchestratorStage;
  reasonCode: AIBillingOrchestratorReasonCode;
  recoveryRequired: true;
}

export type AIBillingOrchestrationResult<T> =
  | AIBillingOrchestratorResult<T>
  | AIBillingOrchestratorReleasedResult
  | AIBillingOrchestratorRecoveryResult;
