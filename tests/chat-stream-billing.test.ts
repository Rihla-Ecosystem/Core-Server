/**
 * Phase 4B test suite for streaming chat usage-based billing (`chat-stream-billing.service.ts`).
 * Proves fail-closed behavior on PARTIALLY_PRICED stream settlement, durable evidence persistence,
 * reservation retention, zero wallet/transaction mutation, and FULLY_PRICED / UNPRICED regression safety.
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
import { getAIExecutionBudget } from '../src/config/ai-execution-budget.js';
import {
  beginChatStreamUsageBasedBilling,
  settleChatStreamUsageBasedBilling,
} from '../src/services/chat-stream-billing.service.js';

const WALLET_POLICY: WalletPolicyConfig = parseWalletPolicyConfig({});
const CHAT_RESERVATION = WALLET_POLICY.maxReservationTokensByFeature.AI_CHAT_QUERY;
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
const BUDGET = getAIExecutionBudget(FEATURE);

const PRICED_CALL = {
  provider: 'google',
  providerCallMade: true,
  providerCallId: 'stream-priced-1',
  actualModel: 'gemini-3.5-flash-lite',
  inputTokens: 100,
  outputTokens: 50,
};

const UNPRICED_CALL = {
  provider: 'openai',
  providerCallMade: true,
  providerCallId: 'stream-unpriced-1',
  actualModel: 'gpt-4o-unknown-model-stream',
  inputTokens: 10,
  outputTokens: 10,
  totalTokens: 20,
  userPromptTextPrivate: 'SECRET_STREAM_PROMPT_DO_NOT_STORE',
};

describe('Phase 4B Streaming Chat Usage-Based Billing Fail-Closed Audit', () => {
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
    const emailFilter = { email: { startsWith: 'test_phase4b_stream_' } };
    const userIds = (await prisma.user.findMany({ where: emailFilter, select: { id: true } })).map(
      (u) => u.id,
    );
    if (userIds.length > 0) {
      await prisma.aIBillingOperation.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.tokenReservationFundingAllocation.deleteMany({
        where: { reservation: { userId: { in: userIds } } },
      });
      await prisma.tokenReservation.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.tokenFundingLot.deleteMany({ where: { userId: { in: userIds } } });
    }
    await prisma.tokenTransaction.deleteMany({ where: { user: emailFilter } });
    await prisma.tokenWallet.deleteMany({ where: { user: emailFilter } });
    await prisma.user.deleteMany({ where: emailFilter });
  }

  async function cleanupUser(userId: string): Promise<void> {
    await prisma.aIBillingOperation.deleteMany({ where: { userId } });
    await prisma.tokenReservationFundingAllocation.deleteMany({
      where: { reservation: { userId } },
    });
    await prisma.tokenReservation.deleteMany({ where: { userId } });
    await prisma.tokenFundingLot.deleteMany({ where: { userId } });
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
        email: `test_phase4b_stream_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Phase4B Stream User',
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
    return { userId: user.id, walletId: wallet.id };
  }

  async function walletState(userId: string) {
    return prisma.tokenWallet.findUnique({ where: { userId } });
  }

  test('1. Stream PARTIALLY_PRICED routes to RECOVERY_REQUIRED, holds reservation PENDING, does not mark operation SETTLED, and records evidence', async () => {
    const { userId } = await createUserWithWallet(1000);
    const operationId = `stream:AI_CHAT_QUERY:${crypto.randomUUID()}`;
    const idempotencyKey = crypto.randomUUID();

    try {
      // 1. Begin stream billing (reservation created)
      const context = await beginChatStreamUsageBasedBilling({
        userId,
        feature: FEATURE,
        source: SOURCE,
        idempotencyKey,
        operationId,
        adminExempt: false,
        chatLimits: CHAT_LIMITS,
        executionBudget: BUDGET,
        estimatedInputTokens: 100,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      // 2. Settle stream with PARTIALLY_PRICED provider calls
      const outcome = await settleChatStreamUsageBasedBilling({
        operationId: context.operationId,
        reservationId: context.reservationId,
        userId,
        feature: FEATURE,
        reservedTokens: context.reservedTokens,
        executionBudget: context.executionBudget,
        usage: {
          provider: 'google',
          model: 'gemini-3.5-flash-lite',
          inputTokens: 110,
          outputTokens: 60,
          totalTokens: 170,
        },
        providerCalls: [PRICED_CALL, UNPRICED_CALL],
        chatLimits: CHAT_LIMITS,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      // 1 & 4. Returns RECOVERY_REQUIRED, does NOT return SETTLED
      assert.equal(outcome, 'RECOVERY_REQUIRED');

      // 2. Reservation remains PENDING
      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: context.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);

      // 3 & 4. Operation status is NOT SETTLED; wallet balances remain held
      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId },
      });
      assert.ok(operation);
      assert.notEqual(operation.status, AIBillingOperationStatus.SETTLED);

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance + wallet.reservedBalance, 1000);
      assert.equal(wallet.reservedBalance > 0, true);
      assert.equal(await prisma.tokenTransaction.count({ where: { userId, type: 'CONSUME' } }), 0);

      // 5. Durable per-call billing evidence is recorded
      const metadata = reservation.metadata as {
        providerExecution?: {
          schemaVersion: number;
          executionSource: string;
          providerCalls: Array<Record<string, unknown>>;
          providerAttempts: Array<Record<string, unknown>>;
        };
        unresolvedCostExposure?: {
          pricedCallCount: number;
          unpricedCallCount: number;
          pricedCostNanoUsd: string;
          markedUpNanoUsd: string;
          walletTokens: string;
          providerCallEvidence: Array<Record<string, unknown>>;
        };
      };
      assert.ok(metadata.providerExecution);
      assert.equal(metadata.providerExecution.schemaVersion, 1);
      assert.equal(metadata.providerExecution.executionSource, 'PROVIDER');
      assert.equal(metadata.providerExecution.providerCalls.length, 2);

      assert.ok(metadata.unresolvedCostExposure);
      assert.equal(metadata.unresolvedCostExposure.pricedCallCount, 1);
      assert.equal(metadata.unresolvedCostExposure.unpricedCallCount, 1);
      assert.ok(Array.isArray(metadata.unresolvedCostExposure.providerCallEvidence));
      const unpricedEvidence = metadata.unresolvedCostExposure.providerCallEvidence.find(
        (c) => c.kind === 'UNPRICED',
      );
      assert.ok(unpricedEvidence);
      assert.equal(unpricedEvidence.providerCallId, 'stream-unpriced-1');
      assert.equal(unpricedEvidence.actualModel, 'gpt-4o-unknown-model-stream');
      assert.equal(unpricedEvidence.inputTokens, 10);
      assert.equal(unpricedEvidence.outputTokens, 10);
      assert.equal(unpricedEvidence.totalTokens, 20);
      assert.ok(unpricedEvidence.reason);

      const pricedEvidence = metadata.unresolvedCostExposure.providerCallEvidence.find(
        (c) => c.kind === 'PRICED',
      );
      assert.ok(pricedEvidence);
      assert.ok(pricedEvidence.costNanoUsd);
      assert.ok(pricedEvidence.rateCard);

      const rawJson = JSON.stringify(reservation.metadata);
      assert.equal(rawJson.includes('SECRET_STREAM_PROMPT_DO_NOT_STORE'), false);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('2. Stream UNPRICED call with missing usage does NOT fabricate zero usage in evidence', async () => {
    const { userId } = await createUserWithWallet(1000);
    const operationId = `stream:AI_CHAT_QUERY:${crypto.randomUUID()}`;
    const idempotencyKey = crypto.randomUUID();

    try {
      const USAGE_MISSING_CALL = {
        provider: 'openai',
        providerCallMade: true,
        providerCallId: 'stream-missing-usage-1',
        actualModel: 'gpt-4o-unknown-model-stream',
      };

      const context = await beginChatStreamUsageBasedBilling({
        userId,
        feature: FEATURE,
        source: SOURCE,
        idempotencyKey,
        operationId,
        adminExempt: false,
        chatLimits: CHAT_LIMITS,
        executionBudget: BUDGET,
        estimatedInputTokens: 100,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      const outcome = await settleChatStreamUsageBasedBilling({
        operationId: context.operationId,
        reservationId: context.reservationId,
        userId,
        feature: FEATURE,
        reservedTokens: context.reservedTokens,
        executionBudget: context.executionBudget,
        usage: {
          provider: 'google',
          model: 'gemini-3.5-flash-lite',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        providerCalls: [PRICED_CALL, USAGE_MISSING_CALL],
        chatLimits: CHAT_LIMITS,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      assert.equal(outcome, 'RECOVERY_REQUIRED');

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: context.reservationId },
      });
      assert.ok(reservation);
      const metadata = reservation.metadata as {
        unresolvedCostExposure?: {
          providerCallEvidence: Array<Record<string, unknown>>;
        };
      };
      const unpriced = metadata.unresolvedCostExposure?.providerCallEvidence.find(
        (c) => c.kind === 'UNPRICED',
      );
      assert.ok(unpriced);
      assert.equal(unpriced.inputTokens, undefined);
      assert.equal(unpriced.outputTokens, undefined);
      assert.equal(unpriced.totalTokens, undefined);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('6. FULLY_PRICED stream still settles normally', async () => {
    const { userId } = await createUserWithWallet(1000);
    const operationId = `stream:AI_CHAT_QUERY:${crypto.randomUUID()}`;
    const idempotencyKey = crypto.randomUUID();

    try {
      const context = await beginChatStreamUsageBasedBilling({
        userId,
        feature: FEATURE,
        source: SOURCE,
        idempotencyKey,
        operationId,
        adminExempt: false,
        chatLimits: CHAT_LIMITS,
        executionBudget: BUDGET,
        estimatedInputTokens: 100,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      const outcome = await settleChatStreamUsageBasedBilling({
        operationId: context.operationId,
        reservationId: context.reservationId,
        userId,
        feature: FEATURE,
        reservedTokens: context.reservedTokens,
        executionBudget: context.executionBudget,
        usage: {
          provider: 'google',
          model: 'gemini-3.5-flash-lite',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        providerCalls: [PRICED_CALL],
        chatLimits: CHAT_LIMITS,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      assert.equal(outcome, 'SETTLED');

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 998);
      assert.equal(wallet.reservedBalance, 0);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: context.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.COMPLETED);

      const providerExecution = (reservation.metadata as { providerExecution?: { schemaVersion: number; executionSource: string; providerCalls: unknown[] } }).providerExecution;
      assert.ok(providerExecution);
      assert.equal(providerExecution.schemaVersion, 1);
      assert.equal(providerExecution.executionSource, 'PROVIDER');
      assert.equal(providerExecution.providerCalls.length, 1);

      const operation = await prisma.aIBillingOperation.findUnique({
        where: { operationId },
      });
      assert.ok(operation);
      assert.equal(operation.status, AIBillingOperationStatus.SETTLED);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('7. UNPRICED stream behavior routes to RECOVERY_REQUIRED', async () => {
    const { userId } = await createUserWithWallet(1000);
    const operationId = `stream:AI_CHAT_QUERY:${crypto.randomUUID()}`;
    const idempotencyKey = crypto.randomUUID();

    try {
      const context = await beginChatStreamUsageBasedBilling({
        userId,
        feature: FEATURE,
        source: SOURCE,
        idempotencyKey,
        operationId,
        adminExempt: false,
        chatLimits: CHAT_LIMITS,
        executionBudget: BUDGET,
        estimatedInputTokens: 100,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      const outcome = await settleChatStreamUsageBasedBilling({
        operationId: context.operationId,
        reservationId: context.reservationId,
        userId,
        feature: FEATURE,
        reservedTokens: context.reservedTokens,
        executionBudget: context.executionBudget,
        usage: {
          provider: 'google',
          model: 'gemini-3.5-flash-lite',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        providerCalls: [UNPRICED_CALL],
        chatLimits: CHAT_LIMITS,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      assert.equal(outcome, 'RECOVERY_REQUIRED');

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: context.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('7b. Stream VOICE DURATION EVIDENCE: UNPRICED raw call survives with upstream duration field names and no prompt/cred leak', async () => {
    const { userId } = await createUserWithWallet(1000);
    const operationId = `stream:AI_CHAT_QUERY:${crypto.randomUUID()}`;
    const idempotencyKey = crypto.randomUUID();

    try {
      const VOICE_CALL = {
        provider: 'openai',
        providerCallMade: true,
        providerCallId: 'stream-voice-1',
        actualModel: 'gpt-voice-unknown-model-stream',
        inputTokens: 5,
        outputTokens: 40,
        totalTokens: 45,
        audioInputSeconds: 12.5,
        audioOutputSeconds: 30.25,
        audioSeconds: 30.25,
        transcriptionSeconds: 12.5,
        inputCharacters: 300,
        outputCharacters: 0,
        userPromptTextPrivate: 'SECRET_STREAM_VOICE_PROMPT_DO_NOT_STORE',
        accessToken: 'SECRET_STREAM_BEARER_DO_NOT_STORE',
      };

      const context = await beginChatStreamUsageBasedBilling({
        userId,
        feature: FEATURE,
        source: SOURCE,
        idempotencyKey,
        operationId,
        adminExempt: false,
        chatLimits: CHAT_LIMITS,
        executionBudget: BUDGET,
        estimatedInputTokens: 100,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      const outcome = await settleChatStreamUsageBasedBilling({
        operationId: context.operationId,
        reservationId: context.reservationId,
        userId,
        feature: FEATURE,
        reservedTokens: context.reservedTokens,
        executionBudget: context.executionBudget,
        usage: {
          provider: 'google',
          model: 'gemini-3.5-flash-lite',
          inputTokens: 5,
          outputTokens: 40,
          totalTokens: 45,
        },
        providerCalls: [VOICE_CALL],
        chatLimits: CHAT_LIMITS,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      assert.equal(outcome, 'RECOVERY_REQUIRED');

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: context.reservationId },
      });
      assert.ok(reservation);
      const providerExecution = (reservation.metadata as { providerExecution?: { schemaVersion: number; executionSource: string; providerCalls: Array<Record<string, unknown>> } }).providerExecution;
      assert.ok(providerExecution);
      const call = providerExecution.providerCalls[0];
      assert.equal(call.kind, 'UNPRICED');
      assert.equal(call.audioInputSeconds, 12.5);
      assert.equal(call.audioOutputSeconds, 30.25);
      assert.equal(call.audioSeconds, 30.25);
      assert.equal(call.transcriptionSeconds, 12.5);
      assert.equal(call.inputCharacters, 300);
      assert.equal(call.outputCharacters, 0);
      const persisted = JSON.stringify(providerExecution);
      assert.equal(persisted.includes('SECRET_STREAM_VOICE_PROMPT_DO_NOT_STORE'), false);
      assert.equal(persisted.includes('SECRET_STREAM_BEARER_DO_NOT_STORE'), false);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('8. Stream INDETERMINATE failure persists providerAttempts in providerExecution', async () => {
    const { userId } = await createUserWithWallet(1000);
    const operationId = `stream:AI_CHAT_QUERY:${crypto.randomUUID()}`;
    const idempotencyKey = crypto.randomUUID();

    try {
      const context = await beginChatStreamUsageBasedBilling({
        userId,
        feature: FEATURE,
        source: SOURCE,
        idempotencyKey,
        operationId,
        adminExempt: false,
        chatLimits: CHAT_LIMITS,
        executionBudget: BUDGET,
        estimatedInputTokens: 100,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      const ATTEMPTS = [
        {
          attemptId: 'stream-att-1',
          provider: 'google',
          attemptNumber: 1,
          outcome: 'FAILED',
          errorCategory: 'TIMEOUT',
          providerCallStarted: true,
          providerResponseReceived: false,
        },
      ];

      const outcome = await settleChatStreamUsageBasedBilling({
        operationId: context.operationId,
        reservationId: context.reservationId,
        userId,
        feature: FEATURE,
        reservedTokens: context.reservedTokens,
        executionBudget: context.executionBudget,
        outcome: {
          kind: 'INDETERMINATE_FAILURE',
          code: 'STREAM_ERROR',
          message: 'Stream failed mid-flight',
          providerRequestSent: true,
          retryable: true,
        },
        providerAttempts: ATTEMPTS,
        chatLimits: CHAT_LIMITS,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      assert.equal(outcome, 'RECOVERY_REQUIRED');

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: context.reservationId },
      });
      assert.ok(reservation);
      const metadata = reservation.metadata as {
        providerExecution?: {
          schemaVersion: number;
          executionSource: string;
          providerAttempts: Array<Record<string, unknown>>;
        };
      };
      assert.ok(metadata.providerExecution);
      assert.equal(metadata.providerExecution.schemaVersion, 1);
      assert.equal(metadata.providerExecution.executionSource, 'PROVIDER');
      assert.equal(metadata.providerExecution.providerAttempts.length, 1);
      assert.equal(metadata.providerExecution.providerAttempts[0].attemptId, 'stream-att-1');
    } finally {
      await cleanupUser(userId);
    }
  });

  test('9. Stream NON_BILLABLE failure with requestSent=false sets executionSource: NONE', async () => {
    const { userId } = await createUserWithWallet(1000);
    const operationId = `stream:AI_CHAT_QUERY:${crypto.randomUUID()}`;
    const idempotencyKey = crypto.randomUUID();

    try {
      const context = await beginChatStreamUsageBasedBilling({
        userId,
        feature: FEATURE,
        source: SOURCE,
        idempotencyKey,
        operationId,
        adminExempt: false,
        chatLimits: CHAT_LIMITS,
        executionBudget: BUDGET,
        estimatedInputTokens: 100,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      const outcome = await settleChatStreamUsageBasedBilling({
        operationId: context.operationId,
        reservationId: context.reservationId,
        userId,
        feature: FEATURE,
        reservedTokens: context.reservedTokens,
        executionBudget: context.executionBudget,
        outcome: {
          kind: 'NON_BILLABLE_FAILURE',
          code: 'USER_CANCELLED',
          message: 'Stream cancelled before dispatch',
          providerRequestSent: false,
          retryable: false,
        },
        chatLimits: CHAT_LIMITS,
        rateCard: PROVIDER_RATE_CARD,
        walletPolicy: WALLET_POLICY,
        pricingSource: 'DATABASE_PRIMARY',
      });

      assert.equal(outcome, 'RECOVERY_REQUIRED');

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: context.reservationId },
      });
      assert.ok(reservation);
      const metadata = reservation.metadata as {
        providerExecution?: {
          schemaVersion: number;
          executionSource: string;
        };
      };
      assert.ok(metadata.providerExecution);
      assert.equal(metadata.providerExecution.schemaVersion, 1);
      assert.equal(metadata.providerExecution.executionSource, 'NONE');
    } finally {
      await cleanupUser(userId);
    }
  });
});
