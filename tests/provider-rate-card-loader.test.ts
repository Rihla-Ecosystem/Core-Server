/**
 * Phase 2F-B loader unit tests.
 *
 * Uses a fake repository (never Prisma) to prove the loader contract:
 * active-date selection, version lookup, date/version validation, mapper
 * integration, error stability, fresh-output guarantees, and the absence of
 * caching/fallback/writes/Pricing-arithmetic/Prisma in the loader.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadActiveRateCardForDate,
  loadRateCardByVersion,
  ProviderRateCardLoadError,
} from '../src/services/provider-rate-card-loader.service.js';
import type {
  ProviderRateCardLoaderDependencies,
  ProviderRateCardLoadResult,
} from '../src/services/provider-rate-card-loader.service.js';
import type { ProviderRateCardRepository, ActiveSnapshotSelection } from '../src/repositories/provider-rate-card.repository.js';
import type { ProviderRateCardSnapshotRow } from '../src/types/provider-pricing-snapshot.js';
import { RATE_CARD_SCHEMA_VERSION } from '../src/types/provider-pricing.js';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(TESTS_DIR, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/** Strip `//` and `/* ... *​/` comments so scans test code, not prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])"\/\/[^\n]*/g, '$1');
}

function readSource(relativePath: string): string {
  return readFileSync(join(SRC_ROOT, relativePath), 'utf8');
}

const GENERATED_AT = new Date('2026-08-05T00:00:00Z');

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    snapshotId: 'snapshot-1',
    provider: 'google',
    model: 'gemini-3.6-flash',
    status: 'STABLE',
    tier: 'FAST_MODE',
    billingUnit: 'TOKEN',
    inputMicrosPerMillion: 1_500_000n,
    outputMicrosPerMillion: 7_500_000n,
    cachedInputMicrosPerMillion: 150_000n,
    cachedOutputMicrosPerMillion: null,
    perUnitMicros: null,
    audioInputMicrosPerMillion: 200_000n,
    audioOutputMicrosPerMillion: null,
    tokensPerSecond: null,
    cachedInputAccounting: 'DISJOINT',
    aliases: ['gemini-3.6-flash-prod'],
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
    effectiveTo: null,
    inactive: false,
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    verifiedAt: new Date('2026-08-04T00:00:00Z'),
    ...overrides,
  };
}

/** A structurally valid ACTIVE snapshot row (mapper-accepted). */
function makeActiveRow(overrides: Record<string, unknown> = {}): ProviderRateCardSnapshotRow {
  return {
    id: 'snapshot-1',
    version: '2.0.0',
    status: 'ACTIVE',
    schemaVersion: RATE_CARD_SCHEMA_VERSION,
    currency: 'USD',
    storageUnit: 'MICROS',
    engineUnit: 'NANO_USD',
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    generatedAt: GENERATED_AT,
    provenance: 'RESEARCH_SNAPSHOT',
    effectiveFrom: new Date('2026-08-01T00:00:00Z'),
    effectiveTo: null,
    publishedAt: new Date('2026-08-06T10:00:00Z'),
    retiredAt: null,
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
    entries: [makeEntry()],
    ...overrides,
  };
}

function makeDraftRow(overrides: Record<string, unknown> = {}): ProviderRateCardSnapshotRow {
  return makeActiveRow({ status: 'DRAFT', effectiveFrom: null, publishedAt: null, ...overrides });
}

function makeRetiredRow(overrides: Record<string, unknown> = {}): ProviderRateCardSnapshotRow {
  return makeActiveRow({
    status: 'RETIRED',
    retiredAt: new Date('2026-12-01T10:00:00Z'),
    ...overrides,
  });
}

interface FakeRepositoryState {
  activeSelection: ActiveSnapshotSelection;
  versionRows: Map<string, ProviderRateCardSnapshotRow>;
  versionCalls: string[];
  activeCalls: string[];
}

function makeDeps(state: Partial<FakeRepositoryState> = {}): ProviderRateCardLoaderDependencies {
  const repository: ProviderRateCardRepository = {
    async findActiveSnapshotForDate(pricingDate) {
      state.activeCalls = state.activeCalls ?? [];
      state.activeCalls.push(pricingDate);
      if (state.activeSelection === undefined) {
        return { kind: 'none' };
      }
      return state.activeSelection;
    },
    async findSnapshotByVersion(version) {
      state.versionCalls = state.versionCalls ?? [];
      state.versionCalls.push(version);
      const rows = state.versionRows ?? new Map();
      return rows.get(version) ?? null;
    },
  };
  return { repository };
}

function asLoadError(err: unknown): ProviderRateCardLoadError {
  assert.ok(err instanceof ProviderRateCardLoadError, `expected ProviderRateCardLoadError, got ${String(err)}`);
  return err;
}

test('1. valid active row maps to the existing ProviderRateCard contract', async () => {
  const deps = makeDeps({ activeSelection: { kind: 'found', snapshot: makeActiveRow() } });
  const result = await loadActiveRateCardForDate(deps, '2026-08-15');
  assert.equal(result.card.version, '2.0.0');
  assert.equal(result.card.schemaVersion, RATE_CARD_SCHEMA_VERSION);
  assert.equal(result.card.currency, 'USD');
  assert.equal(result.card.storageUnit, 'MICROS');
  assert.equal(result.card.engineUnit, 'NANO_USD');
  assert.equal(result.card.provenance, 'RESEARCH_SNAPSHOT');
  assert.equal(result.card.generatedAt, '2026-08-05');
  assert.equal(result.card.entries.length, 1);
  assert.equal(result.card.entries[0].provider, 'google');
  assert.equal(result.card.entries[0].billingUnit, 'TOKEN');
  assert.equal(result.card.entries[0].tokenRates?.inputMicrosPerMillion, 1_500_000);
});

test('2. version is preserved', async () => {
  const deps = makeDeps({ activeSelection: { kind: 'found', snapshot: makeActiveRow({ version: '3.1.0' }) } });
  const result = await loadActiveRateCardForDate(deps, '2026-08-15');
  assert.equal(result.card.version, '3.1.0');
  assert.equal(result.snapshot.version, '3.1.0');
});

test('3. providers are preserved', async () => {
  const row = makeActiveRow();
  const deps = makeDeps({ activeSelection: { kind: 'found', snapshot: row } });
  const result = await loadActiveRateCardForDate(deps, '2026-08-15');
  assert.deepEqual(result.providers, ['google']);
});

test('4. snapshot metadata is copied', async () => {
  const deps = makeDeps({
    activeSelection: {
      kind: 'found',
      snapshot: makeActiveRow({
        id: 'snapshot-abc',
        effectiveFrom: new Date('2026-08-01T00:00:00Z'),
        effectiveTo: new Date('2026-08-31T00:00:00Z'),
        publishedAt: new Date('2026-08-06T10:30:00Z'),
      }),
    },
  });
  const result = await loadActiveRateCardForDate(deps, '2026-08-15');
  assert.equal(result.snapshot.id, 'snapshot-abc');
  assert.equal(result.snapshot.status, 'ACTIVE');
  assert.equal(result.snapshot.effectiveFrom, '2026-08-01');
  assert.equal(result.snapshot.effectiveTo, '2026-08-31');
  assert.equal(result.snapshot.publishedAt, '2026-08-06T10:30:00.000Z');
  assert.equal(result.snapshot.retiredAt, null);
});

test('5. repository row is not mutated', async () => {
  const row = makeActiveRow();
  const deps = makeDeps({ activeSelection: { kind: 'found', snapshot: row } });
  const before = JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  await loadActiveRateCardForDate(deps, '2026-08-15');
  const after = JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  assert.equal(after, before);
});

test('6. nested entries/aliases are not shared by mutable reference', async () => {
  const row = makeActiveRow();
  const deps = makeDeps({ activeSelection: { kind: 'found', snapshot: row } });
  const result = await loadActiveRateCardForDate(deps, '2026-08-15');
  assert.notEqual(result.card.entries[0], row.entries[0]);
  assert.notEqual(result.card.entries[0].aliases, row.entries[0].aliases);
  assert.notEqual(result.card.entries[0].tokenRates, undefined);
});

test('7. no active snapshot -> RATE_CARD_NOT_FOUND', async () => {
  const deps = makeDeps({ activeSelection: { kind: 'none' } });
  await assert.rejects(
    loadActiveRateCardForDate(deps, '2026-08-15'),
    (err: unknown) => asLoadError(err).code === 'RATE_CARD_NOT_FOUND',
  );
});

test('8. active conflict -> RATE_CARD_ACTIVE_CONFLICT', async () => {
  const deps = makeDeps({
    activeSelection: { kind: 'conflict', pricingDate: '2026-08-15', versions: ['1.0.0', '2.0.0'], count: 2 },
  });
  await assert.rejects(
    loadActiveRateCardForDate(deps, '2026-08-15'),
    (err: unknown) => {
      const e = asLoadError(err);
      assert.equal(e.code, 'RATE_CARD_ACTIVE_CONFLICT');
      assert.deepEqual(e.snapshotVersions, ['1.0.0', '2.0.0']);
      assert.equal(e.snapshotCount, 2);
      assert.equal(e.pricingDate, '2026-08-15');
      return true;
    },
  );
});

test('9. missing version -> RATE_CARD_VERSION_NOT_FOUND', async () => {
  const deps = makeDeps({ versionRows: new Map() });
  await assert.rejects(
    loadRateCardByVersion(deps, '1.0.0'),
    (err: unknown) => asLoadError(err).code === 'RATE_CARD_VERSION_NOT_FOUND',
  );
});

test('10. blank version -> RATE_CARD_INVALID_VERSION', async () => {
  const deps = makeDeps({ versionRows: new Map() });
  for (const bad of ['', '   ', '  \t ']) {
    await assert.rejects(
      loadRateCardByVersion(deps, bad),
      (err: unknown) => asLoadError(err).code === 'RATE_CARD_INVALID_VERSION',
    );
  }
});

test('11. invalid pricing date -> RATE_CARD_INVALID_PRICING_DATE', async () => {
  const deps = makeDeps({ activeSelection: { kind: 'none' } });
  const badDates = [
    '',
    '   ',
    '08-15-2026',
    '2026/08/15',
    '2026-08-15T10:00:00Z',
    '2026-02-31',
    '2026-13-01',
    'abc',
    '2026-8-1',
    null as unknown as string,
    undefined as unknown as string,
    20260815 as unknown as string,
  ];
  for (const bad of badDates) {
    await assert.rejects(
      loadActiveRateCardForDate(deps, bad),
      (err: unknown) => asLoadError(err).code === 'RATE_CARD_INVALID_PRICING_DATE',
      `expected INVALID_PRICING_DATE for ${String(bad)}`,
    );
  }
});

test('12. mapper validation failure -> RATE_CARD_SNAPSHOT_INVALID', async () => {
  const bad = makeActiveRow({ version: '' });
  const deps = makeDeps({ activeSelection: { kind: 'found', snapshot: bad } });
  await assert.rejects(
    loadActiveRateCardForDate(deps, '2026-08-15'),
    (err: unknown) => asLoadError(err).code === 'RATE_CARD_SNAPSHOT_INVALID',
  );
});

test('13. mapper stable code is preserved in safe error metadata', async () => {
  const bad = makeActiveRow({ version: '' });
  const deps = makeDeps({ activeSelection: { kind: 'found', snapshot: bad } });
  await assert.rejects(
    loadActiveRateCardForDate(deps, '2026-08-15'),
    (err: unknown) => {
      const e = asLoadError(err);
      assert.equal(e.mapperCode, 'SNAPSHOT_INVALID');
      assert.equal(e.version, '');
      return true;
    },
  );
});

test('14. repository unexpected error -> RATE_CARD_DATABASE_ERROR', async () => {
  const repository: ProviderRateCardRepository = {
    async findActiveSnapshotForDate() {
      throw new Error('db connection lost');
    },
    async findSnapshotByVersion() {
      throw new Error('db connection lost');
    },
  };
  const deps: ProviderRateCardLoaderDependencies = { repository };
  await assert.rejects(
    loadActiveRateCardForDate(deps, '2026-08-15'),
    (err: unknown) => {
      const e = asLoadError(err);
      assert.equal(e.code, 'RATE_CARD_DATABASE_ERROR');
      assert.equal((e.message as string).includes('credentials'), false);
      return true;
    },
  );
});

test('15. repository stable domain error is not reclassified as DATABASE_ERROR', async () => {
  const repository: ProviderRateCardRepository = {
    async findActiveSnapshotForDate() {
      throw new ProviderRateCardLoadError('RATE_CARD_DATABASE_ERROR', 'prisma failed', { pricingDate: '2026-08-15' });
    },
    async findSnapshotByVersion() {
      throw new ProviderRateCardLoadError('RATE_CARD_DATABASE_ERROR', 'prisma failed');
    },
  };
  const deps: ProviderRateCardLoaderDependencies = { repository };
  await assert.rejects(
    loadActiveRateCardForDate(deps, '2026-08-15'),
    (err: unknown) => {
      const e = asLoadError(err);
      assert.equal(e.code, 'RATE_CARD_DATABASE_ERROR');
      assert.equal(e.pricingDate, '2026-08-15');
      return true;
    },
  );
});

test('16. DRAFT can load by version', async () => {
  const deps = makeDeps({ versionRows: new Map([['draft-1', makeDraftRow({ version: 'draft-1' })]]) });
  const result = await loadRateCardByVersion(deps, 'draft-1');
  assert.equal(result.snapshot.status, 'DRAFT');
  assert.equal(result.card.version, 'draft-1');
});

test('17. ACTIVE can load by version', async () => {
  const deps = makeDeps({ versionRows: new Map([['2.0.0', makeActiveRow()]]) });
  const result = await loadRateCardByVersion(deps, '2.0.0');
  assert.equal(result.snapshot.status, 'ACTIVE');
});

test('18. RETIRED can load by version', async () => {
  const deps = makeDeps({ versionRows: new Map([['old-1', makeRetiredRow({ version: 'old-1' })]]) });
  const result = await loadRateCardByVersion(deps, 'old-1');
  assert.equal(result.snapshot.status, 'RETIRED');
});

test('19. unknown provider remains structurally accepted when mapper accepts it', async () => {
  const row = makeActiveRow({
    entries: [makeEntry({ provider: 'some-new-provider', model: 'brand-new-model' })],
  });
  const deps = makeDeps({ activeSelection: { kind: 'found', snapshot: row } });
  const result = await loadActiveRateCardForDate(deps, '2026-08-15');
  assert.deepEqual(result.providers, ['some-new-provider']);
  assert.equal(result.card.entries[0].provider, 'some-new-provider');
});

test('20. static PROVIDER_RATE_CARD is never imported', async () => {
  const loaderPath = join(SRC_ROOT, 'services', 'provider-rate-card-loader.service.ts');
  const repoPath = join(SRC_ROOT, 'repositories', 'provider-rate-card.repository.ts');
  for (const p of [loaderPath, repoPath]) {
    const code = stripComments(readFileSync(p, 'utf8'));
    assert.ok(!/import[^;]*config\/provider-rate-card/.test(code), `${p} must not import the static card`);
    assert.ok(!/require\([^)]*provider-rate-card[/]index/.test(code), `${p} must not require the static card`);
  }
});

test('21. pricing arithmetic is never duplicated', async () => {
  const loaderPath = join(SRC_ROOT, 'services', 'provider-rate-card-loader.service.ts');
  const content = readFileSync(loaderPath, 'utf8');
  assert.ok(!content.includes('priceProviderCall'), 'loader must not call pricing arithmetic');
  assert.ok(!content.includes('aggregateProviderCalls'), 'loader must not aggregate pricing');
});

test('22. loader performs no Prisma query directly', async () => {
  const loaderPath = join(SRC_ROOT, 'services', 'provider-rate-card-loader.service.ts');
  const content = readFileSync(loaderPath, 'utf8');
  assert.ok(!content.includes('prisma'), 'loader must not reference Prisma');
});

test('23. loader performs no database write', async () => {
  const loaderPath = join(SRC_ROOT, 'services', 'provider-rate-card-loader.service.ts');
  const content = readFileSync(loaderPath, 'utf8');
  for (const token of ['.create(', '.update(', '.delete(', 'deleteMany', 'updateMany', 'upsert', 'createMany']) {
    assert.ok(!content.includes(token), `loader must not contain write token ${token}`);
  }
});

test('24. no Wallet or billing imports', async () => {
  const loaderPath = join(SRC_ROOT, 'services', 'provider-rate-card-loader.service.ts');
  const repoPath = join(SRC_ROOT, 'repositories', 'provider-rate-card.repository.ts');
  for (const p of [loaderPath, repoPath]) {
    const code = stripComments(readFileSync(p, 'utf8'));
    assert.ok(!/import[^;]*(wallet|token-reservation|durable-billing)/i.test(code), `${p} must not import Wallet/billing`);
  }
});

test('25. no cache implementation exists', async () => {
  const loaderPath = join(SRC_ROOT, 'services', 'provider-rate-card-loader.service.ts');
  const repoPath = join(SRC_ROOT, 'repositories', 'provider-rate-card.repository.ts');
  for (const p of [loaderPath, repoPath]) {
    const code = stripComments(readFileSync(p, 'utf8'));
    for (const token of ['new Map(', 'new WeakMap(', 'new Map<', 'ttl', 'TTL', 'LRU', 'memcache', 'redis']) {
      assert.ok(!code.includes(token), `${p} must not contain cache token ${token}`);
    }
  }
});

// Ensure the result type is exported (compile-time sanity).
export type { ProviderRateCardLoadResult };
