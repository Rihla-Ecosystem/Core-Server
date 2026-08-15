import type { AIBillingMetadataStatus, MetadataIssue } from '../types/ai-billing-recovery.js';
import { parseAIBillingMetadata } from './ai-billing-recovery.service.js';
import type {
  AccountingConsistencyStatus,
  AdminTokenReservationDetailResult,
  AdminTokenReservationListItem,
  AdminTokenReservationListResult,
} from '../types/admin-token-reservation.js';
import type { AdminTokenReservationListQuery } from '../schemas/admin-token-reservation.schema.js';
import type { AdminTokenReservationRepository } from '../repositories/admin-token-reservation.repository.js';
import { createPrismaAdminTokenReservationRepository } from '../repositories/admin-token-reservation.repository.js';
import { AppError } from '../middleware/errorHandler.js';

export function calculateReturnedTokens(
  reservedTokens: number,
  actualWalletTokens: number | null | undefined,
): number | null {
  if (
    typeof actualWalletTokens === 'number' &&
    Number.isInteger(actualWalletTokens) &&
    actualWalletTokens >= 0 &&
    actualWalletTokens <= reservedTokens
  ) {
    return reservedTokens - actualWalletTokens;
  }
  return null;
}

export function evaluateAIBillingMetadataStatus(
  metadata: unknown,
  reservedTokens: number,
): {
  status: AIBillingMetadataStatus;
  issues: MetadataIssue[];
  observed: Record<string, unknown>;
} {
  const parsed = parseAIBillingMetadata(metadata);
  const issues: MetadataIssue[] = [...parsed.metadataIssues];

  if (
    parsed.status === 'VALID' &&
    parsed.reservationAmountFromMetadata !== reservedTokens
  ) {
    issues.push({
      field:
        parsed.metadataContract === 'USAGE_BASED'
          ? 'aiBilling.reservationTokens'
          : 'aiBilling.quotedTokens',
      code: 'RESERVATION_MISMATCH',
      message:
        parsed.metadataContract === 'USAGE_BASED'
          ? 'reservationTokens does not match reservation.tokens'
          : 'quotedTokens does not match reservation.tokens',
    });
  }

  let status: AIBillingMetadataStatus;
  if (parsed.status === 'MISSING') {
    status = 'MISSING';
  } else if (issues.length > 0) {
    status = 'INVALID';
  } else {
    status = 'VALID';
  }

  return {
    status,
    issues,
    observed: parsed.observed ?? {},
  };
}

export function evaluateAccountingConsistency(input: {
  reservationStatus: 'PENDING' | 'COMPLETED' | 'RELEASED';
  reservedTokens: number;
  actualWalletTokens: number | null;
  allocationConsumedTokens: number;
}): {
  actualWithinReservation: boolean | null;
  allocationWithinReservation: boolean;
  actualMatchesAllocation: boolean | null;
  returnedTokens: number | null;
  consistencyStatus: AccountingConsistencyStatus;
} {
  const { reservationStatus, reservedTokens, actualWalletTokens, allocationConsumedTokens } =
    input;

  const returnedTokens = calculateReturnedTokens(reservedTokens, actualWalletTokens);

  const actualWithinReservation =
    actualWalletTokens !== null ? actualWalletTokens <= reservedTokens : null;

  const allocationWithinReservation = allocationConsumedTokens <= reservedTokens;

  const actualMatchesAllocation =
    actualWalletTokens !== null ? actualWalletTokens === allocationConsumedTokens : null;

  let consistencyStatus: AccountingConsistencyStatus;

  if (
    allocationWithinReservation === false ||
    actualWithinReservation === false ||
    actualMatchesAllocation === false
  ) {
    consistencyStatus = 'MISMATCH';
  } else if (reservationStatus === 'COMPLETED') {
    if (actualWalletTokens === null) {
      consistencyStatus = 'INCOMPLETE_EVIDENCE';
    } else if (
      actualMatchesAllocation === true &&
      actualWithinReservation === true &&
      allocationWithinReservation === true
    ) {
      consistencyStatus = 'CONSISTENT';
    } else {
      consistencyStatus = 'MISMATCH';
    }
  } else if (reservationStatus === 'RELEASED') {
    if (
      allocationConsumedTokens === 0 &&
      (actualWalletTokens === null || actualWalletTokens === 0) &&
      allocationWithinReservation === true
    ) {
      consistencyStatus = 'CONSISTENT';
    } else {
      consistencyStatus = 'MISMATCH';
    }
  } else {
    // PENDING status
    if (actualWalletTokens === null) {
      consistencyStatus = 'INCOMPLETE_EVIDENCE';
    } else if (
      actualMatchesAllocation === true &&
      actualWithinReservation === true &&
      allocationWithinReservation === true
    ) {
      consistencyStatus = 'CONSISTENT';
    } else {
      consistencyStatus = 'MISMATCH';
    }
  }

  return {
    actualWithinReservation,
    allocationWithinReservation,
    actualMatchesAllocation,
    returnedTokens,
    consistencyStatus,
  };
}

export async function listTokenReservations(
  query: AdminTokenReservationListQuery,
  repository: AdminTokenReservationRepository = createPrismaAdminTokenReservationRepository(),
): Promise<AdminTokenReservationListResult> {
  const { items: rawItems, total, summary } = await repository.findReservations(query);
  const totalPages = Math.ceil(total / query.limit) || (total === 0 ? 0 : 1);

  const items: AdminTokenReservationListItem[] = rawItems.map((row) => {
    const actualWalletTokens = row.billingOperation?.actualWalletTokens ?? null;
    const returnedTokens = calculateReturnedTokens(row.tokens, actualWalletTokens);
    const { status: metadataStatus } = evaluateAIBillingMetadataStatus(row.metadata, row.tokens);

    return {
      reservationId: row.id,
      referenceId: row.referenceId,
      walletId: row.walletId,
      userId: row.userId,
      user: {
        email: row.user.email,
        displayName: row.user.displayName,
      },
      feature: row.feature,
      source: row.source,
      reservationStatus: row.status,
      reservedTokens: row.tokens,
      actualWalletTokens,
      returnedTokens,
      pricingVersion: row.pricingVersion,
      metadataStatus,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      settledAt: row.settledAt,
      releasedAt: row.releasedAt,
      billingOperationStatus: row.billingOperation?.status ?? null,
      operationId: row.billingOperation?.operationId ?? null,
    };
  });

  return {
    items,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
    },
    summary,
  };
}

export async function inspectTokenReservation(
  reservationId: string,
  repository: AdminTokenReservationRepository = createPrismaAdminTokenReservationRepository(),
): Promise<AdminTokenReservationDetailResult> {
  const detail = await repository.findReservationDetailById(reservationId);
  if (!detail) {
    throw new AppError(404, 'Reservation not found');
  }

  const { reservation, user, wallet, billingOperation, fundingAllocations, transactions } = detail;

  const actualWalletTokens = billingOperation?.actualWalletTokens ?? null;

  const mappedAllocations = fundingAllocations.map((alloc: any) => {
    const reservedTokens = alloc.reservedTokens;
    const consumedTokens = alloc.consumedTokens ?? 0;
    const restoredTokens = reservedTokens - consumedTokens;
    const lot = alloc.fundingLot || {};

    return {
      allocationId: alloc.id,
      fundingLotId: alloc.fundingLotId,
      reservedTokens,
      consumedTokens,
      restoredTokens,
      source: lot.source,
      sourceTransactionId: lot.sourceTransactionId,
      paymentId: lot.paymentId ?? null,
      originalTokens: lot.originalTokens ?? 0,
      availableTokens: lot.availableTokens ?? 0,
      fundingLotReservedTokens: lot.reservedTokens ?? 0,
      fundingLotConsumedTokens: lot.consumedTokens ?? 0,
      refundHeldTokens: lot.refundHeldTokens ?? 0,
      refundedTokens: lot.refundedTokens ?? 0,
      refundedAt: lot.refundedAt ?? null,
    };
  });

  const allocationConsumedTokens = mappedAllocations.reduce(
    (sum: number, alloc: any) => sum + alloc.consumedTokens,
    0,
  );

  const accounting = evaluateAccountingConsistency({
    reservationStatus: reservation.status,
    reservedTokens: reservation.tokens,
    actualWalletTokens,
    allocationConsumedTokens,
  });

  const { status: metadataStatus, issues: metadataIssues, observed } =
    evaluateAIBillingMetadataStatus(reservation.metadata, reservation.tokens);

  const mappedTransactions = transactions.map((tx: any) => ({
    id: tx.id,
    type: tx.type,
    tokens: tx.tokens,
    source: tx.source,
    paymentId: tx.paymentId ?? null,
    referenceId: tx.referenceId ?? null,
    metadata: tx.metadata ?? null,
    createdAt: tx.createdAt,
  }));

  const mappedBillingOperation = billingOperation
    ? {
        operationId: billingOperation.operationId,
        status: billingOperation.status,
        reservedTokens: billingOperation.reservedTokens,
        requestedProvider: billingOperation.requestedProvider ?? null,
        requestedModel: billingOperation.requestedModel ?? null,
        actualProvider: billingOperation.actualProvider ?? null,
        actualModel: billingOperation.actualModel ?? null,
        providerRequestId: billingOperation.providerRequestId ?? null,
        providerRequestSent: billingOperation.providerRequestSent ?? null,
        inputTokens: billingOperation.inputTokens ?? null,
        outputTokens: billingOperation.outputTokens ?? null,
        totalTokens: billingOperation.totalTokens ?? null,
        cached: billingOperation.cached ?? null,
        audioSeconds: billingOperation.audioSeconds ?? null,
        pricingMode: billingOperation.pricingMode ?? null,
        pricingFallbackReason: billingOperation.pricingFallbackReason ?? null,
        actualWalletTokens: billingOperation.actualWalletTokens ?? null,
        billingCurrency: billingCurrencyOrNull(billingOperation.billingCurrency),
        rateCardVersion: billingOperation.rateCardVersion ?? null,
        walletPolicyVersion: billingOperation.walletPolicyVersion ?? null,
        failureKind: billingOperation.failureKind ?? null,
        failureCode: billingOperation.failureCode ?? null,
        retryable: billingOperation.retryable ?? null,
        reviewReasonCode: billingOperation.reviewReasonCode ?? null,
        executedAt: billingOperation.executedAt ?? null,
        pricedAt: billingOperation.pricedAt ?? null,
        failedAt: billingOperation.failedAt ?? null,
        reviewedAt: billingOperation.reviewedAt ?? null,
        settledAt: billingOperation.settledAt ?? null,
        releasedAt: billingOperation.releasedAt ?? null,
        createdAt: billingOperation.createdAt,
        updatedAt: billingOperation.updatedAt,
      }
    : null;

  return {
    reservation: {
      id: reservation.id,
      referenceId: reservation.referenceId,
      walletId: reservation.walletId,
      userId: reservation.userId,
      feature: reservation.feature,
      source: reservation.source,
      tokens: reservation.tokens,
      pricingVersion: reservation.pricingVersion,
      idempotencyKey: reservation.idempotencyKey,
      status: reservation.status,
      expiresAt: reservation.expiresAt,
      settledAt: reservation.settledAt ?? null,
      releasedAt: reservation.releasedAt ?? null,
      releaseReason: reservation.releaseReason ?? null,
      metadata: reservation.metadata ?? null,
      createdAt: reservation.createdAt,
      updatedAt: reservation.updatedAt,
    },
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
    },
    wallet: {
      id: wallet.id,
      tokenBalance: wallet.tokenBalance,
      reservedBalance: wallet.reservedBalance,
      status: wallet.status,
    },
    billingOperation: mappedBillingOperation,
    fundingAllocations: mappedAllocations,
    transactions: mappedTransactions,
    accounting: {
      reservedTokens: reservation.tokens,
      actualWalletTokens,
      allocationConsumedTokens,
      returnedTokens: accounting.returnedTokens,
      actualWithinReservation: accounting.actualWithinReservation,
      allocationWithinReservation: accounting.allocationWithinReservation,
      actualMatchesAllocation: accounting.actualMatchesAllocation,
      consistencyStatus: accounting.consistencyStatus,
    },
    metadata: {
      status: metadataStatus,
      issues: metadataIssues,
      observed,
    },
  };
}

function billingCurrencyOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
