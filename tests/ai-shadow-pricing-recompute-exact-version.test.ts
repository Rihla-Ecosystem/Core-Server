/**
 * Phase 2F-E recompute exact-version tests.
 *
 * Historical recompute must prefer the exact recorded `rateCardVersion` when
 * present (ACTIVE/DRAFT/RETIRED all allowed via exact lookup), fall back to
 * ACTIVE-date selection only when no version is recorded, never replace the
 * recorded version with the newest, and never write anything (read-only).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recomputePreview,
  type HistoricalPricingRow,
  type RecomputeRepository,
} from '../src/services/ai-shadow-pricing-recompute.service.js';
import type { ShadowPricingDependencies } from '../src/services/shadow-pricing-deps.js';
import type { ProviderRateCardLoadResult } from '../src/services/provider-rate-card-loader.service.js';
import type { ProviderRateCard } from '../src/types/provider-pricing.js';
import { ProviderRateCardLoadError } from '../src/types/provider-rate-card-load.js';
import { PROVIDER_RATE_CARD } from '../src/config/provider-rate-card/index.js';

function makeRow(overrides?: Partial<HistoricalPricingRow>): HistoricalPricingRow {
  return {
    id: 'row-1',
    source: 'chat',
    createdAt: new Date('2026-08-03T10:00:00.000Z'),
    provider: 'google',
    actualModel: 'gemini-3.6-flash',
    requestedModel: 'gemini-3.6-flash',
    inputTokens: 1000,
    outputTokens: 500,
    recomputeSupported: true,
    ...overrides,
  };
}

function snapshotResult(card: ProviderRateCard, version: string): ProviderRateCardLoadResult {
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

/** Card identical to static (MATCH comparison), with a specific version label. */
function versionedCard(version: string): ProviderRateCard {
  return { ...PROVIDER_RATE_CARD, version };
}

function captureDeps(opts: {
  versionResults?: Record<string, ProviderRateCardLoadResult>;
  activeResult?: ProviderRateCardLoadResult;
} = {}) {
  const versionCalls: string[] = [];
  const activeCalls: string[] = [];
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: true,
    pricingSource: 'DATABASE_SHADOW',
    now: () => Date.now(),
    loadRateCardByVersion: async (version) => {
      versionCalls.push(version);
      const result = opts.versionResults?.[version];
      if (result) return result;
      throw new Error(`no version result for ${version}`);
    },
    loadActiveRateCardForDate: async (date) => {
      activeCalls.push(date);
      if (opts.activeResult) return opts.activeResult;
      throw new Error('no active result configured');
    },
  };
  return { deps, versionCalls, activeCalls };
}

function fakeRepository(rows: HistoricalPricingRow[]) {
  const repo: RecomputeRepository = {
    fetchRows: async () => rows,
  };
  return repo;
}

const PREVIEW = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' };

test('1. recorded rateCardVersion → exact EXPLICIT_VERSION lookup, never active-date', async () => {
  const { deps, versionCalls, activeCalls } = captureDeps({
    versionResults: { 'v-recorded-1': snapshotResult(versionedCard('v-recorded-1'), 'v-recorded-1') },
  });
  const repo = fakeRepository([makeRow({ rateCardVersion: 'v-recorded-1' })]);
  const result = await recomputePreview({ repository: repo, shadowDeps: deps }, PREVIEW);
  assert.equal(versionCalls.length, 1);
  assert.equal(versionCalls[0], 'v-recorded-1', 'exact recorded version must be the lookup key');
  assert.equal(activeCalls.length, 0, 'never fall back to active-date when a version is recorded');
  const cmp = result.rowResults[0].shadowComparison;
  assert.equal(cmp?.selectionMode, 'EXPLICIT_VERSION');
  assert.equal(cmp?.databaseRateCardVersion, 'v-recorded-1');
  assert.equal(cmp?.status, 'MATCH', 'identical rates must compare as MATCH');
});

test('2. no recorded version → ACTIVE_DATE lookup on the row pricing date', async () => {
  const { deps, versionCalls, activeCalls } = captureDeps({
    activeResult: snapshotResult(versionedCard('active-v'), 'active-v'),
  });
  const repo = fakeRepository([makeRow({ rateCardVersion: null })]);
  const result = await recomputePreview({ repository: repo, shadowDeps: deps }, PREVIEW);
  assert.equal(activeCalls.length, 1);
  assert.equal(activeCalls[0], '2026-08-03', 'active-date lookup uses the row createdAt date');
  assert.equal(versionCalls.length, 0);
  const cmp = result.rowResults[0].shadowComparison;
  assert.equal(cmp?.selectionMode, 'ACTIVE_DATE');
});

test('3. recorded DRAFT version is looked up exactly (status is preserved, not newest)', async () => {
  const draftCard = { ...versionedCard('v-draft'), entries: PROVIDER_RATE_CARD.entries.map((e) => (e.provider === 'google' && e.model === 'gemini-3.6-flash' ? { ...e, tokenRates: { ...e.tokenRates!, inputMicrosPerMillion: 8_000_000 } } : e)) };
  const { deps, versionCalls } = captureDeps({
    versionResults: { 'v-draft': { card: draftCard, providers: ['google'], snapshot: { id: 's', version: 'v-draft', status: 'DRAFT', effectiveFrom: '2026-08-01', effectiveTo: null, publishedAt: null, retiredAt: null } } },
  });
  const repo = fakeRepository([makeRow({ rateCardVersion: 'v-draft' })]);
  const result = await recomputePreview({ repository: repo, shadowDeps: deps }, PREVIEW);
  assert.deepEqual(versionCalls, ['v-draft'], 'exact DRAFT version is the lookup key');
  const cmp = result.rowResults[0].shadowComparison;
  assert.equal(cmp?.selectionMode, 'EXPLICIT_VERSION');
  assert.equal(cmp?.databaseRateCardVersion, 'v-draft');
  assert.equal(cmp?.status, 'MISMATCH', 'different rates must compare as MISMATCH');
});

test('4. recorded RETIRED version is looked up exactly (never replaced with newest)', async () => {
  const { deps, versionCalls, activeCalls } = captureDeps({
    versionResults: { 'v-retired': snapshotResult(versionedCard('v-retired'), 'v-retired') },
  });
  const repo = fakeRepository([makeRow({ rateCardVersion: 'v-retired' })]);
  const result = await recomputePreview({ repository: repo, shadowDeps: deps }, PREVIEW);
  assert.deepEqual(versionCalls, ['v-retired']);
  assert.equal(activeCalls.length, 0, 'never silently swap in the newest active card');
  const cmp = result.rowResults[0].shadowComparison;
  assert.equal(cmp?.databaseRateCardVersion, 'v-retired');
});

test('5. missing exact version → stable DB_RATE_CARD_VERSION_NOT_FOUND', async () => {
  const versionCalls: string[] = [];
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: true,
    pricingSource: 'DATABASE_SHADOW',
    now: () => Date.now(),
    loadRateCardByVersion: async (version) => {
      versionCalls.push(version);
      throw new ProviderRateCardLoadError('RATE_CARD_VERSION_NOT_FOUND', 'version not found', { version });
    },
    loadActiveRateCardForDate: async () => {
      throw new Error('must not be reached');
    },
  };
  const repo = fakeRepository([makeRow({ rateCardVersion: 'v-gone' })]);
  const result = await recomputePreview({ repository: repo, shadowDeps: deps }, PREVIEW);
  assert.deepEqual(versionCalls, ['v-gone']);
  const cmp = result.rowResults[0].shadowComparison;
  assert.equal(cmp?.status, 'DB_RATE_CARD_VERSION_NOT_FOUND');
});

test('6. shadow comparison disabled when STATIC + flag off → no DB lookup at all', async () => {
  const versionCalls: string[] = [];
  const activeCalls: string[] = [];
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: false,
    pricingSource: 'STATIC',
    now: () => Date.now(),
    loadRateCardByVersion: async (v) => {
      versionCalls.push(v);
      return snapshotResult(versionedCard(v), v);
    },
    loadActiveRateCardForDate: async (d) => {
      activeCalls.push(d);
      return snapshotResult(versionedCard('active'), 'active');
    },
  };
  const repo = fakeRepository([makeRow({ rateCardVersion: 'v-recorded' })]);
  const result = await recomputePreview({ repository: repo, shadowDeps: deps }, PREVIEW);
  assert.equal(result.rowResults[0].shadowComparison, undefined, 'no comparison when shadow disabled');
  assert.equal(versionCalls.length, 0);
  assert.equal(activeCalls.length, 0);
});

test('7. recompute is strictly read-only (no repository writes)', async () => {
  const { deps } = captureDeps({
    versionResults: { 'v-recorded': snapshotResult(versionedCard('v-recorded'), 'v-recorded') },
  });
  let fetchCount = 0;
  const repo: RecomputeRepository = {
    fetchRows: async () => {
      fetchCount += 1;
      return [makeRow({ rateCardVersion: 'v-recorded' })];
    },
  };
  const result = await recomputePreview({ repository: repo, shadowDeps: deps }, PREVIEW);
  assert.equal(fetchCount, 1);
  assert.equal(result.mode, 'READ_ONLY_PREVIEW');
  assert.equal(result.rowResults[0].outcome, 'RECOMPUTED_PRICED');
  assert.ok(result.warnings.some((w) => w.includes('read-only preview')));
});
