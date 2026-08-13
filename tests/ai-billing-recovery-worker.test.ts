import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AIBillingRecoveryWorkerDependencies, StaleAIBillingRecoveryReservation } from '../src/services/ai-billing-recovery-worker.service.js';
import { processStaleAIBillingReservations } from '../src/services/ai-billing-recovery-worker.service.js';

type Reservation = StaleAIBillingRecoveryReservation & { tokens: number };

function stale(
  status: NonNullable<StaleAIBillingRecoveryReservation['operation']>['status'],
  actualWalletTokens: number | null = null,
): Reservation {
  return {
    id: 'reservation-1',
    status: 'PENDING',
    expiresAt: new Date(Date.now() - 1),
    tokens: 10,
    operation: { operationId: 'operation-1', reservationId: 'reservation-1', status, actualWalletTokens },
  };
}

function dependencies(rows: Reservation[], wallet = { tokenBalance: 90, reservedBalance: 10 }) {
  let releases = 0;
  let settlements = 0;
  let reviews = 0;
  const deps: AIBillingRecoveryWorkerDependencies = {
    async listStaleReservations(now) {
      return rows.filter((row) => row.status === 'PENDING' && row.expiresAt <= now);
    },
    releaseReservation: (async ({ reservationId }: { reservationId: string }) => {
      const row = rows.find((candidate) => candidate.id === reservationId)!;
      if (row.status === 'RELEASED') return { idempotentReplay: true };
      row.status = 'RELEASED';
      wallet.reservedBalance -= row.tokens;
      wallet.tokenBalance += row.tokens;
      releases += 1;
      return { idempotentReplay: false };
    }) as AIBillingRecoveryWorkerDependencies['releaseReservation'],
    settleReservation: (async ({ reservationId, actualTokens }: { reservationId: string; actualTokens: number }) => {
      const row = rows.find((candidate) => candidate.id === reservationId)!;
      if (row.status === 'COMPLETED') return { idempotentReplay: true };
      row.status = 'COMPLETED';
      wallet.reservedBalance -= row.tokens;
      wallet.tokenBalance += row.tokens - actualTokens;
      settlements += 1;
      return { idempotentReplay: false };
    }) as AIBillingRecoveryWorkerDependencies['settleReservation'],
    markForReview: (async () => { reviews += 1; return {}; }) as AIBillingRecoveryWorkerDependencies['markForReview'],
    markReleased: (async () => ({})) as AIBillingRecoveryWorkerDependencies['markReleased'],
    markSettled: (async () => ({})) as AIBillingRecoveryWorkerDependencies['markSettled'],
  };
  return { deps, wallet, counts: () => ({ releases, settlements, reviews }) };
}

describe('AI billing recovery worker', () => {
  test('releases only an expired definitely non-billable reservation and preserves wallet consistency', async () => {
    const row = stale('NON_BILLABLE_CONFIRMED');
    const fixture = dependencies([row]);
    const result = await processStaleAIBillingReservations(10, fixture.deps);
    assert.deepEqual(result, { scanned: 1, released: 1, settled: 0, reviewRequired: 0, skipped: 0, failed: 0 });
    assert.equal(row.status, 'RELEASED');
    assert.deepEqual(fixture.wallet, { tokenBalance: 100, reservedBalance: 0 });
  });

  test('ignores non-expired, completed, and released reservations', async () => {
    const fresh = { ...stale('NON_BILLABLE_CONFIRMED'), expiresAt: new Date(Date.now() + 60_000) };
    const completed = { ...stale('NON_BILLABLE_CONFIRMED'), id: 'completed', status: 'COMPLETED' as const };
    const released = { ...stale('NON_BILLABLE_CONFIRMED'), id: 'released', status: 'RELEASED' as const };
    const fixture = dependencies([fresh, completed, released]);
    const result = await processStaleAIBillingReservations(10, fixture.deps);
    assert.equal(result.scanned, 0);
    assert.deepEqual(fixture.counts(), { releases: 0, settlements: 0, reviews: 0 });
  });

  test('settles confirmed, priceable usage including a zero-cost cache hit', async () => {
    const priced = stale('PRICED', 3);
    const cacheHit = { ...stale('PRICED', 0), id: 'reservation-2', operation: {
      operationId: 'operation-2', reservationId: 'reservation-2', status: 'PRICED' as const, actualWalletTokens: 0,
    } };
    const fixture = dependencies([priced, cacheHit], { tokenBalance: 80, reservedBalance: 20 });
    const result = await processStaleAIBillingReservations(10, fixture.deps);
    assert.equal(result.settled, 2);
    assert.equal(priced.status, 'COMPLETED');
    assert.equal(cacheHit.status, 'COMPLETED');
    assert.deepEqual(fixture.wallet, { tokenBalance: 97, reservedBalance: 0 });
  });

  test('does not release indeterminate execution and sends it to review', async () => {
    const row = stale('INDETERMINATE');
    const fixture = dependencies([row]);
    const result = await processStaleAIBillingReservations(10, fixture.deps);
    assert.equal(result.reviewRequired, 1);
    assert.equal(row.status, 'PENDING');
    assert.deepEqual(fixture.wallet, { tokenBalance: 90, reservedBalance: 10 });
  });

  test('is idempotent across repeated and concurrent recovery attempts', async () => {
    const row = stale('NON_BILLABLE_CONFIRMED');
    const fixture = dependencies([row]);
    await Promise.all([
      processStaleAIBillingReservations(10, fixture.deps),
      processStaleAIBillingReservations(10, fixture.deps),
    ]);
    await processStaleAIBillingReservations(10, fixture.deps);
    assert.deepEqual(fixture.counts(), { releases: 1, settlements: 0, reviews: 0 });
    assert.deepEqual(fixture.wallet, { tokenBalance: 100, reservedBalance: 0 });
  });
});
