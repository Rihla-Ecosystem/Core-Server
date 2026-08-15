{
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('Safety check failed: DATABASE_URL is not set');
  const parsed = new URL(dbUrl);
  if (parsed.pathname !== '/core_server_test') {
    throw new Error(
      `Safety check failed: DATABASE_URL must point to /core_server_test, got "${parsed.pathname}"`,
    );
  }
}

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Gender,
  TokenReservationStatus,
  TokenTransactionSource,
  WalletStatus,
} from '@prisma/client';
import { prisma } from '../src/config/prisma.js';
import { ensureUserRole } from './helpers/test-role-fixtures.js';

let USER_ROLE_ID: number;
import { AppError } from '../src/middleware/errorHandler.js';
import {
  AIBillingRecoveryError,
  createDefaultAIBillingRecoveryDependencies,
  inspectAIBillingRecovery,
  reconcileWalletReservations,
  recoverAIBillingReservation,
} from '../src/services/ai-billing-recovery.service.js';
import type { AIBillingRecoveryDependencies } from '../src/services/ai-billing-recovery.service.js';
import type { AIBillingRecoveryErrorCode } from '../src/types/ai-billing-recovery.js';
import type { AIBillingRecoveryAction } from '../src/types/ai-billing-recovery.js';
import type {
  AIBillingRecoveryConsumeRow,
  AIBillingRecoveryRepository,
  AIBillingRecoveryReservationRow,
  AIBillingRecoveryWalletRow,
} from '../src/repositories/ai-billing-recovery.repository.js';
import type { BusinessTokenFeature } from '../src/config/business-token-features.js';
import type { BusinessConsumptionSource } from '../src/services/business-token-consumption.service.js';
import type {
  ReleaseBusinessTokenReservationInput,
  ReleaseBusinessTokenReservationResult,
  SettleBusinessTokenReservationForAmountInput,
  SettleBusinessTokenReservationResult,
} from '../src/services/token-reservation.service.js';
import { reserveBusinessTokensForAmount } from '../src/services/token-reservation.service.js';

function validMetadata(tokens: number): unknown {
  return {
    aiBilling: {
      schemaVersion: 1,
      requestedMode: 'PROVIDER_USAGE',
      quoteAppliedMode: 'PROVIDER_USAGE',
      quotedTokens: tokens,
      fixedFallbackTokens: tokens,
      maxInputTokens: 12000,
      maxOutputTokens: 1200,
      provider: 'fake-provider',
      model: 'fake-model',
    },
  };
}

function fullMetadata(tokens: number): unknown {
  return {
    aiBilling: {
      schemaVersion: 1,
      requestedMode: 'PROVIDER_USAGE',
      quoteAppliedMode: 'PROVIDER_USAGE',
      quotedTokens: tokens,
      fixedFallbackTokens: tokens,
      maxInputTokens: 12000,
      maxOutputTokens: 1200,
      maximumUsageWalletTokens: 12000,
      provider: 'fake-provider',
      model: 'fake-model',
      billingCurrency: 'USD',
      rateCardVersion: 'rate-v1',
      walletPolicyVersion: 'policy-v1',
    },
  };
}

// Current live metadata written by usage-based-ai-billing.service.ts
function usageBasedMetadata(tokens: number): unknown {
  return {
    aiBilling: {
      schemaVersion: 1,
      requestedMode: 'USAGE_BASED',
      feature: 'AI_CHAT_QUERY',
      reservationTokens: tokens,
      maxInputTokens: 12000,
      maxOutputTokens: 1200,
      rateCardVersion: 'rate-v1',
      walletPolicyVersion: 'policy-v1',
      provider: 'fake-provider',
      model: 'fake-model',
    },
  };
}

function buildReservation(
  overrides: Partial<AIBillingRecoveryReservationRow> = {},
): AIBillingRecoveryReservationRow {
  return {
    id: 'reservation-1',
    walletId: 'wallet-1',
    userId: 'user-1',
    feature: 'AI_CHAT_QUERY',
    source: TokenTransactionSource.CHAT,
    tokens: 2,
    pricingVersion: 1,
    status: TokenReservationStatus.PENDING,
    expiresAt: new Date(Date.now() + 60_000),
    settledAt: null,
    releasedAt: null,
    releaseReason: null,
    metadata: validMetadata(2),
    referenceId: 'user-1:AI_CHAT_QUERY:key-1',
    ...overrides,
  };
}

function buildWallet(
  overrides: Partial<AIBillingRecoveryWalletRow> = {},
): AIBillingRecoveryWalletRow {
  return {
    id: 'wallet-1',
    userId: 'user-1',
    tokenBalance: 100,
    reservedBalance: 2,
    status: WalletStatus.ACTIVE,
    ...overrides,
  };
}

function buildConsume(
  overrides: Partial<AIBillingRecoveryConsumeRow> = {},
): AIBillingRecoveryConsumeRow {
  return {
    id: 'consume-1',
    tokens: 2,
    source: TokenTransactionSource.CHAT,
    referenceId: 'user-1:AI_CHAT_QUERY:key-1:settle',
    ...overrides,
  };
}

function settleAction(
  actualTokens: number,
  overrides: Partial<{
    confirmation: 'ACTUAL_TOKENS_CONFIRMED';
    reason: string;
    evidenceReference?: string;
  }> = {},
): AIBillingRecoveryAction {
  return {
    type: 'SETTLE',
    confirmation: 'ACTUAL_TOKENS_CONFIRMED',
    actualTokens,
    reason: 'confirmed actual usage',
    ...overrides,
  };
}

function releaseAction(
  overrides: Partial<{
    confirmation: 'CONFIRMED_NON_BILLABLE';
    reason: string;
    evidenceReference?: string;
  }> = {},
): AIBillingRecoveryAction {
  return {
    type: 'RELEASE',
    confirmation: 'CONFIRMED_NON_BILLABLE',
    reason: 'provider returned no billable response',
    ...overrides,
  };
}

function reviewAction(reason = 'needs a human look'): AIBillingRecoveryAction {
  return { type: 'REVIEW', reason };
}

function manualReleaseAction(
  overrides: Partial<{
    reason: string;
    evidenceReference?: string;
  }> = {},
): AIBillingRecoveryAction {
  return {
    type: 'MANUAL_RELEASE',
    reason: 'manual release override',
    ...overrides,
  };
}

function manualSettleAction(
  actualTokens: number,
  overrides: Partial<{
    reason: string;
    evidenceReference?: string;
  }> = {},
): AIBillingRecoveryAction {
  return {
    type: 'MANUAL_SETTLE',
    actualTokens,
    reason: 'manual settle override',
    ...overrides,
  };
}

function asAction(value: unknown): AIBillingRecoveryAction {
  return value as AIBillingRecoveryAction;
}

class FakeRecoveryStore {
  reservations = new Map<string, AIBillingRecoveryReservationRow>();
  wallets = new Map<string, AIBillingRecoveryWalletRow>();
  consumes = new Map<string, AIBillingRecoveryConsumeRow[]>();
  auditLogs: AIBillingRecoveryAuditLogRecord[] = [];
  reads: string[] = [];
  writes: string[] = [];
}

function fakeRepository(store: FakeRecoveryStore): AIBillingRecoveryRepository {
  return {
    async findReservationById(id) {
      store.reads.push('findReservationById');
      return store.reservations.get(id) ?? null;
    },
    async findWalletById(id) {
      store.reads.push('findWalletById');
      return store.wallets.get(id) ?? null;
    },
    async findConsumeForReservation(reservation) {
      store.reads.push('findConsumeForReservation');
      return store.consumes.get(reservation.id) ?? [];
    },
    async aggregatePendingReservations(walletId) {
      store.reads.push('aggregatePendingReservations');
      let count = 0;
      let totalTokens = 0;
      for (const row of store.reservations.values()) {
        if (row.walletId === walletId && row.status === 'PENDING') {
          count += 1;
          totalTokens += row.tokens;
        }
      }
      return { count, totalTokens };
    },
    async readReconciliationSnapshot(walletId) {
      store.reads.push('readReconciliationSnapshot');
      const wallet = store.wallets.get(walletId) ?? null;
      let count = 0;
      let totalTokens = 0;
      for (const row of store.reservations.values()) {
        if (row.walletId === walletId && row.status === 'PENDING') {
          count += 1;
          totalTokens += row.tokens;
        }
      }
      return { wallet, pending: { count, totalTokens } };
    },
    async listReservationsForRecovery(filter) {
      store.reads.push('listReservationsForRecovery');
      const items = Array.from(store.reservations.values());
      return {
        items,
        total: items.length,
        aggregate: { count: items.length, totalTokens: items.reduce((acc, curr) => acc + curr.tokens, 0) },
      };
    },
    async recordAuditLog(data) {
      const record: AIBillingRecoveryAuditLogRecord = {
        id: `audit-${crypto.randomUUID()}`,
        actorId: data.actorId ?? null,
        action: data.action,
        targetUserId: data.targetUserId ?? null,
        metadata: data.metadata,
        createdAt: new Date(),
      };
      store.auditLogs.push(record);
      return record;
    },
    async findLatestRecoveryAuditLog(reservationId) {
      store.reads.push('findLatestRecoveryAuditLog');
      const matches = store.auditLogs.filter((log) => {
        const meta = log.metadata as Record<string, unknown>;
        return meta && meta.reservationId === reservationId;
      });
      return matches.length > 0 ? matches[matches.length - 1] : null;
    },
    async findLatestRecoveryReviewAuditLog(reservationId) {
      store.reads.push('findLatestRecoveryReviewAuditLog');
      const matches = store.auditLogs.filter((log) => {
        const meta = log.metadata as Record<string, unknown>;
        return log.action === 'AI_BILLING_RECOVERY_REVIEW' && meta && meta.reservationId === reservationId;
      });
      return matches.length > 0 ? matches[matches.length - 1] : null;
    },
  };
}

function failingRepository(): AIBillingRecoveryRepository {
  return {
    async findReservationById() {
      throw new Error('Prisma P2025 raw internal message');
    },
    async findWalletById() {
      return null;
    },
    async findConsumeForReservation() {
      return [];
    },
    async aggregatePendingReservations() {
      return { count: 0, totalTokens: 0 };
    },
    async readReconciliationSnapshot() {
      throw new Error('Prisma P2025 raw internal message');
    },
    async listReservationsForRecovery() {
      throw new Error('Prisma P2025 raw internal message');
    },
    async recordAuditLog() {
      throw new Error('Prisma P2025 raw internal message');
    },
    async findLatestRecoveryAuditLog() {
      return null;
    },
    async findLatestRecoveryReviewAuditLog() {
      return null;
    },
  };
}

function fakeSettle(store: FakeRecoveryStore) {
  return async (
    input: SettleBusinessTokenReservationForAmountInput,
  ): Promise<SettleBusinessTokenReservationResult> => {
    store.writes.push('settle');
    const reservation = store.reservations.get(input.reservationId);
    if (!reservation) throw new AppError(404, 'Reservation not found');
    const actualTokens = input.actualTokens;
    if (actualTokens > reservation.tokens) {
      throw new AppError(409, 'Token reservation integrity conflict');
    }
    const common = {
      reservationId: reservation.id,
      referenceId: reservation.referenceId,
      walletId: reservation.walletId,
      userId: reservation.userId,
      feature: reservation.feature as BusinessTokenFeature,
      source: reservation.source as BusinessConsumptionSource,
      tokens: reservation.tokens,
      pricingVersion: reservation.pricingVersion,
      releasedTokens: reservation.tokens - actualTokens,
    };
    if (reservation.status === 'COMPLETED') {
      const consume = store.consumes.get(reservation.id)?.[0];
      if (consume && consume.tokens === actualTokens) {
        return {
          ...common,
          actualTokens,
          status: TokenReservationStatus.COMPLETED,
          settledAt: reservation.settledAt ?? new Date(),
          consumeTransactionId: consume.id,
          idempotentReplay: true,
        };
      }
      throw new AppError(409, 'Token reservation integrity conflict');
    }
    if (reservation.status === 'RELEASED') {
      throw new AppError(409, 'Cannot settle a released reservation');
    }
    reservation.status = TokenReservationStatus.COMPLETED;
    reservation.settledAt = new Date();
    const wallet = store.wallets.get(reservation.walletId);
    if (wallet) {
      wallet.reservedBalance -= reservation.tokens;
    }
    const consume: AIBillingRecoveryConsumeRow = {
      id: `consume-${crypto.randomUUID()}`,
      tokens: actualTokens,
      source: reservation.source,
      referenceId: `${reservation.referenceId}:settle`,
    };
    store.consumes.set(reservation.id, [consume]);
    return {
      ...common,
      actualTokens,
      status: TokenReservationStatus.COMPLETED,
      settledAt: reservation.settledAt,
      consumeTransactionId: consume.id,
      idempotentReplay: false,
    };
  };
}

function fakeRelease(store: FakeRecoveryStore) {
  return async (
    input: ReleaseBusinessTokenReservationInput,
  ): Promise<ReleaseBusinessTokenReservationResult> => {
    store.writes.push('release');
    const reservation = store.reservations.get(input.reservationId);
    if (!reservation) throw new AppError(404, 'Reservation not found');
    const common = {
      reservationId: reservation.id,
      referenceId: reservation.referenceId,
      walletId: reservation.walletId,
      userId: reservation.userId,
      feature: reservation.feature as BusinessTokenFeature,
      source: reservation.source as BusinessConsumptionSource,
      tokens: reservation.tokens,
      pricingVersion: reservation.pricingVersion,
    };
    if (reservation.status === 'COMPLETED') {
      throw new AppError(409, 'Cannot release a completed reservation');
    }
    if (reservation.status === 'RELEASED') {
      return {
        ...common,
        status: TokenReservationStatus.RELEASED,
        releasedAt: reservation.releasedAt ?? new Date(),
        releaseReason: reservation.releaseReason,
        idempotentReplay: true,
      };
    }
    reservation.status = TokenReservationStatus.RELEASED;
    reservation.releasedAt = new Date();
    reservation.releaseReason = input.reason?.trim() || null;
    const wallet = store.wallets.get(reservation.walletId);
    if (wallet) {
      wallet.reservedBalance -= reservation.tokens;
    }
    return {
      ...common,
      status: TokenReservationStatus.RELEASED,
      releasedAt: reservation.releasedAt,
      releaseReason: reservation.releaseReason,
      idempotentReplay: false,
    };
  };
}

function buildDeps(store: FakeRecoveryStore): AIBillingRecoveryDependencies {
  return {
    repository: fakeRepository(store),
    settleForAmount: fakeSettle(store),
    releaseReservation: fakeRelease(store),
  };
}

function seedReservation(store: FakeRecoveryStore, reservation: AIBillingRecoveryReservationRow) {
  store.reservations.set(reservation.id, reservation);
  store.wallets.set(reservation.walletId, {
    id: reservation.walletId,
    userId: reservation.userId,
    tokenBalance: 100,
    reservedBalance: reservation.tokens,
    status: WalletStatus.ACTIVE,
  });
}

function seedWallet(store: FakeRecoveryStore, wallet: AIBillingRecoveryWalletRow = buildWallet()) {
  store.wallets.set(wallet.id, wallet);
}

async function expectRecoveryError(
  promise: Promise<unknown>,
  code: AIBillingRecoveryErrorCode,
): Promise<AIBillingRecoveryError> {
  let captured: AIBillingRecoveryError | undefined;
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(
      err instanceof AIBillingRecoveryError,
      `expected AIBillingRecoveryError, got ${(err as Error)?.message}`,
    );
    assert.equal((err as AIBillingRecoveryError).code, code);
    captured = err as AIBillingRecoveryError;
    return true;
  });
  return captured as AIBillingRecoveryError;
}

// ---------------------------------------------------------------------------
// Unit tests (no database)
// ---------------------------------------------------------------------------

describe('AI Billing Recovery Service', () => {
  test('1. PENDING reservation with valid metadata is REVIEW', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.reservationId, 'reservation-1');
    assert.equal(result.reservationStatus, TokenReservationStatus.PENDING);
    assert.equal(result.metadataStatus, 'VALID');
    assert.equal(result.recommendation, 'REVIEW');
    assert.equal(result.recoveryRequired, true);
    assert.equal(result.automaticFinancialActionAllowed, false);
    assert.equal(result.integrityConflict, false);
    assert.equal(result.reasonCode, 'PENDING_REVIEW');
    assert.equal(store.writes.length, 0);
  });

  test('2. PENDING reservation with missing metadata is REVIEW (MISSING)', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ metadata: null }));
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'MISSING');
    assert.equal(result.reasonCode, 'METADATA_MISSING');
    assert.equal(result.recommendation, 'REVIEW');
    assert.equal(result.recoveryRequired, true);
  });

  test('3. PENDING reservation with unsupported schemaVersion is REVIEW (INVALID)', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        metadata: {
          aiBilling: {
            schemaVersion: 2,
            requestedMode: 'PROVIDER_USAGE',
            quoteAppliedMode: 'PROVIDER_USAGE',
            quotedTokens: 2,
            fixedFallbackTokens: 2,
            maxInputTokens: 12000,
            maxOutputTokens: 1200,
          },
        },
      }),
    );
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'INVALID');
    assert.equal(result.reasonCode, 'METADATA_INVALID');
    assert.equal(result.recommendation, 'REVIEW');
  });

  test('4. PENDING reservation without an aiBilling section is MISSING', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ metadata: { someOtherKey: true } }));
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'MISSING');
    assert.equal(result.reasonCode, 'METADATA_MISSING');
    assert.equal(result.recommendation, 'REVIEW');
  });

  test('5. PENDING reservation whose quotedTokens mismatch tokens is REVIEW (INVALID)', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 5, metadata: validMetadata(2) }));
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'INVALID');
    assert.equal(result.reasonCode, 'METADATA_INVALID');
    assert.equal(result.recommendation, 'REVIEW');
  });

  test('6. Unknown extra metadata fields are ignored (still VALID)', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        metadata: {
          aiBilling: {
            schemaVersion: 1,
            requestedMode: 'PROVIDER_USAGE',
            quoteAppliedMode: 'PROVIDER_USAGE',
            quotedTokens: 2,
            fixedFallbackTokens: 2,
            maxInputTokens: 12000,
            maxOutputTokens: 1200,
            someFutureField: 'ignored',
          },
        },
      }),
    );
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'VALID');
  });

  test('7. PENDING reservation with an existing consume is an integrity conflict', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    store.consumes.set('reservation-1', [buildConsume()]);
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.integrityConflict, true);
    assert.equal(result.reasonCode, 'INTEGRITY_CONFLICT');
    assert.equal(result.recommendation, 'REVIEW');
    assert.equal(result.recoveryRequired, true);
  });

  test('8. COMPLETED reservation with a valid consume is NO_ACTION', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.COMPLETED,
        settledAt: new Date(),
      }),
    );
    store.consumes.set('reservation-1', [buildConsume({ tokens: 2 })]);
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.recommendation, 'NO_ACTION');
    assert.equal(result.recoveryRequired, false);
    assert.equal(result.automaticFinancialActionAllowed, false);
    assert.equal(result.integrityConflict, false);
    assert.equal(result.reasonCode, 'RESOLVED');
    assert.equal(result.consumedTokens, 2);
    assert.equal(result.releasedTokens, 0);
    assert.equal(result.consumeTransactionId, 'consume-1');
  });

  test('9. COMPLETED reservation whose consume exceeds reserved tokens is a conflict', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.COMPLETED,
        settledAt: new Date(),
      }),
    );
    store.consumes.set('reservation-1', [buildConsume({ tokens: 5 })]);
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.integrityConflict, true);
    assert.equal(result.recommendation, 'REVIEW');
  });

  test('10. COMPLETED reservation without a consume is a conflict', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.COMPLETED,
        settledAt: new Date(),
      }),
    );
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.integrityConflict, true);
    assert.equal(result.recommendation, 'REVIEW');
  });

  test('11. RELEASED reservation without a consume is NO_ACTION', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.RELEASED,
        releasedAt: new Date(),
        releaseReason: 'not billable',
      }),
    );
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.recommendation, 'NO_ACTION');
    assert.equal(result.recoveryRequired, false);
    assert.equal(result.integrityConflict, false);
    assert.equal(result.reasonCode, 'RESOLVED');
  });

  test('12. RELEASED reservation with a consume is a conflict', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.RELEASED,
        releasedAt: new Date(),
        releaseReason: 'not billable',
      }),
    );
    store.consumes.set('reservation-1', [buildConsume()]);
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.integrityConflict, true);
    assert.equal(result.recommendation, 'REVIEW');
  });

  test('13. Inspection with an empty reservationId is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    const err = await expectRecoveryError(
      inspectAIBillingRecovery({ reservationId: '   ' }, buildDeps(store)),
      'INVALID_INPUT',
    );
    assert.equal(err.reservationId, undefined);
  });

  test('14. Inspection of a missing reservation is RESERVATION_NOT_FOUND', async () => {
    const store = new FakeRecoveryStore();
    const err = await expectRecoveryError(
      inspectAIBillingRecovery({ reservationId: 'reservation-missing' }, buildDeps(store)),
      'RESERVATION_NOT_FOUND',
    );
    assert.equal(err.reservationId, 'reservation-missing');
  });

  test('15. Inspection with a missing wallet is INTEGRITY_CONFLICT', async () => {
    const store = new FakeRecoveryStore();
    store.reservations.set('reservation-1', buildReservation());
    const err = await expectRecoveryError(
      inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store)),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(err.reservationId, 'reservation-1');
  });

  test('16. COMPLETED reservation with non-safe consume tokens is a conflict', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.COMPLETED,
        settledAt: new Date(),
      }),
    );
    store.consumes.set('reservation-1', [buildConsume({ tokens: 1.5 })]);
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.integrityConflict, true);
    assert.equal(result.recommendation, 'REVIEW');
  });

  test('17. Non-object metadata is INVALID', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ metadata: 'not-an-object' }));
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'INVALID');
    assert.equal(result.reasonCode, 'METADATA_INVALID');
  });

  test('18. COMPLETED partial settlement is NO_ACTION with released tokens', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        tokens: 5,
        metadata: validMetadata(5),
        status: TokenReservationStatus.COMPLETED,
        settledAt: new Date(),
      }),
    );
    store.consumes.set('reservation-1', [buildConsume({ tokens: 3 })]);
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.recommendation, 'NO_ACTION');
    assert.equal(result.consumedTokens, 3);
    assert.equal(result.releasedTokens, 2);
  });

  test('19. Inspection exposes all required sanitized identifiers and billing summary', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        tokens: 5,
        metadata: fullMetadata(5),
        pricingVersion: 3,
        referenceId: 'user-1:AI_TRIP_ITINERARY:key-9',
        feature: 'AI_TRIP_ITINERARY',
      }),
    );
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.reservationId, 'reservation-1');
    assert.equal(result.referenceId, 'user-1:AI_TRIP_ITINERARY:key-9');
    assert.equal(result.walletId, 'wallet-1');
    assert.equal(result.userId, 'user-1');
    assert.equal(result.feature, 'AI_TRIP_ITINERARY');
    assert.equal(result.source, TokenTransactionSource.CHAT);
    assert.equal(result.reservedTokens, 5);
    assert.equal(result.pricingVersion, 3);
    assert.equal(result.expiresAt.getTime() > Date.now(), true);
    assert.equal(result.isExpired, false);
    assert.equal(result.quotedTokens, 5);
    assert.equal(result.requestedMode, 'PROVIDER_USAGE');
    assert.equal(result.quoteAppliedMode, 'PROVIDER_USAGE');
    assert.equal(result.maximumUsageWalletTokens, 12000);
    assert.equal(result.provider, 'fake-provider');
    assert.equal(result.model, 'fake-model');
    assert.equal(result.billingCurrency, 'USD');
    assert.equal(result.rateCardVersion, 'rate-v1');
    assert.equal(result.walletPolicyVersion, 'policy-v1');
    assert.ok(!('metadata' in result));
    assert.ok(!('aiBilling' in result));
    assert.ok(!('fixedFallbackTokens' in result));
    assert.ok(!('maxInputTokens' in result));
    assert.ok(!('maxOutputTokens' in result));
  });

  test('20. isExpired is false while the reservation is still valid', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({ expiresAt: new Date(Date.now() + 5 * 60 * 1000) }),
    );
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.isExpired, false);
    assert.equal(result.recommendation, 'REVIEW');
  });

  test('21. isExpired is true for a past expiry and expired PENDING still recommends REVIEW', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({ expiresAt: new Date(Date.now() - 60_000) }),
    );
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.isExpired, true);
    assert.equal(result.recommendation, 'REVIEW');
    assert.equal(result.recoveryRequired, true);
    assert.equal(store.writes.length, 0);
  });

  test('22. automaticFinancialActionAllowed is false for PENDING, COMPLETED, and RELEASED', async () => {
    const pendingStore = new FakeRecoveryStore();
    seedReservation(pendingStore, buildReservation());
    const pending = await inspectAIBillingRecovery(
      { reservationId: 'reservation-1' },
      buildDeps(pendingStore),
    );
    assert.equal(pending.automaticFinancialActionAllowed, false);

    const completedStore = new FakeRecoveryStore();
    seedReservation(
      completedStore,
      buildReservation({
        status: TokenReservationStatus.COMPLETED,
        settledAt: new Date(),
      }),
    );
    completedStore.consumes.set('reservation-1', [buildConsume()]);
    const completed = await inspectAIBillingRecovery(
      { reservationId: 'reservation-1' },
      buildDeps(completedStore),
    );
    assert.equal(completed.recommendation, 'NO_ACTION');
    assert.equal(completed.automaticFinancialActionAllowed, false);

    const releasedStore = new FakeRecoveryStore();
    seedReservation(
      releasedStore,
      buildReservation({
        status: TokenReservationStatus.RELEASED,
        releasedAt: new Date(),
        releaseReason: 'not billable',
      }),
    );
    const released = await inspectAIBillingRecovery(
      { reservationId: 'reservation-1' },
      buildDeps(releasedStore),
    );
    assert.equal(released.recommendation, 'NO_ACTION');
    assert.equal(released.automaticFinancialActionAllowed, false);
  });

  test('23. COMPLETED without settledAt is an integrity conflict', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.COMPLETED,
        settledAt: null,
      }),
    );
    store.consumes.set('reservation-1', [buildConsume()]);
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.integrityConflict, true);
    assert.equal(result.recommendation, 'REVIEW');
  });

  test('24. COMPLETED with multiple consumes is an integrity conflict', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.COMPLETED,
        settledAt: new Date(),
      }),
    );
    store.consumes.set('reservation-1', [
      buildConsume({ id: 'consume-1' }),
      buildConsume({ id: 'consume-2' }),
    ]);
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.integrityConflict, true);
    assert.equal(result.recommendation, 'REVIEW');
  });

  test('25. COMPLETED with a release timestamp is an integrity conflict', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.COMPLETED,
        settledAt: new Date(),
        releasedAt: new Date(),
      }),
    );
    store.consumes.set('reservation-1', [buildConsume()]);
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.integrityConflict, true);
    assert.equal(result.recommendation, 'REVIEW');
  });

  test('26. RELEASED without releasedAt is an integrity conflict', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.RELEASED,
        releasedAt: null,
        releaseReason: 'not billable',
      }),
    );
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.integrityConflict, true);
    assert.equal(result.recommendation, 'REVIEW');
  });

  test('27. RELEASED with settledAt is an integrity conflict', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.RELEASED,
        settledAt: new Date(),
        releasedAt: new Date(),
        releaseReason: 'not billable',
      }),
    );
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.integrityConflict, true);
    assert.equal(result.recommendation, 'REVIEW');
  });

  test('28. Malformed quotedTokens is INVALID', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        metadata: {
          aiBilling: {
            schemaVersion: 1,
            requestedMode: 'PROVIDER_USAGE',
            quoteAppliedMode: 'PROVIDER_USAGE',
            quotedTokens: 'two',
            fixedFallbackTokens: 2,
            maxInputTokens: 12000,
            maxOutputTokens: 1200,
          },
        },
      }),
    );
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'INVALID');
  });

  test('29. Malformed requestedMode is INVALID', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        metadata: {
          aiBilling: {
            schemaVersion: 1,
            requestedMode: 'SURPRISE_MODE',
            quoteAppliedMode: 'PROVIDER_USAGE',
            quotedTokens: 2,
            fixedFallbackTokens: 2,
            maxInputTokens: 12000,
            maxOutputTokens: 1200,
          },
        },
      }),
    );
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'INVALID');
  });

  test('30. Malformed maxInputTokens is INVALID', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        metadata: {
          aiBilling: {
            schemaVersion: 1,
            requestedMode: 'PROVIDER_USAGE',
            quoteAppliedMode: 'PROVIDER_USAGE',
            quotedTokens: 2,
            fixedFallbackTokens: 2,
            maxInputTokens: -5,
            maxOutputTokens: 1200,
          },
        },
      }),
    );
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'INVALID');
  });

  test('31. Malformed provider is INVALID', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        metadata: {
          aiBilling: {
            schemaVersion: 1,
            requestedMode: 'PROVIDER_USAGE',
            quoteAppliedMode: 'PROVIDER_USAGE',
            quotedTokens: 2,
            fixedFallbackTokens: 2,
            maxInputTokens: 12000,
            maxOutputTokens: 1200,
            provider: 123,
          },
        },
      }),
    );
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'INVALID');
  });

  test('32. VALID metadata exposes the billing summary fields', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ metadata: fullMetadata(2) }));
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'VALID');
    assert.equal(result.quotedTokens, 2);
    assert.equal(result.requestedMode, 'PROVIDER_USAGE');
    assert.equal(result.quoteAppliedMode, 'PROVIDER_USAGE');
    assert.equal(result.provider, 'fake-provider');
    assert.equal(result.model, 'fake-model');
    assert.equal(result.billingCurrency, 'USD');
    assert.equal(result.rateCardVersion, 'rate-v1');
    assert.equal(result.walletPolicyVersion, 'policy-v1');
  });

  test('33. SETTLE new settlement returns SETTLED with mutation performed', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(2) },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'SETTLED');
    assert.equal(result.financialMutationPerformed, true);
    assert.equal(result.status, TokenReservationStatus.COMPLETED);
    assert.equal(result.actualTokens, 2);
    assert.equal(result.releasedTokens, 0);
    assert.ok(result.consumeTransactionId);
    assert.equal(result.recoveryRequired, false);
    assert.equal(result.idempotentReplay, false);
  });

  test('34. SETTLE succeeds for a partial confirmed amount', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 5, metadata: validMetadata(5) }));
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(3) },
      buildDeps(store),
    );
    assert.equal(result.actualTokens, 3);
    assert.equal(result.releasedTokens, 2);
  });

  test('35. SETTLE allows a zero confirmed amount', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(0) },
      buildDeps(store),
    );
    assert.equal(result.actualTokens, 0);
    assert.equal(result.releasedTokens, 2);
  });

  test('36. SETTLE with the wrong confirmation is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        {
          reservationId: 'reservation-1',
          action: asAction({
            type: 'SETTLE',
            confirmation: 'CONFIRMED_NON_BILLABLE',
            actualTokens: 2,
            reason: 'wrong confirmation',
          }),
        },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('37. SETTLE without actualTokens is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        {
          reservationId: 'reservation-1',
          action: asAction({ type: 'SETTLE', confirmation: 'ACTUAL_TOKENS_CONFIRMED', reason: 'no amount' }),
        },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('38. SETTLE with a negative amount is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(-1) },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('39. SETTLE with a non-integer amount is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(1.5) },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('40. SETTLE above the reserved amount is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 2 }));
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(3) },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('41. SETTLE with an empty reservationId is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: '  ', action: settleAction(2) },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('42. SETTLE of a missing reservation is RESERVATION_NOT_FOUND', async () => {
    const store = new FakeRecoveryStore();
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-missing', action: settleAction(2) },
        buildDeps(store),
      ),
      'RESERVATION_NOT_FOUND',
    );
    assert.equal(err.reservationId, 'reservation-missing');
  });

  test('43. SETTLE replay returns ALREADY_SETTLED with no mutation performed', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    const first = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(2) },
      deps,
    );
    assert.equal(first.outcome, 'SETTLED');
    assert.equal(first.financialMutationPerformed, true);
    const second = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(2) },
      deps,
    );
    assert.equal(second.outcome, 'ALREADY_SETTLED');
    assert.equal(second.financialMutationPerformed, false);
    assert.equal(second.idempotentReplay, true);
    assert.equal(store.consumes.get('reservation-1')?.length, 1);
  });

  test('44. SETTLE on a released reservation is INTEGRITY_CONFLICT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.RELEASED,
        releasedAt: new Date(),
        releaseReason: 'not billable',
      }),
    );
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(err.recoveryRequired, true);
  });

  test('45. SETTLE with unsupported metadata version is METADATA_INVALID', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        metadata: { aiBilling: { schemaVersion: 2, quotedTokens: 2 } },
      }),
    );
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        buildDeps(store),
      ),
      'METADATA_INVALID',
    );
  });

  test('46. SETTLE with missing metadata is METADATA_INVALID', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ metadata: null }));
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        buildDeps(store),
      ),
      'METADATA_INVALID',
    );
  });

  test('47. SETTLE with a quotedTokens mismatch is METADATA_INVALID', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 5, metadata: validMetadata(2) }));
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(5) },
        buildDeps(store),
      ),
      'METADATA_INVALID',
    );
  });

  test('48. SETTLE without a reason is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2, { reason: '   ' }) },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('49. SETTLE with a missing reason is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2, { reason: '' }) },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('50. SETTLE with an empty evidenceReference is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        {
          reservationId: 'reservation-1',
          action: settleAction(2, { reason: 'evidence', evidenceReference: ' ' }),
        },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('51. SETTLE echoes a non-empty evidenceReference', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await recoverAIBillingReservation(
      {
        reservationId: 'reservation-1',
        action: settleAction(2, { reason: 'evidence', evidenceReference: 'evidence-42' }),
      },
      buildDeps(store),
    );
    assert.equal(result.evidenceReference, 'evidence-42');
  });

  test('52. SETTLE maps an underlying 409 to INTEGRITY_CONFLICT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.RELEASED,
        releasedAt: new Date(),
        releaseReason: 'released concurrently',
      }),
    );
    const deps = buildDeps(store);
    deps.settleForAmount = async () => {
      throw new AppError(409, 'Cannot settle a released reservation');
    };
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        deps,
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(err.recoveryRequired, true);
  });

  test('53. SETTLE maps an unexpected failure to SETTLEMENT_FAILED', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    deps.settleForAmount = async () => {
      throw new Error('database exploded');
    };
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        deps,
      ),
      'SETTLEMENT_FAILED',
    );
    assert.equal(err.recoveryRequired, true);
  });

  test('54. RELEASE new returns RELEASED with mutation performed', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: releaseAction() },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'RELEASED');
    assert.equal(result.financialMutationPerformed, true);
    assert.equal(result.status, TokenReservationStatus.RELEASED);
    assert.equal(result.recoveryRequired, false);
    assert.equal(result.idempotentReplay, false);
  });

  test('55. RELEASE with the wrong confirmation is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        {
          reservationId: 'reservation-1',
          action: asAction({
            type: 'RELEASE',
            confirmation: 'ACTUAL_TOKENS_CONFIRMED',
            reason: 'wrong confirmation',
          }),
        },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('56. RELEASE without a reason is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: releaseAction({ reason: '' }) },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('57. RELEASE of a missing reservation is RESERVATION_NOT_FOUND', async () => {
    const store = new FakeRecoveryStore();
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-missing', action: releaseAction() },
        buildDeps(store),
      ),
      'RESERVATION_NOT_FOUND',
    );
  });

  test('58. RELEASE replay returns ALREADY_RELEASED with no mutation performed', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    const first = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: releaseAction() },
      deps,
    );
    assert.equal(first.outcome, 'RELEASED');
    assert.equal(first.financialMutationPerformed, true);
    const second = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: releaseAction() },
      deps,
    );
    assert.equal(second.outcome, 'ALREADY_RELEASED');
    assert.equal(second.financialMutationPerformed, false);
    assert.equal(second.idempotentReplay, true);
  });

  test('59. RELEASE on a completed reservation is INTEGRITY_CONFLICT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.COMPLETED,
        settledAt: new Date(),
      }),
    );
    store.consumes.set('reservation-1', [buildConsume()]);
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: releaseAction() },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(err.recoveryRequired, true);
  });

  test('60. RELEASE with invalid metadata is METADATA_INVALID', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ metadata: null }));
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: releaseAction() },
        buildDeps(store),
      ),
      'METADATA_INVALID',
    );
  });

  test('61. RELEASE maps an unexpected failure to RELEASE_FAILED', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    deps.releaseReservation = async () => {
      throw new Error('database exploded');
    };
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: releaseAction() },
        deps,
      ),
      'RELEASE_FAILED',
    );
    assert.equal(err.recoveryRequired, true);
  });

  test('62. RELEASE echoes a non-empty evidenceReference', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await recoverAIBillingReservation(
      {
        reservationId: 'reservation-1',
        action: releaseAction({ evidenceReference: 'evidence-9' }),
      },
      buildDeps(store),
    );
    assert.equal(result.evidenceReference, 'evidence-9');
  });

  test('63. REVIEW returns REVIEW_REQUIRED and performs no mutation', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: reviewAction() },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'REVIEW_REQUIRED');
    assert.equal(result.financialMutationPerformed, false);
    assert.equal(result.status, TokenReservationStatus.PENDING);
    assert.equal(result.recoveryRequired, true);
    assert.equal(store.writes.length, 0);
    assert.equal(store.reservations.get('reservation-1')?.status, TokenReservationStatus.PENDING);
  });

  test('64. REVIEW with a blank reason is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: reviewAction('   ') },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('65. REVIEW of a missing reservation is RESERVATION_NOT_FOUND', async () => {
    const store = new FakeRecoveryStore();
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-missing', action: reviewAction() },
        buildDeps(store),
      ),
      'RESERVATION_NOT_FOUND',
    );
  });

  test('66. REVIEW rejects completed reservations with INTEGRITY_CONFLICT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.COMPLETED,
        settledAt: new Date(),
      }),
    );
    store.consumes.set('reservation-1', [buildConsume()]);
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: reviewAction() },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
  });

  test('67. REVIEW rejects released reservations with INTEGRITY_CONFLICT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.RELEASED,
        releasedAt: new Date(),
        releaseReason: 'not billable',
      }),
    );
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: reviewAction() },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
  });

  test('68. REVIEW result is sanitized and never exposes raw metadata', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: reviewAction() },
      buildDeps(store),
    );
    assert.ok(!('metadata' in result));
    assert.ok(!('aiBilling' in result));
  });

  test('69. Unknown runtime action type is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: asAction({ type: 'DELETE', reason: 'nope' }) },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('70. A non-object action is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: asAction('SETTLE') },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('71. A null action is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: asAction(null) },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('72. Concurrency: settle after a REVIEW inspection is a clean replay', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    const inspection = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, deps);
    assert.equal(inspection.recommendation, 'REVIEW');
    const first = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(2) },
      deps,
    );
    assert.equal(first.outcome, 'SETTLED');
    assert.equal(first.financialMutationPerformed, true);
    const second = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(2) },
      deps,
    );
    assert.equal(second.outcome, 'ALREADY_SETTLED');
    assert.equal(second.financialMutationPerformed, false);
    assert.equal(store.consumes.get('reservation-1')?.length, 1);
  });

  test('73. Concurrency: release after settle maps to INTEGRITY_CONFLICT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(2) },
      deps,
    );
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: releaseAction() },
        deps,
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(err.recoveryRequired, true);
  });

  test('74. Concurrency: concurrent same-amount settles settle exactly once', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    const results = await Promise.all([
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        deps,
      ),
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        deps,
      ),
    ]);
    const outcomes = results.map((r) => r.outcome).sort();
    assert.deepEqual(outcomes, ['ALREADY_SETTLED', 'SETTLED']);
    assert.equal(results.filter((r) => r.financialMutationPerformed).length, 1);
    assert.equal(store.consumes.get('reservation-1')?.length, 1);
  });

  test('75. Concurrency: concurrent releases are idempotent', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    const results = await Promise.all([
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: releaseAction() },
        deps,
      ),
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: releaseAction() },
        deps,
      ),
    ]);
    const outcomes = results.map((r) => r.outcome).sort();
    assert.deepEqual(outcomes, ['ALREADY_RELEASED', 'RELEASED']);
    assert.equal(results.filter((r) => r.financialMutationPerformed).length, 1);
  });

  test('76. Concurrency: reconcile matches before and after a settle', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    const before = await reconcileWalletReservations({ walletId: 'wallet-1' }, deps);
    assert.equal(before.status, 'MATCH');
    assert.equal(before.difference, 0);
    await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(2) },
      deps,
    );
    const after = await reconcileWalletReservations({ walletId: 'wallet-1' }, deps);
    assert.equal(after.status, 'MATCH');
    assert.equal(after.actualReservedBalance, 0);
    assert.equal(after.expectedPendingReservedTokens, 0);
  });

  test('77. Concurrency: re-settling with a different amount is INTEGRITY_CONFLICT', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 5, metadata: validMetadata(5) }));
    const deps = buildDeps(store);
    await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(3) },
      deps,
    );
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(4) },
        deps,
      ),
      'INTEGRITY_CONFLICT',
    );
  });

  test('78. Reconcile matches an empty wallet and exposes userId', async () => {
    const store = new FakeRecoveryStore();
    store.wallets.set('wallet-1', buildWallet({ reservedBalance: 0 }));
    const result = await reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store));
    assert.equal(result.walletId, 'wallet-1');
    assert.equal(result.userId, 'user-1');
    assert.equal(result.status, 'MATCH');
    assert.equal(result.recoveryRequired, false);
    assert.equal(result.difference, 0);
    assert.equal(result.pendingReservationCount, 0);
  });

  test('79. Reconcile matches a single pending reservation', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 5, metadata: validMetadata(5) }));
    const result = await reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store));
    assert.equal(result.status, 'MATCH');
    assert.equal(result.recoveryRequired, false);
    assert.equal(result.actualReservedBalance, 5);
    assert.equal(result.expectedPendingReservedTokens, 5);
    assert.equal(result.pendingReservationCount, 1);
  });

  test('80. Reconcile matches multiple pending reservations', async () => {
    const store = new FakeRecoveryStore();
    store.wallets.set('wallet-1', buildWallet({ reservedBalance: 8 }));
    store.reservations.set(
      'reservation-1',
      buildReservation({ id: 'reservation-1', tokens: 3, metadata: validMetadata(3) }),
    );
    store.reservations.set(
      'reservation-2',
      buildReservation({ id: 'reservation-2', tokens: 5, metadata: validMetadata(5) }),
    );
    const result = await reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store));
    assert.equal(result.status, 'MATCH');
    assert.equal(result.pendingReservationCount, 2);
    assert.equal(result.expectedPendingReservedTokens, 8);
  });

  test('81. Reconcile reports a positive difference mismatch', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 3, metadata: validMetadata(3) }));
    store.wallets.get('wallet-1')!.reservedBalance = 5;
    const result = await reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store));
    assert.equal(result.status, 'MISMATCH');
    assert.equal(result.recoveryRequired, true);
    assert.equal(result.difference, 2);
    assert.equal(result.actualReservedBalance, 5);
    assert.equal(result.expectedPendingReservedTokens, 3);
  });

  test('82. Reconcile reports a negative difference mismatch', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 5, metadata: validMetadata(5) }));
    store.wallets.get('wallet-1')!.reservedBalance = 3;
    const result = await reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store));
    assert.equal(result.status, 'MISMATCH');
    assert.equal(result.recoveryRequired, true);
    assert.equal(result.difference, -2);
  });

  test('83. Reconcile with an empty walletId is INVALID_INPUT', async () => {
    const store = new FakeRecoveryStore();
    await expectRecoveryError(
      reconcileWalletReservations({ walletId: '   ' }, buildDeps(store)),
      'INVALID_INPUT',
    );
  });

  test('84. Reconcile of a missing wallet is RECONCILIATION_FAILED', async () => {
    const store = new FakeRecoveryStore();
    await expectRecoveryError(
      reconcileWalletReservations({ walletId: 'wallet-missing' }, buildDeps(store)),
      'RECONCILIATION_FAILED',
    );
  });

  test('85. Reconcile rejects a non-safe reserved balance', async () => {
    const store = new FakeRecoveryStore();
    store.wallets.set('wallet-1', buildWallet({ reservedBalance: 1.5 }));
    await expectRecoveryError(
      reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store)),
      'RECONCILIATION_FAILED',
    );
  });

  test('86. Reconcile rejects a non-safe pending aggregate', async () => {
    const store = new FakeRecoveryStore();
    store.wallets.set('wallet-1', buildWallet({ reservedBalance: 2 }));
    store.reservations.set(
      'reservation-1',
      buildReservation({ tokens: 1.5, metadata: validMetadata(2) }),
    );
    await expectRecoveryError(
      reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store)),
      'RECONCILIATION_FAILED',
    );
  });

  test('87. Reconcile is strictly read-only', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const beforeReservations = store.reservations.size;
    const beforeWrites = store.writes.length;
    await reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store));
    assert.equal(store.writes.length, beforeWrites);
    assert.equal(store.reservations.size, beforeReservations);
    assert.equal(store.reservations.get('reservation-1')?.status, TokenReservationStatus.PENDING);
  });

  test('88. Reconcile only counts PENDING reservations', async () => {
    const store = new FakeRecoveryStore();
    store.wallets.set('wallet-1', buildWallet({ reservedBalance: 3 }));
    store.reservations.set(
      'reservation-1',
      buildReservation({ id: 'reservation-1', tokens: 3, metadata: validMetadata(3) }),
    );
    store.reservations.set(
      'reservation-2',
      buildReservation({
        id: 'reservation-2',
        tokens: 9,
        metadata: validMetadata(9),
        status: TokenReservationStatus.COMPLETED,
        settledAt: new Date(),
      }),
    );
    store.reservations.set(
      'reservation-3',
      buildReservation({
        id: 'reservation-3',
        tokens: 7,
        metadata: validMetadata(7),
        status: TokenReservationStatus.RELEASED,
        releasedAt: new Date(),
        releaseReason: 'not billable',
      }),
    );
    const result = await reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store));
    assert.equal(result.status, 'MATCH');
    assert.equal(result.pendingReservationCount, 1);
    assert.equal(result.expectedPendingReservedTokens, 3);
  });

  test('89. Reconcile returns inspectedAt and pending count', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store));
    assert.ok(result.inspectedAt instanceof Date);
    assert.ok(result.inspectedAt.getTime() <= Date.now());
    assert.equal(typeof result.pendingReservationCount, 'number');
  });

  test('90. Reconcile reports the exact signed difference', async () => {
    const store = new FakeRecoveryStore();
    store.wallets.set('wallet-1', buildWallet({ reservedBalance: 10 }));
    store.reservations.set(
      'reservation-1',
      buildReservation({ id: 'reservation-1', tokens: 6, metadata: validMetadata(6) }),
    );
    const result = await reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store));
    assert.equal(result.difference, 4);
    assert.equal(result.status, 'MISMATCH');
  });

  test('91. Reconcile matches with zero pending reservations and zero balance', async () => {
    const store = new FakeRecoveryStore();
    store.wallets.set('wallet-1', buildWallet({ reservedBalance: 0 }));
    const result = await reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store));
    assert.equal(result.status, 'MATCH');
    assert.equal(result.difference, 0);
  });

  test('92. Reconcile matches when released tokens are already returned to the balance', async () => {
    const store = new FakeRecoveryStore();
    store.wallets.set('wallet-1', buildWallet({ reservedBalance: 0 }));
    store.reservations.set(
      'reservation-1',
      buildReservation({
        id: 'reservation-1',
        tokens: 4,
        metadata: validMetadata(4),
        status: TokenReservationStatus.RELEASED,
        releasedAt: new Date(),
        releaseReason: 'not billable',
      }),
    );
    const result = await reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store));
    assert.equal(result.status, 'MATCH');
    assert.equal(result.expectedPendingReservedTokens, 0);
  });

  test('93. Reconcile flags reserved balance with no matching pending reservation', async () => {
    const store = new FakeRecoveryStore();
    store.wallets.set('wallet-1', buildWallet({ reservedBalance: 4 }));
    store.reservations.set(
      'reservation-1',
      buildReservation({
        id: 'reservation-1',
        tokens: 4,
        metadata: validMetadata(4),
        status: TokenReservationStatus.COMPLETED,
        settledAt: new Date(),
      }),
    );
    const result = await reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store));
    assert.equal(result.status, 'MISMATCH');
    assert.equal(result.recoveryRequired, true);
    assert.equal(result.difference, 4);
  });

  test('94. Reconcile reads a single consistent snapshot', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    await reconcileWalletReservations({ walletId: 'wallet-1' }, deps);
    assert.ok(store.reads.includes('readReconciliationSnapshot'));
    assert.ok(!store.reads.includes('findReservationById'));
  });

  test('95. Reconcile rejects an invalid pendingReservationCount', async () => {
    const store = new FakeRecoveryStore();
    store.wallets.set('wallet-1', buildWallet({ reservedBalance: 0 }));
    const deps = buildDeps(store);
    deps.repository = {
      ...deps.repository,
      readReconciliationSnapshot: async () => ({
        wallet: buildWallet({ reservedBalance: 0 }),
        pending: { count: 1.5, totalTokens: 0 },
      }),
    };
    await expectRecoveryError(
      reconcileWalletReservations({ walletId: 'wallet-1' }, deps),
      'RECONCILIATION_FAILED',
    );
  });

  test('96. Separation: inspection never calls the settle or release dependencies', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(
      store,
      buildReservation({
        status: TokenReservationStatus.COMPLETED,
        settledAt: new Date(),
      }),
    );
    store.consumes.set('reservation-1', [buildConsume()]);
    await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(store.writes.length, 0);
  });

  test('97. Separation: recovery completes its mutation before returning', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(2) },
      deps,
    );
    assert.equal(store.consumes.get('reservation-1')?.length, 1);
    assert.equal(
      store.reservations.get('reservation-1')?.status,
      TokenReservationStatus.COMPLETED,
    );
    assert.equal(result.outcome, 'SETTLED');
  });

  test('98. Separation: errors never leak the underlying failure message', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    deps.settleForAmount = async () => {
      throw new Error('DATABASE_SECRET credential leaked reservedBalance=999');
    };
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        deps,
      ),
      'SETTLEMENT_FAILED',
    );
    assert.equal(err.message, 'AI billing reservation settlement failed');
    assert.ok(!err.message.includes('DATABASE_SECRET'));
    assert.ok(!err.message.includes('999'));
  });

  test('99. Separation: AIBillingRecoveryError is not an AppError', async () => {
    const store = new FakeRecoveryStore();
    const err = await expectRecoveryError(
      inspectAIBillingRecovery({ reservationId: 'reservation-missing' }, buildDeps(store)),
      'RESERVATION_NOT_FOUND',
    );
    assert.equal(err.name, 'AIBillingRecoveryError');
    assert.ok(!(err instanceof AppError));
    assert.ok(!('statusCode' in err));
  });

  test('100. Separation: a valid amount above eight is passed through unchanged', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 12, metadata: validMetadata(12) }));
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(10) },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'SETTLED');
    assert.equal(result.actualTokens, 10);
    assert.equal(result.releasedTokens, 2);
  });

  test('101. Separation: inspection never returns raw metadata or rate cards', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.ok(!('metadata' in result));
    assert.ok(!('aiBilling' in result));
    assert.ok(!('rateCard' in result));
    assert.ok(!('walletPolicy' in result));
    assert.ok(!('prompts' in result));
  });

  test('102. Separation: recovery results never include raw metadata', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: reviewAction() },
      buildDeps(store),
    );
    assert.ok(!('metadata' in result));
    assert.ok(!('aiBilling' in result));
  });

  test('103. Separation: reconcile never mutates reservations or wallets', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const reservationBefore = { ...store.reservations.get('reservation-1') };
    const walletBefore = { ...store.wallets.get('wallet-1') };
    await reconcileWalletReservations({ walletId: 'wallet-1' }, buildDeps(store));
    assert.deepEqual(store.reservations.get('reservation-1'), reservationBefore);
    assert.deepEqual(store.wallets.get('wallet-1'), walletBefore);
    assert.equal(store.writes.length, 0);
  });

  test('104. Repository read failures become safe AIBillingRecoveryError values', async () => {
    const deps: AIBillingRecoveryDependencies = {
      repository: failingRepository(),
      settleForAmount: async () => {
        throw new Error('never called');
      },
      releaseReservation: async () => {
        throw new Error('never called');
      },
    };

    const inspectionError = await expectRecoveryError(
      inspectAIBillingRecovery({ reservationId: 'reservation-1' }, deps),
      'INTEGRITY_CONFLICT',
    );
    assert.ok(!inspectionError.message.includes('Prisma'));
    assert.ok(!inspectionError.message.includes('P2025'));
    assert.ok(!inspectionError.message.includes('raw'));

    const recoverError = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        deps,
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.ok(!recoverError.message.includes('Prisma'));
    assert.ok(!recoverError.message.includes('P2025'));

    const reconcileError = await expectRecoveryError(
      reconcileWalletReservations({ walletId: 'wallet-1' }, deps),
      'RECONCILIATION_FAILED',
    );
    assert.equal(reconcileError.reservationId, undefined);
    assert.ok(!reconcileError.message.includes('Prisma'));
    assert.ok(!reconcileError.message.includes('P2025'));
  });

  test('105. Reconciliation repository failure reports RECONCILIATION_FAILED without reservationId', async () => {
    const deps: AIBillingRecoveryDependencies = {
      repository: failingRepository(),
      settleForAmount: async () => {
        throw new Error('never called');
      },
      releaseReservation: async () => {
        throw new Error('never called');
      },
    };
    const err = await expectRecoveryError(
      reconcileWalletReservations({ walletId: 'wallet-1' }, deps),
      'RECONCILIATION_FAILED',
    );
    assert.equal(err.reservationId, undefined);
    assert.ok(!err.message.includes('Prisma'));
    assert.ok(!err.message.includes('P2025'));
    assert.ok(!err.message.includes('wallet-1'));
  });

  test('106. Matching reservation and wallet user ownership passes inspection', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.reservationId, 'reservation-1');
    assert.equal(result.userId, 'user-1');
    assert.equal(result.walletId, 'wallet-1');
  });

  test('107. Mismatching reservation and wallet user ownership is INTEGRITY_CONFLICT', async () => {
    const store = new FakeRecoveryStore();
    store.reservations.set('reservation-1', buildReservation({ userId: 'user-1' }));
    store.wallets.set('wallet-1', buildWallet({ userId: 'user-OTHER' }));
    const err = await expectRecoveryError(
      inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store)),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(err.reservationId, 'reservation-1');
    assert.equal(err.recoveryRequired, true);
    assert.equal(err.message, 'AI billing reservation wallet ownership mismatch');
  });

  test('108. Ownership mismatch exposes no raw Wallet data', async () => {
    const store = new FakeRecoveryStore();
    store.reservations.set('reservation-1', buildReservation());
    store.wallets.set('wallet-1', buildWallet({ userId: 'user-OTHER' }));
    const err = await expectRecoveryError(
      inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store)),
      'INTEGRITY_CONFLICT',
    );
    assert.ok(!err.message.includes('user-OTHER'));
    assert.ok(!err.message.includes('tokenBalance'));
    assert.ok(!err.message.includes('reservedBalance'));
    assert.ok(!err.message.includes('ACTIVE'));
  });

  test('109. Ownership mismatch performs no settlement or release', async () => {
    const store = new FakeRecoveryStore();
    store.reservations.set('reservation-1', buildReservation());
    store.wallets.set('wallet-1', buildWallet({ userId: 'user-OTHER' }));
    await assert.rejects(
      inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store)),
      AIBillingRecoveryError,
    );
    assert.equal(store.writes.length, 0);
    assert.deepEqual(store.writes, []);
  });

  test('110. maximumUsageWalletTokens is exposed only for VALID metadata', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ metadata: fullMetadata(2) }));
    const valid = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(valid.metadataStatus, 'VALID');
    assert.equal(valid.maximumUsageWalletTokens, 12000);

    const invalidStore = new FakeRecoveryStore();
    seedReservation(
      invalidStore,
      buildReservation({ metadata: { aiBilling: { schemaVersion: 2 } } }),
    );
    const invalid = await inspectAIBillingRecovery(
      { reservationId: 'reservation-1' },
      buildDeps(invalidStore),
    );
    assert.equal(invalid.metadataStatus, 'INVALID');
    assert.equal('maximumUsageWalletTokens' in invalid, false);
    assert.equal(invalid.maximumUsageWalletTokens, undefined);
  });

  test('111. RELEASE rejects a runtime actualTokens field', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        {
          reservationId: 'reservation-1',
          action: asAction({
            type: 'RELEASE',
            confirmation: 'CONFIRMED_NON_BILLABLE',
            actualTokens: 2,
            reason: 'must not carry an amount',
          }),
        },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
    assert.ok(err.message.includes('actual token amount'));
  });

  test('112. REVIEW rejects a runtime confirmation field', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        {
          reservationId: 'reservation-1',
          action: asAction({
            type: 'REVIEW',
            confirmation: 'CONFIRMED_NON_BILLABLE',
            reason: 'must not carry a confirmation',
          }),
        },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
    assert.ok(err.message.includes('confirmation'));
  });

  test('113. REVIEW rejects a runtime actualTokens field', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    await expectRecoveryError(
      recoverAIBillingReservation(
        {
          reservationId: 'reservation-1',
          action: asAction({ type: 'REVIEW', actualTokens: 2, reason: 'must not carry an amount' }),
        },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('114. REVIEW accepts a runtime evidenceReference field', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await recoverAIBillingReservation(
      {
        reservationId: 'reservation-1',
        action: asAction({
          type: 'REVIEW',
          evidenceReference: 'evidence-1',
          reason: 'review with evidence reference',
        }),
      },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'REVIEW_REQUIRED');
    assert.equal(result.evidenceReference, 'evidence-1');
  });

  test('115. SETTLE with matching Wallet ownership succeeds', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(2) },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'SETTLED');
    assert.equal(result.financialMutationPerformed, true);
  });

  test('116. RELEASE with matching Wallet ownership succeeds', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: releaseAction() },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'RELEASED');
    assert.equal(result.financialMutationPerformed, true);
  });

  test('117. SETTLE with ownership mismatch returns INTEGRITY_CONFLICT', async () => {
    const store = new FakeRecoveryStore();
    store.reservations.set('reservation-1', buildReservation());
    store.wallets.set('wallet-1', buildWallet({ userId: 'user-OTHER' }));
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(err.reservationId, 'reservation-1');
    assert.equal(err.recoveryRequired, true);
    assert.equal(err.message, 'AI billing reservation wallet ownership mismatch');
  });

  test('118. RELEASE with ownership mismatch returns INTEGRITY_CONFLICT', async () => {
    const store = new FakeRecoveryStore();
    store.reservations.set('reservation-1', buildReservation());
    store.wallets.set('wallet-1', buildWallet({ userId: 'user-OTHER' }));
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: releaseAction() },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(err.reservationId, 'reservation-1');
    assert.equal(err.recoveryRequired, true);
    assert.equal(err.message, 'AI billing reservation wallet ownership mismatch');
  });

  test('119. SETTLE ownership mismatch never calls settleForAmount', async () => {
    const store = new FakeRecoveryStore();
    store.reservations.set('reservation-1', buildReservation());
    store.wallets.set('wallet-1', buildWallet({ userId: 'user-OTHER' }));
    let settleCalled = false;
    const deps = buildDeps(store);
    deps.settleForAmount = async () => {
      settleCalled = true;
      throw new Error('must not be called');
    };
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        deps,
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(settleCalled, false);
  });

  test('120. SETTLE ownership mismatch never calls releaseReservation', async () => {
    const store = new FakeRecoveryStore();
    store.reservations.set('reservation-1', buildReservation());
    store.wallets.set('wallet-1', buildWallet({ userId: 'user-OTHER' }));
    let releaseCalled = false;
    const deps = buildDeps(store);
    deps.releaseReservation = async () => {
      releaseCalled = true;
      throw new Error('must not be called');
    };
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        deps,
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(releaseCalled, false);
  });

  test('121. RELEASE ownership mismatch never calls settleForAmount or releaseReservation', async () => {
    const store = new FakeRecoveryStore();
    store.reservations.set('reservation-1', buildReservation());
    store.wallets.set('wallet-1', buildWallet({ userId: 'user-OTHER' }));
    let settleCalled = false;
    let releaseCalled = false;
    const deps = buildDeps(store);
    deps.settleForAmount = async () => {
      settleCalled = true;
      throw new Error('must not be called');
    };
    deps.releaseReservation = async () => {
      releaseCalled = true;
      throw new Error('must not be called');
    };
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: releaseAction() },
        deps,
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(settleCalled, false);
    assert.equal(releaseCalled, false);
  });

  test('122. Missing wallet blocks SETTLE', async () => {
    const store = new FakeRecoveryStore();
    store.reservations.set('reservation-1', buildReservation());
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(err.reservationId, 'reservation-1');
    assert.equal(err.recoveryRequired, true);
    assert.equal(err.message, 'AI billing reservation references a missing wallet');
  });

  test('123. Missing wallet blocks RELEASE', async () => {
    const store = new FakeRecoveryStore();
    store.reservations.set('reservation-1', buildReservation());
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: releaseAction() },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(err.reservationId, 'reservation-1');
    assert.equal(err.recoveryRequired, true);
    assert.equal(err.message, 'AI billing reservation references a missing wallet');
  });

  test('124. Repository failure while verifying SETTLE ownership is sanitized', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    deps.repository = {
      ...deps.repository,
      findWalletById: async () => {
        throw new Error('Prisma P2025 raw internal message');
      },
    };
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        deps,
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(err.reservationId, 'reservation-1');
    assert.equal(err.recoveryRequired, true);
    assert.equal(err.message, 'AI billing reservation data could not be read reliably');
    assert.ok(!err.message.includes('Prisma'));
    assert.ok(!err.message.includes('P2025'));
    assert.ok(!err.message.includes('raw'));
  });

  test('125. Repository failure while verifying RELEASE ownership is sanitized', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    const deps = buildDeps(store);
    deps.repository = {
      ...deps.repository,
      findWalletById: async () => {
        throw new Error('Prisma P2025 raw internal message');
      },
    };
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: releaseAction() },
        deps,
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(err.reservationId, 'reservation-1');
    assert.equal(err.recoveryRequired, true);
    assert.equal(err.message, 'AI billing reservation data could not be read reliably');
    assert.ok(!err.message.includes('Prisma'));
    assert.ok(!err.message.includes('P2025'));
    assert.ok(!err.message.includes('raw'));
  });

  test('126. Ownership verification errors expose no Wallet data', async () => {
    const store = new FakeRecoveryStore();
    store.reservations.set('reservation-1', buildReservation());
    store.wallets.set('wallet-1', buildWallet({ userId: 'user-OTHER' }));
    const err = await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(2) },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.ok(!err.message.includes('user-OTHER'));
    assert.ok(!err.message.includes('tokenBalance'));
    assert.ok(!err.message.includes('reservedBalance'));
    assert.ok(!err.message.includes('ACTIVE'));
  });

  // ---------------------------------------------------------------------------
  // Current Usage-Based Metadata Contract Tests
  // ---------------------------------------------------------------------------

  test('UB-1. Current live usage-based metadata is classified VALID', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 100, metadata: usageBasedMetadata(100) }));
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'VALID');
    assert.equal(result.reasonCode, 'PENDING_REVIEW');
    assert.equal(result.automaticFinancialActionAllowed, false);
    assert.ok(!(result as Record<string, unknown>).quotedTokens, 'quotedTokens must not be present for usage-based metadata');
    assert.equal((result.observed as Record<string, unknown>)?.reservationTokens, 100);
    assert.equal((result.observed as Record<string, unknown>)?.requestedMode, 'USAGE_BASED');
  });

  test('UB-2. PENDING reservation with current live metadata can pass validation for confirmed SETTLE', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 50, metadata: usageBasedMetadata(50) }));
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(30) },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'SETTLED');
    assert.equal(result.financialMutationPerformed, true);
    assert.equal(result.actualTokens, 30);
    assert.equal(result.releasedTokens, 20);
    assert.equal(result.recoveryRequired, false);
  });

  test('UB-3. PENDING reservation with current live metadata can pass validation for confirmed RELEASE', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 50, metadata: usageBasedMetadata(50) }));
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: releaseAction() },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'RELEASED');
    assert.equal(result.financialMutationPerformed, true);
    assert.equal(result.recoveryRequired, false);
  });

  test('UB-4. Current metadata where reservationTokens != reservation.tokens is INVALID and SETTLE is rejected', async () => {
    const store = new FakeRecoveryStore();
    // reservation.tokens = 50, but metadata says reservationTokens = 99 (mismatch)
    seedReservation(store, buildReservation({ tokens: 50, metadata: usageBasedMetadata(99) }));
    const inspectResult = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(inspectResult.metadataStatus, 'INVALID');
    assert.equal(inspectResult.reasonCode, 'METADATA_INVALID');
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(40) },
        buildDeps(store),
      ),
      'METADATA_INVALID',
    );
  });

  test('UB-5. Usage-based metadata missing reservationTokens is INVALID', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({
      tokens: 50,
      metadata: {
        aiBilling: {
          schemaVersion: 1,
          requestedMode: 'USAGE_BASED',
          // reservationTokens intentionally omitted
          maxInputTokens: 12000,
          maxOutputTokens: 1200,
          rateCardVersion: 'rate-v1',
          walletPolicyVersion: 'policy-v1',
        },
      },
    }));
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'INVALID');
    assert.equal(result.reasonCode, 'METADATA_INVALID');
    const issueFields = result.metadataIssues.map((i) => i.field);
    assert.ok(issueFields.includes('aiBilling.reservationTokens'), 'must report reservationTokens missing');
  });

  test('UB-6. Existing legacy metadata (quotedTokens) remains VALID after fix', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 2, metadata: validMetadata(2) }));
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'VALID');
    assert.equal((result as Record<string, unknown>).quotedTokens, 2);
    assert.equal((result as Record<string, unknown>).requestedMode, 'PROVIDER_USAGE');
    assert.equal((result as Record<string, unknown>).quoteAppliedMode, 'PROVIDER_USAGE');
  });

  test('UB-7. Malformed legacy metadata (missing quotedTokens) remains INVALID after fix', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({
      tokens: 2,
      metadata: {
        aiBilling: {
          schemaVersion: 1,
          requestedMode: 'PROVIDER_USAGE',
          quoteAppliedMode: 'PROVIDER_USAGE',
          // quotedTokens intentionally omitted
          fixedFallbackTokens: 2,
          maxInputTokens: 12000,
          maxOutputTokens: 1200,
        },
      },
    }));
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.metadataStatus, 'INVALID');
    assert.equal(result.reasonCode, 'METADATA_INVALID');
    const issueFields = result.metadataIssues.map((i) => i.field);
    assert.ok(issueFields.includes('aiBilling.quotedTokens'), 'must report quotedTokens missing');
  });

  test('UB-8. Repeating a valid usage-based SETTLE is idempotent', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 50, metadata: usageBasedMetadata(50) }));
    const first = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(30) },
      buildDeps(store),
    );
    assert.equal(first.outcome, 'SETTLED');
    assert.equal(first.financialMutationPerformed, true);
    const second = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: settleAction(30) },
      buildDeps(store),
    );
    assert.equal(second.outcome, 'ALREADY_SETTLED');
    assert.equal(second.financialMutationPerformed, false);
    assert.equal(second.idempotentReplay, true);
    // Exactly one wallet write performed across both calls
    assert.equal(store.writes.filter((w) => w === 'settle').length, 2);
  });

  test('UB-9. automaticFinancialActionAllowed remains false for usage-based PENDING reservation', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 50, metadata: usageBasedMetadata(50) }));
    const result = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, buildDeps(store));
    assert.equal(result.automaticFinancialActionAllowed, false);
  });

  test('UB-10. SETTLE with actualTokens > reservedTokens is rejected even with valid usage-based metadata', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 50, metadata: usageBasedMetadata(50) }));
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: settleAction(51) },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
    // No financial mutation must have occurred
    assert.equal(store.writes.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Service source separation
// ---------------------------------------------------------------------------

const recoveryServiceSource = readFileSync(
  new URL('../src/services/ai-billing-recovery.service.ts', import.meta.url),
  'utf8',
);

describe('AI Billing Recovery service source', () => {
  test('127. Recovery service performs no direct Prisma call', () => {
    assert.ok(!recoveryServiceSource.includes('@prisma/client'));
    assert.ok(!/prisma\./.test(recoveryServiceSource));
  });

  test('128. Recovery service performs no direct HTTP or AI call', () => {
    assert.ok(!recoveryServiceSource.includes('node:http'));
    assert.ok(!recoveryServiceSource.includes('node:https'));
    assert.ok(!recoveryServiceSource.includes('fetch('));
    assert.ok(!recoveryServiceSource.includes('@google/generative-ai'));
    assert.ok(!recoveryServiceSource.includes('gemini'));
  });
});

describe('New Manual Billing Recovery Operations', () => {
  // --- MANUAL_RELEASE ---
  test('MANUAL_RELEASE: PENDING + INVALID metadata can be manually released', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ metadata: { broken: 'invalid' } }));
    seedWallet(store, buildWallet());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: manualReleaseAction(), actorId: 'admin-1' },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'RELEASED');
    assert.equal(result.financialMutationPerformed, true);
  });

  test('MANUAL_RELEASE: PENDING + MISSING metadata can be manually released', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ metadata: null }));
    seedWallet(store, buildWallet());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: manualReleaseAction(), actorId: 'admin-1' },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'RELEASED');
    assert.equal(result.financialMutationPerformed, true);
  });

  test('MANUAL_RELEASE: ownership mismatch blocks mutation', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ userId: 'user-1' }));
    seedWallet(store, buildWallet({ userId: 'user-2' }));
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: manualReleaseAction(), actorId: 'admin-1' },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
    assert.equal(store.writes.length, 0);
  });

  test('MANUAL_RELEASE: existing consume transaction blocks mutation', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    seedWallet(store, buildWallet());
    store.consumes.set('reservation-1', [buildConsume()]);
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: manualReleaseAction(), actorId: 'admin-1' },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
  });

  test('MANUAL_RELEASE: financial dependency failure does not produce a successful audit', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    seedWallet(store, buildWallet());
    const deps = buildDeps(store);
    deps.releaseReservation = async () => {
      throw new Error('Database connection failed during release');
    };
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: manualReleaseAction(), actorId: 'admin-1' },
        deps,
      ),
      'RELEASE_FAILED',
    );
    const actions = store.auditLogs.map((l) => l.action);
    assert.equal(actions.includes('AI_BILLING_RECOVERY_MANUAL_RELEASE'), false);
    assert.equal(actions.includes('AI_BILLING_RECOVERY_MANUAL_RELEASE_FAILED'), true);
  });

  test('MANUAL_RELEASE: successful action records actorId/reason/evidence', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    seedWallet(store, buildWallet());
    await recoverAIBillingReservation(
      {
        reservationId: 'reservation-1',
        action: manualReleaseAction({ reason: 'Admin verified log', evidenceReference: 'INC-99' }),
        actorId: 'admin-42',
      },
      buildDeps(store),
    );
    const releaseAudit = store.auditLogs.find((l) => l.action === 'AI_BILLING_RECOVERY_MANUAL_RELEASE');
    assert.ok(releaseAudit);
    assert.equal(releaseAudit?.actorId, 'admin-42');
    const meta = releaseAudit?.metadata as Record<string, unknown>;
    assert.equal(meta.reason, 'Admin verified log');
    assert.equal(meta.evidenceReference, 'INC-99');
  });

  test('MANUAL_RELEASE: replay behavior is safe and deterministic', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    seedWallet(store, buildWallet());
    const deps = buildDeps(store);
    const first = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: manualReleaseAction(), actorId: 'admin-1' },
      deps,
    );
    assert.equal(first.outcome, 'RELEASED');
    assert.equal(first.financialMutationPerformed, true);

    const second = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: manualReleaseAction(), actorId: 'admin-1' },
      deps,
    );
    assert.equal(second.outcome, 'ALREADY_RELEASED');
    assert.equal(second.financialMutationPerformed, false);
  });

  // --- MANUAL_SETTLE ---
  test('MANUAL_SETTLE: PENDING + INVALID metadata can settle confirmed actualTokens', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ metadata: { broken: true } }));
    seedWallet(store, buildWallet());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: manualSettleAction(2), actorId: 'admin-1' },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'SETTLED');
    assert.equal(result.financialMutationPerformed, true);
    assert.equal(result.actualTokens, 2);
  });

  test('MANUAL_SETTLE: PENDING + MISSING metadata can settle', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ metadata: null }));
    seedWallet(store, buildWallet());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: manualSettleAction(2), actorId: 'admin-1' },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'SETTLED');
    assert.equal(result.financialMutationPerformed, true);
    assert.equal(result.actualTokens, 2);
  });

  test('MANUAL_SETTLE: actualTokens > reservation.tokens is rejected', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 2 }));
    seedWallet(store, buildWallet());
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: manualSettleAction(5), actorId: 'admin-1' },
        buildDeps(store),
      ),
      'INVALID_INPUT',
    );
  });

  test('MANUAL_SETTLE: actualTokens = 0 is supported if schema allows it', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 2 }));
    seedWallet(store, buildWallet());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: manualSettleAction(0), actorId: 'admin-1' },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'SETTLED');
    assert.equal(result.actualTokens, 0);
  });

  test('MANUAL_SETTLE: existing consume transaction blocks unsafe mutation', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 5 }));
    seedWallet(store, buildWallet());
    store.consumes.set('reservation-1', [buildConsume({ tokens: 5 })]);
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: manualSettleAction(3), actorId: 'admin-1' },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
  });

  test('MANUAL_SETTLE: ownership mismatch blocks mutation', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ userId: 'user-1' }));
    seedWallet(store, buildWallet({ userId: 'user-2' }));
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: manualSettleAction(2), actorId: 'admin-1' },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
  });

  test('MANUAL_SETTLE: successful action records actualTokens + actorId + reason', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    seedWallet(store, buildWallet());
    await recoverAIBillingReservation(
      {
        reservationId: 'reservation-1',
        action: manualSettleAction(2, { reason: 'Verified manually', evidenceReference: 'INC-100' }),
        actorId: 'admin-77',
      },
      buildDeps(store),
    );
    const settleAudit = store.auditLogs.find((l) => l.action === 'AI_BILLING_RECOVERY_MANUAL_SETTLE');
    assert.ok(settleAudit);
    assert.equal(settleAudit?.actorId, 'admin-77');
    const meta = settleAudit?.metadata as Record<string, unknown>;
    assert.equal(meta.actualTokens, 2);
    assert.equal(meta.reason, 'Verified manually');
    assert.equal(meta.evidenceReference, 'INC-100');
  });

  test('MANUAL_SETTLE: replay behavior is safe and deterministic', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ tokens: 5 }));
    seedWallet(store, buildWallet());
    const deps = buildDeps(store);
    const first = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: manualSettleAction(2), actorId: 'admin-1' },
      deps,
    );
    assert.equal(first.outcome, 'SETTLED');
    assert.equal(first.financialMutationPerformed, true);

    const second = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: manualSettleAction(2), actorId: 'admin-1' },
      deps,
    );
    assert.equal(second.outcome, 'ALREADY_SETTLED');
    assert.equal(second.financialMutationPerformed, false);
  });

  // --- REVIEW ---
  test('REVIEW: performs ZERO financial mutation', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    seedWallet(store, buildWallet());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: reviewAction(), actorId: 'admin-1' },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'REVIEW_REQUIRED');
    assert.equal(result.financialMutationPerformed, false);
    assert.equal(store.writes.length, 0);
  });

  test('REVIEW: persists actorId, reason, evidenceReference and timestamp', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    seedWallet(store, buildWallet());
    await recoverAIBillingReservation(
      {
        reservationId: 'reservation-1',
        action: { type: 'REVIEW', reason: 'Checking logs', evidenceReference: 'REF-55' },
        actorId: 'admin-99',
      },
      buildDeps(store),
    );
    const reviewAudit = store.auditLogs.find((l) => l.action === 'AI_BILLING_RECOVERY_REVIEW');
    assert.ok(reviewAudit);
    assert.equal(reviewAudit?.actorId, 'admin-99');
    const meta = reviewAudit?.metadata as Record<string, unknown>;
    assert.equal(meta.reason, 'Checking logs');
    assert.equal(meta.evidenceReference, 'REF-55');
  });

  test('REVIEW: only unresolved PENDING reservation can enter UNDER_REVIEW', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ status: TokenReservationStatus.PENDING }));
    seedWallet(store, buildWallet());
    const result = await recoverAIBillingReservation(
      { reservationId: 'reservation-1', action: reviewAction(), actorId: 'admin-1' },
      buildDeps(store),
    );
    assert.equal(result.outcome, 'REVIEW_REQUIRED');
  });

  test('REVIEW: completed/released reservations must not become UNDER_REVIEW', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation({ status: TokenReservationStatus.COMPLETED }));
    seedWallet(store, buildWallet());
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: reviewAction(), actorId: 'admin-1' },
        buildDeps(store),
      ),
      'INTEGRITY_CONFLICT',
    );
  });

  test('REVIEW: audit persistence failure must NOT be reported as successful persistence', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    seedWallet(store, buildWallet());
    const deps = buildDeps(store);
    deps.repository.recordAuditLog = async () => {
      throw new Error('Audit database down');
    };
    await expectRecoveryError(
      recoverAIBillingReservation(
        { reservationId: 'reservation-1', action: reviewAction(), actorId: 'admin-1' },
        deps,
      ),
      'INTEGRITY_CONFLICT',
    );
  });

  test('REVIEW: inspection returns persisted UNDER_REVIEW state', async () => {
    const store = new FakeRecoveryStore();
    seedReservation(store, buildReservation());
    seedWallet(store, buildWallet());
    const deps = buildDeps(store);
    await recoverAIBillingReservation(
      {
        reservationId: 'reservation-1',
        action: { type: 'REVIEW', reason: 'Under investigation', evidenceReference: 'EVID-1' },
        actorId: 'admin-12',
      },
      deps,
    );

    const inspection = await inspectAIBillingRecovery({ reservationId: 'reservation-1' }, deps);
    assert.ok(inspection.review);
    assert.equal(inspection.review?.status, 'UNDER_REVIEW');
    assert.equal(inspection.review?.reviewedBy, 'admin-12');
    assert.equal(inspection.review?.reason, 'Under investigation');
    assert.equal(inspection.review?.evidenceReference, 'EVID-1');
  });
});

// ---------------------------------------------------------------------------
// Database integration tests
// ---------------------------------------------------------------------------

describe('AI Billing Recovery DB Integration', () => {
  before(async () => {
    USER_ROLE_ID = (await ensureUserRole()).id;
    await cleanupSuiteData();
  });

  after(async () => {
    try {
      await cleanupSuiteData();
    } finally {
      await prisma.$disconnect();
    }
  });

  async function cleanupSuiteData(): Promise<void> {
    const emailFilter = { email: { startsWith: 'test_recovery_' } };
    await prisma.tokenReservationFundingAllocation.deleteMany({
      where: { reservation: { user: emailFilter } },
    });
    await prisma.tokenFundingLot.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenReservation.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenTransaction.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenWallet.deleteMany({ where: { user: emailFilter } });
    await prisma.user.deleteMany({ where: emailFilter });
  }

  async function cleanupUser(userId: string): Promise<void> {
    await prisma.tokenReservationFundingAllocation.deleteMany({
      where: { reservation: { userId } },
    });
    await prisma.tokenFundingLot.deleteMany({ where: { userId } });
    await prisma.tokenReservation.deleteMany({ where: { userId } });
    await prisma.tokenTransaction.deleteMany({ where: { userId } });
    await prisma.tokenWallet.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  async function createUserWithWallet(
    balance: number,
  ): Promise<{ userId: string; walletId: string }> {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_recovery_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Recovery Test User',
        gender: Gender.MALE,
        nationality: 'Egyptian',
      },
    });
    const wallet = await prisma.tokenWallet.create({
      data: {
        userId: user.id,
        tokenBalance: balance,
        reservedBalance: 0,
        status: WalletStatus.ACTIVE,
      },
    });
    if (balance > 0) {
      const grant = await prisma.tokenTransaction.create({
        data: {
          walletId: wallet.id,
          userId: user.id,
          type: 'GRANT',
          tokens: balance,
          source: TokenTransactionSource.PURCHASE,
          referenceId: `test-grant-${crypto.randomUUID()}`,
        },
      });
      await prisma.tokenFundingLot.create({
        data: {
          walletId: wallet.id,
          userId: user.id,
          source: TokenTransactionSource.PURCHASE,
          sourceTransactionId: grant.id,
          originalTokens: balance,
          availableTokens: balance,
          reservedTokens: 0,
          consumedTokens: 0,
        },
      });
    }
    return { userId: user.id, walletId: wallet.id };
  }

  test('129. Real inspection of a Step 8 style reservation exposes the sanitized summary', async () => {
    const { userId, walletId } = await createUserWithWallet(100);
    try {
      const reserved = await reserveBusinessTokensForAmount({
        userId,
        feature: 'AI_CHAT_QUERY',
        source: 'CHAT',
        tokens: 2,
        idempotencyKey: crypto.randomUUID(),
        metadata: validMetadata(2) as object,
      });
      const deps = createDefaultAIBillingRecoveryDependencies();
      const result = await inspectAIBillingRecovery(
        { reservationId: reserved.reservationId },
        deps,
      );
      assert.equal(result.reservationStatus, TokenReservationStatus.PENDING);
      assert.equal(result.metadataStatus, 'VALID');
      assert.equal(result.recommendation, 'REVIEW');
      assert.equal(result.recoveryRequired, true);
      assert.equal(result.automaticFinancialActionAllowed, false);
      assert.equal(result.reservedTokens, 2);
      assert.equal(result.userId, userId);
      assert.equal(result.walletId, walletId);
      assert.equal(result.referenceId, reserved.referenceId);
      assert.equal(result.quotedTokens, 2);
      assert.equal(result.provider, 'fake-provider');
      assert.equal(result.model, 'fake-model');
    } finally {
      await cleanupUser(userId);
    }
  });

  test('130. Real SETTLE recovery is idempotent across calls', async () => {
    const { userId } = await createUserWithWallet(100);
    try {
      const reserved = await reserveBusinessTokensForAmount({
        userId,
        feature: 'AI_CHAT_QUERY',
        source: 'CHAT',
        tokens: 2,
        idempotencyKey: crypto.randomUUID(),
        metadata: validMetadata(2) as object,
      });
      const deps = createDefaultAIBillingRecoveryDependencies();
      const first = await recoverAIBillingReservation(
        { reservationId: reserved.reservationId, action: settleAction(2) },
        deps,
      );
      assert.equal(first.outcome, 'SETTLED');
      assert.equal(first.financialMutationPerformed, true);
      const second = await recoverAIBillingReservation(
        { reservationId: reserved.reservationId, action: settleAction(2) },
        deps,
      );
      assert.equal(second.outcome, 'ALREADY_SETTLED');
      assert.equal(second.financialMutationPerformed, false);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('131. Real RELEASE recovery is idempotent across calls', async () => {
    const { userId } = await createUserWithWallet(100);
    try {
      const reserved = await reserveBusinessTokensForAmount({
        userId,
        feature: 'AI_CHAT_QUERY',
        source: 'CHAT',
        tokens: 2,
        idempotencyKey: crypto.randomUUID(),
        metadata: validMetadata(2) as object,
      });
      const deps = createDefaultAIBillingRecoveryDependencies();
      const first = await recoverAIBillingReservation(
        { reservationId: reserved.reservationId, action: releaseAction() },
        deps,
      );
      assert.equal(first.outcome, 'RELEASED');
      assert.equal(first.financialMutationPerformed, true);
      const second = await recoverAIBillingReservation(
        { reservationId: reserved.reservationId, action: releaseAction() },
        deps,
      );
      assert.equal(second.outcome, 'ALREADY_RELEASED');
      assert.equal(second.financialMutationPerformed, false);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('132. Real reconciliation matches before and after a real settle', async () => {
    const { userId, walletId } = await createUserWithWallet(100);
    try {
      const first = await reserveBusinessTokensForAmount({
        userId,
        feature: 'AI_CHAT_QUERY',
        source: 'CHAT',
        tokens: 5,
        idempotencyKey: crypto.randomUUID(),
        metadata: validMetadata(5) as object,
      });
      await reserveBusinessTokensForAmount({
        userId,
        feature: 'AI_CHAT_QUERY',
        source: 'CHAT',
        tokens: 3,
        idempotencyKey: crypto.randomUUID(),
        metadata: validMetadata(3) as object,
      });
      const deps = createDefaultAIBillingRecoveryDependencies();
      const before = await reconcileWalletReservations({ walletId }, deps);
      assert.equal(before.status, 'MATCH');
      assert.equal(before.recoveryRequired, false);
      assert.equal(before.userId, userId);
      assert.equal(before.actualReservedBalance, 8);
      assert.equal(before.expectedPendingReservedTokens, 8);
      assert.equal(before.pendingReservationCount, 2);

      await recoverAIBillingReservation(
        { reservationId: first.reservationId, action: settleAction(5) },
        deps,
      );

      const after = await reconcileWalletReservations({ walletId }, deps);
      assert.equal(after.status, 'MATCH');
      assert.equal(after.actualReservedBalance, 3);
      assert.equal(after.expectedPendingReservedTokens, 3);
      assert.equal(after.pendingReservationCount, 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('133. Real reconciliation detects reserved balance drift', async () => {
    const { userId, walletId } = await createUserWithWallet(100);
    try {
      await reserveBusinessTokensForAmount({
        userId,
        feature: 'AI_CHAT_QUERY',
        source: 'CHAT',
        tokens: 5,
        idempotencyKey: crypto.randomUUID(),
        metadata: validMetadata(5) as object,
      });
      await prisma.tokenWallet.update({
        where: { id: walletId },
        data: { reservedBalance: { decrement: 2 } },
      });
      const deps = createDefaultAIBillingRecoveryDependencies();
      const result = await reconcileWalletReservations({ walletId }, deps);
      assert.equal(result.status, 'MISMATCH');
      assert.equal(result.recoveryRequired, true);
      assert.equal(result.difference, -2);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('134. Real SETTLE vs RELEASE concurrency resolves exactly one way', async () => {
    const { userId } = await createUserWithWallet(100);
    try {
      const reserved = await reserveBusinessTokensForAmount({
        userId,
        feature: 'AI_CHAT_QUERY',
        source: 'CHAT',
        tokens: 2,
        idempotencyKey: crypto.randomUUID(),
        metadata: validMetadata(2) as object,
      });
      const deps = createDefaultAIBillingRecoveryDependencies();
      const results = await Promise.allSettled([
        recoverAIBillingReservation(
          { reservationId: reserved.reservationId, action: settleAction(2) },
          deps,
        ),
        recoverAIBillingReservation(
          { reservationId: reserved.reservationId, action: releaseAction() },
          deps,
        ),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      const fulfilledResult = fulfilled[0] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof recoverAIBillingReservation>>
      >;
      assert.equal(fulfilledResult.value.financialMutationPerformed, true);
      const rejection = rejected[0] as PromiseRejectedResult;
      assert.ok(rejection.reason instanceof AIBillingRecoveryError);
      assert.equal((rejection.reason as AIBillingRecoveryError).code, 'INTEGRITY_CONFLICT');

      const finalReservation = await prisma.tokenReservation.findUnique({
        where: { id: reserved.reservationId },
      });
      assert.ok(finalReservation);
      assert.ok(
        finalReservation.status === TokenReservationStatus.COMPLETED ||
          finalReservation.status === TokenReservationStatus.RELEASED,
      );
      const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
      assert.ok(wallet);
      assert.equal(wallet.reservedBalance, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('135. Real recovery refuses non-Step-8 reservations with METADATA_INVALID', async () => {
    const { userId } = await createUserWithWallet(100);
    try {
      const reserved = await reserveBusinessTokensForAmount({
        userId,
        feature: 'AI_CHAT_QUERY',
        source: 'CHAT',
        tokens: 2,
        idempotencyKey: crypto.randomUUID(),
      });
      const deps = createDefaultAIBillingRecoveryDependencies();
      await assert.rejects(
        recoverAIBillingReservation(
          { reservationId: reserved.reservationId, action: settleAction(2) },
          deps,
        ),
        (err: unknown) => {
          assert.ok(err instanceof AIBillingRecoveryError);
          assert.equal(err.code, 'METADATA_INVALID');
          return true;
        },
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('136. Real recovery rejects a confirmed amount above the reservation', async () => {
    const { userId } = await createUserWithWallet(100);
    try {
      const reserved = await reserveBusinessTokensForAmount({
        userId,
        feature: 'AI_CHAT_QUERY',
        source: 'CHAT',
        tokens: 2,
        idempotencyKey: crypto.randomUUID(),
        metadata: validMetadata(2) as object,
      });
      const deps = createDefaultAIBillingRecoveryDependencies();
      await assert.rejects(
        recoverAIBillingReservation(
          { reservationId: reserved.reservationId, action: settleAction(3) },
          deps,
        ),
        (err: unknown) => {
          assert.ok(err instanceof AIBillingRecoveryError);
          assert.equal(err.code, 'INVALID_INPUT');
          return true;
        },
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('137. Real expired PENDING reservation still recommends REVIEW', async () => {
    const { userId } = await createUserWithWallet(100);
    try {
      const reserved = await reserveBusinessTokensForAmount({
        userId,
        feature: 'AI_CHAT_QUERY',
        source: 'CHAT',
        tokens: 2,
        idempotencyKey: crypto.randomUUID(),
        metadata: validMetadata(2) as object,
      });
      await prisma.tokenReservation.update({
        where: { id: reserved.reservationId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const deps = createDefaultAIBillingRecoveryDependencies();
      const result = await inspectAIBillingRecovery(
        { reservationId: reserved.reservationId },
        deps,
      );
      assert.equal(result.isExpired, true);
      assert.equal(result.recommendation, 'REVIEW');
      assert.equal(result.recoveryRequired, true);
      assert.equal(result.automaticFinancialActionAllowed, false);
    } finally {
      await cleanupUser(userId);
    }
  });
});
