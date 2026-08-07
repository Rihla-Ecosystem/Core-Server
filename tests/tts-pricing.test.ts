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
import { aggregateProviderCalls } from '../src/utils/provider-pricing/aggregate.js';
import { computeWalletCharge } from '../src/utils/wallet-conversion.js';
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

const TTS_MODEL = 'gemini-3.1-flash-tts-preview';

const TTS_CALL = {
  provider: 'google',
  providerCallMade: true,
  providerCallId: 'tts-call-1',
  actualModel: TTS_MODEL,
  inputTokens: 12,
  outputTokens: 250,
  audioOutputTokens: 250,
};

const AUDIO_UNDERSTANDING_CALL = {
  provider: 'google',
  providerCallMade: true,
  providerCallId: 'audio-call-1',
  actualModel: 'gemini-3.6-flash',
  inputTokens: 120,
  outputTokens: 60,
  audioInputTokens: 120,
};

describe('Gemini 3.1 Flash TTS usage-based pricing & Wallet integration', () => {
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
    const emailFilter = { email: { startsWith: 'test_tts_pricing_' } };
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
        email: `test_tts_pricing_${crypto.randomUUID()}@example.com`,
        passwordHash: 'hash',
        displayName: 'TTS Pricing User',
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

  // TEST 1 — TTS CALL PRICING
  test('TEST 1 — TTS Call Pricing: input 12, output 250 => 5_012_000 nUSD ($0.005012) & audioOutputTokens not double-counted', () => {
    const r = aggregateProviderCalls({
      providerCalls: [TTS_CALL],
      pricingDate: '2026-08-03',
    });

    assert.equal(r.summaryStatus, 'FULLY_PRICED');
    assert.equal(r.totals.callCount, 1);
    assert.equal(r.totals.pricedCallCount, 1);
    assert.equal(r.totals.unpricedCallCount, 0);

    // Input: 12 * $1.00 / 1M = 12_000 nUSD
    // Output: 250 * $20.00 / 1M = 5_000_000 nUSD
    // Total = 5_012_000 nUSD
    assert.equal(r.totals.pricedCostNanoUsd, 5_012_000n);

    // Prove audioOutputTokens is NOT double-counted: compare with call omitting audioOutputTokens
    const callWithoutAudioModality = {
      provider: 'google',
      providerCallMade: true,
      providerCallId: 'tts-call-1',
      actualModel: TTS_MODEL,
      inputTokens: 12,
      outputTokens: 250,
    };
    const rWithout = aggregateProviderCalls({
      providerCalls: [callWithoutAudioModality],
      pricingDate: '2026-08-03',
    });
    assert.equal(r.totals.pricedCostNanoUsd, rWithout.totals.pricedCostNanoUsd);
  });

  // TEST 2 — MISSING TTS USAGE IS NOT FREE
  test('TEST 2 — Missing TTS usage is NOT free (returns UNPRICED)', () => {
    const missingCall = {
      provider: 'google',
      providerCallMade: true,
      providerCallId: 'tts-missing',
      actualModel: TTS_MODEL,
    };
    const r = aggregateProviderCalls({
      providerCalls: [missingCall],
      pricingDate: '2026-08-03',
    });

    assert.equal(r.summaryStatus, 'UNPRICED');
    assert.equal(r.totals.callCount, 1);
    assert.equal(r.totals.pricedCallCount, 0);
    assert.equal(r.totals.unpricedCallCount, 1);
    assert.equal(r.totals.unpricedReasons['USAGE_MISSING'], 1);
  });

  // TEST 3 — VOICE AGGREGATION
  test('TEST 3 — Voice Aggregation: Audio Understanding + TTS => aggregate cost = sum of both', () => {
    const audioRes = aggregateProviderCalls({
      providerCalls: [AUDIO_UNDERSTANDING_CALL],
      pricingDate: '2026-08-03',
    });
    const ttsRes = aggregateProviderCalls({
      providerCalls: [TTS_CALL],
      pricingDate: '2026-08-03',
    });

    const combinedRes = aggregateProviderCalls({
      providerCalls: [AUDIO_UNDERSTANDING_CALL, TTS_CALL],
      pricingDate: '2026-08-03',
    });

    assert.equal(combinedRes.summaryStatus, 'FULLY_PRICED');
    assert.equal(combinedRes.totals.callCount, 2);
    assert.equal(combinedRes.totals.pricedCallCount, 2);
    assert.equal(combinedRes.totals.unpricedCallCount, 0);

    const expectedTotalCost = audioRes.totals.pricedCostNanoUsd + ttsRes.totals.pricedCostNanoUsd;
    assert.equal(combinedRes.totals.pricedCostNanoUsd, expectedTotalCost);
  });

  // TEST 4 — WALLET SETTLEMENT
  test('TEST 4 — Wallet Settlement: Voice Audio Understanding + TTS settles normally with exact Wallet tokens derived from aggregate provider cost', async () => {
    const { userId } = await createUserWithWallet(1000);

    // Compute expected charges via authoritative engine & Wallet conversion helper
    const aggregated = aggregateProviderCalls({
      providerCalls: [AUDIO_UNDERSTANDING_CALL, TTS_CALL],
      pricingDate: '2026-08-03',
    });
    const expectedCharge = computeWalletCharge(aggregated, WALLET_POLICY);
    const expectedTokens = Number(expectedCharge.tokens);

    const audioOnlyAggregated = aggregateProviderCalls({
      providerCalls: [AUDIO_UNDERSTANDING_CALL],
      pricingDate: '2026-08-03',
    });
    const expectedAudioOnlyCharge = computeWalletCharge(audioOnlyAggregated, WALLET_POLICY);
    const expectedAudioOnlyTokens = Number(expectedAudioOnlyCharge.tokens);

    // TTS cost increases total provider cost and Wallet tokens
    assert.ok(aggregated.totals.pricedCostNanoUsd > audioOnlyAggregated.totals.pricedCostNanoUsd);
    assert.ok(expectedTokens > expectedAudioOnlyTokens);

    const voiceInput: UsageBasedBillingInput = {
      operationId: `usage:REAL_TIME_TRANSLATION:${crypto.randomUUID()}`,
      userId,
      feature: 'REAL_TIME_TRANSLATION',
      source: TokenTransactionSource.VOICE,
      idempotencyKey: crypto.randomUUID(),
      adminExempt: false,
      provider: 'google',
      model: 'gemini-3.6-flash',
      chatLimits: CHAT_LIMITS,
      rateCard: PROVIDER_RATE_CARD,
      walletPolicy: WALLET_POLICY,
      execute: async () => ({
        kind: 'SUCCESS',
        data: { providerCalls: [AUDIO_UNDERSTANDING_CALL, TTS_CALL] },
        execution: { provider: 'google', model: 'gemini-3.6-flash' },
        usage: {
          provider: 'google',
          model: 'gemini-3.6-flash',
          inputTokens: 120,
          outputTokens: 60,
          totalTokens: 180,
        },
      }),
    };

    const result = await runUsageBasedAIBilling(voiceInput);
    assert.equal(result.outcome, 'SETTLED');

    if (result.outcome === 'SETTLED') {
      assert.equal(result.billing.requestedMode, 'USAGE_BASED');
      assert.equal(result.actualWalletTokens, expectedTokens);
      assert.equal(result.billing.consumedTokens, expectedTokens);
      assert.equal(result.billing.pricedCostNanoUsd, aggregated.totals.pricedCostNanoUsd.toString());
    }

    const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
    assert.ok(wallet);
    assert.equal(wallet.reservedBalance, 0);
    assert.equal(wallet.tokenBalance, 1000 - expectedTokens);

    const reservation = await prisma.tokenReservation.findFirst({ where: { userId } });
    assert.equal(reservation?.status, TokenReservationStatus.COMPLETED);

    const operation = await prisma.aIBillingOperation.findFirst({ where: { userId } });
    assert.equal(operation?.status, AIBillingOperationStatus.SETTLED);
  });
});
