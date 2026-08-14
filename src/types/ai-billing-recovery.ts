import type { TokenReservationStatus, TokenTransactionSource, WalletStatus } from '@prisma/client';
import type { AIUsagePricingMode } from './ai-pricing.js';

export type AIBillingRecoveryRecommendation = 'NO_ACTION' | 'REVIEW';

export type AIBillingMetadataStatus = 'VALID' | 'MISSING' | 'INVALID';

export type AIBillingRecoveryReasonCode =
  | 'RESOLVED'
  | 'PENDING_REVIEW'
  | 'METADATA_MISSING'
  | 'METADATA_INVALID'
  | 'INTEGRITY_CONFLICT';

export type AIBillingRecoveryConfirmation =
  | 'ACTUAL_TOKENS_CONFIRMED'
  | 'CONFIRMED_NON_BILLABLE'
  | 'ADMIN_CONFIRMED_NON_BILLABLE'
  | 'ADMIN_CONFIRMED_ACTUAL_TOKENS';

export interface MetadataIssue {
  field: string;
  code: string;
  message: string;
}

export type AIBillingRecoveryAction =
  | {
      type: 'SETTLE';
      confirmation: 'ACTUAL_TOKENS_CONFIRMED';
      actualTokens: number;
      reason: string;
      evidenceReference?: string;
    }
  | {
      type: 'RELEASE';
      confirmation: 'CONFIRMED_NON_BILLABLE';
      reason: string;
      evidenceReference?: string;
    }
  | {
      type: 'MANUAL_RELEASE';
      confirmation: 'ADMIN_CONFIRMED_NON_BILLABLE';
      reason: string;
      evidenceReference?: string;
    }
  | {
      type: 'MANUAL_SETTLE';
      confirmation: 'ADMIN_CONFIRMED_ACTUAL_TOKENS';
      actualTokens: number;
      reason: string;
      evidenceReference?: string;
    }
  | {
      type: 'REVIEW';
      reason: string;
      evidenceReference?: string;
    };

export type AIBillingRecoveryOutcome =
  | 'SETTLED'
  | 'ALREADY_SETTLED'
  | 'RELEASED'
  | 'ALREADY_RELEASED'
  | 'REVIEW_REQUIRED';

export type AIBillingRecoveryErrorCode =
  | 'INVALID_INPUT'
  | 'RESERVATION_NOT_FOUND'
  | 'METADATA_INVALID'
  | 'INTEGRITY_CONFLICT'
  | 'SETTLEMENT_FAILED'
  | 'RELEASE_FAILED'
  | 'RECONCILIATION_FAILED';

export interface InspectAIBillingRecoveryInput {
  reservationId: string;
}

export interface InspectAIBillingRecoveryResult {
  reservationId: string;
  referenceId: string;
  walletId: string;
  userId: string;
  feature: string;
  source: TokenTransactionSource;
  reservationStatus: TokenReservationStatus;
  reservedTokens: number;
  pricingVersion: number;
  expiresAt: Date;
  isExpired: boolean;
  metadataStatus: AIBillingMetadataStatus;
  metadataIssues?: MetadataIssue[];
  observed?: Record<string, unknown>;
  quotedTokens?: number;
  requestedMode?: AIUsagePricingMode;
  quoteAppliedMode?: AIUsagePricingMode;
  maximumUsageWalletTokens?: number;
  provider?: string;
  model?: string;
  billingCurrency?: string;
  rateCardVersion?: string;
  walletPolicyVersion?: string;
  consumeTransactionId?: string;
  consumedTokens?: number;
  releasedTokens?: number;
  recommendation: AIBillingRecoveryRecommendation;
  automaticFinancialActionAllowed: boolean;
  recoveryRequired: boolean;
  reasonCode: AIBillingRecoveryReasonCode;
  integrityConflict: boolean;
  inspectedAt: Date;
  review?: {
    reviewedBy?: string;
    reviewedAt: string;
    reason: string;
    evidenceReference?: string;
    status: string;
  };
}

export interface RecoverAIBillingReservationInput {
  reservationId: string;
  action: AIBillingRecoveryAction;
  actorId?: string;
}

export interface RecoverAIBillingReservationResult {
  reservationId: string;
  outcome: AIBillingRecoveryOutcome;
  status: TokenReservationStatus;
  financialMutationPerformed: boolean;
  recoveryRequired: boolean;
  actualTokens?: number;
  releasedTokens?: number;
  consumeTransactionId?: string;
  idempotentReplay?: boolean;
  reason: string;
  evidenceReference?: string;
}

export type WalletReservationReconciliationStatus = 'MATCH' | 'MISMATCH';

export interface ReconcileWalletReservationsInput {
  walletId: string;
}

export interface ReconcileWalletReservationsResult {
  walletId: string;
  userId: string;
  status: WalletReservationReconciliationStatus;
  actualReservedBalance: number;
  expectedPendingReservedTokens: number;
  difference: number;
  pendingReservationCount: number;
  walletStatus: WalletStatus;
  recoveryRequired: boolean;
  inspectedAt: Date;
}

export interface AIBillingRecoveryErrorOptions {
  reservationId?: string;
  recoveryRequired?: boolean;
}

export interface AIBillingRecoveryQueueInput {
  page: number;
  limit: number;
  status?: TokenReservationStatus;
  feature?: string;
}

export interface AIBillingRecoveryQueueItem {
  reservationId: string;
  referenceId: string;
  walletId: string;
  userId: string;
  feature: string;
  source: TokenTransactionSource;
  reservationStatus: TokenReservationStatus;
  reservedTokens: number;
  pricingVersion: number;
  expiresAt: string;
  isExpired: boolean;
  metadataStatus: AIBillingMetadataStatus;
  reasonCode: AIBillingRecoveryReasonCode;
  requestedMode?: AIUsagePricingMode;
  quoteAppliedMode?: AIUsagePricingMode;
  provider?: string;
  model?: string;
  billingCurrency?: string;
  rateCardVersion?: string;
  walletPolicyVersion?: string;
}

export interface AIBillingRecoveryQueueAggregate {
  count: number;
  totalTokens: number;
}

export interface AIBillingRecoveryQueueResult {
  items: AIBillingRecoveryQueueItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  aggregate: AIBillingRecoveryQueueAggregate;
}
