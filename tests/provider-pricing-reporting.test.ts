import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateProviderCalls } from '../src/utils/provider-pricing/aggregate.js';
import {
  toReportableShadow,
  reportableShadowCall,
  reportMonetary,
  reportableTotals,
} from '../src/utils/provider-pricing/reporting.js';
import type {
  PricedShadowCall,
  UnpricedShadowCall,
} from '../src/types/provider-pricing.js';
import { PROVIDER_RATE_CARD } from '../src/config/provider-rate-card/index.js';

const RATE_CARD_VERSION = PROVIDER_RATE_CARD.version;

function pricedCall(): PricedShadowCall {
  return {
    kind: 'PRICED',
    providerCallId: 'call-1',
    provider: 'google',
    operation: 'TEXT_CHAT',
    requestedModel: 'gemini-3.6-flash',
    actualModel: 'gemini-3.6-flash',
    reason: 'ACTUAL_MODEL',
    rateCard: { version: RATE_CARD_VERSION, model: 'gemini-3.6-flash', tier: 'standard', billingUnit: 'TOKEN' },
    costNanoUsd: 3_825_000n,
    usageApplied: { inputTokens: 1500, outputTokens: 200, cachedInputTokens: 500 },
    pricedAt: '2026-08-03',
  };
}

function unpricedCall(): UnpricedShadowCall {
  return {
    kind: 'UNPRICED',
    providerCallId: 'call-2',
    provider: 'google',
    operation: 'TEXT_CHAT',
    requestedModel: 'gemini-mystery',
    actualModel: 'gemini-mystery',
    reason: 'ACTUAL_MODEL_NOT_IN_RATECARD',
    pricedAt: '2026-08-03',
  };
}

/** Recursively assert a JSON-safe object contains no bigint anywhere. */
function assertNoBigint(value: unknown, path = 'root'): void {
  if (typeof value === 'bigint') {
    assert.fail(`bigint found at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoBigint(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assertNoBigint(v, `${path}.${k}`);
    }
  }
}

test('1. PRICED bigint money becomes exact decimal strings', () => {
  const call = reportableShadowCall(pricedCall());
  if (call.kind !== 'PRICED') assert.fail('expected PRICED call');
  assert.equal(call.costNanoUsd, '3825000');
  assert.equal(call.costMicroUsd, '3825');
  assert.equal(call.costUsd, '0.003825000');
});

test('2. large bigint values remain exact', () => {
  const huge = 10n ** 24n + 1234567n;
  const money = reportMonetary(huge);
  assert.equal(money.costNanoUsd, huge.toString());
  // nanoUsdToUsdString returns an exact 9-decimal string derived from the BigInt.
  assert.notEqual(money.costUsd, String(Number(huge)));
});

test('3. no reportable object contains raw bigint; it is JSON-safe', () => {
  const result = aggregateProviderCalls({
    providerCalls: [
      { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-3.6-flash', inputTokens: 1500, outputTokens: 200, cachedInputTokens: 500 },
      { provider: 'google', providerCallMade: true, providerCallId: 'b', actualModel: 'gemini-mystery' },
    ],
    pricingDate: '2026-08-03',
  });
  const report = toReportableShadow(result, RATE_CARD_VERSION);
  assertNoBigint(report);
  const serialized = report.calls.map((c) => JSON.stringify(c));
  assert.ok(serialized.every((s) => typeof s === 'string'));
});

test('4. UNPRICED reportable calls contain no cost fields', () => {
  const call = reportableShadowCall(unpricedCall());
  if (call.kind !== 'UNPRICED') assert.fail('expected UNPRICED call');
  const serialized = JSON.stringify(call);
  assert.ok(!serialized.includes('cost'));
});

test('5. exact USD string is preserved for small values', () => {
  assert.equal(reportMonetary(1n).costUsd, '0.000000001');
  assert.equal(reportMonetary(100n).costUsd, '0.000000100');
  assert.equal(reportMonetary(3_825_000n).costUsd, '0.003825000');
});

test('6. reporting does not mutate the pure engine result', () => {
  const result = aggregateProviderCalls({
    providerCalls: [
      { provider: 'google', providerCallMade: true, providerCallId: 'a', actualModel: 'gemini-3.6-flash', inputTokens: 1500, outputTokens: 200, cachedInputTokens: 500 },
      { provider: 'google', providerCallMade: true, providerCallId: 'b', actualModel: 'gemini-mystery' },
    ],
    pricingDate: '2026-08-03',
  });
  const before = {
    calls: result.calls.length,
    priced: result.calls.filter((c) => c.kind === 'PRICED').length,
    cost: result.totals.pricedCostNanoUsd,
    reasons: { ...result.totals.unpricedReasons },
  };

  toReportableShadow(result, RATE_CARD_VERSION);

  assert.equal(result.calls.length, before.calls);
  assert.equal(result.calls.filter((c) => c.kind === 'PRICED').length, before.priced);
  assert.equal(result.totals.pricedCostNanoUsd, before.cost);
  assert.deepEqual(result.totals.unpricedReasons, before.reasons);
  assert.equal(reportableTotals(result.totals).callCount, before.calls);
});