import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OBSERVATION_BUFFER } from '../src/services/ai-shadow-pricing.service.js';
import { recomputePreviewHandler } from '../src/controllers/ai-shadow-pricing-admin.controller.js';
import type { ShadowPricingObservation } from '../src/services/ai-shadow-pricing-observation.service.js';
import type { RecomputeRepository } from '../src/services/ai-shadow-pricing-recompute.service.js';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(TESTS_DIR, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

const EMPTY_REASONS = {
  PROVIDER_NOT_IN_RATECARD: 0, MODEL_MISSING: 0, ACTUAL_MODEL_NOT_IN_RATECARD: 0,
  REQUESTED_MODEL_NOT_IN_RATECARD: 0, USAGE_MISSING: 0, USAGE_INVALID: 0,
  RATE_NOT_ACTIVE: 0, UNIT_UNPRICED: 0, MODALITY_INVALID: 0, OVERFLOW: 0,
};

function pricedObs(): ShadowPricingObservation {
  return {
    observedAt: '2026-08-03T00:00:00.000Z',
    source: 'chat',
    conversationId: 'c1',
    report: {
      pricedAt: '2026-08-03T00:00:00.000Z',
      noProviderCalls: false,
      summaryStatus: 'FULLY_PRICED',
      calls: [{
        kind: 'PRICED',
        provider: 'google',
        providerCallId: 'a',
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
    },
  };
}

function unpricedObs(): ShadowPricingObservation {
  return {
    observedAt: '2026-08-03T00:00:01.000Z',
    source: 'voice',
    conversationId: 'c2',
    report: {
      pricedAt: '2026-08-03T00:00:01.000Z',
      noProviderCalls: false,
      summaryStatus: 'UNPRICED',
      calls: [{
        kind: 'UNPRICED',
        provider: 'google',
        providerCallId: 'b',
        actualModel: 'gemini-mystery',
        reason: 'ACTUAL_MODEL_NOT_IN_RATECARD',
      }],
      totals: {
        callCount: 1, pricedCallCount: 0, unpricedCallCount: 1,
        unpricedReasons: { ...EMPTY_REASONS, ACTUAL_MODEL_NOT_IN_RATECARD: 1 },
        pricedCostNanoUsd: '0', pricedCostMicroUsd: '0', pricedCostUsd: '0.000000000',
      },
      rateCardVersion: '1.0.0',
    },
  };
}

function cacheHitObs(): ShadowPricingObservation {
  return {
    observedAt: '2026-08-03T00:00:02.000Z',
    source: 'identify',
    conversationId: 'c3',
    report: {
      pricedAt: '2026-08-03T00:00:02.000Z',
      noProviderCalls: true,
      summaryStatus: 'UNPRICED',
      calls: [],
      totals: {
        callCount: 0, pricedCallCount: 0, unpricedCallCount: 0,
        unpricedReasons: { ...EMPTY_REASONS },
        pricedCostNanoUsd: '0', pricedCostMicroUsd: '0', pricedCostUsd: '0.000000000',
      },
      rateCardVersion: '1.0.0',
    },
  };
}

function mockRes() {
  let statusCode = 200;
  let jsonData: unknown;
  // `_json` is intentionally typed as `any` so endpoint contract assertions
  // can read the captured body directly.
  return {
    _status: 200 as number,
    _json: undefined as any,
    status: function (s: number) { statusCode = s; this._status = s; return this; },
    json: function (data: unknown) { jsonData = data; this._json = data; },
  };
}

function assertNoBigint(value: unknown, path = 'root'): void {
  if (typeof value === 'bigint') assert.fail(`bigint at ${path}`);
  if (Array.isArray(value)) value.forEach((v, i) => assertNoBigint(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoBigint(v, `${path}.${k}`);
  }
}

function fakeRecomputeRepository(): RecomputeRepository {
  return {
    fetchRows: async () => [],
  };
}

test('1. unauthenticated request receives existing 401 behavior', async () => {
  const { authenticate } = await import('../src/middleware/auth.js');
  const req = { headers: {} } as any;
  let status = 0;
  authenticate(req, {} as any, (err: any) => { status = err?.statusCode ?? 0; });
  assert.equal(status, 401);
});

test('2. authenticated non-admin receives existing 403 behavior', async () => {
  const { requireRole } = await import('../src/middleware/rbac.js');
  const req = { user: { role: 'user' } } as any;
  let status = 0;
  requireRole('admin')(req, {} as any, (err: any) => { status = err?.statusCode ?? 0; });
  assert.equal(status, 403);
});

test('3. admin summary receives 200', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  DEFAULT_OBSERVATION_BUFFER.record(pricedObs());
  const { getShadowPricingSummary } = await import('../src/controllers/ai-shadow-pricing-admin.controller.js');
  const res = mockRes();
  await getShadowPricingSummary({} as any, res as any, (e: unknown) => { if (e) throw e; });
  assert.equal(res._status, 200);
  assert.equal(res._json.requests.totalObserved, 1);
  assert.equal(res._json.requests.fullyPriced, 1);
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('4. admin observations receives 200', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  DEFAULT_OBSERVATION_BUFFER.record(pricedObs());
  const { getShadowPricingObservations } = await import('../src/controllers/ai-shadow-pricing-admin.controller.js');
  const res = mockRes();
  await getShadowPricingObservations({ query: {} } as any, res as any, (e: unknown) => { if (e) throw e; });
  assert.equal(res._status, 200);
  assert.equal(res._json.data.length, 1);
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('5. admin recompute preview receives 200 using a dependency/fake seam', async () => {
  const handler = recomputePreviewHandler({ repository: fakeRecomputeRepository() });
  const res = mockRes();
  await handler(
    { body: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' } } as any,
    res as any,
    (e: unknown) => { if (e) throw e; },
  );
  assert.equal(res._status, 200);
  assert.equal(res._json.mode, 'READ_ONLY_PREVIEW');
  assert.equal(res._json.requestAggregationAvailable, false);
  assert.equal(res._json.rows.scanned, 0);
});

test('6. invalid observation limit rejected', async () => {
  const { adminObservationsQuerySchema } = await import('../src/schemas/admin-shadow-pricing.schema.js');
  for (const bad of [{ limit: -1 }, { limit: 0 }, { limit: 201 }, { limit: 'abc' }]) {
    const r = adminObservationsQuerySchema.safeParse(bad);
    assert.equal(r.success, false, `expected failure for ${JSON.stringify(bad)}`);
  }
});

test('7. invalid observation boolean rejected', async () => {
  const { adminObservationsQuerySchema } = await import('../src/schemas/admin-shadow-pricing.schema.js');
  for (const bad of ['yes', '1', '0', '', 'TRUE', 'False', 1, 0]) {
    const r = adminObservationsQuerySchema.safeParse({ noProviderCalls: bad });
    assert.equal(r.success, false, `expected failure for ${JSON.stringify(bad)}`);
  }
  const f = adminObservationsQuerySchema.safeParse({ noProviderCalls: 'false' });
  assert.equal(f.success, true);
  assert.equal((f.data as { noProviderCalls: boolean }).noProviderCalls, false);
  const t = adminObservationsQuerySchema.safeParse({ noProviderCalls: 'true' });
  assert.equal(t.success, true);
  assert.equal((t.data as { noProviderCalls: boolean }).noProviderCalls, true);
});

test('8. invalid recompute range rejected (from > to)', async () => {
  const { adminRecomputeBodySchema } = await import('../src/schemas/admin-shadow-pricing.schema.js');
  const r = adminRecomputeBodySchema.safeParse({
    from: '2026-08-10T00:00:00.000Z',
    to: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(r.success, false);
});

test('9. recompute range over 31 days rejected', async () => {
  const { adminRecomputeBodySchema } = await import('../src/schemas/admin-shadow-pricing.schema.js');
  const ok = adminRecomputeBodySchema.safeParse({
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });
  assert.equal(ok.success, true);
  const tooLong = adminRecomputeBodySchema.safeParse({
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(tooLong.success, false);
});

test('10. recompute limit over 500 rejected', async () => {
  const { adminRecomputeBodySchema } = await import('../src/schemas/admin-shadow-pricing.schema.js');
  for (const bad of [{ limit: 501 }, { limit: 0 }, { limit: -1 }]) {
    const r = adminRecomputeBodySchema.safeParse({
      ...bad,
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-02T00:00:00.000Z',
    });
    assert.equal(r.success, false, `expected failure for ${JSON.stringify(bad)}`);
  }
});

test('11. responses contain no bigint', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  DEFAULT_OBSERVATION_BUFFER.record(pricedObs());
  DEFAULT_OBSERVATION_BUFFER.record(unpricedObs());
  DEFAULT_OBSERVATION_BUFFER.record(cacheHitObs());
  const { getShadowPricingSummary, getShadowPricingObservations } = await import('../src/controllers/ai-shadow-pricing-admin.controller.js');
  const summaryRes = mockRes();
  await getShadowPricingSummary({} as any, summaryRes as any, (e: unknown) => { if (e) throw e; });
  JSON.stringify(summaryRes._json);
  assertNoBigint(summaryRes._json);
  const obsRes = mockRes();
  await getShadowPricingObservations({ query: {} } as any, obsRes as any, (e: unknown) => { if (e) throw e; });
  JSON.stringify(obsRes._json);
  assertNoBigint(obsRes._json);
  const recomputeRes = mockRes();
  const handler = recomputePreviewHandler({ repository: fakeRecomputeRepository() });
  await handler(
    { body: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' } } as any,
    recomputeRes as any,
    (e: unknown) => { if (e) throw e; },
  );
  JSON.stringify(recomputeRes._json);
  assertNoBigint(recomputeRes._json);
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('12. no public route exposes the metrics', () => {
  const adminRoutes = readFileSync(join(SRC_ROOT, 'routes/admin.routes.ts'), 'utf8');
  const lines = adminRoutes.split('\n');
  for (const path of ['/ai-shadow-pricing/summary', '/ai-shadow-pricing/observations', '/ai-shadow-pricing/recompute-preview']) {
    const idx = lines.findIndex((l) => l.includes(path));
    assert.ok(idx !== -1, `missing route ${path}`);
    const block = lines.slice(idx, idx + 14).join(' ');
    assert.ok(block.includes("requireRole('admin')"), `route ${path} lacks requireRole('admin')`);
  }
  const publicFiles = ['index.ts', 'auth.routes.ts', 'user.routes.ts', 'chat.routes.ts',
    'chat-stream.routes.ts', 'voice.routes.ts', 'identify.routes.ts', 'itinerary.routes.ts',
    'token.routes.ts', 'payment.routes.ts', 'dashboard/users.routes.ts'];
  for (const file of publicFiles) {
    const text = readFileSync(join(SRC_ROOT, 'routes', file), 'utf8');
    if (text.includes('ai-shadow-pricing')) {
      assert.fail(`found ai-shadow-pricing reference in non-admin route file: ${file}`);
    }
  }
});

test('13. endpoint response includes ephemeral/per-process metadata', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  DEFAULT_OBSERVATION_BUFFER.record(pricedObs());
  const { getShadowPricingSummary, getShadowPricingObservations } = await import('../src/controllers/ai-shadow-pricing-admin.controller.js');
  const summaryRes = mockRes();
  await getShadowPricingSummary({} as any, summaryRes as any, (e: unknown) => { if (e) throw e; });
  assert.equal(summaryRes._json.window.storage, 'IN_MEMORY');
  assert.equal(summaryRes._json.window.ephemeral, true);
  assert.equal(summaryRes._json.window.perProcess, true);
  assert.equal(summaryRes._json.window.capacity, 500);
  assert.equal(summaryRes._json.window.retainedObservations, 1);
  const obsRes = mockRes();
  await getShadowPricingObservations({ query: {} } as any, obsRes as any, (e: unknown) => { if (e) throw e; });
  assert.equal(obsRes._json.meta.storage, 'IN_MEMORY');
  assert.equal(obsRes._json.meta.ephemeral, true);
  assert.equal(obsRes._json.meta.perProcess, true);
  assert.equal(obsRes._json.meta.capacity, 500);
  DEFAULT_OBSERVATION_BUFFER.reset();
});

test('14. zero-call observations are not exposed as normal unpriced failures', async () => {
  DEFAULT_OBSERVATION_BUFFER.reset();
  DEFAULT_OBSERVATION_BUFFER.record(unpricedObs());
  DEFAULT_OBSERVATION_BUFFER.record(cacheHitObs());
  const { getShadowPricingSummary, getShadowPricingObservations } = await import('../src/controllers/ai-shadow-pricing-admin.controller.js');
  const summaryRes = mockRes();
  await getShadowPricingSummary({} as any, summaryRes as any, (e: unknown) => { if (e) throw e; });
  assert.equal(summaryRes._json.requests.unpriced, 1);
  assert.equal(summaryRes._json.requests.zeroProviderCalls, 1);
  assert.equal(
    summaryRes._json.requests.fullyPriced + summaryRes._json.requests.partiallyPriced +
    summaryRes._json.requests.unpriced + summaryRes._json.requests.zeroProviderCalls,
    summaryRes._json.requests.totalObserved,
  );
  // Observations view: UNPRICED filter excludes the zero-call cache hit.
  const obsRes = mockRes();
  await getShadowPricingObservations({ query: { status: 'UNPRICED' } } as any, obsRes as any, (e: unknown) => { if (e) throw e; });
  assert.equal(obsRes._json.data.length, 1);
  assert.equal(obsRes._json.data[0].requestCategory, 'UNPRICED');
  // The zero-call observation is surfaced with a distinct request category.
  const allRes = mockRes();
  await getShadowPricingObservations({ query: {} } as any, allRes as any, (e: unknown) => { if (e) throw e; });
  const cacheHit = allRes._json.data.find((r: any) => r.requestCategory === 'ZERO_PROVIDER_CALLS');
  assert.ok(cacheHit, 'expected a ZERO_PROVIDER_CALLS category row');
  assert.equal(cacheHit.noProviderCalls, true);
  assert.equal(cacheHit.engineSummaryStatus, 'UNPRICED');
  DEFAULT_OBSERVATION_BUFFER.reset();
});
