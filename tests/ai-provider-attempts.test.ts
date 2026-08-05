/**
 * Phase 2E-A2 failed provider attempt & retry observability — Core Server.
 *
 * Covers the attempt contract on the Core side:
 *  - normalization of `providerAttempts` (drop invalid, preserve order)
 *  - `attemptRiskStatus` derivation (NONE / FAILED_ATTEMPT_PRESENT /
 *    INDETERMINATE_COST_RISK), kept strictly separate from pricing
 *  - threading of `providerAttempts` from `recordAiUsage` into the shadow
 *    pricing observation buffer
 *  - attempt metrics aggregation (totals, retry, risk, dimensions) and admin
 *    observation rows
 *  - safety: attempts never create provider calls, never create AiUsageLog
 *    rows, never touch Wallet / Durable Billing, and never change pricing
 *    semantics
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAiUsage, recordAiUsageWith } from '../src/services/ai-usage.service.js';
import type { RecordAiUsageDeps, AiUsageLogRow } from '../src/services/ai-usage.service.js';
import type { ShadowPricingRequestContext, ShadowPricingOutcome } from '../src/services/ai-shadow-pricing.service.js';
import {
  shadowPricingService,
  DEFAULT_OBSERVATION_BUFFER,
} from '../src/services/ai-shadow-pricing.service.js';
import {
  normalizeProviderAttempts,
  computeAttemptRiskStatus,
  attemptsIncludeRetry,
} from '../src/utils/ai-usage.js';
import { computeShadowPricingMetrics } from '../src/services/ai-shadow-pricing-metrics.service.js';
import { queryShadowPricingObservations } from '../src/services/ai-shadow-pricing-observation-query.service.js';
import type { ShadowPricingObservation } from '../src/services/ai-shadow-pricing-observation.service.js';
import type { ProviderAttempt } from '../src/types/ai.js';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(TESTS_DIR, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

const EMPTY_REASONS = {
  PROVIDER_NOT_IN_RATECARD: 0, MODEL_MISSING: 0, ACTUAL_MODEL_NOT_IN_RATECARD: 0,
  REQUESTED_MODEL_NOT_IN_RATECARD: 0, USAGE_MISSING: 0, USAGE_INVALID: 0,
  RATE_NOT_ACTIVE: 0, UNIT_UNPRICED: 0, MODALITY_INVALID: 0, OVERFLOW: 0,
};

function attempt(overrides?: Partial<ProviderAttempt>): ProviderAttempt {
  return {
    attemptId: 'attempt-1',
    provider: 'google',
    operation: 'TEXT_CHAT',
    requestedModel: 'gemini-3.6-flash',
    actualModel: 'gemini-3.6-flash',
    attemptNumber: 1,
    outcome: 'SUCCEEDED',
    providerCallStarted: true,
    providerCallStartedAt: '2026-08-03T00:00:00.000Z',
    providerResponseReceived: true,
    providerCallId: 'call-1',
    ...overrides,
  };
}

function validCall(id: string, totalTokens: number) {
  return {
    provider: 'google',
    providerCallMade: true,
    providerCallId: id,
    requestedModel: 'gemini-3.6-flash',
    actualModel: 'gemini-3.6-flash',
    operation: 'TEXT_CHAT',
    inputTokens: 100,
    outputTokens: 40,
    totalTokens,
  };
}

function fakeDeps(overrides?: {
  writeCount?: number;
  onRows?: (rows: AiUsageLogRow[]) => void;
  shadowRecord?: (calls: unknown, ctx: ShadowPricingRequestContext) => ShadowPricingOutcome;
  throwOnShadow?: Error;
}): RecordAiUsageDeps {
  return {
    writeAiUsageLogRows: async (rows) => {
      if (overrides?.onRows) overrides.onRows(rows);
      return overrides?.writeCount ?? rows.length;
    },
    writeAiUsageLog: async () => {},
    runShadowPricing: (calls, ctx) => {
      if (overrides?.throwOnShadow) throw overrides.throwOnShadow;
      if (overrides?.shadowRecord) return overrides.shadowRecord(calls, ctx);
      return shadowPricingService.record(calls, ctx);
    },
  };
}

function makeObs(overrides?: Partial<ShadowPricingObservation>): ShadowPricingObservation {
  const report = {
    pricedAt: '2026-08-03T00:00:00.000Z',
    noProviderCalls: false,
    summaryStatus: 'FULLY_PRICED' as const,
    calls: [{
      kind: 'PRICED',
      provider: 'google',
      providerCallId: 'call-1',
      actualModel: 'gemini-3.6-flash',
      reason: 'ACTUAL_MODEL',
      rateCard: { version: '1.0.0', model: 'gemini-3.6-flash', tier: 'standard', billingUnit: 'TOKEN' },
      costNanoUsd: '3825000',
      costMicroUsd: '3825',
      costUsd: '0.003825000',
    }],
    totals: {
      callCount: 1, pricedCallCount: 1, unpricedCallCount: 0,
      unpricedReasons: { ...EMPTY_REASONS },
      pricedCostNanoUsd: '3825000', pricedCostMicroUsd: '3825', pricedCostUsd: '0.003825000',
    },
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

function assertNoBigint(value: unknown, path = 'root'): void {
  if (typeof value === 'bigint') assert.fail(`bigint at ${path}`);
  if (Array.isArray(value)) value.forEach((v, i) => assertNoBigint(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoBigint(v, `${path}.${k}`);
  }
}

test('1. normalizeProviderAttempts: valid array preserved in order; non-array → undefined; [] → []', () => {
  const raw = [
    attempt({ attemptId: 'attempt-1', attemptNumber: 1, outcome: 'FAILED', providerCallId: undefined, errorCategory: 'RATE_LIMIT', httpStatus: 429 }),
    attempt({ attemptId: 'attempt-2', attemptNumber: 2, outcome: 'SUCCEEDED' }),
  ];
  const normalized = normalizeProviderAttempts(raw)!;
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].attemptId, 'attempt-1');
  assert.equal(normalized[0].attemptNumber, 1);
  assert.equal(normalized[0].outcome, 'FAILED');
  assert.equal(normalized[0].providerCallId, undefined);
  assert.equal(normalized[0].httpStatus, 429);
  assert.equal(normalized[1].attemptId, 'attempt-2');
  assert.equal(normalized[1].attemptNumber, 2);
  assert.equal(normalized[1].outcome, 'SUCCEEDED');
  assert.equal(normalized[1].providerCallId, 'call-1');
  assert.equal(normalizeProviderAttempts(undefined), undefined);
  assert.equal(normalizeProviderAttempts({ not: 'an array' }), undefined);
  assert.deepEqual(normalizeProviderAttempts([]), []);
});

test('2. normalizeProviderAttempts: invalid elements dropped individually, valid kept', () => {
  const raw = [
    null,
    { attemptId: '', provider: 'google', attemptNumber: 1, outcome: 'SUCCEEDED', providerResponseReceived: true },
    { attemptId: 'bad-number', provider: 'google', attemptNumber: 0, outcome: 'SUCCEEDED', providerResponseReceived: true },
    { attemptId: 'bad-outcome', provider: 'google', attemptNumber: 1, outcome: 'MAYBE', providerResponseReceived: true },
    { attemptId: 'bad-http', provider: 'google', attemptNumber: 1, outcome: 'FAILED', providerResponseReceived: true, httpStatus: 4.5 },
    { attemptId: 'bad-optional', provider: 'google', attemptNumber: 1, outcome: 'FAILED', providerResponseReceived: true, requestedModel: '' },
    attempt({ attemptId: 'ok', attemptNumber: 2, outcome: 'SUCCEEDED' }),
    { attemptId: 'missing-received', provider: 'google', attemptNumber: 1, outcome: 'FAILED' },
  ];
  const normalized = normalizeProviderAttempts(raw)!;
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].attemptId, 'ok');
});

test('3. computeAttemptRiskStatus: NONE / FAILED_ATTEMPT_PRESENT / INDETERMINATE precedence', () => {
  assert.equal(computeAttemptRiskStatus(undefined), 'NONE');
  assert.equal(computeAttemptRiskStatus([]), 'NONE');
  assert.equal(computeAttemptRiskStatus([attempt({ outcome: 'SUCCEEDED' })]), 'NONE');
  assert.equal(
    computeAttemptRiskStatus([attempt({ outcome: 'FAILED', attemptNumber: 1 }), attempt({ outcome: 'SUCCEEDED', attemptNumber: 2 })]),
    'FAILED_ATTEMPT_PRESENT',
  );
  assert.equal(
    computeAttemptRiskStatus([
      attempt({ outcome: 'FAILED', attemptNumber: 1 }),
      attempt({ outcome: 'INDETERMINATE', attemptNumber: 2 }),
    ]),
    'INDETERMINATE_COST_RISK',
    'INDETERMINATE takes precedence over FAILED',
  );
});

test('4. attemptsIncludeRetry: true only when any attemptNumber > 1', () => {
  assert.equal(attemptsIncludeRetry(undefined), false);
  assert.equal(attemptsIncludeRetry([]), false);
  assert.equal(attemptsIncludeRetry([attempt({ attemptNumber: 1 })]), false);
  assert.equal(
    attemptsIncludeRetry([
      attempt({ attemptNumber: 1, outcome: 'FAILED' }),
      attempt({ attemptNumber: 2, outcome: 'SUCCEEDED' }),
    ]),
    true,
  );
});

test('5. recordAiUsageWith passes providerAttempts into the shadow ctx and stores them on the observation', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  let capturedCtx: ShadowPricingRequestContext | undefined;
  const attempts = [
    attempt({ attemptId: 'attempt-1', attemptNumber: 1, outcome: 'FAILED', providerCallId: undefined, errorCategory: 'RATE_LIMIT', httpStatus: 429 }),
    attempt({ attemptId: 'attempt-2', attemptNumber: 2, outcome: 'SUCCEEDED', providerCallId: 'call-1' }),
  ];
  const deps = fakeDeps({
    writeCount: 1,
    shadowRecord: (calls, ctx) => {
      capturedCtx = ctx;
      return shadowPricingService.record(calls, ctx);
    },
  });
  await recordAiUsageWith(
    { userId: 'u1', source: 'chat', providerCalls: [validCall('call-1', 140)], providerAttempts: attempts },
    deps,
  );
  assert.equal(capturedCtx?.providerAttempts, attempts, 'raw attempts flow into shadow ctx');
  const obs = DEFAULT_OBSERVATION_BUFFER.snapshot()[DEFAULT_OBSERVATION_BUFFER.snapshot().length - 1];
  assert.equal(obs.attemptRiskStatus, 'FAILED_ATTEMPT_PRESENT');
  assert.equal(obs.attempts?.length, 2);
  assert.equal(obs.attempts?.[0].attemptId, 'attempt-1');
  assert.equal(obs.attempts?.[1].providerCallId, 'call-1');
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('6. retry-then-success: FAILED_ATTEMPT_PRESENT without changing FULLY_PRICED', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  const deps = fakeDeps({
    writeCount: 1,
    shadowRecord: (calls, ctx) => shadowPricingService.record(calls, ctx),
  });
  await recordAiUsageWith(
    {
      userId: 'u1',
      source: 'chat',
      providerCalls: [validCall('call-final', 140)],
      providerAttempts: [
        attempt({ attemptId: 'attempt-1', attemptNumber: 1, outcome: 'FAILED', providerCallId: undefined, errorCategory: 'SERVER_ERROR', httpStatus: 503 }),
        attempt({ attemptId: 'attempt-2', attemptNumber: 2, outcome: 'SUCCEEDED', providerCallId: 'call-final' }),
      ],
    },
    deps,
  );
  const obs = DEFAULT_OBSERVATION_BUFFER.snapshot()[DEFAULT_OBSERVATION_BUFFER.snapshot().length - 1];
  assert.equal(obs.attemptRiskStatus, 'FAILED_ATTEMPT_PRESENT');
  assert.equal(obs.report.summaryStatus, 'FULLY_PRICED', 'attempts must not change pricing summaryStatus');
  assert.equal(obs.report.totals.callCount, 1, 'only the successful call is a provider call');
  assert.equal(obs.attempts?.length, 2);
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('7. INDETERMINATE attempt → INDETERMINATE_COST_RISK while pricing semantics are unchanged', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  const deps = fakeDeps({
    writeCount: 1,
    shadowRecord: (calls, ctx) => shadowPricingService.record(calls, ctx),
  });
  await recordAiUsageWith(
    {
      userId: 'u1',
      source: 'chat',
      providerCalls: [validCall('call-x', 140)],
      providerAttempts: [
        attempt({ attemptId: 'attempt-1', attemptNumber: 1, outcome: 'INDETERMINATE', providerCallId: 'call-x', errorCategory: 'TIMEOUT' }),
      ],
    },
    deps,
  );
  const obs = DEFAULT_OBSERVATION_BUFFER.snapshot()[DEFAULT_OBSERVATION_BUFFER.snapshot().length - 1];
  assert.equal(obs.attemptRiskStatus, 'INDETERMINATE_COST_RISK');
  assert.equal(obs.report.summaryStatus, 'FULLY_PRICED');
  assert.equal(obs.report.totals.callCount, 1);
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('8. cache hit: providerCalls=[] + providerAttempts=[] → ZERO_PROVIDER_CALLS observation with NONE risk', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  const deps = fakeDeps({
    shadowRecord: (calls, ctx) => shadowPricingService.record(calls, ctx),
  });
  const result = await recordAiUsageWith(
    { userId: 'u1', source: 'identify', providerCalls: [], providerAttempts: [] },
    deps,
  );
  assert.equal(result, null);
  const obs = DEFAULT_OBSERVATION_BUFFER.snapshot()[DEFAULT_OBSERVATION_BUFFER.snapshot().length - 1];
  assert.equal(obs.report.noProviderCalls, true);
  assert.equal(obs.attemptRiskStatus, 'NONE');
  assert.deepEqual(obs.attempts, []);
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('9. malformed providerAttempts are default-safe and never throw', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  const deps = fakeDeps({
    writeCount: 1,
    shadowRecord: (calls, ctx) => shadowPricingService.record(calls, ctx),
  });
  await recordAiUsageWith(
    {
      userId: 'u1',
      source: 'chat',
      providerCalls: [validCall('call-1', 140)],
      providerAttempts: { not: 'an array' },
    },
    deps,
  );
  let obs = DEFAULT_OBSERVATION_BUFFER.snapshot()[DEFAULT_OBSERVATION_BUFFER.snapshot().length - 1];
  assert.equal(obs.attemptRiskStatus, 'NONE', 'non-array attempts default to NONE');
  assert.deepEqual(obs.attempts, []);

  await recordAiUsageWith(
    {
      userId: 'u1',
      source: 'chat',
      providerCalls: [validCall('call-2', 140)],
      providerAttempts: [{ garbage: true }, attempt({ attemptId: 'attempt-1', attemptNumber: 1, outcome: 'FAILED', providerCallId: undefined })],
    },
    deps,
  );
  obs = DEFAULT_OBSERVATION_BUFFER.snapshot()[DEFAULT_OBSERVATION_BUFFER.snapshot().length - 1];
  assert.equal(obs.attempts?.length, 1, 'invalid elements dropped, valid kept');
  assert.equal(obs.attemptRiskStatus, 'FAILED_ATTEMPT_PRESENT');
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('10. attempts ride the pricing observation: skipped providerCalls record no observation', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  const deps = fakeDeps({
    shadowRecord: (calls, ctx) => shadowPricingService.record(calls, ctx),
  });
  await recordAiUsageWith(
    {
      userId: 'u1',
      source: 'chat',
      providerAttempts: [attempt({ outcome: 'FAILED', providerCallId: undefined })],
    },
    deps,
  );
  assert.equal(DEFAULT_OBSERVATION_BUFFER.size(), 0, 'absent providerCalls skip pricing and store no observation');
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('11. metrics aggregate attempt totals across observations', () => {
  const metrics = computeShadowPricingMetrics([
    makeObs({
      attempts: [
        attempt({ attemptId: 'a1', attemptNumber: 1, outcome: 'SUCCEEDED' }),
        attempt({ attemptId: 'a2', attemptNumber: 2, outcome: 'FAILED', providerCallId: undefined, errorCategory: 'RATE_LIMIT', httpStatus: 429 }),
      ],
    }),
    makeObs({
      observedAt: '2026-08-03T00:00:01.000Z',
      attempts: [attempt({ attemptId: 'a3', attemptNumber: 1, outcome: 'INDETERMINATE', errorCategory: 'TIMEOUT' })],
    }),
    makeObs({ observedAt: '2026-08-03T00:00:02.000Z' }),
  ]);
  assert.equal(metrics.attempts.totalAttempts, 3);
  assert.equal(metrics.attempts.succeeded, 1);
  assert.equal(metrics.attempts.failed, 1);
  assert.equal(metrics.attempts.indeterminate, 1);
});

test('12. metrics aggregate retry/risk counters and dimension breakdowns', () => {
  const metrics = computeShadowPricingMetrics([
    makeObs({
      attempts: [
        attempt({ attemptId: 'a1', attemptNumber: 1, outcome: 'FAILED', providerCallId: undefined, errorCategory: 'RATE_LIMIT' }),
        attempt({ attemptId: 'a2', attemptNumber: 2, outcome: 'SUCCEEDED' }),
      ],
    }),
    makeObs({
      observedAt: '2026-08-03T00:00:01.000Z',
      source: 'voice',
      attempts: [attempt({ attemptId: 'a3', attemptNumber: 1, outcome: 'INDETERMINATE', errorCategory: 'TIMEOUT' })],
    }),
  ]);
  assert.equal(metrics.attempts.retryContainingRequests, 1);
  assert.equal(metrics.attempts.indeterminateCostRisk, 1);
  assert.equal(metrics.attempts.byProvider['google'], 3);
  assert.equal(metrics.attempts.byOperation['TEXT_CHAT'], 3);
  assert.equal(metrics.attempts.byRequestedModel['gemini-3.6-flash'], 3);
  assert.equal(metrics.attempts.byActualModel['gemini-3.6-flash'], 3);
  assert.equal(metrics.attempts.byErrorCategory['RATE_LIMIT'], 1);
  assert.equal(metrics.attempts.byErrorCategory['TIMEOUT'], 1);
});

test('13. metrics attempts output is JSON-safe and holds no sensitive content', () => {
  const metrics = computeShadowPricingMetrics([
    makeObs({
      attempts: [
        attempt({
          attemptId: 'a1',
          attemptNumber: 1,
          outcome: 'FAILED',
          providerCallId: undefined,
          errorCategory: 'RATE_LIMIT',
          httpStatus: 429,
        }),
        attempt({ attemptId: 'a2', attemptNumber: 2, outcome: 'SUCCEEDED' }),
      ],
    }),
  ]);
  JSON.stringify(metrics);
  assertNoBigint(metrics);
  const json = JSON.stringify(metrics);
  assert.ok(!json.includes('TOP-SECRET'));
  assert.ok(!json.includes('"prompt"'));
  assert.ok(!json.includes('"response"'));
  assert.ok(!json.includes('"media"'));
  assert.ok(!('attemptRiskStatus' in metrics), 'metrics exposes aggregate attempts, not per-request risk');
});

test('14. observation query rows expose attemptRiskStatus and attempt counters', () => {
  const result = queryShadowPricingObservations([
    makeObs({
      attempts: [
        attempt({ attemptId: 'a1', attemptNumber: 1, outcome: 'FAILED', providerCallId: undefined, errorCategory: 'RATE_LIMIT' }),
        attempt({ attemptId: 'a2', attemptNumber: 2, outcome: 'SUCCEEDED' }),
      ],
    }),
    makeObs({
      observedAt: '2026-08-03T00:00:01.000Z',
      attempts: [attempt({ attemptId: 'a3', attemptNumber: 1, outcome: 'INDETERMINATE', errorCategory: 'TIMEOUT' })],
    }),
    makeObs({ observedAt: '2026-08-03T00:00:02.000Z' }),
  ]);
  assert.equal(result.data.length, 3);
  assert.equal(result.data[0].attemptRiskStatus, 'NONE');
  assert.equal(result.data[0].attemptCount, 0);
  assert.equal(result.data[1].attemptRiskStatus, 'INDETERMINATE_COST_RISK');
  assert.equal(result.data[1].attemptCount, 1);
  assert.equal(result.data[1].indeterminateAttemptCount, 1);
  assert.equal(result.data[2].attemptRiskStatus, 'FAILED_ATTEMPT_PRESENT');
  assert.equal(result.data[2].attemptCount, 2);
  assert.equal(result.data[2].failedAttemptCount, 1);
  assert.equal(result.data[2].indeterminateAttemptCount, 0);
  assert.equal(result.data[2].hasRetry, true);
  JSON.stringify(result);
  assertNoBigint(result);
});

test('15. production recordAiUsage end-to-end: attempts reach the buffer; no DB write; no Wallet; every call site threads providerAttempts', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  const result = await recordAiUsage({
    userId: '',
    source: 'chat',
    providerCalls: [validCall('call-1', 140)],
    providerAttempts: [
      attempt({ attemptId: 'attempt-1', attemptNumber: 1, outcome: 'FAILED', providerCallId: undefined, errorCategory: 'SERVER_ERROR', httpStatus: 503 }),
      attempt({ attemptId: 'attempt-2', attemptNumber: 2, outcome: 'SUCCEEDED', providerCallId: 'call-1' }),
    ],
  });
  assert.equal(result, undefined, 'empty userId → no AiUsageLog write');
  const obs = DEFAULT_OBSERVATION_BUFFER.snapshot()[DEFAULT_OBSERVATION_BUFFER.snapshot().length - 1];
  assert.equal(obs.attemptRiskStatus, 'FAILED_ATTEMPT_PRESENT');
  assert.equal(obs.attempts?.length, 2);
  assert.equal(obs.report.summaryStatus, 'FULLY_PRICED');
  DEFAULT_OBSERVATION_BUFFER.reset();

  // Attempts never create provider calls or telemetry rows: providerAttempts
  // are not read by the AiUsageLog row-writing path at all.
  const usageSource = readFileSync(join(SRC_ROOT, 'services/ai-usage.service.ts'), 'utf8');
  assert.ok(!/providerAttempts.*totalTokens|providerAttempts.*computeAiCost/.test(usageSource));

  // Every consumer call site threads providerAttempts into recordAiUsage.
  const callSites: Record<string, string> = {
    'services/voice.service.ts': 'voice',
    'services/identify.service.ts': 'identify',
    'services/chat.service.ts': 'chat',
    'services/itinerary.service.ts': 'itinerary',
    'routes/chat-stream.routes.ts': 'stream',
  };
  for (const [file, sourceName] of Object.entries(callSites)) {
    const text = readFileSync(join(SRC_ROOT, file), 'utf8');
    assert.ok(
      text.includes('providerAttempts'),
      `${file} must expose/pass providerAttempts for source=${sourceName}`,
    );
    assert.ok(
      /recordAiUsage\([\s\S]*providerAttempts/.test(text),
      `${file} must pass providerAttempts into recordAiUsage for source=${sourceName}`,
    );
  }
});

test('16. providerCallStarted boolean normalizes; providerCallStartedAt optional ISO kept', () => {
  const normalized = normalizeProviderAttempts([
    attempt({ providerCallStarted: true, providerCallStartedAt: '2026-08-03T00:00:00.000Z' }),
  ])!;
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].providerCallStarted, true);
  assert.equal(normalized[0].providerCallStartedAt, '2026-08-03T00:00:00.000Z');

  const withoutAt = normalizeProviderAttempts([
    attempt({ providerCallStarted: false, providerCallStartedAt: undefined }),
  ])!;
  assert.equal(withoutAt[0].providerCallStarted, false);
  assert.equal(withoutAt[0].providerCallStartedAt, undefined);
});

test('17. providerCallStartedAt: valid ISO accepted, invalid dropped (element kept)', () => {
  const normalized = normalizeProviderAttempts([
    attempt({ providerCallStartedAt: '2026-08-03T00:00:00.000Z' }),
    attempt({ attemptId: 'a2', providerCallStartedAt: 'not-a-timestamp' }),
  ])!;
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].providerCallStartedAt, '2026-08-03T00:00:00.000Z');
  assert.equal(normalized[1].providerCallStartedAt, undefined, 'invalid timestamp dropped, element kept');
});

test('18. legacy string providerCallStarted (ISO) → true + moved into providerCallStartedAt', () => {
  const legacy = {
    attemptId: 'attempt-1',
    provider: 'google',
    attemptNumber: 1,
    outcome: 'SUCCEEDED',
    providerCallStarted: '2026-08-03T00:00:00.000Z',
    providerResponseReceived: true,
  };
  const normalized = normalizeProviderAttempts([legacy])!;
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].providerCallStarted, true);
  assert.equal(normalized[0].providerCallStartedAt, '2026-08-03T00:00:00.000Z');
  const json = JSON.stringify(normalized[0]);
  assert.ok(!json.includes('"providerCallStarted":"2026-08-03T00:00:00.000Z"'), 'legacy string shape never exposed');
});

test('19. invalid providerCallStarted (non-boolean, non-ISO-string) rejects the element', () => {
  const raw = [
    attempt({ attemptId: 'a1', providerCallStarted: 123 }),
    attempt({ attemptId: 'a2', providerCallStarted: { bad: true } }),
    attempt({ attemptId: 'a3', providerCallStarted: 'garbage-not-iso' }),
    attempt({ attemptId: 'a4' }),
  ];
  const normalized = normalizeProviderAttempts(raw)!;
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].attemptId, 'a4');
});

test('20. INDETERMINATE 5xx attempt → INDETERMINATE_COST_RISK; pricing unchanged', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  const deps = fakeDeps({
    writeCount: 1,
    shadowRecord: (calls, ctx) => shadowPricingService.record(calls, ctx),
  });
  await recordAiUsageWith(
    {
      userId: 'u1',
      source: 'chat',
      providerCalls: [validCall('call-x', 140)],
      providerAttempts: [
        attempt({
          attemptId: 'attempt-1',
          attemptNumber: 1,
          outcome: 'INDETERMINATE',
          providerCallId: undefined,
          errorCategory: 'SERVER_ERROR',
          httpStatus: 503,
        }),
      ],
    },
    deps,
  );
  const obs = DEFAULT_OBSERVATION_BUFFER.snapshot()[DEFAULT_OBSERVATION_BUFFER.snapshot().length - 1];
  assert.equal(obs.attemptRiskStatus, 'INDETERMINATE_COST_RISK');
  assert.equal(obs.report.summaryStatus, 'FULLY_PRICED');
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('21. INDETERMINATE 429 attempt → INDETERMINATE_COST_RISK; pricing unchanged', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  const deps = fakeDeps({
    writeCount: 1,
    shadowRecord: (calls, ctx) => shadowPricingService.record(calls, ctx),
  });
  await recordAiUsageWith(
    {
      userId: 'u1',
      source: 'chat',
      providerCalls: [validCall('call-x', 140)],
      providerAttempts: [
        attempt({
          attemptId: 'attempt-1',
          attemptNumber: 1,
          outcome: 'INDETERMINATE',
          providerCallId: undefined,
          errorCategory: 'RATE_LIMIT',
          httpStatus: 429,
        }),
      ],
    },
    deps,
  );
  const obs = DEFAULT_OBSERVATION_BUFFER.snapshot()[DEFAULT_OBSERVATION_BUFFER.snapshot().length - 1];
  assert.equal(obs.attemptRiskStatus, 'INDETERMINATE_COST_RISK');
  assert.equal(obs.report.summaryStatus, 'FULLY_PRICED');
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('22. confirmed FAILED attempt → FAILED_ATTEMPT_PRESENT; INDETERMINATE still wins precedence', () => {
  assert.equal(
    computeAttemptRiskStatus([
      attempt({ outcome: 'FAILED', providerCallId: undefined }),
    ]),
    'FAILED_ATTEMPT_PRESENT',
  );
  assert.equal(
    computeAttemptRiskStatus([
      attempt({ outcome: 'FAILED', providerCallId: undefined }),
      attempt({ attemptId: 'a2', attemptNumber: 2, outcome: 'INDETERMINATE' }),
    ]),
    'INDETERMINATE_COST_RISK',
  );
});

test('23. providerCalls priced exactly once; attempts never create or alter provider calls', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  const deps = fakeDeps({
    writeCount: 1,
    shadowRecord: (calls, ctx) => shadowPricingService.record(calls, ctx),
  });
  await recordAiUsageWith(
    {
      userId: 'u1',
      source: 'chat',
      providerCalls: [validCall('call-1', 140)],
      providerAttempts: [
        attempt({ outcome: 'FAILED', providerCallId: undefined, errorCategory: 'INVALID_REQUEST', httpStatus: 400 }),
        attempt({ attemptId: 'a2', attemptNumber: 2, outcome: 'SUCCEEDED', providerCallId: 'call-1' }),
      ],
    },
    deps,
  );
  const obs = DEFAULT_OBSERVATION_BUFFER.snapshot()[DEFAULT_OBSERVATION_BUFFER.snapshot().length - 1];
  assert.equal(obs.report.totals.callCount, 1, 'only the real provider call is counted');
  assert.equal(obs.report.totals.pricedCallCount, 1);
  assert.equal(obs.report.totals.pricedCostUsd, '0.000450000');
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('24. metrics count corrected outcomes (SUCCEEDED/FAILED/INDETERMINATE) from corrected contract', () => {
  const metrics = computeShadowPricingMetrics([
    makeObs({
      attempts: [
        attempt({ attemptId: 'a1', attemptNumber: 1, outcome: 'SUCCEEDED', providerCallStarted: true }),
        attempt({ attemptId: 'a2', attemptNumber: 2, outcome: 'FAILED', providerCallId: undefined, errorCategory: 'AUTH_ERROR', httpStatus: 401 }),
        attempt({ attemptId: 'a3', attemptNumber: 3, outcome: 'INDETERMINATE', errorCategory: 'TIMEOUT' }),
      ],
    }),
  ]);
  assert.equal(metrics.attempts.totalAttempts, 3);
  assert.equal(metrics.attempts.succeeded, 1);
  assert.equal(metrics.attempts.failed, 1);
  assert.equal(metrics.attempts.indeterminate, 1);
  assert.equal(metrics.attempts.byErrorCategory['AUTH_ERROR'], 1);
  assert.equal(metrics.attempts.byErrorCategory['TIMEOUT'], 1);
  JSON.stringify(metrics);
  assertNoBigint(metrics);
});

test('25. Wallet / Durable Billing are never invoked by attempt observability', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  const deps = fakeDeps({
    writeCount: 1,
    shadowRecord: (calls, ctx) => shadowPricingService.record(calls, ctx),
  });
  await recordAiUsageWith(
    {
      userId: 'u1',
      source: 'chat',
      providerCalls: [validCall('call-1', 140)],
      providerAttempts: [
        attempt({ outcome: 'INDETERMINATE', errorCategory: 'SERVER_ERROR', httpStatus: 500 }),
      ],
    },
    deps,
  );
  const obs = DEFAULT_OBSERVATION_BUFFER.snapshot()[DEFAULT_OBSERVATION_BUFFER.snapshot().length - 1];
  assert.equal(obs.attemptRiskStatus, 'INDETERMINATE_COST_RISK');
  assert.equal(obs.report.summaryStatus, 'FULLY_PRICED', 'no cost reserve/settle triggered by attempts');
  DEFAULT_OBSERVATION_BUFFER.reset();
});
