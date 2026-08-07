/**
 * Phase 2G-A real PostgreSQL billing-outcomes tests for the usage-based AI
 * Wallet coordinator (`runUsageBasedAIBilling`).
 *
 * Uses the real durable dependencies (TokenReservation, AIBillingOperation,
 * Wallet) against `core_server_test`. Every fixture is created and cleaned by
 * this suite with a `test_wallet_billing_` email prefix.
 */

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
  AIBillingOperationStatus,
  Gender,
  TokenReservationStatus,
  TokenTransactionSource,
  WalletStatus,
} from '@prisma/client';
import { prisma } from '../src/config/prisma.js';
import { ensureUserRole } from './helpers/test-role-fixtures.js';
import { parseWalletPolicyConfig } from '../src/config/wallet-policy.js';
import { PROVIDER_RATE_CARD } from '../src/config/provider-rate-card/index.js';
import type { ChatLimitsConfig } from '../src/config/chat-limits.js';
import type { WalletPolicyConfig } from '../src/config/wallet-policy.js';
import type { UsageBasedBillingInput } from '../src/types/usage-based-ai-billing.js';
import { runUsageBasedAIBilling } from '../src/services/usage-based-ai-billing.service.js';

const WALLET_POLICY: WalletPolicyConfig = parseWalletPolicyConfig({});
const CHAT_LIMITS: ChatLimitsConfig = {
  maxInputTokens: 12000,
  maxCurrentMessageTokens: 3000,
  maxMessageCharacters: 10000,
  maxRecentMessages: 10,
  historyTokenBudget: 5500,
  summaryTokenBudget: 1000,
  maxOutputTokens: 1200,
  inputHeadroomTokens: 12000 - 3000 - 5500 - 1000,
};

const FEATURE = 'AI_CHAT_QUERY' as const;
const SOURCE = TokenTransactionSource.CHAT;

/** gemini-3.5-flash-lite 100 in / 50 out -> 155_000 nano-USD -> 2 Wallet Tokens. */
const PRICED_CALL = {
  provider: 'google',
  providerCallMade: true,
  providerCallId: 'priced-call-1',
  actualModel: 'gemini-3.5-flash-lite',
  inputTokens: 100,
  outputTokens: 50,
};

const UNPRICED_CALL = {
  provider: 'openai',
  providerCallMade: true,
  providerCallId: 'unpriced-call-1',
  actualModel: 'gpt-4o',
  inputTokens: 10,
  outputTokens: 10,
};

interface ExecContext {
  operationId: string;
  reservationId: string;
}

describe('Usage-based AI Wallet billing outcomes (real PostgreSQL)', () => {
  let USER_ROLE_ID: number;

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
    const emailFilter = { email: { startsWith: 'test_wallet_billing_' } };
    const userIds = (await prisma.user.findMany({ where: emailFilter, select: { id: true } })).map(
      (u) => u.id,
    );
    if (userIds.length > 0) {
      await prisma.aIBillingOperation.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.tokenReservation.deleteMany({ where: { userId: { in: userIds } } });
    }
    await prisma.tokenTransaction.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenWallet.deleteMany({ where: { user: emailFilter } });
    await prisma.user.deleteMany({ where: emailFilter });
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
        roleId: USER_ROLE_ID,
        email: `test_wallet_billing_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Wallet Billing User',
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

  function buildInput(overrides: Partial<UsageBasedBillingInput> = {}): UsageBasedBillingInput {
    return {
      operationId: `usage:AI_CHAT_QUERY:${crypto.randomUUID()}`,
      userId: 'unset',
      feature: FEATURE,
      source: SOURCE,
      idempotencyKey: crypto.randomUUID(),
      adminExempt: false,
      provider: 'google',
      model: 'gemini-3.5-flash-lite',
      chatLimits: CHAT_LIMITS,
      rateCard: PROVIDER_RATE_CARD,
      walletPolicy: WALLET_POLICY,
      execute: async () => ({
        kind: 'SUCCESS',
        data: { providerCalls: [PRICED_CALL] },
        execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
        usage: {
          provider: 'google',
          model: 'gemini-3.5-flash-lite',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      }),
      ...overrides,
    };
  }

  async function walletState(userId: string) {
    return prisma.tokenWallet.findUnique({ where: { userId } });
  }

  // --- SUCCESS / FULLY_PRICED ----------------------------------------------

  test('1. SUCCESS + FULLY_PRICED settles, charges priced tokens, and executes AI once', async () => {
    const { userId } = await createUserWithWallet(1000);
    const contexts: ExecContext[] = [];
    try {
      const input = buildInput({
        userId,
        execute: async (ctx) => {
          contexts.push(ctx);
          return {
            kind: 'SUCCESS',
            data: { providerCalls: [PRICED_CALL] },
            execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
            usage: {
              provider: 'google',
              model: 'gemini-3.5-flash-lite',
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
            },
          };
        },
      });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'SETTLED');
      assert.equal(result.actualWalletTokens, 2);
      assert.equal(result.recoveryRequired, false);
      assert.equal(result.billing.actualTokens, 2);
      assert.equal(result.billing.releasedTokens, 998);
      assert.equal(result.billing.consumedTokens, 2);
      assert.equal(result.billing.pricedCostNanoUsd, '155000');
      assert.equal(result.billing.requestedMode, 'USAGE_BASED');

      assert.equal(contexts.length, 1);
      assert.equal(contexts[0].operationId, input.operationId);
      assert.equal(contexts[0].reservationId, result.reservationId);

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 998);
      assert.equal(wallet.reservedBalance, 0);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.COMPLETED);

      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId: input.operationId },
      });
      assert.ok(operation);
      assert.equal(operation.status, AIBillingOperationStatus.SETTLED);
      assert.equal(operation.actualWalletTokens, 2);
      assert.equal(operation.consumeTransactionId, result.billing.consumeTransactionId);

      const consume = await prisma.tokenTransaction.findUnique({
        where: { id: result.billing.consumeTransactionId },
      });
      assert.ok(consume);
      assert.equal(consume.type, 'CONSUME');
      assert.equal(consume.tokens, 2);
    } finally {
      await cleanupUser(userId);
    }
  });

  // --- PARTIALLY_PRICED -----------------------------------------------------

  test('2. SUCCESS + PARTIALLY_PRICED settles charged priced calls and records exposure', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const input = buildInput({
        userId,
        execute: async () => ({
          kind: 'SUCCESS',
          data: { providerCalls: [PRICED_CALL, UNPRICED_CALL] },
          execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
          usage: {
            provider: 'google',
            model: 'gemini-3.5-flash-lite',
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          },
        }),
      });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'SETTLED');
      assert.equal(result.actualWalletTokens, 2);
      assert.equal(result.recoveryRequired, false);

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 998);
      assert.equal(wallet.reservedBalance, 0);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.COMPLETED);
      const exposure = reservation.metadata as {
        unresolvedCostExposure?: {
          pricedCallCount: number;
          unpricedCallCount: number;
          pricedCostNanoUsd: string;
          markedUpNanoUsd: string;
          walletTokens: string;
        };
      };
      assert.ok(exposure.unresolvedCostExposure, 'unresolved exposure must be recorded');
      assert.equal(exposure.unresolvedCostExposure.pricedCallCount, 1);
      assert.equal(exposure.unresolvedCostExposure.unpricedCallCount, 1);
      assert.equal(exposure.unresolvedCostExposure.walletTokens, '2');
    } finally {
      await cleanupUser(userId);
    }
  });

  // --- UNPRICED --------------------------------------------------------------

  test('3. SUCCESS + UNPRICED never auto-deducts and requires recovery', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const input = buildInput({
        userId,
        execute: async () => ({
          kind: 'SUCCESS',
          data: { providerCalls: [UNPRICED_CALL] },
          execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
          usage: {
            provider: 'google',
            model: 'gemini-3.5-flash-lite',
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          },
        }),
      });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'RECOVERY_REQUIRED');
      assert.equal(result.reasonCode, 'UNPRICED_PROVIDER_CALLS');
      assert.equal(result.stage, 'PRICING');
      assert.equal(result.operationStatus, AIBillingOperationStatus.EXECUTION_SUCCEEDED);

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 0);
      assert.equal(wallet.reservedBalance, 1000);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);

      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId: input.operationId },
      });
      assert.ok(operation);
      assert.equal(operation.status, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  // --- NON_BILLABLE_FAILURE -------------------------------------------------

  test('4. NON_BILLABLE_FAILURE releases the reservation and refunds the wallet', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const input = buildInput({
        userId,
        execute: async () => ({
          kind: 'NON_BILLABLE_FAILURE',
          code: 'AI_SERVICE_UNAVAILABLE',
          message: 'provider unavailable',
          providerRequestSent: false,
          retryable: true,
        }),
      });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'RELEASED');
      assert.equal(result.failureCode, 'AI_SERVICE_UNAVAILABLE');
      assert.equal(result.adminExempt, false);
      assert.equal(result.recoveryRequired, false);

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 1000);
      assert.equal(wallet.reservedBalance, 0);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.RELEASED);

      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId: input.operationId },
      });
      assert.ok(operation);
      assert.equal(operation.status, AIBillingOperationStatus.RELEASED);
      assert.equal(operation.failureCode, 'AI_SERVICE_UNAVAILABLE');
    } finally {
      await cleanupUser(userId);
    }
  });

  // --- INDETERMINATE_FAILURE ------------------------------------------------

  test('5. INDETERMINATE_FAILURE is never auto-released and requires recovery', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const input = buildInput({
        userId,
        execute: async () => ({
          kind: 'INDETERMINATE_FAILURE',
          code: 'STREAM_INTERRUPTED',
          message: 'stream interrupted mid-flight',
          providerRequestSent: true,
          retryable: false,
        }),
      });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'RECOVERY_REQUIRED');
      assert.equal(result.reasonCode, 'INDETERMINATE_EXECUTION');
      assert.equal(result.stage, 'EXECUTION');
      assert.equal(result.operationStatus, AIBillingOperationStatus.INDETERMINATE);

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 0);
      assert.equal(wallet.reservedBalance, 1000);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);

      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId: input.operationId },
      });
      assert.ok(operation);
      assert.equal(operation.status, AIBillingOperationStatus.INDETERMINATE);
    } finally {
      await cleanupUser(userId);
    }
  });

  // --- Cache hit (explicit empty providerCalls) ------------------------------

  test('6. Cache hit (explicit empty providerCalls) settles zero and returns the reservation', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const input = buildInput({
        userId,
        execute: async () => ({
          kind: 'SUCCESS',
          data: { providerCalls: [] },
          execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
          usage: {
            provider: 'google',
            model: 'gemini-3.5-flash-lite',
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          },
        }),
      });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'SETTLED');
      assert.equal(result.actualWalletTokens, 0);
      assert.equal(result.billing.releasedTokens, 1000);

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 1000);
      assert.equal(wallet.reservedBalance, 0);

      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId: input.operationId },
      });
      assert.ok(operation);
      assert.equal(operation.status, AIBillingOperationStatus.SETTLED);
      assert.equal(operation.actualWalletTokens, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  // --- Absent providerCalls --------------------------------------------------

  test('7. Absent providerCalls is NOT a cache hit: recovery, never zero-charge', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const input = buildInput({
        userId,
        execute: async () => ({
          kind: 'SUCCESS',
          data: { text: 'no provider calls here' },
          execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
          usage: {
            provider: 'google',
            model: 'gemini-3.5-flash-lite',
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          },
        }),
      });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'RECOVERY_REQUIRED');
      assert.equal(result.reasonCode, 'UNPRICED_PROVIDER_CALLS');

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 0);
      assert.equal(wallet.reservedBalance, 1000);

      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId: input.operationId },
      });
      assert.ok(operation);
      assert.equal(operation.status, AIBillingOperationStatus.EXECUTION_SUCCEEDED);
    } finally {
      await cleanupUser(userId);
    }
  });

  // --- Insufficient balance ---------------------------------------------------

  test('8. Insufficient balance is denied with 402 and reserves nothing', async () => {
    const { userId } = await createUserWithWallet(500);
    try {
      const input = buildInput({ userId });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'RESERVATION_DENIED');
      assert.equal(result.reason, 'INSUFFICIENT_BALANCE');
      assert.equal(result.httpStatus, 402);

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 500);
      assert.equal(wallet.reservedBalance, 0);
      assert.equal(await prisma.tokenReservation.count({ where: { userId } }), 0);
      assert.equal(await prisma.aIBillingOperation.count({ where: { userId } }), 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  // --- Replay / idempotency --------------------------------------------------

  test('9. A replayed operationId is blocked, never double-charges, and AI runs once', async () => {
    const { userId } = await createUserWithWallet(1000);
    let executeCount = 0;
    try {
      const operationId = `usage:AI_CHAT_QUERY:${crypto.randomUUID()}`;
      const idempotencyKey = crypto.randomUUID();
      const run = () =>
        runUsageBasedAIBilling(
          buildInput({
            userId,
            operationId,
            idempotencyKey,
            execute: async () => {
              executeCount += 1;
              return {
                kind: 'SUCCESS',
                data: { providerCalls: [PRICED_CALL] },
                execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
                usage: {
                  provider: 'google',
                  model: 'gemini-3.5-flash-lite',
                  inputTokens: 100,
                  outputTokens: 50,
                  totalTokens: 150,
                },
              };
            },
          }),
        );

      const first = await run();
      assert.equal(first.outcome, 'SETTLED');
      assert.equal(executeCount, 1);

      const second = await run();
      assert.equal(second.outcome, 'RECOVERY_REQUIRED');
      assert.equal(second.reasonCode, 'OPERATION_REPLAY_REQUIRES_RECOVERY');
      assert.equal(second.stage, 'PREFLIGHT');
      assert.equal(executeCount, 1);

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 998);
      assert.equal(wallet.reservedBalance, 0);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 1);
    } finally {
      await cleanupUser(userId);
    }
  });

  // --- Usage limits -----------------------------------------------------------

  test('10. SUCCESS with usage above the configured limits requires recovery', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const input = buildInput({
        userId,
        execute: async () => ({
          kind: 'SUCCESS',
          data: { providerCalls: [PRICED_CALL] },
          execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
          usage: {
            provider: 'google',
            model: 'gemini-3.5-flash-lite',
            inputTokens: 13000,
            outputTokens: 50,
            totalTokens: 13050,
          },
        }),
      });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'RECOVERY_REQUIRED');
      assert.equal(result.reasonCode, 'USAGE_LIMITS_EXCEEDED');
      assert.equal(result.stage, 'USAGE_VALIDATION');
      assert.equal(result.operationStatus, AIBillingOperationStatus.EXECUTION_SUCCEEDED);

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 0);
      assert.equal(wallet.reservedBalance, 1000);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId } }), 0);
    } finally {
      await cleanupUser(userId);
    }
  });
});
