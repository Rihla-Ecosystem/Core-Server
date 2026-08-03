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
import {
  AIBillingOperationFailureKind,
  AIBillingOperationStatus,
  Gender,
  TokenReservationStatus,
  TokenTransactionSource,
  WalletStatus,
} from '@prisma/client';
import { prisma } from '../src/config/prisma.js';
import {
  AIBillingOperationError,
  createAIBillingOperation,
  createDefaultAIBillingOperationDependencies,
  getAIBillingOperationByOperationId,
  getAIBillingOperationByReservationId,
  markAIBillingOperationForReview,
  markAIBillingOperationReleased,
  markAIBillingOperationSettled,
  recordAIBillingOperationExecutionSuccess,
  recordAIBillingOperationFailure,
  recordAIBillingOperationPricing,
} from '../src/services/ai-billing-operation.service.js';
import type { AIBillingOperationDependencies } from '../src/services/ai-billing-operation.service.js';
import type { AIBillingOperationErrorCode } from '../src/types/ai-billing-operation.js';
import type { RecordAIBillingOperationFailureInputFailure } from '../src/types/ai-billing-operation.js';
import type {
  AIBillingOperationRepository,
  AIBillingOperationReservationRow,
  AIBillingOperationRow,
  AIBillingOperationWalletRow,
} from '../src/repositories/ai-billing-operation.repository.js';
import type { AIExecutionIdentity } from '../src/types/ai-execution.js';
import type { AIProviderUsage } from '../src/types/ai.js';
import type { AIUsagePricingResult } from '../src/types/ai-pricing.js';
import type {
  ReleaseBusinessTokenReservationResult,
  SettleBusinessTokenReservationResult,
} from '../src/services/token-reservation.service.js';
import {
  releaseBusinessTokenReservation,
  reserveBusinessTokensForAmount,
  settleBusinessTokenReservationForAmount,
} from '../src/services/token-reservation.service.js';

const OPERATION_ID = 'operation-external-1';

function buildReservation(
  overrides: Partial<AIBillingOperationReservationRow> = {},
): AIBillingOperationReservationRow {
  return {
    id: 'reservation-1',
    walletId: 'wallet-1',
    userId: 'user-1',
    feature: 'AI_CHAT_QUERY',
    source: TokenTransactionSource.CHAT,
    tokens: 10,
    pricingVersion: 1,
    status: TokenReservationStatus.PENDING,
    referenceId: 'user-1:AI_CHAT_QUERY:key-1',
    ...overrides,
  };
}

function buildWallet(overrides: Partial<AIBillingOperationWalletRow> = {}): AIBillingOperationWalletRow {
  return {
    id: 'wallet-1',
    userId: 'user-1',
    ...overrides,
  };
}

function buildOperation(
  overrides: Partial<AIBillingOperationRow> = {},
): AIBillingOperationRow {
  return {
    id: 'operation-internal-1',
    operationId: OPERATION_ID,
    reservationId: 'reservation-1',
    walletId: 'wallet-1',
    userId: 'user-1',
    feature: 'AI_CHAT_QUERY',
    source: TokenTransactionSource.CHAT,
    status: AIBillingOperationStatus.RESERVED,
    reservedTokens: 10,
    reservationPricingVersion: 1,
    requestedProvider: null,
    requestedModel: null,
    actualProvider: null,
    actualModel: null,
    providerRequestId: null,
    providerRequestSent: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cached: null,
    audioSeconds: null,
    pricingMode: null,
    pricingFallbackReason: null,
    actualWalletTokens: null,
    billingCurrency: null,
    rateCardVersion: null,
    walletPolicyVersion: null,
    failureKind: null,
    failureCode: null,
    retryable: null,
    reviewReasonCode: null,
    consumeTransactionId: null,
    executedAt: null,
    pricedAt: null,
    failedAt: null,
    reviewedAt: null,
    settledAt: null,
    releasedAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildExecution(
  overrides: Partial<AIExecutionIdentity> = {},
): AIExecutionIdentity {
  return {
    provider: 'fake-provider',
    model: 'fake-model',
    providerRequestId: 'req-1',
    ...overrides,
  };
}

function buildUsage(
  overrides: Partial<AIProviderUsage> = {},
): AIProviderUsage {
  return {
    provider: 'fake-provider',
    model: 'fake-model',
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    cached: false,
    audioSeconds: 0.5,
    ...overrides,
  };
}

function buildPricing(
  overrides: Partial<AIUsagePricingResult> = {},
): AIUsagePricingResult {
  return {
    feature: 'AI_CHAT_QUERY',
    requestedMode: 'PROVIDER_USAGE',
    appliedMode: 'PROVIDER_USAGE',
    walletTokens: 5,
    fixedFallbackTokens: 0,
    provider: 'fake-provider',
    model: 'fake-model',
    billingCurrency: 'USD',
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    cached: false,
    audioSeconds: 0.5,
    rateCardVersion: 'rate-v1',
    walletPolicyVersion: 'policy-v1',
    ...overrides,
  };
}

function buildSettlement(
  overrides: Partial<SettleBusinessTokenReservationResult> = {},
): SettleBusinessTokenReservationResult {
  return {
    reservationId: 'reservation-1',
    referenceId: 'user-1:AI_CHAT_QUERY:key-1',
    walletId: 'wallet-1',
    userId: 'user-1',
    feature: 'AI_CHAT_QUERY',
    source: TokenTransactionSource.CHAT,
    tokens: 10,
    actualTokens: 5,
    releasedTokens: 5,
    pricingVersion: 1,
    status: TokenReservationStatus.COMPLETED,
    settledAt: new Date('2026-08-02T00:00:00.000Z'),
    consumeTransactionId: 'consume-1',
    idempotentReplay: false,
    ...overrides,
  };
}

function buildRelease(
  overrides: Partial<ReleaseBusinessTokenReservationResult> = {},
): ReleaseBusinessTokenReservationResult {
  return {
    reservationId: 'reservation-1',
    referenceId: 'user-1:AI_CHAT_QUERY:key-1',
    walletId: 'wallet-1',
    userId: 'user-1',
    feature: 'AI_CHAT_QUERY',
    source: TokenTransactionSource.CHAT,
    tokens: 10,
    pricingVersion: 1,
    status: TokenReservationStatus.RELEASED,
    releasedAt: new Date('2026-08-02T00:00:00.000Z'),
    releaseReason: 'confirmed non-billable',
    idempotentReplay: false,
    ...overrides,
  };
}

function buildNonBillableFailure(
  overrides: Partial<RecordAIBillingOperationFailureInputFailure> = {},
): RecordAIBillingOperationFailureInputFailure {
  return {
    kind: 'NON_BILLABLE_FAILURE',
    code: 'E_CANCELLED',
    message: 'cancelled before the provider request was sent',
    providerRequestSent: false,
    retryable: false,
    ...overrides,
  } as RecordAIBillingOperationFailureInputFailure;
}

function buildIndeterminateFailure(
  overrides: Partial<RecordAIBillingOperationFailureInputFailure> = {},
): RecordAIBillingOperationFailureInputFailure {
  return {
    kind: 'INDETERMINATE_FAILURE',
    code: 'E_TIMEOUT',
    message: 'provider request timed out',
    providerRequestSent: true,
    retryable: true,
    execution: { provider: 'fake-provider' },
    ...overrides,
  } as RecordAIBillingOperationFailureInputFailure;
}

function asExecution(value: unknown): AIExecutionIdentity {
  return value as AIExecutionIdentity;
}

function asUsage(value: unknown): AIProviderUsage {
  return value as AIProviderUsage;
}

function asPricing(value: unknown): AIUsagePricingResult {
  return value as AIUsagePricingResult;
}

function asSettlement(value: unknown): SettleBusinessTokenReservationResult {
  return value as SettleBusinessTokenReservationResult;
}

function asRelease(value: unknown): ReleaseBusinessTokenReservationResult {
  return value as ReleaseBusinessTokenReservationResult;
}

function asFailure(value: unknown): RecordAIBillingOperationFailureInputFailure {
  return value as RecordAIBillingOperationFailureInputFailure;
}

class FakeOperationStore {
  reservations = new Map<string, AIBillingOperationReservationRow>();
  wallets = new Map<string, AIBillingOperationWalletRow>();
  operations = new Map<string, AIBillingOperationRow>();
  reads: string[] = [];
  writes: string[] = [];
  throwOnReadReservation = false;
  throwOnReadOperation = false;
  throwOnReadWallet = false;
  throwOnCreate = false;
  throwOnTransition = false;
  simulateRaceOnCreate = false;
  simulateRaceOnCreateDifferentOperationId = false;
  transitionReturnsFalse = false;

  addReservation(row: AIBillingOperationReservationRow): void {
    this.reservations.set(row.id, row);
  }

  addWallet(row: AIBillingOperationWalletRow): void {
    this.wallets.set(row.id, row);
  }

  addOperation(row: AIBillingOperationRow): void {
    this.operations.set(row.id, row);
  }

  findOperationByOperationId(operationId: string): AIBillingOperationRow | undefined {
    for (const op of this.operations.values()) {
      if (op.operationId === operationId) return op;
    }
    return undefined;
  }

  findOperationByReservationId(reservationId: string): AIBillingOperationRow | undefined {
    for (const op of this.operations.values()) {
      if (op.reservationId === reservationId) return op;
    }
    return undefined;
  }

  deps(): AIBillingOperationDependencies {
    const store = this;
    const repository: AIBillingOperationRepository = {
      async findReservationById(reservationId) {
        store.reads.push(`reservation:${reservationId}`);
        if (store.throwOnReadReservation) throw new Error('db down');
        return store.reservations.get(reservationId) ?? null;
      },

      async findWalletById(walletId) {
        store.reads.push(`wallet:${walletId}`);
        if (store.throwOnReadWallet) throw new Error('db down');
        return store.wallets.get(walletId) ?? null;
      },

      async findOperationByOperationId(operationId) {
        store.reads.push(`operationByOperationId:${operationId}`);
        if (store.throwOnReadOperation) throw new Error('db down');
        return store.findOperationByOperationId(operationId) ?? null;
      },

      async findOperationByReservationId(reservationId) {
        store.reads.push(`operationByReservation:${reservationId}`);
        if (store.throwOnReadOperation) throw new Error('db down');
        return store.findOperationByReservationId(reservationId) ?? null;
      },

      async createOperation(input) {
        store.writes.push(`create:${input.operationId}`);
        if (store.throwOnCreate) throw new Error('db down');
        const existing = store.findOperationByOperationId(input.operationId)
          ?? store.findOperationByReservationId(input.reservationId);
        if (existing) {
          const err = new Error('unique violation') as Error & { code: string };
          err.code = 'P2002';
          throw err;
        }
        if (store.simulateRaceOnCreate) {
          const raced = buildOperation({
            id: `operation-internal-raced`,
            operationId: input.operationId,
            reservationId: input.reservationId,
            walletId: input.walletId,
            userId: input.userId,
            feature: input.feature,
            source: input.source,
            reservedTokens: input.reservedTokens,
            reservationPricingVersion: input.reservationPricingVersion,
            requestedProvider: input.requestedProvider,
            requestedModel: input.requestedModel,
          });
          store.operations.set(raced.id, raced);
          const err = new Error('unique violation') as Error & { code: string };
          err.code = 'P2002';
          throw err;
        }
        if (store.simulateRaceOnCreateDifferentOperationId) {
          const raced = buildOperation({
            id: `operation-internal-raced-different`,
            operationId: 'operation-external-raced',
            reservationId: input.reservationId,
            walletId: input.walletId,
            userId: input.userId,
            feature: input.feature,
            source: input.source,
            reservedTokens: input.reservedTokens,
            reservationPricingVersion: input.reservationPricingVersion,
            requestedProvider: input.requestedProvider,
            requestedModel: input.requestedModel,
          });
          store.operations.set(raced.id, raced);
          const err = new Error('unique violation') as Error & { code: string };
          err.code = 'P2002';
          throw err;
        }
        const row = buildOperation({
          id: `operation-internal-${store.operations.size + 1}`,
          operationId: input.operationId,
          reservationId: input.reservationId,
          walletId: input.walletId,
          userId: input.userId,
          feature: input.feature,
          source: input.source,
          reservedTokens: input.reservedTokens,
          reservationPricingVersion: input.reservationPricingVersion,
          requestedProvider: input.requestedProvider,
          requestedModel: input.requestedModel,
        });
        store.operations.set(row.id, row);
        return row;
      },

      async transitionOperation(input) {
        store.writes.push(`transition:${input.operationId}:${input.target}`);
        if (store.throwOnTransition) throw new Error('db down');
        const op = store.findOperationByOperationId(input.operationId);
        if (!op) return false;
        if (!input.allowedFrom.includes(op.status)) return false;
        const updated = buildOperation({
          ...op,
          ...input.set,
          status: input.target,
          updatedAt: new Date('2026-08-02T00:00:00.000Z'),
        });
        store.operations.set(op.id, updated);
        if (store.transitionReturnsFalse) return false;
        return true;
      },
    };
    return { repository };
  }
}

async function expectOpError(
  promise: Promise<unknown>,
  code: AIBillingOperationErrorCode,
  message: string,
): Promise<AIBillingOperationError> {
  let captured: AIBillingOperationError | undefined;
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(
      err instanceof AIBillingOperationError,
      `expected AIBillingOperationError, got ${(err as Error)?.message}`,
    );
    assert.equal((err as AIBillingOperationError).code, code);
    assert.equal((err as AIBillingOperationError).message, message);
    captured = err as AIBillingOperationError;
    return true;
  });
  return captured as AIBillingOperationError;
}

function executedOperation(overrides: Partial<AIBillingOperationRow> = {}): AIBillingOperationRow {
  return buildOperation({
    status: AIBillingOperationStatus.EXECUTION_SUCCEEDED,
    actualProvider: 'fake-provider',
    actualModel: 'fake-model',
    providerRequestId: 'req-1',
    providerRequestSent: null,
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    cached: false,
    audioSeconds: 0.5,
    executedAt: new Date('2026-08-02T00:00:00.000Z'),
    ...overrides,
  });
}

function pricedOperation(actualWalletTokens = 5): AIBillingOperationRow {
  return buildOperation({
    ...executedOperation(),
    status: AIBillingOperationStatus.PRICED,
    pricingMode: 'PROVIDER_USAGE',
    pricingFallbackReason: null,
    actualWalletTokens,
    billingCurrency: 'USD',
    rateCardVersion: 'rate-v1',
    walletPolicyVersion: 'policy-v1',
    pricedAt: new Date('2026-08-02T00:00:00.000Z'),
  });
}

describe('AI Billing Operation Service', () => {
  // ---------------------------------------------------------------------------
  // Create operation
  // ---------------------------------------------------------------------------
  describe('createAIBillingOperation', () => {
    test('1. rejects a missing operationId', async () => {
      const store = new FakeOperationStore();
      await expectOpError(
        createAIBillingOperation({ operationId: '', reservationId: 'reservation-1' }, store.deps()),
        'INVALID_INPUT',
        'operationId must not be empty',
      );
    });

    test('2. rejects a missing reservationId', async () => {
      const store = new FakeOperationStore();
      await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: '' }, store.deps()),
        'INVALID_INPUT',
        'reservationId must not be empty',
      );
    });

    test('3. rejects a requested provider without a requested model', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      await expectOpError(
        createAIBillingOperation(
          { operationId: OPERATION_ID, reservationId: 'reservation-1', requestedProvider: 'p' },
          store.deps(),
        ),
        'INVALID_INPUT',
        'requestedProvider and requestedModel must be provided together',
      );
    });

    test('4. rejects an empty requested provider', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      await expectOpError(
        createAIBillingOperation(
          {
            operationId: OPERATION_ID,
            reservationId: 'reservation-1',
            requestedProvider: '  ',
            requestedModel: 'm',
          },
          store.deps(),
        ),
        'INVALID_INPUT',
        'requestedProvider must be a non-empty string when present',
      );
    });

    test('5. throws RESERVATION_NOT_FOUND when the reservation is missing', async () => {
      const store = new FakeOperationStore();
      await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'RESERVATION_NOT_FOUND',
        'AI billing reservation not found',
      );
    });

    test('6. throws RESERVATION_NOT_PENDING when the reservation is COMPLETED', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation({ status: TokenReservationStatus.COMPLETED }));
      store.addWallet(buildWallet());
      await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'RESERVATION_NOT_PENDING',
        'AI billing reservation is not pending',
      );
    });

    test('7. throws RESERVATION_NOT_PENDING when the reservation is RELEASED', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation({ status: TokenReservationStatus.RELEASED }));
      store.addWallet(buildWallet());
      await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'RESERVATION_NOT_PENDING',
        'AI billing reservation is not pending',
      );
    });

    test('8. throws INTEGRITY_CONFLICT with recoveryRequired when the wallet is missing', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      const err = await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'INTEGRITY_CONFLICT',
        'AI billing wallet could not be verified for this reservation',
      );
      assert.equal(err.recoveryRequired, true);
      assert.equal(err.operationId, OPERATION_ID);
      assert.equal(err.reservationId, 'reservation-1');
      assert.equal(store.operations.size, 0);
      assert.equal(/wallet-1|user-1|db down|Prisma/i.test(err.message), false);
    });

    test('9. throws INTEGRITY_CONFLICT with recoveryRequired when the wallet does not own the reservation', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet({ userId: 'user-other' }));
      const err = await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'INTEGRITY_CONFLICT',
        'AI billing wallet ownership could not be verified for this reservation',
      );
      assert.equal(err.recoveryRequired, true);
      assert.equal(store.operations.size, 0);
      assert.equal(/wallet-1|user-1|user-other|db down|Prisma/i.test(err.message), false);
    });

    test('9a. throws INTEGRITY_CONFLICT with recoveryRequired when the wallet read fails', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      store.throwOnReadWallet = true;
      const err = await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'INTEGRITY_CONFLICT',
        'AI billing wallet data could not be read reliably',
      );
      assert.equal(err.recoveryRequired, true);
      assert.equal(err.operationId, OPERATION_ID);
      assert.equal(store.operations.size, 0);
      assert.equal(/wallet-1|user-1|db down|Prisma/i.test(err.message), false);
    });

    test('10. creates a RESERVED operation copying the immutable reservation snapshot', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation({ tokens: 10, pricingVersion: 1 }));
      store.addWallet(buildWallet());
      const result = await createAIBillingOperation(
        { operationId: OPERATION_ID, reservationId: 'reservation-1' },
        store.deps(),
      );
      assert.equal(result.operationId, OPERATION_ID);
      assert.equal(result.reservationId, 'reservation-1');
      assert.equal(result.walletId, 'wallet-1');
      assert.equal(result.userId, 'user-1');
      assert.equal(result.feature, 'AI_CHAT_QUERY');
      assert.equal(result.source, TokenTransactionSource.CHAT);
      assert.equal(result.status, AIBillingOperationStatus.RESERVED);
      assert.equal(result.reservedTokens, 10);
      assert.equal(result.reservationPricingVersion, 1);
      assert.equal(result.idempotentReplay, false);
      assert.ok(result.createdAt instanceof Date);
      const stored = store.findOperationByOperationId(OPERATION_ID);
      assert.ok(stored);
      assert.equal(stored.status, AIBillingOperationStatus.RESERVED);
      assert.equal(stored.id, 'operation-internal-1');
      assert.equal(stored.operationId, OPERATION_ID);
      assert.notEqual(stored.id, stored.operationId);
    });

    test('11. persists requested identity and trims identifiers', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      await createAIBillingOperation(
        {
          operationId: OPERATION_ID,
          reservationId: 'reservation-1',
          requestedProvider: '  fake-provider  ',
          requestedModel: ' fake-model ',
        },
        store.deps(),
      );
      const stored = store.findOperationByOperationId(OPERATION_ID);
      assert.ok(stored);
      assert.equal(stored.requestedProvider, 'fake-provider');
      assert.equal(stored.requestedModel, 'fake-model');
    });

    test('12. returns idempotentReplay when an identical operation exists by operationId', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      store.addOperation(buildOperation());
      const result = await createAIBillingOperation(
        { operationId: OPERATION_ID, reservationId: 'reservation-1' },
        store.deps(),
      );
      assert.equal(result.operationId, OPERATION_ID);
      assert.equal(result.idempotentReplay, true);
    });

    test('13. throws IDEMPOTENCY_CONFLICT when the reservation is already attached to a different operationId', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      store.addOperation(buildOperation({ operationId: 'operation-external-different' }));
      const err = await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already exists for this reservation',
      );
      assert.equal(err.operationId, OPERATION_ID);
      assert.equal(err.reservationId, 'reservation-1');
      const stored = store.findOperationByReservationId('reservation-1');
      assert.ok(stored);
      assert.equal(stored.operationId, 'operation-external-different');
    });

    test('14. throws IDEMPOTENCY_CONFLICT when a conflicting operation exists by operationId', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      store.addOperation(buildOperation({ userId: 'user-2', walletId: 'wallet-2' }));
      const err = await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already exists for this reservation',
      );
      assert.equal(err.operationId, OPERATION_ID);
    });

    test('15. throws IDEMPOTENCY_CONFLICT when the reservation already has a different operation', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      store.addOperation(
        buildOperation({
          operationId: 'operation-external-other',
          reservationId: 'reservation-1',
          userId: 'user-2',
          walletId: 'wallet-2',
        }),
      );
      await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already exists for this reservation',
      );
    });

    test('16. throws IDEMPOTENCY_CONFLICT when requested identity differs from the existing operation', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      store.addOperation(buildOperation({ requestedProvider: 'other', requestedModel: 'other' }));
      await expectOpError(
        createAIBillingOperation(
          {
            operationId: OPERATION_ID,
            reservationId: 'reservation-1',
            requestedProvider: 'fake-provider',
            requestedModel: 'fake-model',
          },
          store.deps(),
        ),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already exists for this reservation',
      );
    });

    test('17. resolves a concurrent create race as an idempotent replay', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      store.simulateRaceOnCreate = true;
      const result = await createAIBillingOperation(
        { operationId: OPERATION_ID, reservationId: 'reservation-1' },
        store.deps(),
      );
      assert.equal(result.idempotentReplay, true);
      assert.equal(result.operationId, OPERATION_ID);
    });

    test('17a. concurrent create race with a different operationId on the same reservation throws IDEMPOTENCY_CONFLICT', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      store.simulateRaceOnCreateDifferentOperationId = true;
      const err = await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already exists for this reservation',
      );
      assert.equal(err.operationId, OPERATION_ID);
      assert.equal(err.reservationId, 'reservation-1');
      const raced = store.findOperationByOperationId('operation-external-raced');
      assert.ok(raced);
      assert.equal(raced.operationId, 'operation-external-raced');
      const created = store.findOperationByOperationId(OPERATION_ID);
      assert.equal(created, undefined);
    });

    test('17b. concurrent different operationIds on the same reservation cannot both succeed', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      const first = await createAIBillingOperation(
        { operationId: 'operation-first', reservationId: 'reservation-1' },
        store.deps(),
      );
      assert.equal(first.idempotentReplay, false);
      assert.equal(first.operationId, 'operation-first');
      await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already exists for this reservation',
      );
      const firstStored = store.findOperationByReservationId('reservation-1');
      assert.ok(firstStored);
      assert.equal(firstStored.operationId, 'operation-first');
      assert.equal(store.findOperationByOperationId(OPERATION_ID), undefined);
    });

    test('18. throws STORAGE_FAILED when create fails unexpectedly', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      store.throwOnCreate = true;
      await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'STORAGE_FAILED',
        'AI billing operation could not be stored reliably',
      );
    });

    test('19. throws INTEGRITY_CONFLICT when the reservation read fails', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      store.throwOnReadReservation = true;
      await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'INTEGRITY_CONFLICT',
        'AI billing reservation data could not be read reliably',
      );
    });

    test('20. throws INTEGRITY_CONFLICT when the operation read fails', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addWallet(buildWallet());
      store.throwOnReadOperation = true;
      await expectOpError(
        createAIBillingOperation({ operationId: OPERATION_ID, reservationId: 'reservation-1' }, store.deps()),
        'INTEGRITY_CONFLICT',
        'AI billing operation data could not be read reliably',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Record execution success
  // ---------------------------------------------------------------------------
  describe('recordAIBillingOperationExecutionSuccess', () => {
    test('21. rejects a non-object execution', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          { operationId: OPERATION_ID, execution: asExecution(null), usage: buildUsage() },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing execution evidence must be an object',
      );
    });

    test('22. rejects execution without a provider', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          { operationId: OPERATION_ID, execution: asExecution({ model: 'm' }), usage: buildUsage() },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing execution provider is missing or empty',
      );
    });

    test('23. rejects invalid usage', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          { operationId: OPERATION_ID, execution: buildExecution(), usage: asUsage(null) },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing usage evidence is missing or invalid',
      );
    });

    test('24. throws INTEGRITY_CONFLICT when usage provider mismatches execution', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          {
            operationId: OPERATION_ID,
            execution: buildExecution(),
            usage: buildUsage({ provider: 'other-provider' }),
          },
          store.deps(),
        ),
        'INTEGRITY_CONFLICT',
        'AI billing execution identity does not match usage evidence',
      );
    });

    test('25. throws OPERATION_NOT_FOUND when no operation exists', async () => {
      const store = new FakeOperationStore();
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          { operationId: OPERATION_ID, execution: buildExecution(), usage: buildUsage() },
          store.deps(),
        ),
        'OPERATION_NOT_FOUND',
        'AI billing operation not found',
      );
    });

    test('26. transitions RESERVED to EXECUTION_SUCCEEDED and records actual identity', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      const result = await recordAIBillingOperationExecutionSuccess(
        { operationId: OPERATION_ID, execution: buildExecution(), usage: buildUsage() },
        store.deps(),
      );
      assert.equal(result.status, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
      assert.equal(result.idempotentReplay, false);
      assert.ok(result.executedAt instanceof Date);
      const stored = store.findOperationByOperationId(OPERATION_ID);
      assert.ok(stored);
      assert.equal(stored.status, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
      assert.equal(stored.actualProvider, 'fake-provider');
      assert.equal(stored.actualModel, 'fake-model');
      assert.equal(stored.providerRequestId, 'req-1');
      assert.equal(stored.providerRequestSent, null);
      assert.equal(stored.inputTokens, 2);
      assert.equal(stored.outputTokens, 3);
      assert.equal(stored.totalTokens, 5);
      assert.equal(stored.cached, false);
      assert.equal(stored.audioSeconds, 0.5);
      assert.ok(stored.executedAt instanceof Date);
    });

    test('27. enforces the requested identity on execution success', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({ requestedProvider: 'fake-provider', requestedModel: 'fake-model' }),
      );
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          {
            operationId: OPERATION_ID,
            execution: buildExecution({ provider: 'other-provider' }),
            usage: buildUsage({ provider: 'other-provider' }),
          },
          store.deps(),
        ),
        'INTEGRITY_CONFLICT',
        'AI billing actual provider does not match the requested provider',
      );
    });

    test('28. enforces the requested model on execution success', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({ requestedProvider: 'fake-provider', requestedModel: 'fake-model' }),
      );
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          {
            operationId: OPERATION_ID,
            execution: buildExecution({ model: 'other-model' }),
            usage: buildUsage({ model: 'other-model' }),
          },
          store.deps(),
        ),
        'INTEGRITY_CONFLICT',
        'AI billing actual model does not match the requested model',
      );
    });

    test('29. exact replay returns idempotentReplay', async () => {
      const store = new FakeOperationStore();
      store.addOperation(executedOperation());
      const result = await recordAIBillingOperationExecutionSuccess(
        { operationId: OPERATION_ID, execution: buildExecution(), usage: buildUsage() },
        store.deps(),
      );
      assert.equal(result.idempotentReplay, true);
      assert.equal(result.status, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
    });

    test('30. conflicting evidence replay throws IDEMPOTENCY_CONFLICT (provider)', async () => {
      const store = new FakeOperationStore();
      store.addOperation(executedOperation());
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          {
            operationId: OPERATION_ID,
            execution: buildExecution({ provider: 'other-provider' }),
            usage: buildUsage({ provider: 'other-provider' }),
          },
          store.deps(),
        ),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already recorded conflicting execution evidence',
      );
    });

    test('31. conflicting evidence replay throws IDEMPOTENCY_CONFLICT (tokens)', async () => {
      const store = new FakeOperationStore();
      store.addOperation(executedOperation());
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          {
            operationId: OPERATION_ID,
            execution: buildExecution(),
            usage: buildUsage({ totalTokens: 9 }),
          },
          store.deps(),
        ),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already recorded conflicting execution evidence',
      );
    });

    test('32. throws INVALID_TRANSITION from PRICED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(pricedOperation());
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          { operationId: OPERATION_ID, execution: buildExecution(), usage: buildUsage() },
          store.deps(),
        ),
        'INVALID_TRANSITION',
        'AI billing operation cannot record execution from its current state',
      );
    });

    test('33. throws INVALID_TRANSITION from SETTLED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.SETTLED,
          actualWalletTokens: 5,
          settledAt: new Date(),
        }),
      );
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          { operationId: OPERATION_ID, execution: buildExecution(), usage: buildUsage() },
          store.deps(),
        ),
        'INVALID_TRANSITION',
        'AI billing operation cannot record execution from its current state',
      );
    });

    test('34. throws INVALID_TRANSITION from REVIEW_REQUIRED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({ status: AIBillingOperationStatus.REVIEW_REQUIRED }),
      );
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          { operationId: OPERATION_ID, execution: buildExecution(), usage: buildUsage() },
          store.deps(),
        ),
        'INVALID_TRANSITION',
        'AI billing operation cannot record execution from its current state',
      );
    });

    test('35. throws INVALID_TRANSITION from NON_BILLABLE_CONFIRMED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.NON_BILLABLE_CONFIRMED,
          failureKind: AIBillingOperationFailureKind.NON_BILLABLE,
        }),
      );
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          { operationId: OPERATION_ID, execution: buildExecution(), usage: buildUsage() },
          store.deps(),
        ),
        'INVALID_TRANSITION',
        'AI billing operation cannot record execution from its current state',
      );
    });

    test('36. throws STORAGE_FAILED when the transition fails', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      store.throwOnTransition = true;
      await expectOpError(
        recordAIBillingOperationExecutionSuccess(
          { operationId: OPERATION_ID, execution: buildExecution(), usage: buildUsage() },
          store.deps(),
        ),
        'STORAGE_FAILED',
        'AI billing operation could not be stored reliably',
      );
    });

    test('37. resolves a concurrent identical transition as a replay', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      store.transitionReturnsFalse = true;
      const result = await recordAIBillingOperationExecutionSuccess(
        { operationId: OPERATION_ID, execution: buildExecution(), usage: buildUsage() },
        store.deps(),
      );
      assert.equal(result.idempotentReplay, true);
      assert.equal(result.status, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
    });
  });

  // ---------------------------------------------------------------------------
  // Record pricing
  // ---------------------------------------------------------------------------
  describe('recordAIBillingOperationPricing', () => {
    test('38. rejects a non-object pricing result', async () => {
      const store = new FakeOperationStore();
      store.addOperation(executedOperation());
      await expectOpError(
        recordAIBillingOperationPricing(
          { operationId: OPERATION_ID, pricing: asPricing(null) },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing pricing evidence must be an object',
      );
    });

    test('39. rejects an invalid appliedMode', async () => {
      const store = new FakeOperationStore();
      store.addOperation(executedOperation());
      await expectOpError(
        recordAIBillingOperationPricing(
          { operationId: OPERATION_ID, pricing: asPricing(buildPricing({ appliedMode: 'UNKNOWN' as never })) },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing pricing appliedMode is invalid',
      );
    });

    test('40. rejects walletTokens exceeding the reserved snapshot', async () => {
      const store = new FakeOperationStore();
      store.addOperation(executedOperation());
      await expectOpError(
        recordAIBillingOperationPricing(
          { operationId: OPERATION_ID, pricing: buildPricing({ walletTokens: 11 }) },
          store.deps(),
        ),
        'INVALID_INPUT',
        'Actual wallet tokens must not exceed the reserved amount',
      );
    });

    test('41. throws OPERATION_NOT_FOUND when no operation exists', async () => {
      const store = new FakeOperationStore();
      await expectOpError(
        recordAIBillingOperationPricing(
          { operationId: OPERATION_ID, pricing: buildPricing() },
          store.deps(),
        ),
        'OPERATION_NOT_FOUND',
        'AI billing operation not found',
      );
    });

    test('42. throws INVALID_TRANSITION from RESERVED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        recordAIBillingOperationPricing(
          { operationId: OPERATION_ID, pricing: buildPricing() },
          store.deps(),
        ),
        'INVALID_TRANSITION',
        'AI billing operation cannot record pricing from its current state',
      );
    });

    test('43. throws INTEGRITY_CONFLICT when pricing provider mismatches execution evidence', async () => {
      const store = new FakeOperationStore();
      store.addOperation(executedOperation());
      await expectOpError(
        recordAIBillingOperationPricing(
          {
            operationId: OPERATION_ID,
            pricing: asPricing(buildPricing({ provider: 'other-provider' })),
          },
          store.deps(),
        ),
        'INTEGRITY_CONFLICT',
        'AI billing pricing provider does not match execution evidence',
      );
    });

    test('44. transitions EXECUTION_SUCCEEDED to PRICED and records pricing evidence', async () => {
      const store = new FakeOperationStore();
      store.addReservation(buildReservation());
      store.addOperation(executedOperation());
      const result = await recordAIBillingOperationPricing(
        { operationId: OPERATION_ID, pricing: buildPricing() },
        store.deps(),
      );
      assert.equal(result.status, AIBillingOperationStatus.PRICED);
      assert.equal(result.actualWalletTokens, 5);
      assert.equal(result.idempotentReplay, false);
      assert.ok(result.pricedAt instanceof Date);
      const stored = store.findOperationByOperationId(OPERATION_ID);
      assert.ok(stored);
      assert.equal(stored.status, AIBillingOperationStatus.PRICED);
      assert.equal(stored.pricingMode, 'PROVIDER_USAGE');
      assert.equal(stored.actualWalletTokens, 5);
      assert.equal(stored.billingCurrency, 'USD');
      assert.equal(stored.rateCardVersion, 'rate-v1');
      assert.equal(stored.walletPolicyVersion, 'policy-v1');
      assert.ok(stored.pricedAt instanceof Date);
    });

    test('45. exact replay returns idempotentReplay', async () => {
      const store = new FakeOperationStore();
      store.addOperation(pricedOperation());
      const result = await recordAIBillingOperationPricing(
        { operationId: OPERATION_ID, pricing: buildPricing() },
        store.deps(),
      );
      assert.equal(result.idempotentReplay, true);
      assert.equal(result.status, AIBillingOperationStatus.PRICED);
    });

    test('46. conflicting pricing replay throws IDEMPOTENCY_CONFLICT', async () => {
      const store = new FakeOperationStore();
      store.addOperation(pricedOperation());
      await expectOpError(
        recordAIBillingOperationPricing(
          { operationId: OPERATION_ID, pricing: buildPricing({ walletTokens: 7 }) },
          store.deps(),
        ),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already recorded conflicting pricing evidence',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Record failure
  // ---------------------------------------------------------------------------
  describe('recordAIBillingOperationFailure', () => {
    test('47. rejects an unrecognized failure kind', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        recordAIBillingOperationFailure(
          { operationId: OPERATION_ID, failure: asFailure({ kind: 'OTHER' }) },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing failure kind is not recognized',
      );
    });

    test('48. rejects a non-billable failure confirming the request was sent', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        recordAIBillingOperationFailure(
          {
            operationId: OPERATION_ID,
            failure: asFailure(
              buildNonBillableFailure({ providerRequestSent: true as unknown as false }),
            ),
          },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing non-billable failure must confirm the provider request was not sent',
      );
    });

    test('49. rejects an indeterminate failure confirming the request was not sent', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        recordAIBillingOperationFailure(
          {
            operationId: OPERATION_ID,
            failure: asFailure(
              buildIndeterminateFailure({ providerRequestSent: false as unknown as true }),
            ),
          },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing indeterminate failure must confirm the provider request was sent',
      );
    });

    test('50. throws OPERATION_NOT_FOUND when no operation exists', async () => {
      const store = new FakeOperationStore();
      await expectOpError(
        recordAIBillingOperationFailure(
          { operationId: OPERATION_ID, failure: buildNonBillableFailure() },
          store.deps(),
        ),
        'OPERATION_NOT_FOUND',
        'AI billing operation not found',
      );
    });

    test('51. transitions to NON_BILLABLE_CONFIRMED and persists dispatch evidence only', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      const result = await recordAIBillingOperationFailure(
        { operationId: OPERATION_ID, failure: buildNonBillableFailure() },
        store.deps(),
      );
      assert.equal(result.status, AIBillingOperationStatus.NON_BILLABLE_CONFIRMED);
      assert.equal(result.failureKind, AIBillingOperationFailureKind.NON_BILLABLE);
      assert.equal(result.providerRequestSent, false);
      assert.equal(result.idempotentReplay, false);
      const stored = store.findOperationByOperationId(OPERATION_ID);
      assert.ok(stored);
      assert.equal(stored.status, AIBillingOperationStatus.NON_BILLABLE_CONFIRMED);
      assert.equal(stored.failureKind, AIBillingOperationFailureKind.NON_BILLABLE);
      assert.equal(stored.failureCode, 'E_CANCELLED');
      assert.equal(stored.retryable, false);
      assert.equal(stored.providerRequestSent, false);
      assert.ok(stored.failedAt instanceof Date);
    });

    test('52. transitions to INDETERMINATE and persists providerRequestSent=true', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      const result = await recordAIBillingOperationFailure(
        { operationId: OPERATION_ID, failure: buildIndeterminateFailure() },
        store.deps(),
      );
      assert.equal(result.status, AIBillingOperationStatus.INDETERMINATE);
      assert.equal(result.failureKind, AIBillingOperationFailureKind.INDETERMINATE);
      assert.equal(result.providerRequestSent, true);
      assert.equal(result.idempotentReplay, false);
      const stored = store.findOperationByOperationId(OPERATION_ID);
      assert.ok(stored);
      assert.equal(stored.failureKind, AIBillingOperationFailureKind.INDETERMINATE);
      assert.equal(stored.failureCode, 'E_TIMEOUT');
      assert.equal(stored.retryable, true);
      assert.equal(stored.providerRequestSent, true);
      assert.equal(stored.actualProvider, 'fake-provider');
      assert.equal(stored.actualModel, null);
      assert.equal(stored.providerRequestId, null);
    });

    test('52a. persists the complete partial execution identity on indeterminate failure', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await recordAIBillingOperationFailure(
        {
          operationId: OPERATION_ID,
          failure: buildIndeterminateFailure({
            execution: {
              provider: 'fake-provider',
              model: 'fake-model',
              providerRequestId: 'req-1',
            },
          }),
        },
        store.deps(),
      );
      const stored = store.findOperationByOperationId(OPERATION_ID);
      assert.ok(stored);
      assert.equal(stored.actualProvider, 'fake-provider');
      assert.equal(stored.actualModel, 'fake-model');
      assert.equal(stored.providerRequestId, 'req-1');
    });

    test('52b. persists only the supplied partial identity fields and invents none', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await recordAIBillingOperationFailure(
        {
          operationId: OPERATION_ID,
          failure: buildIndeterminateFailure({ execution: { providerRequestId: 'req-only' } }),
        },
        store.deps(),
      );
      const stored = store.findOperationByOperationId(OPERATION_ID);
      assert.ok(stored);
      assert.equal(stored.providerRequestId, 'req-only');
      assert.equal(stored.actualProvider, null);
      assert.equal(stored.actualModel, null);
    });

    test('53. does not persist the raw failure message', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await recordAIBillingOperationFailure(
        { operationId: OPERATION_ID, failure: buildIndeterminateFailure() },
        store.deps(),
      );
      const stored = store.findOperationByOperationId(OPERATION_ID);
      assert.ok(stored);
      const hasMessage = 'failureMessage' in stored || 'message' in stored;
      assert.equal(hasMessage, false);
    });

    test('54. non-billable exact replay returns idempotentReplay', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.NON_BILLABLE_CONFIRMED,
          failureKind: AIBillingOperationFailureKind.NON_BILLABLE,
          failureCode: 'E_CANCELLED',
          retryable: false,
          providerRequestSent: false,
          failedAt: new Date(),
        }),
      );
      const result = await recordAIBillingOperationFailure(
        { operationId: OPERATION_ID, failure: buildNonBillableFailure() },
        store.deps(),
      );
      assert.equal(result.idempotentReplay, true);
    });

    test('55. indeterminate exact replay returns idempotentReplay', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.INDETERMINATE,
          failureKind: AIBillingOperationFailureKind.INDETERMINATE,
          failureCode: 'E_TIMEOUT',
          retryable: true,
          providerRequestSent: true,
          actualProvider: 'fake-provider',
          actualModel: null,
          providerRequestId: null,
          failedAt: new Date(),
        }),
      );
      const result = await recordAIBillingOperationFailure(
        { operationId: OPERATION_ID, failure: buildIndeterminateFailure() },
        store.deps(),
      );
      assert.equal(result.idempotentReplay, true);
    });

    test('55a. indeterminate replay with a different provider conflicts', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.INDETERMINATE,
          failureKind: AIBillingOperationFailureKind.INDETERMINATE,
          failureCode: 'E_TIMEOUT',
          retryable: true,
          providerRequestSent: true,
          actualProvider: 'other-provider',
          failedAt: new Date(),
        }),
      );
      await expectOpError(
        recordAIBillingOperationFailure(
          { operationId: OPERATION_ID, failure: buildIndeterminateFailure() },
          store.deps(),
        ),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already recorded conflicting failure evidence',
      );
    });

    test('55b. indeterminate replay with a different model conflicts', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.INDETERMINATE,
          failureKind: AIBillingOperationFailureKind.INDETERMINATE,
          failureCode: 'E_TIMEOUT',
          retryable: true,
          providerRequestSent: true,
          actualProvider: 'fake-provider',
          actualModel: 'other-model',
          failedAt: new Date(),
        }),
      );
      await expectOpError(
        recordAIBillingOperationFailure(
          { operationId: OPERATION_ID, failure: buildIndeterminateFailure() },
          store.deps(),
        ),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already recorded conflicting failure evidence',
      );
    });

    test('55c. indeterminate replay with a different providerRequestId conflicts', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.INDETERMINATE,
          failureKind: AIBillingOperationFailureKind.INDETERMINATE,
          failureCode: 'E_TIMEOUT',
          retryable: true,
          providerRequestSent: true,
          actualProvider: 'fake-provider',
          providerRequestId: 'req-other',
          failedAt: new Date(),
        }),
      );
      await expectOpError(
        recordAIBillingOperationFailure(
          {
            operationId: OPERATION_ID,
            failure: buildIndeterminateFailure({
              execution: {
                provider: 'fake-provider',
                providerRequestId: 'req-1',
              },
            }),
          },
          store.deps(),
        ),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already recorded conflicting failure evidence',
      );
    });

    test('55d. reads expose only the sanitized stored partial identity', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.INDETERMINATE,
          failureKind: AIBillingOperationFailureKind.INDETERMINATE,
          failureCode: 'E_TIMEOUT',
          retryable: true,
          providerRequestSent: true,
          actualProvider: 'fake-provider',
          actualModel: 'fake-model',
          providerRequestId: 'req-1',
          failedAt: new Date('2026-08-02T00:00:00.000Z'),
        }),
      );
      const evidence = await getAIBillingOperationByOperationId(
        { operationId: OPERATION_ID },
        store.deps(),
      );
      assert.equal(evidence.failureKind, AIBillingOperationFailureKind.INDETERMINATE);
      assert.equal(evidence.providerRequestSent, true);
      assert.equal(evidence.actualProvider, 'fake-provider');
      assert.equal(evidence.actualModel, 'fake-model');
      assert.equal(evidence.providerRequestId, 'req-1');
      assert.equal('failureMessage' in evidence, false);
      assert.equal('message' in evidence, false);
    });

    test('56. conflicting failure replay throws IDEMPOTENCY_CONFLICT', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.NON_BILLABLE_CONFIRMED,
          failureKind: AIBillingOperationFailureKind.NON_BILLABLE,
          failureCode: 'E_OTHER',
          retryable: false,
          providerRequestSent: false,
        }),
      );
      await expectOpError(
        recordAIBillingOperationFailure(
          { operationId: OPERATION_ID, failure: buildNonBillableFailure() },
          store.deps(),
        ),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already recorded conflicting failure evidence',
      );
    });

    test('57. throws INVALID_TRANSITION from PRICED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(pricedOperation());
      await expectOpError(
        recordAIBillingOperationFailure(
          { operationId: OPERATION_ID, failure: buildNonBillableFailure() },
          store.deps(),
        ),
        'INVALID_TRANSITION',
        'AI billing operation cannot record a failure from its current state',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Mark for review
  // ---------------------------------------------------------------------------
  describe('markAIBillingOperationForReview', () => {
    test('58. rejects an empty reasonCode', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        markAIBillingOperationForReview({ operationId: OPERATION_ID, reasonCode: '  ' }, store.deps()),
        'INVALID_INPUT',
        'reasonCode must be a non-empty string',
      );
    });

    test('59. rejects a free-text reasonCode', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        markAIBillingOperationForReview({ operationId: OPERATION_ID, reasonCode: 'please review this case' }, store.deps()),
        'INVALID_INPUT',
        'reasonCode must contain only uppercase ASCII letters, digits, and underscores',
      );
    });

    test('60. rejects a lowercase reasonCode', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        markAIBillingOperationForReview({ operationId: OPERATION_ID, reasonCode: 'review_required' }, store.deps()),
        'INVALID_INPUT',
        'reasonCode must contain only uppercase ASCII letters, digits, and underscores',
      );
    });

    test('61. rejects a reasonCode with a line break', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        markAIBillingOperationForReview({ operationId: OPERATION_ID, reasonCode: 'REVIEW\nREQUIRED' }, store.deps()),
        'INVALID_INPUT',
        'reasonCode must contain only uppercase ASCII letters, digits, and underscores',
      );
    });

    test('62. rejects an overlong reasonCode', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        markAIBillingOperationForReview(
          { operationId: OPERATION_ID, reasonCode: 'A'.repeat(65) },
          store.deps(),
        ),
        'INVALID_INPUT',
        'reasonCode must not exceed 64 characters',
      );
    });

    test('63. rejects a non-string reasonCode', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        markAIBillingOperationForReview(
          { operationId: OPERATION_ID, reasonCode: 42 as unknown as string },
          store.deps(),
        ),
        'INVALID_INPUT',
        'reasonCode must be a non-empty string',
      );
    });

    test('64. throws OPERATION_NOT_FOUND when no operation exists', async () => {
      const store = new FakeOperationStore();
      await expectOpError(
        markAIBillingOperationForReview({ operationId: OPERATION_ID, reasonCode: 'REVIEW_REQUIRED' }, store.deps()),
        'OPERATION_NOT_FOUND',
        'AI billing operation not found',
      );
    });

    test('65. transitions RESERVED to REVIEW_REQUIRED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      const result = await markAIBillingOperationForReview(
        { operationId: OPERATION_ID, reasonCode: 'REVIEW_REQUIRED' },
        store.deps(),
      );
      assert.equal(result.status, AIBillingOperationStatus.REVIEW_REQUIRED);
      assert.equal(result.reviewRequired, true);
      assert.equal(result.idempotentReplay, false);
      const stored = store.findOperationByOperationId(OPERATION_ID);
      assert.ok(stored);
      assert.equal(stored.reviewReasonCode, 'REVIEW_REQUIRED');
      assert.ok(stored.reviewedAt instanceof Date);
    });

    test('66. transitions EXECUTION_SUCCEEDED to REVIEW_REQUIRED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(executedOperation());
      const result = await markAIBillingOperationForReview(
        { operationId: OPERATION_ID, reasonCode: 'USAGE_MISMATCH' },
        store.deps(),
      );
      assert.equal(result.status, AIBillingOperationStatus.REVIEW_REQUIRED);
    });

    test('67. transitions INDETERMINATE to REVIEW_REQUIRED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.INDETERMINATE,
          failureKind: AIBillingOperationFailureKind.INDETERMINATE,
        }),
      );
      const result = await markAIBillingOperationForReview(
        { operationId: OPERATION_ID, reasonCode: 'OUTCOME_UNKNOWN' },
        store.deps(),
      );
      assert.equal(result.status, AIBillingOperationStatus.REVIEW_REQUIRED);
    });

    test('68. throws INVALID_TRANSITION from SETTLED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({ status: AIBillingOperationStatus.SETTLED, actualWalletTokens: 5 }),
      );
      await expectOpError(
        markAIBillingOperationForReview({ operationId: OPERATION_ID, reasonCode: 'LATE_REVIEW' }, store.deps()),
        'INVALID_TRANSITION',
        'AI billing operation cannot be sent for review once settled or released',
      );
    });

    test('69. throws INVALID_TRANSITION from RELEASED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({ status: AIBillingOperationStatus.RELEASED, releasedAt: new Date() }),
      );
      await expectOpError(
        markAIBillingOperationForReview({ operationId: OPERATION_ID, reasonCode: 'LATE_REVIEW' }, store.deps()),
        'INVALID_TRANSITION',
        'AI billing operation cannot be sent for review once settled or released',
      );
    });

    test('70. already under review with the same reasonCode replays idempotently', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({ status: AIBillingOperationStatus.REVIEW_REQUIRED, reviewReasonCode: 'REVIEW_REQUIRED' }),
      );
      const result = await markAIBillingOperationForReview(
        { operationId: OPERATION_ID, reasonCode: 'REVIEW_REQUIRED' },
        store.deps(),
      );
      assert.equal(result.idempotentReplay, true);
      assert.equal(result.status, AIBillingOperationStatus.REVIEW_REQUIRED);
    });

    test('71. already under review with a different reasonCode throws IDEMPOTENCY_CONFLICT', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({ status: AIBillingOperationStatus.REVIEW_REQUIRED, reviewReasonCode: 'OTHER_REASON' }),
      );
      await expectOpError(
        markAIBillingOperationForReview({ operationId: OPERATION_ID, reasonCode: 'REVIEW_REQUIRED' }, store.deps()),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation is already under review with different evidence',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Mark settled
  // ---------------------------------------------------------------------------
  describe('markAIBillingOperationSettled', () => {
    test('72. rejects a non-object settlement', async () => {
      const store = new FakeOperationStore();
      store.addOperation(pricedOperation());
      await expectOpError(
        markAIBillingOperationSettled(
          { operationId: OPERATION_ID, settlement: asSettlement(null) },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing settlement evidence must be an object',
      );
    });

    test('73. rejects a settlement for a different reservation', async () => {
      const store = new FakeOperationStore();
      store.addOperation(pricedOperation());
      await expectOpError(
        markAIBillingOperationSettled(
          {
            operationId: OPERATION_ID,
            settlement: asSettlement(buildSettlement({ reservationId: 'reservation-other' })),
          },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing settlement reservation does not match the operation',
      );
    });

    test('74. rejects a settlement that is not COMPLETED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(pricedOperation());
      await expectOpError(
        markAIBillingOperationSettled(
          {
            operationId: OPERATION_ID,
            settlement: asSettlement(buildSettlement({ status: TokenReservationStatus.PENDING })),
          },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing settlement must confirm a completed reservation',
      );
    });

    test('75. rejects settlement reserved tokens that do not match the operation snapshot', async () => {
      const store = new FakeOperationStore();
      store.addOperation(pricedOperation());
      await expectOpError(
        markAIBillingOperationSettled(
          {
            operationId: OPERATION_ID,
            settlement: asSettlement(buildSettlement({ tokens: 9 })),
          },
          store.deps(),
        ),
        'INTEGRITY_CONFLICT',
        'AI billing settlement reserved tokens do not match the operation snapshot',
      );
    });

    test('76. rejects a missing consumeTransactionId', async () => {
      const store = new FakeOperationStore();
      store.addOperation(pricedOperation());
      await expectOpError(
        markAIBillingOperationSettled(
          {
            operationId: OPERATION_ID,
            settlement: asSettlement(buildSettlement({ consumeTransactionId: '' })),
          },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing settlement consume transaction is missing',
      );
    });

    test('77. throws OPERATION_NOT_FOUND when no operation exists', async () => {
      const store = new FakeOperationStore();
      await expectOpError(
        markAIBillingOperationSettled(
          { operationId: OPERATION_ID, settlement: buildSettlement() },
          store.deps(),
        ),
        'OPERATION_NOT_FOUND',
        'AI billing operation not found',
      );
    });

    test('78. throws INVALID_TRANSITION from EXECUTION_SUCCEEDED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(executedOperation());
      await expectOpError(
        markAIBillingOperationSettled(
          { operationId: OPERATION_ID, settlement: buildSettlement() },
          store.deps(),
        ),
        'INVALID_TRANSITION',
        'AI billing operation cannot be marked settled from its current state',
      );
    });

    test('79. throws INTEGRITY_CONFLICT when the settlement amount differs from priced evidence', async () => {
      const store = new FakeOperationStore();
      store.addOperation(pricedOperation(7));
      await expectOpError(
        markAIBillingOperationSettled(
          { operationId: OPERATION_ID, settlement: buildSettlement({ actualTokens: 5 }) },
          store.deps(),
        ),
        'INTEGRITY_CONFLICT',
        'AI billing settlement amount does not match priced evidence',
      );
    });

    test('80. transitions PRICED to SETTLED and persists consumeTransactionId', async () => {
      const store = new FakeOperationStore();
      store.addOperation(pricedOperation());
      const result = await markAIBillingOperationSettled(
        { operationId: OPERATION_ID, settlement: buildSettlement() },
        store.deps(),
      );
      assert.equal(result.status, AIBillingOperationStatus.SETTLED);
      assert.equal(result.actualWalletTokens, 5);
      assert.equal(result.consumeTransactionId, 'consume-1');
      assert.equal(result.idempotentReplay, false);
      assert.ok(result.settledAt instanceof Date);
      const stored = store.findOperationByOperationId(OPERATION_ID);
      assert.ok(stored);
      assert.equal(stored.status, AIBillingOperationStatus.SETTLED);
      assert.equal(stored.consumeTransactionId, 'consume-1');
      assert.ok(stored.settledAt instanceof Date);
    });

    test('81. exact replay returns idempotentReplay and preserves consumeTransactionId', async () => {
      const store = new FakeOperationStore();
      const priced = pricedOperation(5);
      store.addOperation(
        buildOperation({
          ...priced,
          status: AIBillingOperationStatus.SETTLED,
          consumeTransactionId: 'consume-1',
          settledAt: new Date('2026-08-02T00:00:00.000Z'),
        }),
      );
      const result = await markAIBillingOperationSettled(
        { operationId: OPERATION_ID, settlement: buildSettlement() },
        store.deps(),
      );
      assert.equal(result.idempotentReplay, true);
      assert.equal(result.status, AIBillingOperationStatus.SETTLED);
      assert.equal(result.consumeTransactionId, 'consume-1');
    });

    test('82. conflicting settlement replay throws INTEGRITY_CONFLICT', async () => {
      const store = new FakeOperationStore();
      const stored = pricedOperation(7);
      store.operations.set(
        'operation-internal-1',
        buildOperation({
          ...stored,
          status: AIBillingOperationStatus.SETTLED,
          consumeTransactionId: 'consume-1',
          settledAt: new Date(),
        }),
      );
      await expectOpError(
        markAIBillingOperationSettled(
          { operationId: OPERATION_ID, settlement: buildSettlement({ actualTokens: 5 }) },
          store.deps(),
        ),
        'INTEGRITY_CONFLICT',
        'AI billing operation already recorded conflicting settlement evidence',
      );
    });

    test('82a. exact settled timestamp replay is idempotent', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          ...pricedOperation(5),
          status: AIBillingOperationStatus.SETTLED,
          consumeTransactionId: 'consume-1',
          settledAt: new Date('2026-08-02T00:00:00.000Z'),
        }),
      );
      const result = await markAIBillingOperationSettled(
        { operationId: OPERATION_ID, settlement: buildSettlement() },
        store.deps(),
      );
      assert.equal(result.idempotentReplay, true);
      assert.equal(result.status, AIBillingOperationStatus.SETTLED);
      assert.equal(result.settledAt.getTime(), new Date('2026-08-02T00:00:00.000Z').getTime());
    });

    test('82b. a different settled timestamp conflicts', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          ...pricedOperation(5),
          status: AIBillingOperationStatus.SETTLED,
          consumeTransactionId: 'consume-1',
          settledAt: new Date('2026-08-02T01:00:00.000Z'),
        }),
      );
      await expectOpError(
        markAIBillingOperationSettled(
          { operationId: OPERATION_ID, settlement: buildSettlement() },
          store.deps(),
        ),
        'INTEGRITY_CONFLICT',
        'AI billing operation already recorded conflicting settlement evidence',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Mark released
  // ---------------------------------------------------------------------------
  describe('markAIBillingOperationReleased', () => {
    test('83. rejects a non-object release', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.NON_BILLABLE_CONFIRMED,
          failureKind: AIBillingOperationFailureKind.NON_BILLABLE,
        }),
      );
      await expectOpError(
        markAIBillingOperationReleased(
          { operationId: OPERATION_ID, release: asRelease(null) },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing release evidence must be an object',
      );
    });

    test('84. rejects a release that is not RELEASED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.NON_BILLABLE_CONFIRMED,
          failureKind: AIBillingOperationFailureKind.NON_BILLABLE,
        }),
      );
      await expectOpError(
        markAIBillingOperationReleased(
          {
            operationId: OPERATION_ID,
            release: asRelease(buildRelease({ status: TokenReservationStatus.PENDING })),
          },
          store.deps(),
        ),
        'INVALID_INPUT',
        'AI billing release must confirm a released reservation',
      );
    });

    test('85. rejects release reserved tokens that do not match the operation snapshot', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.NON_BILLABLE_CONFIRMED,
          failureKind: AIBillingOperationFailureKind.NON_BILLABLE,
        }),
      );
      await expectOpError(
        markAIBillingOperationReleased(
          {
            operationId: OPERATION_ID,
            release: asRelease(buildRelease({ tokens: 9 })),
          },
          store.deps(),
        ),
        'INTEGRITY_CONFLICT',
        'AI billing release reserved tokens do not match the operation snapshot',
      );
    });

    test('86. throws INVALID_TRANSITION from INDETERMINATE (never auto-releases)', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.INDETERMINATE,
          failureKind: AIBillingOperationFailureKind.INDETERMINATE,
        }),
      );
      await expectOpError(
        markAIBillingOperationReleased(
          { operationId: OPERATION_ID, release: buildRelease() },
          store.deps(),
        ),
        'INVALID_TRANSITION',
        'AI billing operation cannot be marked released from its current state',
      );
    });

    test('87. throws INVALID_TRANSITION from RESERVED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      await expectOpError(
        markAIBillingOperationReleased(
          { operationId: OPERATION_ID, release: buildRelease() },
          store.deps(),
        ),
        'INVALID_TRANSITION',
        'AI billing operation cannot be marked released from its current state',
      );
    });

    test('88. transitions NON_BILLABLE_CONFIRMED to RELEASED', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.NON_BILLABLE_CONFIRMED,
          failureKind: AIBillingOperationFailureKind.NON_BILLABLE,
        }),
      );
      const result = await markAIBillingOperationReleased(
        { operationId: OPERATION_ID, release: buildRelease() },
        store.deps(),
      );
      assert.equal(result.status, AIBillingOperationStatus.RELEASED);
      assert.equal(result.idempotentReplay, false);
      assert.ok(result.releasedAt instanceof Date);
      const stored = store.findOperationByOperationId(OPERATION_ID);
      assert.ok(stored);
      assert.equal(stored.status, AIBillingOperationStatus.RELEASED);
      assert.ok(stored.releasedAt instanceof Date);
    });

    test('89. exact replay returns idempotentReplay', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.RELEASED,
          failureKind: AIBillingOperationFailureKind.NON_BILLABLE,
          releasedAt: new Date('2026-08-02T00:00:00.000Z'),
        }),
      );
      const result = await markAIBillingOperationReleased(
        { operationId: OPERATION_ID, release: buildRelease() },
        store.deps(),
      );
      assert.equal(result.idempotentReplay, true);
      assert.equal(result.status, AIBillingOperationStatus.RELEASED);
    });

    test('90. conflicting release replay throws IDEMPOTENCY_CONFLICT', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.RELEASED,
          failureKind: AIBillingOperationFailureKind.NON_BILLABLE,
          userId: 'user-other',
          walletId: 'wallet-other',
          releasedAt: new Date(),
        }),
      );
      await expectOpError(
        markAIBillingOperationReleased(
          { operationId: OPERATION_ID, release: buildRelease() },
          store.deps(),
        ),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already recorded conflicting release evidence',
      );
    });

    test('90a. exact released timestamp replay is idempotent', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.RELEASED,
          failureKind: AIBillingOperationFailureKind.NON_BILLABLE,
          releasedAt: new Date('2026-08-02T00:00:00.000Z'),
        }),
      );
      const result = await markAIBillingOperationReleased(
        { operationId: OPERATION_ID, release: buildRelease() },
        store.deps(),
      );
      assert.equal(result.idempotentReplay, true);
      assert.equal(result.status, AIBillingOperationStatus.RELEASED);
      assert.equal(result.releasedAt.getTime(), new Date('2026-08-02T00:00:00.000Z').getTime());
    });

    test('90b. a different released timestamp conflicts', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          status: AIBillingOperationStatus.RELEASED,
          failureKind: AIBillingOperationFailureKind.NON_BILLABLE,
          releasedAt: new Date('2026-08-02T01:00:00.000Z'),
        }),
      );
      await expectOpError(
        markAIBillingOperationReleased(
          { operationId: OPERATION_ID, release: buildRelease() },
          store.deps(),
        ),
        'IDEMPOTENCY_CONFLICT',
        'AI billing operation already recorded conflicting release evidence',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------
  describe('reads', () => {
    test('91. getAIBillingOperationByOperationId throws OPERATION_NOT_FOUND', async () => {
      const store = new FakeOperationStore();
      await expectOpError(
        getAIBillingOperationByOperationId({ operationId: OPERATION_ID }, store.deps()),
        'OPERATION_NOT_FOUND',
        'AI billing operation not found',
      );
    });

    test('92. getAIBillingOperationByReservationId throws OPERATION_NOT_FOUND', async () => {
      const store = new FakeOperationStore();
      await expectOpError(
        getAIBillingOperationByReservationId({ reservationId: 'reservation-1' }, store.deps()),
        'OPERATION_NOT_FOUND',
        'AI billing operation not found',
      );
    });

    test('93. returns sanitized evidence with the external operationId', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          ...pricedOperation(),
          status: AIBillingOperationStatus.SETTLED,
          consumeTransactionId: 'consume-1',
          settledAt: new Date('2026-08-02T00:00:00.000Z'),
        }),
      );
      const evidence = await getAIBillingOperationByOperationId(
        { operationId: OPERATION_ID },
        store.deps(),
      );
      assert.equal(evidence.operationId, OPERATION_ID);
      assert.equal(evidence.reservationId, 'reservation-1');
      assert.equal(evidence.status, AIBillingOperationStatus.SETTLED);
      assert.equal(evidence.reservedTokens, 10);
      assert.equal(evidence.reservationPricingVersion, 1);
      assert.equal(evidence.actualProvider, 'fake-provider');
      assert.equal(evidence.actualModel, 'fake-model');
      assert.equal(evidence.providerRequestId, 'req-1');
      assert.equal(evidence.inputTokens, 2);
      assert.equal(evidence.outputTokens, 3);
      assert.equal(evidence.totalTokens, 5);
      assert.equal(evidence.pricingMode, 'PROVIDER_USAGE');
      assert.equal(evidence.actualWalletTokens, 5);
      assert.equal(evidence.billingCurrency, 'USD');
      assert.equal(evidence.rateCardVersion, 'rate-v1');
      assert.equal(evidence.walletPolicyVersion, 'policy-v1');
      assert.equal(evidence.consumeTransactionId, 'consume-1');
      assert.ok(evidence.executedAt instanceof Date);
      assert.ok(evidence.pricedAt instanceof Date);
      assert.ok(evidence.settledAt instanceof Date);
      assert.equal('id' in evidence, false);
      assert.equal('internalId' in evidence, false);
    });

    test('94. read by reservationId returns the same sanitized evidence', async () => {
      const store = new FakeOperationStore();
      store.addOperation(
        buildOperation({
          ...pricedOperation(),
          status: AIBillingOperationStatus.SETTLED,
          consumeTransactionId: 'consume-1',
          settledAt: new Date('2026-08-02T00:00:00.000Z'),
        }),
      );
      const evidence = await getAIBillingOperationByReservationId(
        { reservationId: 'reservation-1' },
        store.deps(),
      );
      assert.equal(evidence.operationId, OPERATION_ID);
      assert.equal(evidence.reservationId, 'reservation-1');
      assert.equal(evidence.status, AIBillingOperationStatus.SETTLED);
      assert.equal('id' in evidence, false);
    });

    test('95. omits optional evidence fields that are absent', async () => {
      const store = new FakeOperationStore();
      store.addOperation(buildOperation());
      const evidence = await getAIBillingOperationByOperationId(
        { operationId: OPERATION_ID },
        store.deps(),
      );
      assert.equal(evidence.status, AIBillingOperationStatus.RESERVED);
      assert.equal(evidence.reservedTokens, 10);
      assert.equal('actualProvider' in evidence, false);
      assert.equal('actualWalletTokens' in evidence, false);
      assert.equal('failureKind' in evidence, false);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests (real database)
// ---------------------------------------------------------------------------
describe('AI Billing Operation Service (database)', () => {
  before(async () => {
    await prisma.role.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, name: 'USER' },
    });
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
    const emailFilter = { startsWith: 'test_ai_operation_' };
    await prisma.aIBillingOperation.deleteMany({
      where: { reservation: { user: { email: emailFilter } } },
    });
    await prisma.tokenReservation.deleteMany({ where: { user: { email: emailFilter } } });
    await prisma.tokenTransaction.deleteMany({ where: { user: { email: emailFilter } } });
    await prisma.tokenWallet.deleteMany({ where: { user: { email: emailFilter } } });
    await prisma.user.deleteMany({ where: { email: emailFilter } });
  }

  async function cleanupUser(userId: string): Promise<void> {
    await prisma.aIBillingOperation.deleteMany({ where: { userId } });
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
        email: `test_ai_operation_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'AI Operation User',
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
    return { userId: user.id, walletId: wallet.id };
  }

  async function createReservation(
    userId: string,
    tokens = 10,
  ): Promise<{ reservationId: string }> {
    const result = await reserveBusinessTokensForAmount({
      userId,
      feature: 'AI_CHAT_QUERY',
      tokens,
      source: 'CHAT',
      idempotencyKey: crypto.randomUUID(),
    });
    return { reservationId: result.reservationId };
  }

  test('96. full success lifecycle settles the operation and reservation', async () => {
    const { userId, walletId } = await createUserWithWallet(50);
    const { reservationId } = await createReservation(userId, 10);
    const operationId = `op-${crypto.randomUUID()}`;

    try {
      const created = await createAIBillingOperation({ operationId, reservationId });
      assert.equal(created.status, AIBillingOperationStatus.RESERVED);
      assert.equal(created.walletId, walletId);
      assert.equal(created.userId, userId);
      assert.equal(created.reservedTokens, 10);
      assert.equal(created.reservationPricingVersion, 1);

      const success = await recordAIBillingOperationExecutionSuccess({
        operationId,
        execution: buildExecution(),
        usage: buildUsage(),
      });
      assert.equal(success.status, AIBillingOperationStatus.EXECUTION_SUCCEEDED);

      const pricing = await recordAIBillingOperationPricing({
        operationId,
        pricing: buildPricing({ walletTokens: 5 }),
      });
      assert.equal(pricing.status, AIBillingOperationStatus.PRICED);
      assert.equal(pricing.actualWalletTokens, 5);

      const settlement = await settleBusinessTokenReservationForAmount({
        reservationId,
        actualTokens: 5,
      });
      assert.equal(settlement.status, TokenReservationStatus.COMPLETED);

      const settled = await markAIBillingOperationSettled({ operationId, settlement });
      assert.equal(settled.status, AIBillingOperationStatus.SETTLED);
      assert.equal(settled.consumeTransactionId, settlement.consumeTransactionId);

      const evidence = await getAIBillingOperationByOperationId({ operationId });
      assert.equal(evidence.actualWalletTokens, 5);
      assert.equal(evidence.consumeTransactionId, settlement.consumeTransactionId);
      assert.equal(evidence.status, AIBillingOperationStatus.SETTLED);

      const stored = await prisma.aIBillingOperation.findUnique({ where: { operationId } });
      assert.ok(stored);
      assert.equal(stored.status, AIBillingOperationStatus.SETTLED);
      assert.equal(stored.actualWalletTokens, 5);
      assert.equal(stored.pricingMode, 'PROVIDER_USAGE');
      assert.equal(stored.actualProvider, 'fake-provider');
      assert.equal(stored.providerRequestSent, null);
      assert.equal(stored.consumeTransactionId, settlement.consumeTransactionId);

      const reservation = await prisma.tokenReservation.findUnique({ where: { id: reservationId } });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.COMPLETED);

      const consume = await prisma.tokenTransaction.findFirst({
        where: { userId, type: 'CONSUME' },
      });
      assert.ok(consume);
      assert.equal(consume.tokens, 5);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('97. non-billable lifecycle releases the operation and reservation', async () => {
    const { userId, walletId } = await createUserWithWallet(50);
    const { reservationId } = await createReservation(userId, 10);
    const operationId = `op-${crypto.randomUUID()}`;

    try {
      const created = await createAIBillingOperation({ operationId, reservationId });
      assert.equal(created.status, AIBillingOperationStatus.RESERVED);
      assert.equal(created.walletId, walletId);

      const failure = await recordAIBillingOperationFailure({
        operationId,
        failure: buildNonBillableFailure(),
      });
      assert.equal(failure.status, AIBillingOperationStatus.NON_BILLABLE_CONFIRMED);
      assert.equal(failure.providerRequestSent, false);

      const release = await releaseBusinessTokenReservation({
        reservationId,
        reason: 'confirmed non-billable',
      });
      assert.equal(release.status, TokenReservationStatus.RELEASED);

      const released = await markAIBillingOperationReleased({ operationId, release });
      assert.equal(released.status, AIBillingOperationStatus.RELEASED);

      const stored = await prisma.aIBillingOperation.findUnique({ where: { operationId } });
      assert.ok(stored);
      assert.equal(stored.status, AIBillingOperationStatus.RELEASED);
      assert.equal(stored.failureKind, AIBillingOperationFailureKind.NON_BILLABLE);
      assert.equal(stored.providerRequestSent, false);

      const reservation = await prisma.tokenReservation.findUnique({ where: { id: reservationId } });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.RELEASED);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('98. indeterminate outcome can be marked for review but never auto-released', async () => {
    const { userId } = await createUserWithWallet(50);
    const { reservationId } = await createReservation(userId, 10);
    const operationId = `op-${crypto.randomUUID()}`;

    try {
      await createAIBillingOperation({ operationId, reservationId });
      const failure = await recordAIBillingOperationFailure({
        operationId,
        failure: buildIndeterminateFailure(),
      });
      assert.equal(failure.status, AIBillingOperationStatus.INDETERMINATE);
      assert.equal(failure.providerRequestSent, true);

      const review = await markAIBillingOperationForReview({
        operationId,
        reasonCode: 'OUTCOME_UNKNOWN',
      });
      assert.equal(review.status, AIBillingOperationStatus.REVIEW_REQUIRED);

      const stored = await prisma.aIBillingOperation.findUnique({ where: { operationId } });
      assert.ok(stored);
      assert.equal(stored.status, AIBillingOperationStatus.REVIEW_REQUIRED);
      assert.equal(stored.reviewReasonCode, 'OUTCOME_UNKNOWN');
      assert.equal(stored.failureKind, AIBillingOperationFailureKind.INDETERMINATE);
      assert.equal(stored.providerRequestSent, true);
      assert.equal(stored.actualProvider, 'fake-provider');
      assert.equal(stored.actualModel, null);
      assert.equal(stored.providerRequestId, null);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('99. pricing is rejected after the reservation was already settled', async () => {
    const { userId } = await createUserWithWallet(50);
    const { reservationId } = await createReservation(userId, 10);
    const operationId = `op-${crypto.randomUUID()}`;

    try {
      await createAIBillingOperation({ operationId, reservationId });
      await recordAIBillingOperationExecutionSuccess({
        operationId,
        execution: buildExecution(),
        usage: buildUsage(),
      });

      const settlement = await settleBusinessTokenReservationForAmount({
        reservationId,
        actualTokens: 5,
      });
      assert.equal(settlement.status, TokenReservationStatus.COMPLETED);

      const existing = await prisma.aIBillingOperation.findUnique({ where: { operationId } });
      assert.ok(existing);
      await expectOpError(
        recordAIBillingOperationPricing({
          operationId,
          pricing: buildPricing({ walletTokens: 5 }),
        }),
        'INVALID_TRANSITION',
        'AI billing operation cannot record pricing from its current state',
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  test('100. migration hardened the schema with the external operation identity and snapshot fields', async () => {
    const columns = (await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'AIBillingOperation'`,
    )) as { column_name: string }[];

    const names = new Set(columns.map((c) => c.column_name));

    for (const expected of [
      'id',
      'operationId',
      'reservationId',
      'walletId',
      'userId',
      'feature',
      'source',
      'status',
      'reservedTokens',
      'reservationPricingVersion',
      'requestedProvider',
      'requestedModel',
      'actualProvider',
      'actualModel',
      'providerRequestId',
      'providerRequestSent',
      'reviewReasonCode',
      'consumeTransactionId',
    ]) {
      assert.ok(names.has(expected), `expected column ${expected}`);
    }

    for (const legacy of ['provider', 'model', 'failureReason', 'reviewReason']) {
      assert.equal(names.has(legacy), false, `legacy column ${legacy} must not exist`);
    }
  });

  test('101. migration hardened the indexes on the billing operation table', async () => {
    const indexes = (await prisma.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'AIBillingOperation'`,
    )) as { indexname: string }[];

    const names = new Set(indexes.map((i) => i.indexname));

    assert.ok(names.has('AIBillingOperation_pkey'));
    assert.ok(names.has('AIBillingOperation_operationId_key'));
    assert.ok(names.has('AIBillingOperation_reservationId_key'));
    assert.ok(names.has('AIBillingOperation_status_updatedAt_idx'));
    assert.ok(names.has('AIBillingOperation_walletId_status_idx'));
    assert.ok(names.has('AIBillingOperation_userId_createdAt_idx'));
  });

  test('102. createAIBillingOperation does not mutate the wallet balance', async () => {
    const { userId, walletId } = await createUserWithWallet(50);
    const { reservationId } = await createReservation(userId, 10);
    const operationId = `op-${crypto.randomUUID()}`;

    try {
      const before = await prisma.tokenWallet.findUniqueOrThrow({ where: { id: walletId } });
      const created = await createAIBillingOperation({ operationId, reservationId });
      assert.equal(created.status, AIBillingOperationStatus.RESERVED);
      const after = await prisma.tokenWallet.findUniqueOrThrow({ where: { id: walletId } });
      assert.equal(after.tokenBalance, before.tokenBalance);
      assert.equal(after.reservedBalance, before.reservedBalance);
    } finally {
      await cleanupUser(userId);
    }
  });
});
