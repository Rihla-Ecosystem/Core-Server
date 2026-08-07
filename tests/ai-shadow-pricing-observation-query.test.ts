import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryShadowPricingObservations } from '../src/services/ai-shadow-pricing-observation-query.service.js';
import { adminObservationsQuerySchema } from '../src/schemas/admin-shadow-pricing.schema.js';
import type { ShadowPricingObservation } from '../src/services/ai-shadow-pricing-observation.service.js';
import type { ReportablePricedCall, ReportableUnpricedCall } from '../src/utils/provider-pricing/reporting.js';

const EMPTY_REASONS = {
  PROVIDER_NOT_IN_RATECARD: 0, MODEL_MISSING: 0, ACTUAL_MODEL_NOT_IN_RATECARD: 0,
  REQUESTED_MODEL_NOT_IN_RATECARD: 0, USAGE_MISSING: 0, USAGE_INVALID: 0,
  RATE_NOT_ACTIVE: 0, UNIT_UNPRICED: 0, MODALITY_INVALID: 0, OVERFLOW: 0,
};

function pricedCall(overrides?: Partial<ReportablePricedCall>): ReportablePricedCall {
  return {
    kind: 'PRICED',
    provider: 'google',
    providerCallId: 'a',
    actualModel: 'gemini-3.6-flash',
    reason: 'ACTUAL_MODEL',
    rateCard: { version: '1.0.0', model: 'gemini-3.6-flash', tier: 'standard', billingUnit: 'TOKEN' },
    costNanoUsd: '3825000',
    costMicroUsd: '3825',
    costUsd: '0.003825000',
    ...overrides,
  };
}

function unpricedCall(overrides?: Partial<ReportableUnpricedCall>): ReportableUnpricedCall {
  return {
    kind: 'UNPRICED',
    provider: 'google',
    providerCallId: 'b',
    actualModel: 'gemini-mystery',
    reason: 'ACTUAL_MODEL_NOT_IN_RATECARD',
    ...overrides,
  };
}

function totals(overrides?: Partial<ShadowPricingObservation['report']['totals']>) {
  return {
    callCount: 0, pricedCallCount: 0, unpricedCallCount: 0,
    unpricedReasons: { ...EMPTY_REASONS },
    pricedCostNanoUsd: '0', pricedCostMicroUsd: '0', pricedCostUsd: '0.000000000',
    ...overrides,
  };
}

function makeObs(overrides?: Partial<ShadowPricingObservation>): ShadowPricingObservation {
  const report = {
    pricedAt: '2026-08-03T00:00:00.000Z',
    noProviderCalls: false,
    summaryStatus: 'FULLY_PRICED' as const,
    calls: [pricedCall()],
    totals: totals({ callCount: 1, pricedCallCount: 1, pricedCostNanoUsd: '3825000', pricedCostMicroUsd: '3825', pricedCostUsd: '0.003825000' }),
    rateCardVersion: '1.0.0',
  };
  return {
    observedAt: '2026-08-03T00:00:00.000Z',
    source: 'chat',
    conversationId: 'c1',
    report,
    ...overrides,
  };
}

function partialObs(): ShadowPricingObservation {
  return makeObs({
    observedAt: '2026-08-03T00:00:01.000Z',
    report: {
      pricedAt: '2026-08-03T00:00:01.000Z',
      noProviderCalls: false,
      summaryStatus: 'PARTIALLY_PRICED',
      calls: [
        pricedCall({ costNanoUsd: '1500', costMicroUsd: '2', costUsd: '0.000001500' }),
        unpricedCall(),
      ],
      totals: totals({
        callCount: 2, pricedCallCount: 1, unpricedCallCount: 1,
        unpricedReasons: { ...EMPTY_REASONS, ACTUAL_MODEL_NOT_IN_RATECARD: 1 },
        pricedCostNanoUsd: '1500', pricedCostMicroUsd: '2', pricedCostUsd: '0.000001500',
      }),
      rateCardVersion: '1.0.0',
    },
  });
}

function unpricedObs(): ShadowPricingObservation {
  return makeObs({
    observedAt: '2026-08-03T00:00:02.000Z',
    report: {
      pricedAt: '2026-08-03T00:00:02.000Z',
      noProviderCalls: false,
      summaryStatus: 'UNPRICED',
      calls: [unpricedCall()],
      totals: totals({
        callCount: 1, pricedCallCount: 0, unpricedCallCount: 1,
        unpricedReasons: { ...EMPTY_REASONS, ACTUAL_MODEL_NOT_IN_RATECARD: 1 },
        pricedCostNanoUsd: '0', pricedCostMicroUsd: '0', pricedCostUsd: '0.000000000',
      }),
      rateCardVersion: '1.0.0',
    },
  });
}

function zeroCallObs(): ShadowPricingObservation {
  return makeObs({
    observedAt: '2026-08-03T00:00:03.000Z',
    source: 'identify',
    report: {
      pricedAt: '2026-08-03T00:00:03.000Z',
      noProviderCalls: true,
      summaryStatus: 'UNPRICED',
      calls: [],
      totals: totals(),
      rateCardVersion: '1.0.0',
    },
  });
}

function assertNoBigint(value: unknown, path = 'root'): void {
  if (typeof value === 'bigint') assert.fail(`bigint at ${path}`);
  if (Array.isArray(value)) value.forEach((v, i) => assertNoBigint(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoBigint(v, `${path}.${k}`);
  }
}

test('1. newest-first ordering', () => {
  const result = queryShadowPricingObservations([makeObs(), partialObs(), unpricedObs()]);
  assert.deepEqual(result.data.map((r) => r.observedAt), [
    '2026-08-03T00:00:02.000Z',
    '2026-08-03T00:00:01.000Z',
    '2026-08-03T00:00:00.000Z',
  ]);
});

test('2. default limit 50', () => {
  const snap = Array.from({ length: 60 }, (_, i) =>
    makeObs({ observedAt: `2026-08-03T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z` }),
  );
  const result = queryShadowPricingObservations(snap);
  assert.equal(result.meta.limit, 50);
  assert.equal(result.data.length, 50);
});

test('3. hard maximum 200', () => {
  const snap = Array.from({ length: 250 }, (_, i) =>
    makeObs({ observedAt: `2026-08-03T00:00:${String(i).padStart(2, '0')}.000Z` }),
  );
  const result = queryShadowPricingObservations(snap, { limit: 250 });
  assert.equal(result.meta.limit, 200);
  assert.equal(result.data.length, 200);
});

test('4. source filter', () => {
  const result = queryShadowPricingObservations([makeObs(), partialObs(), unpricedObs(), zeroCallObs()], { source: 'identify' });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].source, 'identify');
});

test('5. FULLY_PRICED filter', () => {
  const result = queryShadowPricingObservations([makeObs(), partialObs(), unpricedObs()], { status: 'FULLY_PRICED' });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].requestCategory, 'FULLY_PRICED');
});

test('6. PARTIALLY_PRICED filter', () => {
  const result = queryShadowPricingObservations([makeObs(), partialObs(), unpricedObs()], { status: 'PARTIALLY_PRICED' });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].requestCategory, 'PARTIALLY_PRICED');
});

test('7. UNPRICED filter excludes zero-call observations', () => {
  const result = queryShadowPricingObservations([unpricedObs(), zeroCallObs()], { status: 'UNPRICED' });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].requestCategory, 'UNPRICED');
  assert.equal(result.data[0].noProviderCalls, false);
});

test('8. ZERO_PROVIDER_CALLS filter/category', () => {
  const result = queryShadowPricingObservations([unpricedObs(), zeroCallObs()], { status: 'ZERO_PROVIDER_CALLS' });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].requestCategory, 'ZERO_PROVIDER_CALLS');
  assert.equal(result.data[0].noProviderCalls, true);
  assert.equal(result.data[0].engineSummaryStatus, 'UNPRICED');
});

test('9. noProviderCalls=true', () => {
  const result = queryShadowPricingObservations([makeObs(), zeroCallObs()], { noProviderCalls: true });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].noProviderCalls, true);
});

test('10. noProviderCalls=false', () => {
  const result = queryShadowPricingObservations([makeObs(), zeroCallObs()], { noProviderCalls: false });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].noProviderCalls, false);
});

test('11. multiple combined filters', () => {
  const result = queryShadowPricingObservations(
    [makeObs(), partialObs(), unpricedObs(), zeroCallObs()],
    { source: 'chat', status: 'UNPRICED', noProviderCalls: false },
  );
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].requestCategory, 'UNPRICED');
});

test('12. invalid limit rejected by schema', () => {
  for (const bad of [{ limit: -1 }, { limit: 0 }, { limit: 201 }, { limit: 'abc' }]) {
    const r = adminObservationsQuerySchema.safeParse(bad);
    assert.equal(r.success, false, `expected failure for ${JSON.stringify(bad)}`);
  }
});

test('13. invalid boolean rejected', () => {
  for (const bad of ['yes', '1', '0', '', 'TRUE', 'False', 1, 0]) {
    const r = adminObservationsQuerySchema.safeParse({ noProviderCalls: bad });
    assert.equal(r.success, false, `expected failure for ${JSON.stringify(bad)}`);
  }
  // Literal "true"/"false" strings are accepted and parsed correctly.
  const t = adminObservationsQuerySchema.safeParse({ noProviderCalls: 'true' });
  assert.equal(t.success, true);
  assert.equal((t.data as { noProviderCalls: boolean }).noProviderCalls, true);
  const f = adminObservationsQuerySchema.safeParse({ noProviderCalls: 'false' });
  assert.equal(f.success, true);
  assert.equal((f.data as { noProviderCalls: boolean }).noProviderCalls, false);
});

test('14. returned array cannot mutate input snapshot', () => {
  const snap = [makeObs(), partialObs()];
  const before = JSON.stringify(snap);
  const result = queryShadowPricingObservations(snap);
  result.data[0].source = 'MODIFIED';
  result.data[1].conversationId = 'MODIFIED';
  assert.equal(JSON.stringify(snap), before);
  assert.equal(snap[0].source, 'chat');
});

test('15. no private/raw payload fields exposed', () => {
  const result = queryShadowPricingObservations([makeObs()]);
  const row = result.data[0];
  assert.ok(!('providerCalls' in row));
  assert.ok(!('prompt' in row));
  assert.ok(!('response' in row));
  assert.ok(!('payload' in row));
  assert.ok(!('error' in row));
  assert.ok(!('calls' in row));
  const json = JSON.stringify(result);
  assert.ok(!json.includes('TOP-SECRET'));
});

test('16. output is JSON-safe', () => {
  const result = queryShadowPricingObservations([makeObs(), zeroCallObs()]);
  JSON.stringify(result);
  assertNoBigint(result);
});

test('17. empty buffer response', () => {
  const result = queryShadowPricingObservations([]);
  assert.equal(result.data.length, 0);
  assert.equal(result.meta.returned, 0);
  assert.equal(result.meta.limit, 50);
  assert.equal(result.meta.capacity, 500);
});
