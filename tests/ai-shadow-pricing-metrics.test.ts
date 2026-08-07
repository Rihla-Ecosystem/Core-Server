import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeShadowPricingMetrics } from '../src/services/ai-shadow-pricing-metrics.service.js';
import type { ShadowPricingObservation } from '../src/services/ai-shadow-pricing-observation.service.js';
import type { ReportablePricedCall, ReportableUnpricedCall } from '../src/utils/provider-pricing/reporting.js';

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
    providerCallId: 'a',
    actualModel: 'gemini-mystery',
    reason: 'ACTUAL_MODEL_NOT_IN_RATECARD',
    ...overrides,
  };
}

const EMPTY_REASONS = {
  PROVIDER_NOT_IN_RATECARD: 0, MODEL_MISSING: 0, ACTUAL_MODEL_NOT_IN_RATECARD: 0,
  REQUESTED_MODEL_NOT_IN_RATECARD: 0, USAGE_MISSING: 0, USAGE_INVALID: 0,
  RATE_NOT_ACTIVE: 0, UNIT_UNPRICED: 0, MODALITY_INVALID: 0, OVERFLOW: 0,
};

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
    conversationId: undefined,
    report,
    ...overrides,
  };
}

function zeroCallObs(): ShadowPricingObservation {
  return makeObs({
    report: {
      pricedAt: '2026-08-03T00:00:00.000Z',
      noProviderCalls: true,
      summaryStatus: 'UNPRICED',
      calls: [],
      totals: totals(),
      rateCardVersion: '1.0.0',
    },
  });
}

function unpricedObs(call: ReportableUnpricedCall = unpricedCall()): ShadowPricingObservation {
  return makeObs({
    report: {
      pricedAt: '2026-08-03T00:00:00.000Z',
      noProviderCalls: false,
      summaryStatus: 'UNPRICED',
      calls: [call],
      totals: totals({ callCount: 1, unpricedCallCount: 1, unpricedReasons: { ...EMPTY_REASONS, [call.reason]: 1 } }),
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

test('1. empty buffer', () => {
  const m = computeShadowPricingMetrics([]);
  assert.equal(m.requests.totalObserved, 0);
  assert.equal(m.requests.fullyPriced, 0);
  assert.equal(m.requests.partiallyPriced, 0);
  assert.equal(m.requests.unpriced, 0);
  assert.equal(m.requests.zeroProviderCalls, 0);
  assert.equal(m.providerCalls.totalRealCalls, 0);
  assert.equal(m.providerCalls.coverageAvailable, false);
  assert.equal(m.providerCalls.coverageBasisPoints, null);
  assert.equal(m.pricedProviderCost.nanoUsd, '0');
  JSON.stringify(m);
  assertNoBigint(m);
});

test('2. one fully priced request', () => {
  const m = computeShadowPricingMetrics([makeObs()]);
  assert.equal(m.requests.totalObserved, 1);
  assert.equal(m.requests.fullyPriced, 1);
  assert.equal(m.requests.zeroProviderCalls, 0);
  assert.equal(m.providerCalls.totalRealCalls, 1);
  assert.equal(m.providerCalls.pricedCalls, 1);
  assert.equal(m.providerCalls.unpricedCalls, 0);
  assert.equal(m.providerCalls.coverageAvailable, true);
  assert.equal(m.providerCalls.coverageBasisPoints, 10_000);
  assert.equal(m.providerCalls.coveragePercent, '100.00');
  assert.equal(m.pricedProviderCost.nanoUsd, '3825000');
});

test('3. one partially priced request', () => {
  const m = computeShadowPricingMetrics([
    makeObs({
      report: {
        pricedAt: '2026-08-03T00:00:00.000Z',
        noProviderCalls: false,
        summaryStatus: 'PARTIALLY_PRICED',
        calls: [pricedCall({ costNanoUsd: '1500', costMicroUsd: '2', costUsd: '0.000001500' }), unpricedCall({ actualModel: 'gemini-mystery' })],
        totals: totals({ callCount: 2, pricedCallCount: 1, unpricedCallCount: 1, unpricedReasons: { ...EMPTY_REASONS, ACTUAL_MODEL_NOT_IN_RATECARD: 1 }, pricedCostNanoUsd: '1500', pricedCostMicroUsd: '2', pricedCostUsd: '0.000001500' }),
        rateCardVersion: '1.0.0',
      },
    }),
  ]);
  assert.equal(m.requests.totalObserved, 1);
  assert.equal(m.requests.partiallyPriced, 1);
  assert.equal(m.requests.fullyPriced, 0);
  assert.equal(m.requests.unpriced, 0);
  assert.equal(m.providerCalls.totalRealCalls, 2);
  assert.equal(m.providerCalls.pricedCalls, 1);
  assert.equal(m.providerCalls.unpricedCalls, 1);
  assert.equal(m.providerCalls.coverageBasisPoints, 5000);
  assert.equal(m.providerCalls.coveragePercent, '50.00');
});

test('4. one completely unpriced request', () => {
  const m = computeShadowPricingMetrics([unpricedObs()]);
  assert.equal(m.requests.totalObserved, 1);
  assert.equal(m.requests.unpriced, 1);
  assert.equal(m.requests.zeroProviderCalls, 0);
  assert.equal(m.providerCalls.coverageAvailable, true);
  assert.equal(m.providerCalls.coverageBasisPoints, 0);
  assert.equal(m.providerCalls.coveragePercent, '0.00');
});

test('5. explicit zero-provider-call observation', () => {
  const m = computeShadowPricingMetrics([zeroCallObs()]);
  assert.equal(m.requests.totalObserved, 1);
  assert.equal(m.requests.zeroProviderCalls, 1);
  assert.equal(m.requests.unpriced, 0);
  assert.equal(m.providerCalls.totalRealCalls, 0);
  assert.equal(m.providerCalls.coverageAvailable, false);
  assert.equal(m.pricedProviderCost.nanoUsd, '0');
});

test('6. zero-call not counted under unpriced requests', () => {
  const m = computeShadowPricingMetrics([
    zeroCallObs(),
    unpricedObs(),
    makeObs(),
  ]);
  assert.equal(m.requests.totalObserved, 3);
  assert.equal(m.requests.zeroProviderCalls, 1);
  assert.equal(m.requests.unpriced, 1);
  assert.equal(m.requests.fullyPriced, 1);
});

test('7. request category counts sum to totalObserved', () => {
  const snapshot = [
    makeObs(), // FULLY_PRICED
    makeObs({ report: { ...makeObs().report, summaryStatus: 'PARTIALLY_PRICED', calls: [pricedCall(), unpricedCall()], totals: totals({ callCount: 2, pricedCallCount: 1, unpricedCallCount: 1, unpricedReasons: { ...EMPTY_REASONS, ACTUAL_MODEL_NOT_IN_RATECARD: 1 }, pricedCostNanoUsd: '3825000', pricedCostMicroUsd: '3825', pricedCostUsd: '0.003825000' }) } }),
    unpricedObs(),
    zeroCallObs(),
  ];
  const m = computeShadowPricingMetrics(snapshot);
  const sum = m.requests.fullyPriced + m.requests.partiallyPriced + m.requests.unpriced + m.requests.zeroProviderCalls;
  assert.equal(sum, m.requests.totalObserved);
  assert.equal(sum, snapshot.length);
});

test('8. zero-call excluded from coverage denominator', () => {
  const m = computeShadowPricingMetrics([
    zeroCallObs(),
    makeObs(),
    unpricedObs(),
  ]);
  // Real calls: 1 priced + 1 unpriced -> 50%.
  assert.equal(m.providerCalls.totalRealCalls, 2);
  assert.equal(m.providerCalls.coverageBasisPoints, 5000);
  assert.equal(m.providerCalls.coveragePercent, '50.00');
});

test('9. coverage unavailable when there are no real calls', () => {
  const m = computeShadowPricingMetrics([zeroCallObs(), zeroCallObs()]);
  assert.equal(m.providerCalls.coverageAvailable, false);
  assert.equal(m.providerCalls.coverageBasisPoints, null);
  assert.equal(m.providerCalls.coveragePercent, null);
});

test('10. coverage 100%', () => {
  const m = computeShadowPricingMetrics([
    makeObs(),
    makeObs({ observedAt: '2026-08-03T00:00:01.000Z' }),
  ]);
  assert.equal(m.providerCalls.coverageAvailable, true);
  assert.equal(m.providerCalls.coverageBasisPoints, 10_000);
  assert.equal(m.providerCalls.coveragePercent, '100.00');
});

test('11. coverage 0%', () => {
  const m = computeShadowPricingMetrics([unpricedObs(), unpricedObs()]);
  assert.equal(m.providerCalls.coverageBasisPoints, 0);
  assert.equal(m.providerCalls.coveragePercent, '0.00');
});

test('12. deterministic coverage rounding (integer basis points)', () => {
  // 1 priced / 3 real -> 3333.33 -> 3333 basis points -> "33.33".
  const oneThird = [
    makeObs(),
    unpricedObs(),
    unpricedObs(),
  ];
  const m1 = computeShadowPricingMetrics(oneThird);
  assert.equal(m1.providerCalls.coverageBasisPoints, 3333);
  assert.equal(m1.providerCalls.coveragePercent, '33.33');

  // 2 priced / 3 real -> 6666.67 -> 6667 basis points -> "66.67".
  const twoThirds = [
    makeObs(),
    makeObs({ observedAt: '2026-08-03T00:00:01.000Z' }),
    unpricedObs(),
  ];
  const m2 = computeShadowPricingMetrics(twoThirds);
  assert.equal(m2.providerCalls.coverageBasisPoints, 6667);
  assert.equal(m2.providerCalls.coveragePercent, '66.67');

  // Round-half-away-from-zero boundary: 1 priced / 32 real -> 312.5 -> 313.
  const boundary = [makeObs(), ...Array.from({ length: 31 }, () => unpricedObs())];
  const m3 = computeShadowPricingMetrics(boundary);
  assert.equal(m3.providerCalls.coverageBasisPoints, 313);
  assert.equal(m3.providerCalls.coveragePercent, '3.13');
});

test('13. multiple calls in one request counted independently', () => {
  const obs = makeObs({
    report: {
      pricedAt: '2026-08-03T00:00:00.000Z',
      noProviderCalls: false,
      summaryStatus: 'PARTIALLY_PRICED',
      calls: [
        pricedCall({ costNanoUsd: '1000', costMicroUsd: '1', costUsd: '0.000001000' }),
        unpricedCall(),
        pricedCall({ providerCallId: 'c', actualModel: 'gemini-2.5-flash-lite', rateCard: { version: '1.0.0', model: 'gemini-2.5-flash-lite', tier: 'standard', billingUnit: 'TOKEN' }, costNanoUsd: '100', costMicroUsd: '1', costUsd: '0.000000100' }),
      ],
      totals: totals({ callCount: 3, pricedCallCount: 2, unpricedCallCount: 1, unpricedReasons: { ...EMPTY_REASONS, ACTUAL_MODEL_NOT_IN_RATECARD: 1 }, pricedCostNanoUsd: '1100', pricedCostMicroUsd: '2', pricedCostUsd: '0.000001100' }),
      rateCardVersion: '1.0.0',
    },
  });
  const m = computeShadowPricingMetrics([obs]);
  assert.equal(m.providerCalls.totalRealCalls, 3);
  assert.equal(m.providerCalls.pricedCalls, 2);
  assert.equal(m.providerCalls.unpricedCalls, 1);
  assert.equal(m.pricedProviderCost.nanoUsd, '1100');
});

test('14. multiple providers remain separate', () => {
  const m = computeShadowPricingMetrics([
    makeObs(),
    makeObs({
      observedAt: '2026-08-03T00:00:01.000Z',
      report: {
        ...makeObs().report,
        calls: [pricedCall({ provider: 'anthropic', providerCallId: 'b', actualModel: 'claude-4', rateCard: { version: '1.0.0', model: 'claude-4', tier: 'standard', billingUnit: 'TOKEN' } })],
      },
    }),
  ]);
  assert.equal(m.byProvider.length, 2);
  assert.ok(m.byProvider.some((p) => p.provider === 'google'));
  assert.ok(m.byProvider.some((p) => p.provider === 'anthropic'));
});

test('15. multiple models remain separate', () => {
  const m = computeShadowPricingMetrics([
    makeObs(),
    makeObs({
      observedAt: '2026-08-03T00:00:01.000Z',
      report: {
        ...makeObs().report,
        calls: [pricedCall({ providerCallId: 'b', actualModel: 'gemini-2.5-flash-lite', rateCard: { version: '1.0.0', model: 'gemini-2.5-flash-lite', tier: 'standard', billingUnit: 'TOKEN' } })],
      },
    }),
  ]);
  assert.equal(m.byModel.length, 2);
});

test('16. UNPRICED calls do not contribute priced cost', () => {
  const m = computeShadowPricingMetrics([unpricedObs()]);
  assert.equal(m.pricedProviderCost.nanoUsd, '0');
  assert.equal(m.pricedProviderCost.usd, '0.000000000');
});

test('17. exact cost beyond Number.MAX_SAFE_INTEGER', () => {
  const largeCost = '9007199254740992000000';
  const m = computeShadowPricingMetrics([
    makeObs({
      report: {
        ...makeObs().report,
        calls: [pricedCall({ costNanoUsd: largeCost, costMicroUsd: '1', costUsd: 'placeholder' })],
        totals: totals({ callCount: 1, pricedCallCount: 1, pricedCostNanoUsd: largeCost, pricedCostMicroUsd: '1', pricedCostUsd: 'placeholder' }),
      },
    }),
  ]);
  assert.equal(m.pricedProviderCost.nanoUsd, largeCost);
  assert.ok(!Number.isSafeInteger(Number(largeCost)));
});

test('18. no raw bigint in output', () => {
  const m = computeShadowPricingMetrics([
    makeObs(),
    makeObs({ observedAt: '2026-08-03T00:00:01.000Z' }),
    zeroCallObs(),
    unpricedObs(),
  ]);
  JSON.stringify(m);
  assertNoBigint(m);
});

test('19. input snapshot is not mutated', () => {
  const snap = [makeObs(), zeroCallObs()];
  const before = JSON.stringify(snap);
  computeShadowPricingMetrics(snap);
  assert.equal(JSON.stringify(snap), before);
});

test('20. unpriced reasons aggregate correctly', () => {
  const m = computeShadowPricingMetrics([
    unpricedObs(unpricedCall({ actualModel: 'x' })),
    unpricedObs(unpricedCall({ providerCallId: 'b', actualModel: 'y', reason: 'MODEL_MISSING' })),
    unpricedObs(unpricedCall({ providerCallId: 'c', actualModel: 'z', reason: 'USAGE_MISSING' })),
  ]);
  assert.equal(m.unpricedReasons['ACTUAL_MODEL_NOT_IN_RATECARD'], 1);
  assert.equal(m.unpricedReasons['MODEL_MISSING'], 1);
  assert.equal(m.unpricedReasons['USAGE_MISSING'], 1);
  assert.equal(m.unpricedReasons['OVERFLOW'], 0);
});

test('21. bySource priced cost aggregates correctly', () => {
  const obs1 = makeObs();
  const obs2 = makeObs({
    source: 'voice',
    observedAt: '2026-08-03T00:00:01.000Z',
    report: {
      ...makeObs().report,
      calls: [pricedCall({ costNanoUsd: '1000', costMicroUsd: '1', costUsd: '0.000001000' })],
      totals: totals({ callCount: 1, pricedCallCount: 1, pricedCostNanoUsd: '1000', pricedCostMicroUsd: '1', pricedCostUsd: '0.000001000' }),
    },
  });
  const obs3 = makeObs({
    source: 'voice',
    observedAt: '2026-08-03T00:00:02.000Z',
    report: {
      ...makeObs().report,
      calls: [pricedCall({ costNanoUsd: '500', costMicroUsd: '1', costUsd: '0.000000500' })],
      totals: totals({ callCount: 1, pricedCallCount: 1, pricedCostNanoUsd: '500', pricedCostMicroUsd: '1', pricedCostUsd: '0.000000500' }),
    },
  });
  const m = computeShadowPricingMetrics([obs1, obs2, obs3]);
  const chat = m.bySource.find((s) => s.source === 'chat');
  const voice = m.bySource.find((s) => s.source === 'voice');
  assert.equal(chat?.pricedProviderCost.nanoUsd, '3825000');
  assert.equal(voice?.pricedProviderCost.nanoUsd, '1500');
});

test('22. byProvider priced cost aggregates correctly', () => {
  const m = computeShadowPricingMetrics([
    makeObs(),
    makeObs({
      observedAt: '2026-08-03T00:00:01.000Z',
      report: {
        ...makeObs().report,
        calls: [pricedCall({ costNanoUsd: '1000', costMicroUsd: '1', costUsd: '0.000001000' })],
        totals: totals({ callCount: 1, pricedCallCount: 1, pricedCostNanoUsd: '1000', pricedCostMicroUsd: '1', pricedCostUsd: '0.000001000' }),
      },
    }),
  ]);
  const google = m.byProvider.find((p) => p.provider === 'google');
  assert.equal(google?.pricedCalls, 2);
  assert.equal(google?.pricedProviderCost.nanoUsd, '3826000');
});

test('23. byModel priced cost aggregates correctly', () => {
  const m = computeShadowPricingMetrics([
    makeObs(),
    makeObs({
      observedAt: '2026-08-03T00:00:01.000Z',
      report: {
        ...makeObs().report,
        calls: [pricedCall({ providerCallId: 'b', actualModel: 'gemini-2.5-flash-lite', rateCard: { version: '1.0.0', model: 'gemini-2.5-flash-lite', tier: 'standard', billingUnit: 'TOKEN' }, costNanoUsd: '100', costMicroUsd: '1', costUsd: '0.000000100' })],
        totals: totals({ callCount: 1, pricedCallCount: 1, pricedCostNanoUsd: '100', pricedCostMicroUsd: '1', pricedCostUsd: '0.000000100' }),
      },
    }),
  ]);
  const flash = m.byModel.find((md) => md.model === 'gemini-3.6-flash');
  const lite = m.byModel.find((md) => md.model === 'gemini-2.5-flash-lite');
  assert.equal(flash?.pricedProviderCost.nanoUsd, '3825000');
  assert.equal(lite?.pricedProviderCost.nanoUsd, '100');
});

test('24. rateCardVersions count observations, not calls', () => {
  // One observation with two calls -> counted once under the version.
  const multiCallObs = makeObs({
    report: {
      pricedAt: '2026-08-03T00:00:00.000Z',
      noProviderCalls: false,
      summaryStatus: 'PARTIALLY_PRICED',
      calls: [
        pricedCall({ costNanoUsd: '1000', costMicroUsd: '1', costUsd: '0.000001000' }),
        pricedCall({ providerCallId: 'c', actualModel: 'gemini-2.5-flash-lite', rateCard: { version: '1.0.0', model: 'gemini-2.5-flash-lite', tier: 'standard', billingUnit: 'TOKEN' }, costNanoUsd: '100', costMicroUsd: '1', costUsd: '0.000000100' }),
      ],
      totals: totals({ callCount: 2, pricedCallCount: 2, pricedCostNanoUsd: '1100', pricedCostMicroUsd: '2', pricedCostUsd: '0.000001100' }),
      rateCardVersion: '1.0.0',
    },
  });
  const m = computeShadowPricingMetrics([multiCallObs, makeObs()]);
  assert.equal(m.rateCardVersions.length, 1);
  assert.equal(m.rateCardVersions[0].version, '1.0.0');
  assert.equal(m.rateCardVersions[0].count, 2);
});

test('25. zero-call observation contributes to rate-card version observation count', () => {
  const m = computeShadowPricingMetrics([
    zeroCallObs(),
    makeObs({ report: { ...makeObs().report, rateCardVersion: '2.0.0' } }),
  ]);
  assert.equal(m.rateCardVersions.length, 2);
  const v100 = m.rateCardVersions.find((v) => v.version === '1.0.0');
  const v200 = m.rateCardVersions.find((v) => v.version === '2.0.0');
  assert.equal(v100?.count, 1);
  assert.equal(v200?.count, 1);
});
