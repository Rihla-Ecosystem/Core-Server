import type { AIBillingOperationStatus, TokenReservationStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import {
  releaseBusinessTokenReservation,
  settleBusinessTokenReservationForAmount,
} from './token-reservation.service.js';
import {
  markAIBillingOperationForReview,
  markAIBillingOperationReleased,
  markAIBillingOperationSettled,
} from './ai-billing-operation.service.js';

export interface StaleAIBillingRecoveryOperation {
  operationId: string;
  reservationId: string;
  status: AIBillingOperationStatus;
  actualWalletTokens: number | null;
}

export interface StaleAIBillingRecoveryReservation {
  id: string;
  status: TokenReservationStatus;
  expiresAt: Date;
  operation: StaleAIBillingRecoveryOperation | null;
}

export interface AIBillingRecoveryWorkerDependencies {
  listStaleReservations(now: Date, limit: number): Promise<StaleAIBillingRecoveryReservation[]>;
  releaseReservation: typeof releaseBusinessTokenReservation;
  settleReservation: typeof settleBusinessTokenReservationForAmount;
  markForReview: typeof markAIBillingOperationForReview;
  markReleased: typeof markAIBillingOperationReleased;
  markSettled: typeof markAIBillingOperationSettled;
}

export interface AIBillingRecoveryWorkerResult {
  scanned: number;
  released: number;
  settled: number;
  reviewRequired: number;
  skipped: number;
  failed: number;
}

export function createDefaultAIBillingRecoveryWorkerDependencies(): AIBillingRecoveryWorkerDependencies {
  return {
    async listStaleReservations(now, limit) {
      const reservations = await prisma.tokenReservation.findMany({
        where: { status: 'PENDING', expiresAt: { lte: now } },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: limit,
        select: {
          id: true,
          status: true,
          expiresAt: true,
          billingOperation: {
            select: {
              operationId: true,
              reservationId: true,
              status: true,
              actualWalletTokens: true,
            },
          },
        },
      });
      return reservations.map((reservation) => ({
        ...reservation,
        operation: reservation.billingOperation,
      }));
    },
    releaseReservation: releaseBusinessTokenReservation,
    settleReservation: settleBusinessTokenReservationForAmount,
    markForReview: markAIBillingOperationForReview,
    markReleased: markAIBillingOperationReleased,
    markSettled: markAIBillingOperationSettled,
  };
}

function assertBatchSize(batchSize: number): void {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('AI billing recovery batch size must be an integer between 1 and 100');
  }
}

async function sendForReview(
  operation: StaleAIBillingRecoveryOperation | null,
  reasonCode: string,
  dependencies: AIBillingRecoveryWorkerDependencies,
): Promise<'reviewRequired' | 'skipped'> {
  if (!operation || operation.status === 'REVIEW_REQUIRED') return 'skipped';
  await dependencies.markForReview({ operationId: operation.operationId, reasonCode });
  return 'reviewRequired';
}

/**
 * Recovers only expired PENDING reservations. Financial mutations are delegated
 * to the established recovery and reservation services, which atomically claim
 * the reservation and enforce wallet balance invariants.
 */
export async function processStaleAIBillingReservations(
  batchSize: number,
  dependencies: AIBillingRecoveryWorkerDependencies =
    createDefaultAIBillingRecoveryWorkerDependencies(),
): Promise<AIBillingRecoveryWorkerResult> {
  assertBatchSize(batchSize);
  const reservations = await dependencies.listStaleReservations(new Date(), batchSize);
  const result: AIBillingRecoveryWorkerResult = {
    scanned: reservations.length,
    released: 0,
    settled: 0,
    reviewRequired: 0,
    skipped: 0,
    failed: 0,
  };

  for (const reservation of reservations) {
    try {
      const operation = reservation.operation;
      if (!operation) {
        // No durable execution evidence means the worker cannot prove that no
        // provider request occurred. Preserve the reservation for admin review.
        result.skipped += 1;
        continue;
      }

      if (operation.status === 'NON_BILLABLE_CONFIRMED') {
        const release = await dependencies.releaseReservation({
          reservationId: reservation.id,
          reason: 'automatic recovery: confirmed non-billable execution',
        });
        await dependencies.markReleased({ operationId: operation.operationId, release });
        result.released += release.idempotentReplay ? 0 : 1;
        result.skipped += release.idempotentReplay ? 1 : 0;
        continue;
      }

      const actualWalletTokens = operation.actualWalletTokens;
      if (
        operation.status === 'PRICED' &&
        typeof actualWalletTokens === 'number' &&
        Number.isFinite(actualWalletTokens) &&
        actualWalletTokens >= 0
      ) {
        const settlement = await dependencies.settleReservation({
          reservationId: reservation.id,
          actualTokens: actualWalletTokens,
        });
        await dependencies.markSettled({ operationId: operation.operationId, settlement });
        result.settled += settlement.idempotentReplay ? 0 : 1;
        result.skipped += settlement.idempotentReplay ? 1 : 0;
        continue;
      }

      const reasonCode = operation.status === 'INDETERMINATE'
        ? 'INDETERMINATE_EXECUTION'
        : operation.status === 'EXECUTION_SUCCEEDED'
          ? 'UNPRICED_PROVIDER_CALLS'
          : operation.status === 'PRICED'
            ? 'PRICING_EVIDENCE_INVALID'
            : 'STALE_RESERVATION_REVIEW';
      const reviewed = await sendForReview(operation, reasonCode, dependencies);
      result[reviewed] += 1;
    } catch (err) {
      result.failed += 1;
      console.error('AI billing recovery item failed', {
        reservationId: reservation.id,
        operationId: reservation.operation?.operationId,
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  console.info('AI billing recovery batch complete', result);
  return result;
}

export interface AIBillingRecoveryWorkerHandle {
  stop(): void;
}

export function startAIBillingRecoveryWorker(config: {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
}): AIBillingRecoveryWorkerHandle {
  if (!config.enabled) {
    console.info('AI billing recovery worker disabled');
    return { stop() {} };
  }

  const run = () => {
    processStaleAIBillingReservations(config.batchSize).catch((err) => {
      console.error('AI billing recovery batch failed', {
        error: err instanceof Error ? err.message : 'unknown error',
      });
    });
  };
  const timer = setInterval(run, config.pollIntervalMs);
  timer.unref();
  run();
  return { stop: () => clearInterval(timer) };
}
