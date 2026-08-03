import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AiShadowPricingObservationService,
  DEFAULT_OBSERVATION_CAPACITY,
} from '../src/services/ai-shadow-pricing-observation.service.js';
import type { ShadowPricingObservation } from '../src/services/ai-shadow-pricing-observation.service.js';
import type { RequestSummaryStatus } from '../src/types/provider-pricing.js';

function observation(source: string, noProviderCalls = false, callCount = 1): ShadowPricingObservation {
  return {
    observedAt: '2026-08-03T00:00:00.000Z',
    source,
    conversationId: `conv-${source}`,
    report: {
      pricedAt: '2026-08-03T00:00:00.000Z',
      noProviderCalls,
      summaryStatus: noProviderCalls ? 'UNPRICED' : 'PARTIALLY_PRICED',
      calls: noProviderCalls
        ? []
        : [{ kind: 'UNPRICED', provider: 'google', providerCallId: 'c', reason: 'MODEL_MISSING' }],
      totals: {
        callCount: callCount,
        pricedCallCount: noProviderCalls ? 0 : 0,
        unpricedCallCount: callCount,
        unpricedReasons: {
          PROVIDER_NOT_IN_RATECARD: 0,
          MODEL_MISSING: noProviderCalls ? 0 : callCount,
          ACTUAL_MODEL_NOT_IN_RATECARD: 0,
          REQUESTED_MODEL_NOT_IN_RATECARD: 0,
          USAGE_MISSING: 0,
          USAGE_INVALID: 0,
          RATE_NOT_ACTIVE: 0,
          UNIT_UNPRICED: 0,
          MODALITY_INVALID: 0,
          OVERFLOW: 0,
        },
        pricedCostNanoUsd: '0',
        pricedCostMicroUsd: '0',
        pricedCostUsd: '0.000000000',
      },
      rateCardVersion: '1.0.0',
    },
  };
}

test('7. appends observations', () => {
  const buf = new AiShadowPricingObservationService({ capacity: 3 });
  buf.record(observation('a'));
  buf.record(observation('b'));
  assert.equal(buf.size(), 2);
  assert.deepEqual(
    buf.snapshot().map((o) => o.source),
    ['a', 'b'],
  );
});

test('8. enforces maximum capacity', () => {
  const buf = new AiShadowPricingObservationService({ capacity: 3 });
  for (let i = 0; i < 10; i++) buf.record(observation(`s${i}`));
  assert.equal(buf.size(), 3);
  assert.equal(buf.maxCapacity, 3);
});

test('9. removes the oldest observation first', () => {
  const buf = new AiShadowPricingObservationService({ capacity: 3 });
  for (let i = 0; i < 5; i++) buf.record(observation(`s${i}`));
  assert.deepEqual(
    buf.snapshot().map((o) => o.source),
    ['s2', 's3', 's4'],
  );
});

test('10. returned snapshots cannot mutate internal state', () => {
  const buf = new AiShadowPricingObservationService({ capacity: 4 });
  buf.record(observation('a'));
  const snap = buf.snapshot();
  snap.pop();
  (snap as unknown as unknown[]).splice(0, 1);
  (buf.snapshot()[0].report as { summaryStatus: string }).summaryStatus = 'HACKED';
  const fresh = buf.snapshot()[0].report;
  assert.deepEqual(
    fresh,
    buf.snapshot()[0].report,
  );
  assert.equal(buf.size(), 1);
  assert.equal(buf.snapshot().length, 1);
});

test('11. reset is deterministic for tests', () => {
  const buf = new AiShadowPricingObservationService({ capacity: 3 });
  buf.record(observation('a'));
  buf.record(observation('b'));
  buf.reset();
  assert.equal(buf.size(), 0);
  assert.deepEqual(buf.snapshot(), []);
});

test('12. cache-hit / noProviderCalls observations can be represented', () => {
  const buf = new AiShadowPricingObservationService({ capacity: 2 });
  const cacheHit = observation('identify-miss-cache', true, 0);
  buf.record(cacheHit);
  const snap = buf.snapshot()[0];
  assert.equal(snap.report.noProviderCalls, true);
  assert.equal(snap.report.summaryStatus, 'UNPRICED');
  assert.deepEqual(snap.report.calls, []);
  assert.equal(snap.report.totals.callCount, 0);
});

test('default capacity is 500', () => {
  assert.equal(new AiShadowPricingObservationService().maxCapacity, DEFAULT_OBSERVATION_CAPACITY);
});

test('mutating original after record() does not affect buffer', () => {
  const buf = new AiShadowPricingObservationService({ capacity: 3 });
  const orig = observation('a');
  buf.record(orig);
  const storedBefore = buf.snapshot()[0];
  orig.source = 'MUTATED';
  orig.report.summaryStatus = 'HACKED' as RequestSummaryStatus;
  orig.report.calls.push({ kind: 'UNPRICED', provider: 'x', providerCallId: 'y', reason: 'MODEL_MISSING' });
  const storedAfter = buf.snapshot()[0];
  assert.equal(storedAfter.source, 'a');
  assert.equal(storedAfter.report.summaryStatus, 'PARTIALLY_PRICED');
  assert.equal(storedAfter.report.calls.length, 1);
  assert.equal(storedAfter.report.calls[0].providerCallId, 'c');
  assert.deepEqual(storedAfter, storedBefore);
});

test('mutating a returned snapshot does not affect buffer', () => {
  const buf = new AiShadowPricingObservationService({ capacity: 3 });
  buf.record(observation('a'));
  const snap = buf.snapshot();
  snap[0].source = 'MUTATED';
  snap[0].report.summaryStatus = 'HACKED' as RequestSummaryStatus;
  snap[0].report.calls.push({ kind: 'UNPRICED', provider: 'x', providerCallId: 'y', reason: 'MODEL_MISSING' });
  const fresh = buf.snapshot();
  assert.equal(fresh[0].source, 'a');
  assert.equal(fresh[0].report.summaryStatus, 'PARTIALLY_PRICED');
  assert.equal(fresh[0].report.calls.length, 1);
  assert.equal(fresh[0].report.calls[0].providerCallId, 'c');
});