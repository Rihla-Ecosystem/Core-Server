import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateProviderCalls } from '../src/utils/provider-pricing/aggregate.js';
import { PROVIDER_RATE_CARD } from '../src/config/provider-rate-card/index.js';
import type { UnpricedReason } from '../src/types/provider-pricing.js';

const ALL_REASONS: readonly UnpricedReason[] = [
  'PROVIDER_NOT_IN_RATECARD',
  'MODEL_MISSING',
  'ACTUAL_MODEL_NOT_IN_RATECARD',
  'REQUESTED_MODEL_NOT_IN_RATECARD',
  'USAGE_MISSING',
  'USAGE_INVALID',
  'RATE_NOT_ACTIVE',
  'UNIT_UNPRICED',
  'MODALITY_INVALID',
  'OVERFLOW',
];

test('1. empty providerCalls → noProviderCalls true, UNPRICED, calls []', () => {
  const r = aggregateProviderCalls({ providerCalls: [], pricingDate: '2026-08-03' });
  assert.equal(r.noProviderCalls, true);
  assert.equal(r.summaryStatus, 'UNPRICED');
  assert.deepEqual(r.calls, []);
  assert.equal(r.totals.callCount, 0);
  assert.equal(r.totals.pricedCostNanoUsd, 0n);
});

test('2. cache hit (null payload) treated as no provider calls', () => {
  const r = aggregateProviderCalls({ providerCalls: null, pricingDate: '2026-08-03' });
  assert.equal(r.noProviderCalls, true);
  assert.equal(r.summaryStatus, 'UNPRICED');
});

test('3. providerCallMade=false records are defensively ignored', () => {
  const r = aggregateProviderCalls({
    providerCalls: [
      { provider: 'google', providerCallMade: false, providerCallId: 'b', actualModel: 'gemini-3.6-flash' },
    ],
    pricingDate: '2026-08-03',
  });
  assert.equal(r.noProviderCalls, true);
  assert.equal(r.totals.callCount, 0);
});

test('4. single priced call → FULLY_PRICED', () => {
  const r = aggregateProviderCalls({
    providerCalls: [
      { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-2.5-flash-lite', inputTokens: 1 },
    ],
    pricingDate: '2026-08-03',
  });
  assert.equal(r.summaryStatus, 'FULLY_PRICED');
  assert.equal(r.totals.pricedCallCount, 1);
  assert.equal(r.totals.unpricedCallCount, 0);
  assert.equal(r.totals.pricedCostNanoUsd, 100n);
});

test('5. all unpriced → UNPRICED', () => {
  const r = aggregateProviderCalls({
    providerCalls: [
      { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-mystery', inputTokens: 1 },
    ],
    pricingDate: '2026-08-03',
  });
  assert.equal(r.summaryStatus, 'UNPRICED');
  assert.equal(r.totals.pricedCallCount, 0);
  assert.equal(r.totals.unpricedCallCount, 1);
  assert.equal(r.totals.unpricedReasons['ACTUAL_MODEL_NOT_IN_RATECARD'], 1);
});

test('6. mixed priced+unpriced → PARTIALLY_PRICED with exact reasons', () => {
  const r = aggregateProviderCalls({
    providerCalls: [
      { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-3.6-flash', inputTokens: 1 },
      { provider: 'google', providerCallMade: true, providerCallId: 'b', actualModel: 'gemini-mystery', inputTokens: 1 },
      { provider: 'google', providerCallMade: true, providerCallId: 'c', actualModel: 'gemini-unpriced-model', inputTokens: 1 },
    ],
    pricingDate: '2026-08-03',
  });
  assert.equal(r.summaryStatus, 'PARTIALLY_PRICED');
  assert.equal(r.totals.callCount, 3);
  assert.equal(r.totals.pricedCallCount, 1);
  assert.equal(r.totals.unpricedCallCount, 2);
  assert.equal(r.totals.pricedCostNanoUsd, 1_500n);
  assert.equal(r.totals.unpricedReasons['ACTUAL_MODEL_NOT_IN_RATECARD'], 2);
  // every reason key present and counted
  for (const reason of ALL_REASONS) {
    assert.ok(reason in r.totals.unpricedReasons);
  }
});

test('7. multi-model request prices each call against its own actualModel', () => {
  const r = aggregateProviderCalls({
    providerCalls: [
      { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-3.6-flash', inputTokens: 10 },
      { provider: 'google', providerCallMade: true, providerCallId: 'b', actualModel: 'gemini-2.5-flash-lite', inputTokens: 1 },
    ],
    pricingDate: '2026-08-03',
  });
  assert.equal(r.totals.callCount, 2);
  assert.equal(r.totals.pricedCallCount, 2);
  // gemini-3.6-flash: 10 x 1_500 nUSD = 15_000; flash-lite: 1 x 100 = 100
  assert.equal(r.totals.pricedCostNanoUsd, 15_100n);
  assert.equal(r.calls.length, 2);
  assert.ok(r.calls.every((c) => c.kind === 'PRICED'));
});

test('8. aggregation never rounds; exact nUSD sum', () => {
  const r = aggregateProviderCalls({
    providerCalls: [
      { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-2.5-flash-lite', inputTokens: 1 },
      { provider: 'google', providerCallMade: true, providerCallId: 'b', actualModel: 'gemini-2.5-flash-lite', inputTokens: 2 },
    ],
    pricingDate: '2026-08-03',
  });
  assert.equal(r.totals.pricedCostNanoUsd, 300n);
});

test('9. duplicates are preserved as separate calls', () => {
  const r = aggregateProviderCalls({
    providerCalls: [
      { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-3.6-flash', inputTokens: 1 },
      { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-3.6-flash', inputTokens: 1 },
    ],
    pricingDate: '2026-08-03',
  });
  assert.equal(r.totals.callCount, 2);
  assert.equal(r.totals.pricedCostNanoUsd, 3_000n);
});

test('10. tier is injectable and prices batch/priority', () => {
  const r = aggregateProviderCalls({
    providerCalls: [
      { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-3.6-flash', inputTokens: 10 },
    ],
    pricingDate: '2026-08-03',
    tier: 'batch',
  });
  assert.equal(r.totals.pricedCostNanoUsd, 7_500n); // 10 x 750 nUSD
});

test('11. invalid providerCalls payload (non-array) → noProviderCalls', () => {
  const r = aggregateProviderCalls({ providerCalls: 'nope', pricingDate: '2026-08-03' });
  assert.equal(r.noProviderCalls, true);
});

test('12. UNPRICED reason recorded per call even when pricedCostNanoUsd stays 0', () => {
  const r = aggregateProviderCalls({
    providerCalls: [
      { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-mystery' },
      { provider: 'google', providerCallMade: true, providerCallId: 'b', actualModel: 'gemini-3.6-flash', inputTokens: 0 },
    ],
    pricingDate: '2026-08-03',
  });
  assert.equal(r.totals.unpricedReasons['ACTUAL_MODEL_NOT_IN_RATECARD'], 1);
  assert.equal(r.totals.pricedCostNanoUsd, 0n);
  assert.equal(r.totals.pricedCallCount, 1);
  assert.equal(r.totals.unpricedCallCount, 1);
  assert.equal(r.summaryStatus, 'PARTIALLY_PRICED');
});

test('13. OVERFLOW reason is never fabricated in normal pricing', () => {
  const r = aggregateProviderCalls({
    providerCalls: [
      { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-3.6-flash', inputTokens: 1 },
    ],
    pricingDate: '2026-08-03',
  });
  assert.equal(r.totals.unpricedReasons['OVERFLOW'], 0);
});

test('14. defaults: pricingDate and materialized card are used', () => {
  const r = aggregateProviderCalls({
    providerCalls: [
      { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-3.6-flash', inputTokens: 1 },
    ],
  });
  assert.equal(r.totals.pricedCallCount, 1);
  assert.equal(r.totals.pricedCostNanoUsd, 1_500n);
  assert.equal(r.calls[0]?.kind, 'PRICED');
});
