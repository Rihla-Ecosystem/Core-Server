/**
 * Phase 2F-E runtime tests for DATABASE_PRIMARY pricing source.
 *
 * The database rate card is the authoritative pricing source: the DB result is
 * returned as the priced outcome, the actual DB version is recorded, the loader
 * runs once per operation, and any load failure produces a stable internal
 * pricing error — there is NO silent static fallback and no fabricated zero cost.
 *
 * Uses injected fake loaders (no database) to isolate runtime behavior; the
 * real-PostgreSQL integration suite covers the actual repository.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiShadowPricingService } from '../src/services/ai-shadow-pricing.service.js';
import { AiShadowPricingObservationService } from '../src/services/ai-shadow-pricing-observation.service.js';
import type { ShadowPricingLogger } from '../src/services/ai-shadow-pricing.service.js';
import type { ShadowPricingDependencies } from '../src/services/shadow-pricing-deps.js';
import type { ProviderRateCardLoadResult, ProviderRateCardSnapshotMetadata } from '../src/services/provider-rate-card-loader.service.js';
import { ProviderRateCardLoadError } from '../src/types/provider-rate-card-load.js';
import type { ProviderRateCard } from '../src/types/provider-pricing.js';
import { PROVIDER_RATE_CARD } from '../src/config/provider-rate-card/index.js';
import { aggregateProviderCalls } from '../src/utils/provider-pricing/aggregate.js';

const VALID_CALL = {
  provider: 'google',
  providerCallMade: true,
  providerCallId: 'call-1',
  actualModel: 'gemini-3.6-flash',
  inputTokens: 1500,
  outputTokens: 200,
  cachedInputTokens: 500,
};

const DIFF_CARD: ProviderRateCard = {
  ...PROVIDER_RATE_CARD,
  version: 'db-primary-9.9.9',
  entries: PROVIDER_RATE_CARD.entries.map((e) =>
    e.provider === 'google' && e.model === 'gemini-3.6-flash'
      ? { ...e, tokenRates: { ...e.tokenRates!, inputMicrosPerMillion: 9_000_000, outputMicrosPerMillion: 9_000_000, cachedInputMicrosPerMillion: 1_000_000 } }
      : e,
  ),
};

function okResult(card: ProviderRateCard, version: string): ProviderRateCardLoadResult {
  return {
    card,
    providers: ['google'],
    snapshot: {
      id: 'snap-1',
      version,
      status: 'ACTIVE',
      effectiveFrom: '2026-08-01',
      effectiveTo: null,
      publishedAt: '2026-08-01T00:00:00.000Z',
      retiredAt: null,
    },
  };
}

/** BigInt-safe serialization so secret-leak assertions never throw on bigint. */
function safeSerialize(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function captureLogger(): {
  logger: ShadowPricingLogger;
  infos: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
} {
  const infos: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  return {
    infos,
    errors,
    logger: {
      info: (_event, payload) => infos.push(payload),
      error: (_event, payload) => errors.push(payload),
    },
  };
}

function buildService(
  loader: (date: string) => Promise<ProviderRateCardLoadResult>,
  opts: {
    pricingSource?: 'STATIC' | 'DATABASE_SHADOW' | 'DATABASE_PRIMARY';
    dbShadowEnabled?: boolean;
  } = {},
): {
  svc: AiShadowPricingService;
  captured: ReturnType<typeof captureLogger>;
  buf: AiShadowPricingObservationService;
  loadCount: { value: number };
} {
  const captured = captureLogger();
  const buf = new AiShadowPricingObservationService();
  const loadCount = { value: 0 };
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: opts.dbShadowEnabled ?? false,
    pricingSource: opts.pricingSource ?? 'STATIC',
    loadActiveRateCardForDate: async (date) => {
      loadCount.value++;
      return loader(date);
    },
    now: () => 1000,
  };
  const svc = new AiShadowPricingService({
    shadowDeps: deps,
    logger: captured.logger,
    buffer: buf,
    now: () => '2026-08-03T00:00:00.000Z',
  });
  return { svc, captured, buf, loadCount };
}

const throwLoader =
  (code: Parameters<typeof ProviderRateCardLoadError>[0]) =>
  async (): Promise<ProviderRateCardLoadResult> => {
    throw new ProviderRateCardLoadError(code, `stable ${code}`, { pricingDate: '2026-08-03' });
  };

// ---------------------------------------------------------------------------
// DATABASE_PRIMARY: authoritative DB pricing
// ---------------------------------------------------------------------------

test('DATABASE_PRIMARY prices with the DB card as authoritative and records DB version', async () => {
  const { svc, captured, buf, loadCount } = buildService(async () => okResult(DIFF_CARD, 'db-primary-9.9.9'), {
    pricingSource: 'DATABASE_PRIMARY',
  });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'priced');
  const result = (outcome as { kind: 'priced'; result: { rateCardVersion?: string; totals: { pricedCostNanoUsd: bigint; pricedCallCount: number; callCount: number } } }).result;
  assert.equal(result.totals.pricedCallCount, 1);
  assert.equal(result.totals.callCount, 1);
  assert.equal(loadCount.value, 1, 'loader runs exactly once per operation');
  assert.ok(result.totals.pricedCostNanoUsd > 0n, 'authoritative DB cost must be positive');
  // Log carries DB version + diagnostics
  const log = captured.infos[0];
  assert.equal(log.configuredPricingSource, 'DATABASE_PRIMARY');
  assert.equal(log.actualPricingSource, 'DATABASE_PRIMARY');
  assert.equal(log.rateCardVersion, 'db-primary-9.9.9');
  assert.equal(log.providerCallCount, 1);
  assert.equal(log.pricingStatus, 'FULLY_PRICED');
  assert.equal(log.loaderErrorCode, null);
  assert.equal(log.rollbackToStatic, false);
  assert.equal(typeof log.durationMs, 'number');
  assert.equal(typeof log.operationId, 'string');
  assert.ok((log.operationId as string).length > 0);
  // Observation carries the DB version
  assert.equal(buf.size(), 1);
  assert.equal(buf.snapshot()[0].report.rateCardVersion, 'db-primary-9.9.9');
});

test('DATABASE_PRIMARY with a DRAFT-only DB → stable NOT_FOUND error (no silent fallback)', async () => {
  const { svc, captured, loadCount } = buildService(throwLoader('RATE_CARD_NOT_FOUND'), {
    pricingSource: 'DATABASE_PRIMARY',
  });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'dbPricingError');
  assert.equal((outcome as { kind: 'dbPricingError'; errorCode: string; status: string }).errorCode, 'RATE_CARD_NOT_FOUND');
  assert.equal((outcome as { kind: 'dbPricingError'; status: string }).status, 'DB_RATE_CARD_NOT_FOUND');
  assert.equal(loadCount.value, 1);
  assert.equal(captured.errors.length, 1, 'exactly one primary-error log');
  const err = captured.errors[0];
  assert.equal(err.event, 'ai_shadow_pricing_primary_error');
  assert.equal(err.pricingStatus, 'DB_RATE_CARD_NOT_FOUND');
  assert.equal(err.loaderErrorCode, 'RATE_CARD_NOT_FOUND');
  assert.equal(err.rollbackToStatic, false);
});

test('DATABASE_PRIMARY with no ACTIVE snapshot → stable NOT_FOUND error, never zero cost', async () => {
  const { svc } = buildService(throwLoader('RATE_CARD_NOT_FOUND'), { pricingSource: 'DATABASE_PRIMARY' });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'dbPricingError');
  assert.equal((outcome as { kind: 'dbPricingError'; errorMessage: string }).errorMessage, 'database rate card pricing unavailable');
});

test('DATABASE_PRIMARY with overlapping ACTIVE snapshots → stable ACTIVE_CONFLICT error', async () => {
  const { svc } = buildService(throwLoader('RATE_CARD_ACTIVE_CONFLICT'), { pricingSource: 'DATABASE_PRIMARY' });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'dbPricingError');
  assert.equal((outcome as { kind: 'dbPricingError'; status: string }).status, 'DB_RATE_CARD_ACTIVE_CONFLICT');
});

test('DATABASE_PRIMARY with invalid snapshot → stable INVALID error', async () => {
  const { svc } = buildService(throwLoader('RATE_CARD_SNAPSHOT_INVALID'), { pricingSource: 'DATABASE_PRIMARY' });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'dbPricingError');
  assert.equal((outcome as { kind: 'dbPricingError'; status: string }).status, 'DB_RATE_CARD_INVALID');
});

test('DATABASE_PRIMARY with repository failure → stable DATABASE_ERROR', async () => {
  const { svc } = buildService(throwLoader('RATE_CARD_DATABASE_ERROR'), { pricingSource: 'DATABASE_PRIMARY' });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'dbPricingError');
  assert.equal((outcome as { kind: 'dbPricingError'; errorCode: string }).errorCode, 'RATE_CARD_DATABASE_ERROR');
});

test('DATABASE_PRIMARY loader throws a generic error → stable DATABASE_ERROR', async () => {
  const { svc, captured } = buildService(async () => {
    throw new Error('db down');
  }, { pricingSource: 'DATABASE_PRIMARY' });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'dbPricingError');
  assert.equal((outcome as { kind: 'dbPricingError'; status: string }).status, 'DB_RATE_CARD_ERROR');
  assert.ok(captured.errors.length >= 1);
});

test('DATABASE_PRIMARY times out when the loader is too slow', async () => {
  const { svc } = buildService(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return okResult(DIFF_CARD, 'db-primary-9.9.9');
  }, { pricingSource: 'DATABASE_PRIMARY' });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'dbPricingError');
  assert.equal((outcome as { kind: 'dbPricingError'; status: string }).status, 'DB_RATE_CARD_TIMEOUT');
});

test('DATABASE_PRIMARY single load serves multiple provider calls', async () => {
  const { svc, loadCount } = buildService(async () => okResult(DIFF_CARD, 'db-primary-9.9.9'), {
    pricingSource: 'DATABASE_PRIMARY',
  });
  const calls = [
    { ...VALID_CALL, providerCallId: 'call-1' },
    { ...VALID_CALL, providerCallId: 'call-2' },
  ];
  const outcome = await svc.record(calls, { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'priced');
  assert.equal((outcome as { kind: 'priced'; result: { totals: { callCount: number } } }).result.totals.callCount, 2);
  assert.equal(loadCount.value, 1, 'one DB load must serve the whole operation');
});

test('DATABASE_PRIMARY engine executes exactly once per operation', async () => {
  let engineCalls = 0;
  const buf = new AiShadowPricingObservationService();
  const svc = new AiShadowPricingService({
    shadowDeps: {
      dbShadowEnabled: false,
      pricingSource: 'DATABASE_PRIMARY',
      loadActiveRateCardForDate: async () => okResult(DIFF_CARD, 'db-primary-9.9.9'),
      now: () => 1000,
    },
    engine: (input) => {
      engineCalls++;
      return aggregateProviderCalls(input);
    },
    logger: { info: () => {}, error: () => {} },
    buffer: buf,
    now: () => '2026-08-03T00:00:00.000Z',
  });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'priced');
  assert.equal(engineCalls, 1, 'engine must run exactly once in DATABASE_PRIMARY (no double AI execution)');
});

test('DATABASE_PRIMARY empty providerCalls → noProviderCalls, no DB load, no cost', async () => {
  const { svc, captured, buf, loadCount } = buildService(async () => okResult(DIFF_CARD, 'db-primary-9.9.9'), {
    pricingSource: 'DATABASE_PRIMARY',
  });
  const outcome = await svc.record([], { source: 'identify', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'noProviderCalls');
  assert.equal(loadCount.value, 0, 'no DB load for a cache hit');
  assert.equal(buf.size(), 1);
  const log = captured.infos[0];
  assert.equal(log.configuredPricingSource, 'DATABASE_PRIMARY');
  assert.equal(log.actualPricingSource, 'STATIC');
  assert.equal(log.noProviderCalls, true);
  assert.equal(log.rateCardVersion, null);
});

test('DATABASE_PRIMARY never logs prompts, responses, DATABASE_URL, or raw SQL', async () => {
  const { svc, captured } = buildService(async () => okResult(DIFF_CARD, 'db-primary-9.9.9'), {
    pricingSource: 'DATABASE_PRIMARY',
  });
  const callWithJunk = {
    ...VALID_CALL,
    prompt: 'TOP-SECRET-PROMPT',
    response: 'TOP-SECRET-RESPONSE',
    rawProviderPayload: { secret: 'TOP-SECRET-RAW' },
  };
  await svc.record([callWithJunk], { source: 'chat', pricingDate: '2026-08-03' });
  const serialized = safeSerialize(captured.infos) + safeSerialize(captured.errors);
  assert.ok(!serialized.includes('TOP-SECRET'));
  assert.ok(!serialized.includes('postgresql://'));
  assert.ok(!serialized.includes('SELECT '));
});

test('DATABASE_PRIMARY never mutates rate-card lifecycle or entries', async () => {
  // In-memory "repository" proves the loader is read-only by construction.
  const { svc } = buildService(async () => okResult(DIFF_CARD, 'db-primary-9.9.9'), {
    pricingSource: 'DATABASE_PRIMARY',
  });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'priced');
  assert.equal(DIFF_CARD.version, 'db-primary-9.9.9', 'loaded card must be unchanged');
});

// ---------------------------------------------------------------------------
// STATIC / rollback
// ---------------------------------------------------------------------------

test('STATIC (default/rollback) → static card is authoritative, no DB load', async () => {
  const { svc, captured, loadCount } = buildService(async () => okResult(DIFF_CARD, 'db-primary-9.9.9'), {
    pricingSource: 'STATIC',
  });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'priced');
  assert.equal(loadCount.value, 0, 'static mode never loads the DB');
  const log = captured.infos[0];
  assert.equal(log.configuredPricingSource, 'STATIC');
  assert.equal(log.actualPricingSource, 'STATIC');
  assert.equal(log.rollbackToStatic, false);
  assert.equal(log.loaderErrorCode, null);
});

test('STATIC mode ignores DATABASE_PRIMARY failures (no effect on static path)', async () => {
  const { svc } = buildService(async () => {
    throw new Error('db down');
  }, { pricingSource: 'STATIC' });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'priced');
});

// ---------------------------------------------------------------------------
// DATABASE_SHADOW
// ---------------------------------------------------------------------------

test('DATABASE_SHADOW keeps static authoritative and runs comparison', async () => {
  const { svc, captured, loadCount } = buildService(async () => okResult(DIFF_CARD, 'db-primary-9.9.9'), {
    pricingSource: 'DATABASE_SHADOW',
    dbShadowEnabled: true,
  });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'priced');
  assert.equal(loadCount.value, 1, 'shadow mode loads the DB for comparison');
  const comparisonLog = captured.infos.find((l) => l.event === 'ai_shadow_pricing_comparison');
  assert.ok(comparisonLog, 'comparison log must be emitted');
  assert.equal(comparisonLog.comparisonStatus, 'MISMATCH');
  assert.equal(comparisonLog.databaseRateCardVersion, 'db-primary-9.9.9');
  const pricingLog = captured.infos.find((l) => l.event === 'ai_shadow_pricing');
  assert.equal(pricingLog.configuredPricingSource, 'DATABASE_SHADOW');
  assert.equal(pricingLog.actualPricingSource, 'STATIC');
});
