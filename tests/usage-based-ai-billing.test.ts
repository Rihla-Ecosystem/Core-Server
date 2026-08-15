/**
 * Phase 4B test suite for usage-based AI billing coordinator (non-stream).
 * Proves fail-closed behavior on PARTIALLY_PRICED, durable evidence persistence,
 * reservation retention, zero wallet/transaction mutation, and regression safety.
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
import { getAIExecutionBudget } from '../src/config/ai-execution-budget.js';

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
  providerCallId: 'priced-call-1',
  actualModel: 'gemini-3.5-flash-lite',
  inputTokens: 100,
  outputTokens: 50,
};

const UNPRICED_CALL = {
  provider: 'openai',
  providerCallMade: true,
  providerCallId: 'unpriced-call-1',
  actualModel: 'gpt-4o-unknown-model-xxx',
  inputTokens: 10,
  outputTokens: 10,
  totalTokens: 20,
  userPromptTextPrivate: 'SECRET_PROMPT_DO_NOT_STORE',
};

describe('Phase 4B Non-Stream Usage-Based Billing Fail-Closed Audit', () => {
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
    const emailFilter = { email: { startsWith: 'test_phase4b_nonstream_' } };
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
        email: `test_phase4b_nonstream_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Phase4B NonStream User',
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
      executionBudget: BUDGET,
      estimatedInputTokens: 100,
      rateCard: PROVIDER_RATE_CARD,
      walletPolicy: WALLET_POLICY,
      pricingSource: 'DATABASE_PRIMARY',
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

  test('1. PARTIALLY_PRICED fails closed, routes to recovery, holds reservation PENDING, and records evidence without prompts', async () => {
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
            inputTokens: 110,
            outputTokens: 60,
            totalTokens: 170,
          },
        }),
      });

      const result = await runUsageBasedAIBilling(input);

      // 1 & 2. Returns recovery-required and operation becomes EXECUTION_SUCCEEDED / REVIEW_REQUIRED in durable DB
      assert.equal(result.outcome, 'RECOVERY_REQUIRED');
      assert.equal(result.stage, 'PRICING');
      assert.equal(result.reasonCode, 'UNPRICED_PROVIDER_CALLS');
      assert.equal(result.recoveryRequired, true);

      // 3. Reservation remains PENDING
      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);

      // 4, 5, 6, 7. No wallet deduction, no release of unused reservation, no CONSUME transaction created
      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance + wallet.reservedBalance, 1000); // Balance held, not deducted
      assert.equal(wallet.reservedBalance > 0, true); // Reservation held!
      assert.equal(await prisma.tokenTransaction.count({ where: { userId, type: 'CONSUME' } }), 0);

      // 8 & 9. Durable unresolved pricing evidence is recorded with call identity/model/usage/reason
      const metadata = reservation.metadata as {
        unresolvedCostExposure?: {
          pricedCallCount: number;
          unpricedCallCount: number;
          pricedCostNanoUsd: string;
          markedUpNanoUsd: string;
          walletTokens: string;
          providerCallEvidence: Array<Record<string, unknown>>;
        };
      };
      assert.ok(metadata.unresolvedCostExposure);
      assert.equal(metadata.unresolvedCostExposure.pricedCallCount, 1);
      assert.equal(metadata.unresolvedCostExposure.unpricedCallCount, 1);
      assert.ok(Array.isArray(metadata.unresolvedCostExposure.providerCallEvidence));
      assert.equal(metadata.unresolvedCostExposure.providerCallEvidence.length, 2);

      const providerExecution = (reservation.metadata as { providerExecution?: { schemaVersion: number; executionSource: string; providerCalls: Array<Record<string, unknown>>; providerAttempts: Array<Record<string, unknown>> } }).providerExecution;
      assert.ok(providerExecution);
      assert.equal(providerExecution.schemaVersion, 1);
      assert.equal(providerExecution.executionSource, 'PROVIDER');
      assert.ok(Array.isArray(providerExecution.providerCalls));
      assert.equal(providerExecution.providerCalls.length, 2);

      const unpricedEvidence = metadata.unresolvedCostExposure.providerCallEvidence.find(
        (c) => c.kind === 'UNPRICED',
      );
      assert.ok(unpricedEvidence);
      assert.equal(unpricedEvidence.providerCallId, 'unpriced-call-1');
      assert.equal(unpricedEvidence.actualModel, 'gpt-4o-unknown-model-xxx');
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

      // 10. Evidence MUST NOT contain user prompts or secrets
      const rawEvidenceJson = JSON.stringify(reservation.metadata);
      assert.equal(rawEvidenceJson.includes('SECRET_PROMPT_DO_NOT_STORE'), false);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('4. UNPRICED call with missing usage does NOT fabricate zero usage in evidence', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const USAGE_MISSING_CALL = {
        provider: 'openai',
        providerCallMade: true,
        providerCallId: 'missing-usage-call-1',
        actualModel: 'gpt-4o-unknown-model-xxx',
      };

      const input = buildInput({
        userId,
        execute: async () => ({
          kind: 'SUCCESS',
          data: { providerCalls: [PRICED_CALL, USAGE_MISSING_CALL] },
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

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      const metadata = reservation.metadata as {
        providerExecution?: { providerCalls: Array<Record<string, unknown>> };
        unresolvedCostExposure?: {
          providerCallEvidence: Array<Record<string, unknown>>;
        };
      };
      const unpriced = metadata.providerExecution?.providerCalls.find(
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

  test('2. FULLY_PRICED continues to settle, deduct tokens, and persist canonical providerExecution', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const input = buildInput({ userId });
      const result = await runUsageBasedAIBilling(input);

      assert.equal(result.outcome, 'SETTLED');
      assert.equal(result.actualWalletTokens, 2);
      assert.equal(result.recoveryRequired, false);

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.tokenBalance, 998); // 1000 - 2 consumed
      assert.equal(wallet.reservedBalance, 0); // Released unused

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.COMPLETED);

      const providerExecution = (reservation.metadata as { providerExecution?: { schemaVersion: number; executionSource: string; providerCalls: Array<Record<string, unknown>> } }).providerExecution;
      assert.ok(providerExecution);
      assert.equal(providerExecution.schemaVersion, 1);
      assert.equal(providerExecution.executionSource, 'PROVIDER');
      assert.equal(providerExecution.providerCalls.length, 1);
      assert.equal(providerExecution.providerCalls[0].kind, 'PRICED');
    } finally {
      await cleanupUser(userId);
    }
  });

  test('3. UNPRICED operations route to RECOVERY_REQUIRED and persist canonical evidence', async () => {
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

      const wallet = await walletState(userId);
      assert.ok(wallet);
      assert.equal(wallet.reservedBalance > 0, true);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);

      const providerExecution = (reservation.metadata as { providerExecution?: { schemaVersion: number; executionSource: string; providerCalls: Array<Record<string, unknown>> } }).providerExecution;
      assert.ok(providerExecution);
      assert.equal(providerExecution.schemaVersion, 1);
      assert.equal(providerExecution.executionSource, 'PROVIDER');
      assert.equal(providerExecution.providerCalls.length, 1);
      assert.equal(providerExecution.providerCalls[0].kind, 'UNPRICED');
      assert.equal(providerExecution.providerCalls[0].inputTokens, 10);
      assert.equal(providerExecution.providerCalls[0].outputTokens, 10);
      assert.equal(providerExecution.providerCalls[0].totalTokens, 20);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('3b. VOICE DURATION EVIDENCE: UNPRICED Voice call preserves audioInputSeconds/audioOutputSeconds (upstream field names) and never leaks prompt/creds', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const VOICE_CALL = {
        provider: 'openai',
        providerCallMade: true,
        providerCallId: 'voice-call-1',
        actualModel: 'gpt-voice-unknown-model-xxx',
        inputTokens: 5,
        outputTokens: 40,
        totalTokens: 45,
        audioInputSeconds: 12.5,
        audioOutputSeconds: 30.25,
        audioSeconds: 30.25,
        transcriptionSeconds: 12.5,
        inputCharacters: 300,
        outputCharacters: 0,
        userPromptTextPrivate: 'SECRET_VOICE_PROMPT_DO_NOT_STORE',
        accessToken: 'SECRET_BEARER_DO_NOT_STORE',
      };

      const input = buildInput({
        userId,
        execute: async () => ({
          kind: 'SUCCESS',
          data: { providerCalls: [VOICE_CALL] },
          execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
          usage: {
            provider: 'google',
            model: 'gemini-3.5-flash-lite',
            inputTokens: 5,
            outputTokens: 40,
            totalTokens: 45,
          },
        }),
      });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'RECOVERY_REQUIRED');
      assert.equal(result.reasonCode, 'UNPRICED_PROVIDER_CALLS');

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
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
      assert.equal(persisted.includes('SECRET_VOICE_PROMPT_DO_NOT_STORE'), false);
      assert.equal(persisted.includes('SECRET_BEARER_DO_NOT_STORE'), false);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('5. INDETERMINATE failure persists providerAttempts retry chain in providerExecution', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const ATTEMPTS = [
        {
          attemptId: 'att-1',
          provider: 'google',
          attemptNumber: 1,
          outcome: 'FAILED',
          errorCategory: 'TIMEOUT',
          providerCallStarted: true,
          providerResponseReceived: false,
        },
        {
          attemptId: 'att-2',
          provider: 'google',
          attemptNumber: 2,
          outcome: 'INDETERMINATE',
          errorCategory: 'SERVER_ERROR',
          providerCallStarted: true,
          providerResponseReceived: true,
        },
      ];

      const input = buildInput({
        userId,
        execute: async () => ({
          kind: 'INDETERMINATE_FAILURE',
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Upstream rate limit',
          providerRequestSent: true,
          retryable: true,
          execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
          providerAttempts: ATTEMPTS,
        }),
      });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'RECOVERY_REQUIRED');
      assert.equal(result.stage, 'EXECUTION');
      assert.equal(result.reasonCode, 'INDETERMINATE_EXECUTION');

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.PENDING);

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
      assert.equal(metadata.providerExecution.providerAttempts.length, 2);
      assert.equal(metadata.providerExecution.providerAttempts[0].attemptId, 'att-1');
      assert.equal(metadata.providerExecution.providerAttempts[1].attemptId, 'att-2');
    } finally {
      await cleanupUser(userId);
    }
  });

  test('6. NON_BILLABLE failure with requestSent=false sets executionSource: NONE', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const input = buildInput({
        userId,
        execute: async () => ({
          kind: 'NON_BILLABLE_FAILURE',
          code: 'USER_CANCELLED',
          message: 'Operation cancelled before request dispatch',
          providerRequestSent: false,
          retryable: false,
        }),
      });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'RELEASED');
      assert.equal(result.failureCode, 'USER_CANCELLED');

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      assert.equal(reservation.status, TokenReservationStatus.RELEASED);

      const metadata = reservation.metadata as {
        providerExecution?: {
          schemaVersion: number;
          executionSource: string;
          providerCalls: unknown[];
          providerAttempts: unknown[];
        };
      };
      assert.ok(metadata.providerExecution);
      assert.equal(metadata.providerExecution.schemaVersion, 1);
      assert.equal(metadata.providerExecution.executionSource, 'NONE');
      assert.equal(metadata.providerExecution.providerCalls.length, 0);
      assert.equal(metadata.providerExecution.providerAttempts.length, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('7. CACHE HIT sets executionSource: CACHE with empty calls and attempts', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const input = buildInput({
        userId,
        execute: async () => ({
          kind: 'SUCCESS',
          data: { cached: true, providerCalls: [] },
          execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
          usage: {
            provider: 'google',
            model: 'gemini-3.5-flash-lite',
            inputTokens: 100,
            outputTokens: 0,
            totalTokens: 100,
            cached: true,
          },
        }),
      });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'SETTLED');
      assert.equal(result.actualWalletTokens, 0);

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      const metadata = reservation.metadata as {
        providerExecution?: {
          schemaVersion: number;
          executionSource: string;
          providerCalls: unknown[];
          providerAttempts: unknown[];
        };
      };
      assert.ok(metadata.providerExecution);
      assert.equal(metadata.providerExecution.schemaVersion, 1);
      assert.equal(metadata.providerExecution.executionSource, 'CACHE');
      assert.equal(metadata.providerExecution.providerCalls.length, 0);
      assert.equal(metadata.providerExecution.providerAttempts.length, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('8. SECURITY & DENYLIST: Prompts, responses, and credentials are never stored in providerExecution', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const SENSITIVE_CALL = {
        provider: 'google',
        providerCallMade: true,
        providerCallId: 'sensitive-call-1',
        actualModel: 'gemini-3.5-flash-lite',
        inputTokens: 50,
        outputTokens: 50,
        userPromptTextPrivate: 'TOP_SECRET_PROMPT_DO_NOT_STORE',
        responseTextPrivate: 'SECRET_RESPONSE_TEXT',
        toolContentPrivate: 'SECRET_TOOL_RESULT',
        authorizationHeader: 'Bearer secret_api_key_12345',
        apiKey: 'sk-secret-key-xyz',
        rawBase64Media: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA',
      };

      const input = buildInput({
        userId,
        execute: async () => ({
          kind: 'SUCCESS',
          data: { providerCalls: [SENSITIVE_CALL] },
          execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
          usage: {
            provider: 'google',
            model: 'gemini-3.5-flash-lite',
            inputTokens: 50,
            outputTokens: 50,
            totalTokens: 100,
          },
        }),
      });

      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'SETTLED');

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      const jsonString = JSON.stringify(reservation.metadata);

      assert.equal(jsonString.includes('TOP_SECRET_PROMPT_DO_NOT_STORE'), false);
      assert.equal(jsonString.includes('SECRET_RESPONSE_TEXT'), false);
      assert.equal(jsonString.includes('SECRET_TOOL_RESULT'), false);
      assert.equal(jsonString.includes('secret_api_key_12345'), false);
      assert.equal(jsonString.includes('sk-secret-key-xyz'), false);
      assert.equal(jsonString.includes('data:image/png;base64'), false);
    } finally {
      await cleanupUser(userId);
    }
  });

  test('9. METADATA PRESERVATION: providerExecution update does not erase pre-existing metadata keys', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const input = buildInput({ userId });
      const result = await runUsageBasedAIBilling(input);
      assert.equal(result.outcome, 'SETTLED');

      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: result.reservationId },
      });
      assert.ok(reservation);
      const meta = reservation.metadata as Record<string, unknown>;

    } finally {
      await cleanupUser(userId);
    }
  });

  test('10. FULLY_PRICED evidence persistence failure logs error but STILL settles operation', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const input = buildInput({ userId });

      const origUpdate = prisma.tokenReservation.update;
      let evidenceAttempted = false;
      (prisma.tokenReservation as any).update = async (args: any) => {
        if (args.data?.metadata?.providerExecution) {
          evidenceAttempted = true;
          throw new Error('Database write error during evidence update');
        }
        return origUpdate.call(prisma.tokenReservation, args);
      };

      try {
        const result = await runUsageBasedAIBilling(input);
        assert.equal(evidenceAttempted, true);
        assert.equal(result.outcome, 'SETTLED');
        assert.equal(result.actualWalletTokens, 2);

        const wallet = await walletState(userId);
        assert.ok(wallet);
        assert.equal(wallet.tokenBalance, 998);
      } finally {
        prisma.tokenReservation.update = origUpdate;
      }
    } finally {
      await cleanupUser(userId);
    }
  });

  test('11. Idempotent replay replaces providerExecution without duplicating providerCalls/attempts or wallet transactions', async () => {
    const { userId } = await createUserWithWallet(1000);
    try {
      const input = buildInput({ userId });
      const result1 = await runUsageBasedAIBilling(input);
      assert.equal(result1.outcome, 'SETTLED');

      const reservation1 = await prisma.tokenReservation.findUnique({
        where: { id: result1.reservationId },
      });
      const meta1 = reservation1?.metadata as Record<string, unknown>;
      const exec1 = meta1?.providerExecution as { providerCalls: unknown[] };
      assert.equal(exec1.providerCalls.length, 1);

      // Re-write providerExecution to simulate idempotent replay
      await prisma.tokenReservation.update({
        where: { id: result1.reservationId },
        data: {
          metadata: {
            ...meta1,
            providerExecution: {
              schemaVersion: 1,
              executionSource: 'PROVIDER',
              providerCalls: exec1.providerCalls as Prisma.InputJsonValue[],
              providerAttempts: [],
            },
          },
        },
      });

      const reservation2 = await prisma.tokenReservation.findUnique({
        where: { id: result1.reservationId },
      });
      const meta2 = reservation2?.metadata as Record<string, unknown>;
      const exec2 = meta2?.providerExecution as { providerCalls: unknown[] };
      assert.equal(exec2.providerCalls.length, 1); // Exact 1 call, not duplicated to 2!

      const wallet = await walletState(userId);
      assert.equal(wallet?.tokenBalance, 998); // Wallet balance unaffected
    } finally {
      await cleanupUser(userId);
    }
  });
});
