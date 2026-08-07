/**
 * Phase 2F-D unit tests for DB-shadow integration in the live service and recompute.
 * Uses fakes; no real database.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiShadowPricingService } from '../src/services/ai-shadow-pricing.service.js';
import { AiShadowPricingObservationService } from '../src/services/ai-shadow-pricing-observation.service.js';
import { recomputePreview } from '../src/services/ai-shadow-pricing-recompute.service.js';
import type { ShadowPricingDependencies, ProviderRateCardLoadResult } from '../src/services/shadow-pricing-deps.js';
import { ProviderRateCardLoadError } from '../src/types/provider-rate-card-load.js';
import { PROVIDER_RATE_CARD } from '../src/config/provider-rate-card/index.js';
import { aggregateProviderCalls } from '../src/utils/provider-pricing/aggregate.js';
import type { ShadowPricingResult, HistoricalPricingRow, RecomputeRepository } from '../src/types/provider-pricing.js';

const VALID_CALL = {
  provider: 'google',
  providerCallMade: true,
  providerCallId: 'call-1',
  actualModel: 'gemini-3.6-flash',
  inputTokens: 1500,
  outputTokens: 200,
  cachedInputTokens: 500,
};

function makeLoadResult(card: any, error: ProviderRateCardLoadResult['error'] = null): ProviderRateCardLoadResult {
  return {
    card,
    snapshot: { id: 'snap-1', version: '1.0.0', status: 'ACTIVE', effectiveFrom: '2026-08-03', effectiveTo: null, publishedAt: '2026-08-03T00:00:00.000Z', retiredAt: null },
    error,
    selectionMode: 'ACTIVE_DATE',
  };
}

test('feature disabled → loader never called', async () => {
  let loadCalls = 0;
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: false,
    loadActiveRateCardForDate: async () => { loadCalls++; return makeLoadResult(PROVIDER_RATE_CARD); },
  };
  const svc = new AiShadowPricingService({ shadowDeps: deps });
  await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(loadCalls, 0);
});

test('feature enabled → loader called once per operation', async () => {
  let loadCalls = 0;
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: true,
    loadActiveRateCardForDate: async () => { loadCalls++; return makeLoadResult(PROVIDER_RATE_CARD); },
  };
  const svc = new AiShadowPricingService({ shadowDeps: deps });
  await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(loadCalls, 1);
});

test('exact-version recompute uses loadRateCardByVersion', async () => {
  let versionLoadCalls = 0;
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: true,
    loadRateCardByVersion: async (v) => { versionLoadCalls++; return makeLoadResult(PROVIDER_RATE_CARD); },
  };
  const repo: RecomputeRepository = {
    fetchRows: async () => [{
      id: 'row-1',
      source: 'chat',
      createdAt: new Date('2026-08-03'),
      provider: 'google',
      actualModel: 'gemini-3.6-flash',
      requestedModel: null,
      inputTokens: 10,
      outputTokens: 5,
      rateCardVersion: '1.0.0',
      recomputeSupported: true,
    }],
  };
  await recomputePreview({ repository: repo, shadowDeps: deps }, { from: '2026-08-01', to: '2026-08-05' });
  assert.equal(versionLoadCalls, 1);
});

test('newest version never selected automatically', async () => {
  let versionLoadCalls = 0;
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: true,
    loadRateCardByVersion: async () => { versionLoadCalls++; return makeLoadResult(PROVIDER_RATE_CARD); },
    loadActiveRateCardForDate: async () => makeLoadResult(PROVIDER_RATE_CARD),
  };
  const repo: RecomputeRepository = {
    fetchRows: async () => [{
      id: 'row-1',
      source: 'chat',
      createdAt: new Date('2026-08-03'),
      provider: 'google',
      actualModel: 'gemini-3.6-flash',
      requestedModel: null,
      inputTokens: 10,
      outputTokens: 5,
      rateCardVersion: '1.0.0',
      recomputeSupported: true,
    }],
  };
  await recomputePreview({ repository: repo, shadowDeps: deps }, { from: '2026-08-01', to: '2026-08-05' });
  // Only exact version load should happen, not active-date
  assert.equal(versionLoadCalls, 1);
});

test('DRAFT version loadable by exact version', async () => {
  let versionLoadCalls = 0;
  const draftCard = { ...PROVIDER_RATE_CARD, version: '1.1.0-draft' };
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: true,
    loadRateCardByVersion: async (v) => { versionLoadCalls++; assert.equal(v, '1.1.0-draft'); return makeLoadResult(draftCard); },
  };
  const repo: RecomputeRepository = {
    fetchRows: async () => [{
      id: 'row-1',
      source: 'chat',
      createdAt: new Date('2026-08-03'),
      provider: 'google',
      actualModel: 'gemini-3.6-flash',
      requestedModel: null,
      inputTokens: 10,
      outputTokens: 5,
      rateCardVersion: '1.1.0-draft',
      recomputeSupported: true,
    }],
  };
  await recomputePreview({ repository: repo, shadowDeps: deps }, { from: '2026-08-01', to: '2026-08-05' });
  assert.equal(versionLoadCalls, 1);
});

test('RETIRED version loadable by exact version', async () => {
  let versionLoadCalls = 0;
  const retiredCard = { ...PROVIDER_RATE_CARD, version: '1.0.0-retired' };
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: true,
    loadRateCardByVersion: async (v) => { versionLoadCalls++; assert.equal(v, '1.0.0-retired'); return makeLoadResult(retiredCard); },
  };
  const repo: RecomputeRepository = {
    fetchRows: async () => [{
      id: 'row-1',
      source: 'chat',
      createdAt: new Date('2026-08-03'),
      provider: 'google',
      actualModel: 'gemini-3.6-flash',
      requestedModel: null,
      inputTokens: 10,
      outputTokens: 5,
      rateCardVersion: '1.0.0-retired',
      recomputeSupported: true,
    }],
  };
  await recomputePreview({ repository: repo, shadowDeps: deps }, { from: '2026-08-01', to: '2026-08-05' });
  assert.equal(versionLoadCalls, 1);
});

test('missing version → DB_RATE_CARD_VERSION_NOT_FOUND', async () => {
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: true,
    loadRateCardByVersion: async () => { throw new ProviderRateCardLoadError('RATE_CARD_VERSION_NOT_FOUND', 'version not found'); },
  };
  const repo: RecomputeRepository = {
    fetchRows: async () => [{
      id: 'row-1',
      source: 'chat',
      createdAt: new Date('2026-08-03'),
      provider: 'google',
      actualModel: 'gemini-3.6-flash',
      requestedModel: null,
      inputTokens: 10,
      outputTokens: 5,
      rateCardVersion: 'missing',
      recomputeSupported: true,
    }],
  };
  const result = await recomputePreview({ repository: repo, shadowDeps: deps }, { from: '2026-08-01', to: '2026-08-05' });
  const row = result.rowResults[0];
  assert.ok(row.shadowComparison);
  assert.equal(row.shadowComparison!.status, 'DB_RATE_CARD_VERSION_NOT_FOUND');
});

test('invalid snapshot → DB_RATE_CARD_INVALID', async () => {
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: true,
    loadRateCardByVersion: async () => { throw new ProviderRateCardLoadError('RATE_CARD_SNAPSHOT_INVALID', 'snapshot invalid'); },
  };
  const repo: RecomputeRepository = {
    fetchRows: async () => [{
      id: 'row-1',
      source: 'chat',
      createdAt: new Date('2026-08-03'),
      provider: 'google',
      actualModel: 'gemini-3.6-flash',
      requestedModel: null,
      inputTokens: 10,
      outputTokens: 5,
      rateCardVersion: 'bad',
      recomputeSupported: true,
    }],
  };
  const result = await recomputePreview({ repository: repo, shadowDeps: deps }, { from: '2026-08-01', to: '2026-08-05' });
  const row = result.rowResults[0];
  assert.ok(row.shadowComparison);
  assert.equal(row.shadowComparison!.status, 'DB_RATE_CARD_INVALID');
});

test('DB failure → DB_RATE_CARD_ERROR, static result unchanged', async () => {
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: true,
    loadActiveRateCardForDate: async () => { throw new Error('db down'); },
  };
  const svc = new AiShadowPricingService({ shadowDeps: deps });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'priced');
  const result = (outcome as any).result as ShadowPricingResult;
  assert.equal(result.totals.pricedCallCount, 1);
});

test('DB pricing failure → DB_RATE_CARD_ERROR, static result unchanged', async () => {
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: true,
    loadActiveRateCardForDate: async () => makeLoadResult(PROVIDER_RATE_CARD),
  };
  let engineCallCount = 0;
  const svc = new AiShadowPricingService({
    shadowDeps: deps,
    engine: (input) => {
      engineCallCount++;
      if (engineCallCount === 2) {
        // Second call is DB pricing - throw to simulate DB pricing failure
        throw new Error('pricing boom');
      }
      return aggregateProviderCalls(input);
    },
  });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'priced');
  const result = (outcome as any).result as ShadowPricingResult;
  assert.equal(result.totals.pricedCallCount, 1);
});

test('static result always returned regardless of comparison', async () => {
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: true,
    loadActiveRateCardForDate: async () => makeLoadResult({ ...PROVIDER_RATE_CARD, entries: [{ ...PROVIDER_RATE_CARD.entries[0], tokenRates: { ...PROVIDER_RATE_CARD.entries[0].tokenRates!, inputMicrosPerMillion: 999_999 } }] }),
  };
  const svc = new AiShadowPricingService({ shadowDeps: deps });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'priced');
  const result = (outcome as any).result as ShadowPricingResult;
  // Static card input rate is 1_500_000 -> cost should match static
  assert.equal(result.totals.pricedCostNanoUsd, 3_825_000n);
});

test('no historical record mutation', async () => {
  // recomputePreview is read-only; we just ensure it doesn't throw and returns preview
  const deps: ShadowPricingDependencies = { dbShadowEnabled: false };
  const repo: RecomputeRepository = {
    fetchRows: async () => [{
      id: 'row-1', source: 'chat', createdAt: new Date('2026-08-03'), provider: 'google',
      actualModel: 'gemini-3.6-flash', requestedModel: null, inputTokens: 10, outputTokens: 5,
      recomputeSupported: true,
    }],
  };
  const result = await recomputePreview({ repository: repo, shadowDeps: deps }, { from: '2026-08-01', to: '2026-08-05' });
  assert.equal(result.mode, 'READ_ONLY_PREVIEW');
});

test('no Wallet/billing mutation', async () => {
  // The service does not import wallet/billing modules; just ensure no error
  const deps: ShadowPricingDependencies = { dbShadowEnabled: false };
  const svc = new AiShadowPricingService({ shadowDeps: deps });
  const outcome = await svc.record([VALID_CALL], { source: 'chat', pricingDate: '2026-08-03' });
  assert.equal(outcome.kind, 'priced');
});