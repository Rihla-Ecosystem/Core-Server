import type {
  AIBillingOperationFailureKind,
  AIBillingOperationStatus,
  TokenTransactionSource,
} from '@prisma/client';
import type { AIExecutionIdentity } from './ai-execution.js';
import type { AIProviderUsage } from './ai.js';
import type {
  AIUsagePricingFallbackReason,
  AIUsagePricingMode,
  AIUsagePricingResult,
} from './ai-pricing.js';
import type {
  ReleaseBusinessTokenReservationResult,
  SettleBusinessTokenReservationResult,
} from '../services/token-reservation.service.js';

export type AIBillingOperationErrorCode =
  | 'INVALID_INPUT'
  | 'RESERVATION_NOT_FOUND'
  | 'OPERATION_NOT_FOUND'
  | 'RESERVATION_NOT_PENDING'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'INTEGRITY_CONFLICT'
  | 'STORAGE_FAILED';

export interface AIBillingOperationErrorOptions {
  operationId?: string;
  reservationId?: string;
  recoveryRequired?: boolean;
}

export interface CreateAIBillingOperationInput {
  operationId: string;
  reservationId: string;
  requestedProvider?: string;
  requestedModel?: string;
}

export interface CreateAIBillingOperationResult {
  operationId: string;
  reservationId: string;
  walletId: string;
  userId: string;
  feature: string;
  source: TokenTransactionSource;
  status: AIBillingOperationStatus;
  reservedTokens: number;
  reservationPricingVersion: number;
  requestedProvider?: string;
  requestedModel?: string;
  idempotentReplay: boolean;
  createdAt: Date;
}

export interface RecordAIBillingOperationExecutionSuccessInput {
  operationId: string;
  execution: AIExecutionIdentity;
  usage: AIProviderUsage;
}

export interface RecordAIBillingOperationExecutionSuccessResult {
  operationId: string;
  reservationId: string;
  status: AIBillingOperationStatus;
  executedAt: Date;
  idempotentReplay: boolean;
}

export interface RecordAIBillingOperationPricingInput {
  operationId: string;
  pricing: AIUsagePricingResult;
}

export interface RecordAIBillingOperationPricingResult {
  operationId: string;
  reservationId: string;
  status: AIBillingOperationStatus;
  pricedAt: Date;
  actualWalletTokens: number;
  idempotentReplay: boolean;
}

export type RecordAIBillingOperationFailureInputFailure =
  | {
      kind: 'NON_BILLABLE_FAILURE';
      code: string;
      message: string;
      providerRequestSent: false;
      retryable: boolean;
    }
  | {
      kind: 'INDETERMINATE_FAILURE';
      code: string;
      message: string;
      providerRequestSent: true;
      retryable: boolean;
      execution?: Partial<AIExecutionIdentity>;
    };

export interface RecordAIBillingOperationFailureInput {
  operationId: string;
  failure: RecordAIBillingOperationFailureInputFailure;
}

export interface RecordAIBillingOperationFailureResult {
  operationId: string;
  reservationId: string;
  status: AIBillingOperationStatus;
  failureKind: AIBillingOperationFailureKind;
  providerRequestSent: boolean;
  failedAt: Date;
  idempotentReplay: boolean;
}

export interface MarkAIBillingOperationForReviewInput {
  operationId: string;
  reasonCode: string;
}

export interface MarkAIBillingOperationForReviewResult {
  operationId: string;
  reservationId: string;
  status: AIBillingOperationStatus;
  reviewedAt: Date;
  reviewRequired: boolean;
  idempotentReplay: boolean;
}

export interface MarkAIBillingOperationSettledInput {
  operationId: string;
  settlement: SettleBusinessTokenReservationResult;
}

export interface MarkAIBillingOperationSettledResult {
  operationId: string;
  reservationId: string;
  status: AIBillingOperationStatus;
  settledAt: Date;
  actualWalletTokens: number;
  consumeTransactionId: string;
  idempotentReplay: boolean;
}

export interface MarkAIBillingOperationReleasedInput {
  operationId: string;
  release: ReleaseBusinessTokenReservationResult;
}

export interface MarkAIBillingOperationReleasedResult {
  operationId: string;
  reservationId: string;
  status: AIBillingOperationStatus;
  releasedAt: Date;
  idempotentReplay: boolean;
}

export interface ReadAIBillingOperationByOperationIdInput {
  operationId: string;
}

export interface ReadAIBillingOperationByReservationIdInput {
  reservationId: string;
}

export interface AIBillingOperationEvidenceResult {
  operationId: string;
  reservationId: string;
  walletId: string;
  userId: string;
  feature: string;
  source: TokenTransactionSource;
  status: AIBillingOperationStatus;
  reservedTokens: number;
  reservationPricingVersion: number;
  requestedProvider?: string;
  requestedModel?: string;
  actualProvider?: string;
  actualModel?: string;
  providerRequestId?: string;
  providerRequestSent?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cached?: boolean;
  audioSeconds?: number;
  pricingMode?: AIUsagePricingMode;
  pricingFallbackReason?: AIUsagePricingFallbackReason;
  actualWalletTokens?: number;
  billingCurrency?: string;
  rateCardVersion?: string;
  walletPolicyVersion?: string;
  failureKind?: AIBillingOperationFailureKind;
  failureCode?: string;
  retryable?: boolean;
  reviewReasonCode?: string;
  consumeTransactionId?: string;
  executedAt?: Date;
  pricedAt?: Date;
  failedAt?: Date;
  reviewedAt?: Date;
  settledAt?: Date;
  releasedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
