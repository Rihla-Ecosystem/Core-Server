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
  | 'ADMIN_CONFIRMED_ACTUAL_TOKENS'
  | 'APPROVE_SYSTEM_RECOMMENDATION';

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
    }
  | {
      /**
       * Admin approves the server-computed system recommendation.
       * No actualTokens field — the server re-computes the amount
       * authoritatively at approval time to prevent client tampering.
       */
      type: 'APPROVE_SYSTEM_RECOMMENDATION';
      confirmation: 'APPROVE_SYSTEM_RECOMMENDATION';
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
  | 'RECONCILIATION_FAILED'
  | 'REPRICING_FAILED';

/**
 * Semantic HTTP status for an AIBillingRecoveryError code.
 *
 * Domain/business conflicts map to semantic 4xx statuses; only genuine
 * unexpected/infrastructure failures remain 5xx. Individual emission sites may
 * override this default via `AIBillingRecoveryErrorOptions.statusCode` when a
 * single code covers both domain and infrastructure causes (e.g. REPRICING_FAILED,
 * RECONCILIATION_FAILED).
 */
export function aiBillingRecoveryErrorStatus(code: AIBillingRecoveryErrorCode): number {
  switch (code) {
    case 'INVALID_INPUT':
      return 400;
    case 'RESERVATION_NOT_FOUND':
      return 404;
    case 'METADATA_INVALID':
    case 'INTEGRITY_CONFLICT':
    case 'REPRICING_FAILED':
      return 409;
    case 'SETTLEMENT_FAILED':
    case 'RELEASE_FAILED':
    case 'RECONCILIATION_FAILED':
      return 500;
  }
}

export interface InspectAIBillingRecoveryInput {
  reservationId: string;
}

// ---------------------------------------------------------------------------
// Repricing Recommendation DTO
// ---------------------------------------------------------------------------

/**
 * Status of the backend's ability to compute an authoritative settlement amount
 * from stored provider evidence.
 *
 * - AUTHORITATIVE_REPRICE_AVAILABLE: All 6 gates passed; recommendedActualWalletTokens is non-null.
 * - ALREADY_PRICED: The operation was already successfully priced; no recovery needed.
 * - PARTIAL_EVIDENCE: One or more gates failed; recommendedActualWalletTokens is null.
 *   Admin must manually verify and provide explicit justification.
 * - INDETERMINATE_EXECUTION: Provider execution outcome is unknown; cannot safely price.
 * - NON_BILLABLE_CONFIRMED: No provider calls were made; full release recommended.
 */
export type AIBillingRepricingStatus =
  | 'AUTHORITATIVE_REPRICE_AVAILABLE'
  | 'ALREADY_PRICED'
  | 'PARTIAL_EVIDENCE'
  | 'INDETERMINATE_EXECUTION'
  | 'NON_BILLABLE_CONFIRMED';

/** Per-call cost breakdown item in the repricing recommendation. */
export interface AIBillingRepricingItemizedCall {
  providerCallId?: string;
  provider: string;
  model: string;
  operation: string;
  kind: 'PRICED' | 'UNPRICED';
  costNanoUsd: string;
  reason: string;
}

/**
 * Persisted Wallet Policy Snapshot stored in metadata at billing time.
 * Authoritative recovery uses this stored snapshot so that changing environment
 * configuration after reservation creation never alters historical replay.
 */
export interface WalletPolicySnapshot {
  walletTokenValueNanoUsd: number;
  markupBasisPoints: number;
  minimumWalletTokens: number;
  sourceNote: 'PERSISTED_SNAPSHOT';
}

/**
 * Backend-computed repricing recommendation attached to the inspection result.
 * When repricingStatus is AUTHORITATIVE_REPRICE_AVAILABLE, recommendedActualWalletTokens
 * is a non-null integer that can be approved via APPROVE_SYSTEM_RECOMMENDATION action.
 * When repricingStatus is PARTIAL_EVIDENCE or INDETERMINATE_EXECUTION,
 * both recommendedActualWalletTokens and recommendedReturnedTokens are null.
 */
export interface AIBillingRecoveryRepricingRecommendation {
  repricingStatus: AIBillingRepricingStatus;
  recommendedActualWalletTokens: number | null;
  recommendedReturnedTokens: number | null;
  recommendedAction: 'APPROVE_SETTLEMENT' | 'RELEASE_RESERVATION' | 'KEEP_UNDER_REVIEW';
  pricingDate: string;
  rateCardVersion: string | null;
  walletPolicyVersion: string | null;
  walletPolicySnapshot: WalletPolicySnapshot | null;
  totalProviderCostNanoUsd: string | null;
  totalPricedCalls: number;
  totalUnpricedCalls: number;
  itemizedCalls: AIBillingRepricingItemizedCall[];
  discrepancyNote?: string;
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
  /** System-computed repricing recommendation. Always present in inspect response. */
  repricingRecommendation: AIBillingRecoveryRepricingRecommendation;
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
  /** Set when APPROVE_SYSTEM_RECOMMENDATION is used — confirms the server computed value. */
  systemApproval?: {
    systemRecommendedTokens: number;
    overrideFlag: false;
  };
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
  /**
   * Optional per-site HTTP status override. When present it takes precedence
   * over `aiBillingRecoveryErrorStatus(code)` so sites that share a code but
   * differ in cause (domain vs infrastructure) can surface distinct statuses.
   */
  statusCode?: number;
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
