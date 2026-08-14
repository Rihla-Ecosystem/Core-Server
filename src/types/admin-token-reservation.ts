import type {
  TokenReservationStatus,
  TokenTransactionSource,
  TokenTransactionType,
  WalletStatus,
} from '@prisma/client';
import type { AIBillingMetadataStatus, MetadataIssue } from './ai-billing-recovery.js';

export type AccountingConsistencyStatus =
  | 'CONSISTENT'
  | 'INCOMPLETE_EVIDENCE'
  | 'MISMATCH';

export interface AdminTokenReservationListQuery {
  page: number;
  limit: number;
  status?: TokenReservationStatus;
  feature?: string;
  source?: TokenTransactionSource;
  userId?: string;
  search?: string;
  from?: string;
  to?: string;
}

export interface AdminTokenReservationSummary {
  totalReservations: number;
  pendingReservations: number;
  completedReservations: number;
  releasedReservations: number;
  totalReservedTokens: number;
  totalActualWalletTokens: number;
  totalReturnedTokens: number;
}

export interface AdminTokenReservationListItem {
  reservationId: string;
  referenceId: string;
  walletId: string;
  userId: string;
  user: {
    email: string;
    displayName: string;
  };
  feature: string;
  source: TokenTransactionSource;
  reservationStatus: TokenReservationStatus;
  reservedTokens: number;
  actualWalletTokens: number | null;
  returnedTokens: number | null;
  pricingVersion: number;
  metadataStatus: AIBillingMetadataStatus;
  createdAt: Date | string;
  expiresAt: Date | string;
  settledAt: Date | string | null;
  releasedAt: Date | string | null;
  billingOperationStatus: string | null;
  operationId: string | null;
}

export interface AdminTokenReservationListResult {
  items: AdminTokenReservationListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  summary: AdminTokenReservationSummary;
}

export interface AdminTokenReservationFundingAllocationItem {
  allocationId: string;
  fundingLotId: string;
  reservedTokens: number;
  consumedTokens: number;
  restoredTokens: number;
  source: TokenTransactionSource;
  sourceTransactionId: string;
  paymentId: string | null;
  originalTokens: number;
  availableTokens: number;
  fundingLotReservedTokens: number;
  fundingLotConsumedTokens: number;
  refundHeldTokens: number;
  refundedTokens: number;
  refundedAt: Date | string | null;
}

export interface AdminTokenReservationTransactionItem {
  id: string;
  type: TokenTransactionType;
  tokens: number;
  source: TokenTransactionSource;
  paymentId: string | null;
  referenceId: string | null;
  metadata: unknown;
  createdAt: Date | string;
}

export interface AdminTokenReservationAccounting {
  reservedTokens: number;
  actualWalletTokens: number | null;
  allocationConsumedTokens: number;
  returnedTokens: number | null;
  actualWithinReservation: boolean | null;
  allocationWithinReservation: boolean;
  actualMatchesAllocation: boolean | null;
  consistencyStatus: AccountingConsistencyStatus;
}

export interface AdminTokenReservationDetailResult {
  reservation: {
    id: string;
    referenceId: string;
    walletId: string;
    userId: string;
    feature: string;
    source: TokenTransactionSource;
    tokens: number;
    pricingVersion: number;
    idempotencyKey: string;
    status: TokenReservationStatus;
    expiresAt: Date | string;
    settledAt: Date | string | null;
    releasedAt: Date | string | null;
    releaseReason: string | null;
    metadata: unknown;
    createdAt: Date | string;
    updatedAt: Date | string;
  };
  user: {
    id: string;
    email: string;
    displayName: string;
  };
  wallet: {
    id: string;
    tokenBalance: number;
    reservedBalance: number;
    status: WalletStatus;
  };
  billingOperation: {
    operationId: string;
    status: string;
    reservedTokens: number;
    requestedProvider: string | null;
    requestedModel: string | null;
    actualProvider: string | null;
    actualModel: string | null;
    providerRequestId: string | null;
    providerRequestSent: boolean | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cached: boolean | null;
    audioSeconds: number | null;
    pricingMode: string | null;
    pricingFallbackReason: string | null;
    actualWalletTokens: number | null;
    billingCurrency: string | null;
    rateCardVersion: string | null;
    walletPolicyVersion: string | null;
    failureKind: string | null;
    failureCode: string | null;
    retryable: boolean | null;
    reviewReasonCode: string | null;
    executedAt: Date | string | null;
    pricedAt: Date | string | null;
    failedAt: Date | string | null;
    reviewedAt: Date | string | null;
    settledAt: Date | string | null;
    releasedAt: Date | string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
  } | null;
  fundingAllocations: AdminTokenReservationFundingAllocationItem[];
  transactions: AdminTokenReservationTransactionItem[];
  accounting: AdminTokenReservationAccounting;
  metadata: {
    status: AIBillingMetadataStatus;
    issues: MetadataIssue[];
    observed: Record<string, unknown>;
  };
}
