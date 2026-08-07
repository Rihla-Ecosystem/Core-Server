/**
 * Phase 2F-D unit tests for the pure shadow pricing comparator.
 * No database, no network — pure TypeScript.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareShadowPricingResults } from '../src/utils/provider-pricing/shadow-comparison.js';
import type { ShadowPricingResult, PricedShadowCall, UnpricedShadowCall, RequestSummaryStatus, UnpricedReason, ProviderRateCard, RateCardEntry, RateCardTier, RateCardBillingUnit } from '../src/types/provider-pricing.js';
import { PROVIDER_RATE_CARD } from '../src/config/provider-rate-card/index.js';

// Helper to build a minimal ProviderRateCard with a single entry
function makeCard(overrides: Partial<ProviderRateCard> = {}): ProviderRateCard {
  const baseEntry: RateCardEntry = {
    provider: 'google',
    model: 'gemini-3.6-flash',
    status: 'STABLE',
    tier: 'standard',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 1_500_000,
      outputMicrosPerMillion: 7_500_000,
      cachedInputMicrosPerMillion: 150_000,
      cachedOutputMicrosPerMillion: 0,
    },
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: '2026-08-03',
    inactive: false,
    source: 'https://example.test/pricing',
    verifiedAt: '2026-08-03',
  };
  return {
    schemaVersion: 1,
    currency: 'USD',
    storageUnit: 'MICROS',
    engineUnit: 'NANO_USD',
    version: '1.0.0',
    source: 'https://example.test/pricing',
    generatedAt: '2026-08-03',
    provenance: 'RESEARCH_SNAPSHOT',
    entries: [baseEntry],
    ...overrides,
  };
}

// Helper to build a minimal ShadowPricingResult with one priced call
function makeResult(overrides: Partial<ShadowPricingResult> = {}): ShadowPricingResult {
  const baseCall: PricedShadowCall = {
    kind: 'PRICED',
    providerCallId: 'call-1',
    provider: 'google',
    operation: 'chat',
    requestedModel: 'gemini-3.6-flash',
    actualModel: 'gemini-3.6-flash',
    reason: 'ACTUAL_MODEL',
    rateCard: { version: '1.0.0', model: 'gemini-3.6-flash', tier: 'standard', billingUnit: 'TOKEN' },
    costNanoUsd: 3_825_000n,
    usageApplied: {
      inputTokens: 1500,
      outputTokens: 200,
      cachedInputTokens: 500,
    },
    pricedAt: '2026-08-03',
  };
  return {
    pricedAt: '2026-08-03T00:00:00.000Z',
    noProviderCalls: false,
    calls: [baseCall],
    totals: {
      callCount: 1,
      pricedCallCount: 1,
      unpricedCallCount: 0,
      unpricedReasons: {
        PROVIDER_NOT_IN_RATECARD: 0,
        MODEL_MISSING: 0,
        ACTUAL_MODEL_NOT_IN_RATECARD: 0,
        REQUESTED_MODEL_NOT_IN_RATECARD: 0,
        USAGE_MISSING: 0,
        USAGE_INVALID: 0,
        RATE_NOT_ACTIVE: 0,
        UNIT_UNPRICED: 0,
        MODALITY_INVALID: 0,
        OVERFLOW: 0,
      },
      pricedCostNanoUsd: 3_825_000n,
    },
    summaryStatus: 'FULLY_PRICED',
    ...overrides,
  };
}

const staticCard = makeCard();
const dbCard = makeCard();

test('exact MATCH → status MATCH, no mismatches', () => {
  const staticRes = makeResult();
  const dbRes = makeResult();
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard,
  );
  assert.equal(cmp.status, 'MATCH');
  assert.deepEqual(cmp.mismatchFields, []);
});

test('input cost mismatch → MISMATCH with INPUT_COST', () => {
  const dbCard2 = makeCard({
    entries: [{
      ...staticCard.entries[0],
      tokenRates: { ...staticCard.entries[0].tokenRates!, inputMicrosPerMillion: 2_000_000 },
    }],
  });
  const staticRes = makeResult();
  const dbRes = makeResult();
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard2,
  );
  assert.equal(cmp.status, 'MISMATCH');
  assert.ok(cmp.mismatchFields.some(f => f.includes('inputCostNanoUsd')));
  assert.ok(cmp.mismatchCategories.includes('INPUT_COST'));
});

test('output cost mismatch → MISMATCH with OUTPUT_COST', () => {
  const dbCard2 = makeCard({
    entries: [{
      ...staticCard.entries[0],
      tokenRates: { ...staticCard.entries[0].tokenRates!, outputMicrosPerMillion: 8_000_000 },
    }],
  });
  const staticRes = makeResult();
  const dbRes = makeResult();
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard2,
  );
  assert.equal(cmp.status, 'MISMATCH');
  assert.ok(cmp.mismatchFields.some(f => f.includes('outputCostNanoUsd')));
  assert.ok(cmp.mismatchCategories.includes('OUTPUT_COST'));
});

test('cached-input cost mismatch → MISMATCH with CACHED_INPUT_COST', () => {
  const dbCard2 = makeCard({
    entries: [{
      ...staticCard.entries[0],
      tokenRates: { ...staticCard.entries[0].tokenRates!, cachedInputMicrosPerMillion: 200_000 },
    }],
  });
  const staticRes = makeResult();
  const dbRes = makeResult();
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard2,
  );
  assert.equal(cmp.status, 'MISMATCH');
  assert.ok(cmp.mismatchFields.some(f => f.includes('cachedInputCostNanoUsd')));
  assert.ok(cmp.mismatchCategories.includes('CACHED_INPUT_COST'));
});

test('cached-output cost mismatch → MISMATCH with CACHED_OUTPUT_COST', () => {
  const dbCard2 = makeCard({
    entries: [{
      ...staticCard.entries[0],
      tokenRates: { ...staticCard.entries[0].tokenRates!, cachedOutputMicrosPerMillion: 100_000 },
    }],
  });
  const baseUsage = { inputTokens: 1500, outputTokens: 200, cachedInputTokens: 500, cachedOutputTokens: 100 };
  const staticRes = makeResult({ calls: [{ ...makeResult().calls[0], usageApplied: baseUsage }] });
  const dbRes = makeResult({ calls: [{ ...makeResult().calls[0], usageApplied: baseUsage }] });
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard2,
  );
  assert.equal(cmp.status, 'MISMATCH');
  assert.ok(cmp.mismatchFields.some(f => f.includes('cachedOutputCostNanoUsd')));
  assert.ok(cmp.mismatchCategories.includes('CACHED_OUTPUT_COST'));
});

test('audio-input cost mismatch → MISMATCH with AUDIO_INPUT_COST', () => {
  const entry = { ...staticCard.entries[0], modalityRates: { audioInputMicrosPerMillion: 500_000 } };
  const dbCard2 = makeCard({ entries: [entry] });
  const baseUsage = { ...makeResult().calls[0].usageApplied, audioInputTokens: 100 };
  const staticRes = makeResult({ calls: [{ ...makeResult().calls[0], usageApplied: baseUsage }] });
  const dbRes = makeResult({ calls: [{ ...makeResult().calls[0], usageApplied: baseUsage }] });
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard2,
  );
  assert.equal(cmp.status, 'MISMATCH');
  assert.ok(cmp.mismatchFields.some(f => f.includes('audioInputCostNanoUsd')));
  assert.ok(cmp.mismatchCategories.includes('AUDIO_INPUT_COST'));
});

test('audio-output cost mismatch → MISMATCH with AUDIO_OUTPUT_COST', () => {
  const entry = { ...staticCard.entries[0], tts: { audioOutputMicrosPerMillion: 2_000_000, tokensPerSecond: 10 } };
  const dbCard2 = makeCard({ entries: [entry] });
  const baseUsage = { ...makeResult().calls[0].usageApplied, audioOutputTokens: 50 };
  const staticRes = makeResult({ calls: [{ ...makeResult().calls[0], usageApplied: baseUsage }] });
  const dbRes = makeResult({ calls: [{ ...makeResult().calls[0], usageApplied: baseUsage }] });
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard2,
  );
  assert.equal(cmp.status, 'MISMATCH');
  assert.ok(cmp.mismatchFields.some(f => f.includes('audioOutputCostNanoUsd')));
  assert.ok(cmp.mismatchCategories.includes('AUDIO_OUTPUT_COST'));
});

test('per-unit cost mismatch → MISMATCH with PER_UNIT_COST', () => {
  const entry = { ...staticCard.entries[0], billingUnit: 'IMAGE', perUnitMicros: 500_000 };
  const staticCard2 = makeCard({ entries: [entry] });
  const dbCard2 = makeCard({ entries: [{ ...entry, perUnitMicros: 600_000 }] });
  const baseCall = makeResult().calls[0];
  const baseUsage = { generatedImageCount: 3 };
  const staticRes = makeResult({ calls: [{ ...baseCall, rateCard: { ...baseCall.rateCard, billingUnit: 'IMAGE' }, usageApplied: baseUsage }] });
  const dbRes = makeResult({ calls: [{ ...baseCall, rateCard: { ...baseCall.rateCard, billingUnit: 'IMAGE' }, usageApplied: baseUsage }] });
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard2, dbCard2,
  );
  assert.equal(cmp.status, 'MISMATCH');
  assert.ok(cmp.mismatchFields.some(f => f.includes('perUnitCostNanoUsd')));
  assert.ok(cmp.mismatchCategories.includes('PER_UNIT_COST'));
});

test('same total but different components → MISMATCH', () => {
  // static: input 100, output 200 = 300
  const staticCard2 = makeCard({
    entries: [{
      ...staticCard.entries[0],
      tokenRates: { inputMicrosPerMillion: 100, outputMicrosPerMillion: 200, cachedInputMicrosPerMillion: 0, cachedOutputMicrosPerMillion: 0 },
    }],
  });
  // db: input 150, output 150 = 300
  const dbCard2 = makeCard({
    entries: [{
      ...staticCard.entries[0],
      tokenRates: { inputMicrosPerMillion: 150, outputMicrosPerMillion: 150, cachedInputMicrosPerMillion: 0, cachedOutputMicrosPerMillion: 0 },
    }],
  });
  const baseUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const staticRes = makeResult({ calls: [{ ...makeResult().calls[0], usageApplied: baseUsage }] });
  const dbRes = makeResult({ calls: [{ ...makeResult().calls[0], usageApplied: baseUsage }] });
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard2, dbCard2,
  );
  assert.equal(cmp.status, 'MISMATCH');
  assert.ok(cmp.mismatchFields.some(f => f.includes('inputCostNanoUsd') || f.includes('outputCostNanoUsd')));
});

test('aggregate status mismatch → MISMATCH', () => {
  const staticRes = makeResult({ summaryStatus: 'FULLY_PRICED' });
  const dbRes = makeResult({ summaryStatus: 'PARTIALLY_PRICED' });
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard,
  );
  assert.equal(cmp.status, 'MISMATCH');
  assert.ok(cmp.mismatchFields.includes('summaryStatus'));
  assert.ok(cmp.mismatchCategories.includes('AGGREGATE_STATUS'));
});

test('unpriced reason mismatch → MISMATCH', () => {
  const baseCall = makeResult().calls[0];
  const staticRes = makeResult({
    calls: [{ ...baseCall, kind: 'UNPRICED', reason: 'MODEL_MISSING' }],
    totals: { ...makeResult().totals, pricedCallCount: 0, unpricedCallCount: 1, pricedCostNanoUsd: 0n, unpricedReasons: { ...makeResult().totals.unpricedReasons, MODEL_MISSING: 1 } },
    summaryStatus: 'UNPRICED',
  });
  const dbRes = makeResult({
    calls: [{ ...baseCall, kind: 'UNPRICED', reason: 'PROVIDER_NOT_IN_RATECARD' }],
    totals: { ...makeResult().totals, pricedCallCount: 0, unpricedCallCount: 1, pricedCostNanoUsd: 0n, unpricedReasons: { ...makeResult().totals.unpricedReasons, PROVIDER_NOT_IN_RATECARD: 1 } },
    summaryStatus: 'UNPRICED',
  });
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard,
  );
  assert.equal(cmp.status, 'MISMATCH');
  assert.ok(cmp.mismatchCategories.includes('UNPRICED_REASONS'));
});

test('partial pricing mismatch → MISMATCH', () => {
  const staticRes = makeResult({ summaryStatus: 'FULLY_PRICED' });
  const dbRes = makeResult({
    calls: [{ ...staticRes.calls[0] as any, kind: 'UNPRICED', reason: 'RATE_NOT_ACTIVE' }],
    totals: { ...staticRes.totals, pricedCallCount: 0, unpricedCallCount: 1, pricedCostNanoUsd: 0n, unpricedReasons: { ...staticRes.totals.unpricedReasons, RATE_NOT_ACTIVE: 1 } },
    summaryStatus: 'UNPRICED',
  });
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard,
  );
  assert.equal(cmp.status, 'MISMATCH');
});

test('ordering independence → MATCH regardless of call order', () => {
  const callA = { ...makeResult().calls[0], providerCallId: 'a' };
  const callB = { ...makeResult().calls[0], providerCallId: 'b' };
  const staticRes = makeResult({ calls: [callA, callB] });
  const dbRes = makeResult({ calls: [callB, callA] });
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard,
  );
  assert.equal(cmp.status, 'MATCH');
});

test('actualModel resolution used for matching', () => {
  const baseCall = makeResult().calls[0];
  const staticRes = makeResult({ calls: [{ ...baseCall, actualModel: 'gemini-3.6-flash', requestedModel: 'gemini-3.5-flash' }] });
  const dbRes = makeResult({ calls: [{ ...baseCall, actualModel: 'gemini-3.6-flash', requestedModel: 'gemini-3.5-flash' }] });
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard,
  );
  assert.equal(cmp.status, 'MATCH');
});

test('requestedModel fallback when actualModel missing', () => {
  const baseCall = makeResult().calls[0];
  const staticRes = makeResult({ calls: [{ ...baseCall, actualModel: undefined, requestedModel: 'gemini-3.6-flash' }] });
  const dbRes = makeResult({ calls: [{ ...baseCall, actualModel: undefined, requestedModel: 'gemini-3.6-flash' }] });
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard,
  );
  assert.equal(cmp.status, 'MATCH');
});

test('omitted tier treated as STANDARD consistently', () => {
  const entryNoTier = { ...staticCard.entries[0], tier: undefined };
  const staticCard2 = makeCard({ entries: [entryNoTier] });
  const dbCard2 = makeCard({ entries: [entryNoTier] });
  const staticRes = makeResult();
  const dbRes = makeResult();
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard2, dbCard2,
  );
  assert.equal(cmp.status, 'MATCH');
});

test('bigint exactness – large numbers compared without loss', () => {
  const large = 9_000_000_000_000_000_000n;
  const baseRes = makeResult();
  const staticRes = makeResult({ totals: { ...baseRes.totals, pricedCostNanoUsd: large } });
  const dbRes = makeResult({ totals: { ...baseRes.totals, pricedCostNanoUsd: large } });
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard,
  );
  assert.equal(cmp.status, 'MATCH');
  assert.equal(cmp.aggregate.deltaNanoUsd, 0n);
});

test('comparator does not mutate inputs', () => {
  const staticRes = makeResult();
  const dbRes = makeResult();
  const staticResCopy = JSON.parse(JSON.stringify(staticRes, (_, v) => typeof v === 'bigint' ? v.toString() : v));
  const dbResCopy = JSON.parse(JSON.stringify(dbRes, (_, v) => typeof v === 'bigint' ? v.toString() : v));
  compareShadowPricingResults(staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard);
  assert.deepEqual(JSON.parse(JSON.stringify(staticRes, (_, v) => typeof v === 'bigint' ? v.toString() : v)), staticResCopy);
  assert.deepEqual(JSON.parse(JSON.stringify(dbRes, (_, v) => typeof v === 'bigint' ? v.toString() : v)), dbResCopy);
});

test('stable mismatch field paths include providerCallId and component', () => {
  const dbCard2 = makeCard({
    entries: [{
      ...staticCard.entries[0],
      tokenRates: { ...staticCard.entries[0].tokenRates!, inputMicrosPerMillion: 2_000_000 },
    }],
  });
  const staticRes = makeResult();
  const dbRes = makeResult();
  const cmp = compareShadowPricingResults(
    staticRes, dbRes, null, 'ACTIVE_DATE', '2026-08-03', '1.0.0', '1.0.0', 0, true, staticCard, dbCard2,
  );
  assert.ok(cmp.mismatchFields.some(f => f.startsWith('call_call-1_inputCostNanoUsd')));
});