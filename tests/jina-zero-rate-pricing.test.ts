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
import { priceProviderCall } from '../src/utils/provider-pricing/price-call.js';
import { aggregateProviderCalls } from '../src/utils/provider-pricing/aggregate.js';
import { runUsageBasedAIBilling } from '../src/services/usage-based-ai-billing.service.js';
import type { ChatLimitsConfig } from '../src/config/chat-limits.js';
import type { WalletPolicyConfig } from '../src/config/wallet-policy.js';
import type { UsageBasedBillingInput } from '../src/types/usage-based-ai-billing.js';

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

const PRICED_GOOGLE_CALL = {
  provider: 'google',
  providerCallMade: true,
  providerCallId: 'google-call-1',
  actualModel: 'gemini-3.5-flash-lite',
  inputTokens: 100,
  outputTokens: 50,
};

const JINA_V4_CALL = {
  provider: 'jina',
  providerCallMade: true,
  providerCallId: 'jina-call-1',
  actualModel: 'jina-embeddings-v4',
  inputTokens: 100,
};

const UNKNOWN_JINA_CALL = {
  provider: 'jina',
  providerCallMade: true,
  providerCallId: 'jina-call-2',
  actualModel: 'jina-unknown-model',
  inputTokens: 100,
};

describe('Jina v4 explicit zero-rate pricing & Wallet integration', () => {
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
    const emailFilter = { email: { startsWith: 'test_jina_pricing_' } };
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

  async function createUserWithWallet(
    balance: number,
  ): Promise<{ userId: string; walletId: string }> {
    const user = await prisma.user.create({
      data: {
        roleId: USER_ROLE_ID,
        email: `test_jina_pricing_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'Jina Pricing User',
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

  // 1. Explicit Jina v4 zero rate
  test('1. Explicit Jina v4 zero rate: FULLY_PRICED, pricedCallCount = 1, cost = 0', () => {
    const r = aggregateProviderCalls({
      providerCalls: [JINA_V4_CALL],
      pricingDate: '2026-08-03',
    });
    assert.equal(r.summaryStatus, 'FULLY_PRICED');
    assert.equal(r.totals.callCount, 1);
    assert.equal(r.totals.pricedCallCount, 1);
    assert.equal(r.totals.unpricedCallCount, 0);
    assert.equal(r.totals.pricedCostNanoUsd, 0n);
  });

  // 2. Unknown Jina model
  test('2. Unknown Jina model: remains UNPRICED', () => {
    const r = aggregateProviderCalls({
      providerCalls: [UNKNOWN_JINA_CALL],
      pricingDate: '2026-08-03',
    });
    assert.equal(r.summaryStatus, 'UNPRICED');
    assert.equal(r.totals.callCount, 1);
    assert.equal(r.totals.pricedCallCount, 0);
    assert.equal(r.totals.unpricedCallCount, 1);
    assert.equal(r.totals.unpricedReasons['ACTUAL_MODEL_NOT_IN_RATECARD'], 1);
  });

  // 3. Jina + Google aggregation
  test('3. Jina + Google aggregation: 2 priced calls, total cost equals Google cost', () => {
    const googleOnly = aggregateProviderCalls({
      providerCalls: [PRICED_GOOGLE_CALL],
      pricingDate: '2026-08-03',
    });

    const combined = aggregateProviderCalls({
      providerCalls: [JINA_V4_CALL, PRICED_GOOGLE_CALL],
      pricingDate: '2026-08-03',
    });

    assert.equal(combined.summaryStatus, 'FULLY_PRICED');
    assert.equal(combined.totals.callCount, 2);
    assert.equal(combined.totals.pricedCallCount, 2);
    assert.equal(combined.totals.unpricedCallCount, 0);
    assert.equal(combined.totals.pricedCostNanoUsd, googleOnly.totals.pricedCostNanoUsd);
  });

  // 4. Wallet integration regression
  test('4. Wallet integration: Jina + Google settles normally with same Wallet charge as Google-only', async () => {
    const { userId: user1 } = await createUserWithWallet(1000);
    const { userId: user2 } = await createUserWithWallet(1000);

    // Run Google-only billing
    const googleInput: UsageBasedBillingInput = {
      operationId: `usage:AI_CHAT_QUERY:${crypto.randomUUID()}`,
      userId: user1,
      feature: 'AI_CHAT_QUERY',
      source: TokenTransactionSource.CHAT,
      idempotencyKey: crypto.randomUUID(),
      adminExempt: false,
      provider: 'google',
      model: 'gemini-3.5-flash-lite',
      chatLimits: CHAT_LIMITS,
      rateCard: PROVIDER_RATE_CARD,
      walletPolicy: WALLET_POLICY,
      execute: async () => ({
        kind: 'SUCCESS',
        data: { providerCalls: [PRICED_GOOGLE_CALL] },
        execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
        usage: { provider: 'google', model: 'gemini-3.5-flash-lite', inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    };
    const googleResult = await runUsageBasedAIBilling(googleInput);
    assert.equal(googleResult.outcome, 'SETTLED');

    // Run Jina + Google combined billing
    const combinedInput: UsageBasedBillingInput = {
      operationId: `usage:AI_CHAT_QUERY:${crypto.randomUUID()}`,
      userId: user2,
      feature: 'AI_CHAT_QUERY',
      source: TokenTransactionSource.CHAT,
      idempotencyKey: crypto.randomUUID(),
      adminExempt: false,
      provider: 'google',
      model: 'gemini-3.5-flash-lite',
      chatLimits: CHAT_LIMITS,
      rateCard: PROVIDER_RATE_CARD,
      walletPolicy: WALLET_POLICY,
      execute: async () => ({
        kind: 'SUCCESS',
        data: { providerCalls: [JINA_V4_CALL, PRICED_GOOGLE_CALL] },
        execution: { provider: 'google', model: 'gemini-3.5-flash-lite' },
        usage: { provider: 'google', model: 'gemini-3.5-flash-lite', inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    };
    const combinedResult = await runUsageBasedAIBilling(combinedInput);
    assert.equal(combinedResult.outcome, 'SETTLED');

    if (googleResult.outcome === 'SETTLED' && combinedResult.outcome === 'SETTLED') {
      assert.equal(combinedResult.actualWalletTokens, googleResult.actualWalletTokens);
    }

    const wallet1 = await prisma.tokenWallet.findUnique({ where: { userId: user1 } });
    const wallet2 = await prisma.tokenWallet.findUnique({ where: { userId: user2 } });
    assert.ok(wallet1);
    assert.ok(wallet2);

    // Exact equal deduction in balance and zero leftover reserved balance
    assert.equal(wallet2.reservedBalance, 0);
    assert.equal(wallet2.tokenBalance, wallet1.tokenBalance);

    const res1 = await prisma.tokenReservation.findFirst({ where: { userId: user1 } });
    const res2 = await prisma.tokenReservation.findFirst({ where: { userId: user2 } });
    assert.equal(res1?.status, TokenReservationStatus.COMPLETED);
    assert.equal(res2?.status, TokenReservationStatus.COMPLETED);

    const op1 = await prisma.aIBillingOperation.findFirst({ where: { userId: user1 } });
    const op2 = await prisma.aIBillingOperation.findFirst({ where: { userId: user2 } });
    assert.equal(op1?.status, AIBillingOperationStatus.SETTLED);
    assert.equal(op2?.status, AIBillingOperationStatus.SETTLED);
  });

  // 5. Explicit zero rate vs missing rate
  test('5. Explicit zero rate vs missing rate: zero = PRICED (cost 0), missing = UNPRICED', () => {
    const ctx = { card: PROVIDER_RATE_CARD, pricingDate: '2026-08-03' };

    const zeroRes = priceProviderCall(
      { provider: 'jina', providerCallId: 'p1', actualModel: 'jina-embeddings-v4', inputTokens: 100 },
      ctx,
    );
    assert.equal(zeroRes.kind, 'PRICED');
    if (zeroRes.kind === 'PRICED') {
      assert.equal(zeroRes.costNanoUsd, 0n);
    }

    const missingRes = priceProviderCall(
      { provider: 'jina', providerCallId: 'p2', actualModel: 'jina-nonexistent', inputTokens: 100 },
      ctx,
    );
    assert.equal(missingRes.kind, 'UNPRICED');
    if (missingRes.kind === 'UNPRICED') {
      assert.equal(missingRes.reason, 'ACTUAL_MODEL_NOT_IN_RATECARD');
    }
  });
});
