{
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('Safety check failed: DATABASE_URL is not set');
  const parsed = new URL(dbUrl);
  if (parsed.pathname !== '/core_server_test') {
    throw new Error(
      `Safety check failed: DATABASE_URL must point to /core_server_test, got "${parsed.pathname}"`,
    );
  }
}

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../src/config/prisma.js';
import { createPrismaProviderRateCardRepository } from '../src/repositories/provider-rate-card.repository.js';
import type { ProviderRateCardRepository } from '../src/repositories/provider-rate-card.repository.js';
import {
  loadActiveRateCardForDate,
  loadRateCardByVersion,
  createDefaultProviderRateCardLoaderDependencies,
  ProviderRateCardLoadError,
} from '../src/services/provider-rate-card-loader.service.js';
import type { ProviderRateCardLoaderDependencies } from '../src/services/provider-rate-card-loader.service.js';
import { RATE_CARD_SCHEMA_VERSION } from '../src/types/provider-pricing.js';

const VERSION_PREFIX = 'test-load-';
const GENERATED_AT = new Date('2026-08-05T00:00:00Z');

function version(): string {
  return `${VERSION_PREFIX}${crypto.randomUUID()}`;
}

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function baseEntry(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'google',
    model: `db-model-${crypto.randomUUID().slice(0, 8)}`,
    status: 'STABLE',
    tier: 'STANDARD',
    billingUnit: 'TOKEN',
    inputMicrosPerMillion: 1_500_000n,
    outputMicrosPerMillion: 7_500_000n,
    cachedInputMicrosPerMillion: 150_000n,
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: utcDate('2026-08-01'),
    inactive: false,
    ...overrides,
  };
}

async function createSnapshot(overrides: Record<string, unknown> = {}) {
  return prisma.providerRateCardSnapshot.create({
    data: {
      version: version(),
      source: 'https://example.test/pricing',
      generatedAt: GENERATED_AT,
      entries: { create: [baseEntry()] },
      ...overrides,
    },
    include: { entries: true },
  });
}

/** Delete only rate-card rows whose version starts with the test prefix. */
async function cleanupRateCardData(): Promise<void> {
  const snapshots = await prisma.providerRateCardSnapshot.findMany({
    where: { version: { startsWith: VERSION_PREFIX } },
    select: { id: true },
  });
  const ids = snapshots.map((s) => s.id);
  if (ids.length) {
    await prisma.providerRateCardEntry.deleteMany({ where: { snapshotId: { in: ids } } });
    await prisma.providerRateCardSnapshot.deleteMany({ where: { id: { in: ids } } });
  }
}

interface IsolationCounts {
  users: number;
  roles: number;
  payments: number;
  tokenTransactions: number;
  tokenReservations: number;
  aiBillingOperations: number;
  aiUsageLogs: number;
}

async function captureIsolationCounts(): Promise<IsolationCounts> {
  const [users, roles, payments, tokenTransactions, tokenReservations, aiBillingOperations, aiUsageLogs] =
    await Promise.all([
      prisma.user.count(),
      prisma.role.count(),
      prisma.payment.count(),
      prisma.tokenTransaction.count(),
      prisma.tokenReservation.count(),
      prisma.aIBillingOperation.count(),
      prisma.aiUsageLog.count(),
    ]);
  return { users, roles, payments, tokenTransactions, tokenReservations, aiBillingOperations, aiUsageLogs };
}

function asLoadError(err: unknown): ProviderRateCardLoadError {
  assert.ok(err instanceof ProviderRateCardLoadError, `expected ProviderRateCardLoadError, got ${String(err)}`);
  return err;
}

const repository: ProviderRateCardRepository = createPrismaProviderRateCardRepository(prisma);
const deps: ProviderRateCardLoaderDependencies = createDefaultProviderRateCardLoaderDependencies(repository);

let baseline: IsolationCounts;

before(async () => {
  await cleanupRateCardData();
  baseline = await captureIsolationCounts();
});

beforeEach(async () => {
  await cleanupRateCardData();
});

after(async () => {
  await cleanupRateCardData();
  const now = await captureIsolationCounts();
  assert.deepEqual(now, baseline, 'rate-card loader/repository tests must not modify any other table');
});

// ---------------------------------------------------------------------------
// Active-date selection (1-13)
// ---------------------------------------------------------------------------

test('1. no snapshots at all -> none', async () => {
  const selection = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.deepEqual(selection, { kind: 'none' });
});

test('2. only a DRAFT snapshot -> none', async () => {
  await createSnapshot({ status: 'DRAFT', effectiveFrom: utcDate('2026-08-01'), publishedAt: null });
  const selection = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.deepEqual(selection, { kind: 'none' });
});

test('3. only a RETIRED snapshot -> none', async () => {
  await createSnapshot({
    status: 'RETIRED',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
    retiredAt: utcDate('2026-12-01'),
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.deepEqual(selection, { kind: 'none' });
});

test('4. future ACTIVE snapshot -> none', async () => {
  await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-09-01'),
    publishedAt: utcDate('2026-08-20'),
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.deepEqual(selection, { kind: 'none' });
});

test('5. expired ACTIVE snapshot -> none', async () => {
  await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-07-01'),
    effectiveTo: utcDate('2026-07-31'),
    publishedAt: utcDate('2026-07-01'),
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.deepEqual(selection, { kind: 'none' });
});

test('6. exactly one ACTIVE snapshot applying -> found (boundary effectiveFrom inclusive)', async () => {
  const created = await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-15'),
    publishedAt: utcDate('2026-08-10'),
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.equal(selection.kind, 'found');
  if (selection.kind === 'found') {
    assert.equal(selection.snapshot.id, created.id);
  }
});

test('7. effectiveTo boundary is inclusive', async () => {
  const created = await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    effectiveTo: utcDate('2026-08-31'),
    publishedAt: utcDate('2026-08-01'),
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-31');
  assert.equal(selection.kind, 'found');
  if (selection.kind === 'found') {
    assert.equal(selection.snapshot.id, created.id);
  }
});

test('8. open-ended ACTIVE (effectiveTo null) applies to any later date', async () => {
  const created = await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
  });
  const selection = await repository.findActiveSnapshotForDate('2026-12-31');
  assert.equal(selection.kind, 'found');
  if (selection.kind === 'found') {
    assert.equal(selection.snapshot.id, created.id);
  }
});

test('9. entries are included in the selection result', async () => {
  const created = await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
    entries: { create: [baseEntry(), baseEntry({ provider: 'anthropic' })] },
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.equal(selection.kind, 'found');
  if (selection.kind === 'found') {
    assert.equal(selection.snapshot.entries.length, 2);
    assert.equal(selection.snapshot.entries.every((e) => e.snapshotId === created.id), true);
  }
});

test('10. entries are deterministically ordered (provider, model, tier, effectiveFrom, id)', async () => {
  await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
    entries: {
      create: [
        baseEntry({ provider: 'zzz', model: 'm3', tier: 'STANDARD', effectiveFrom: utcDate('2026-08-03') }),
        baseEntry({ provider: 'aaa', model: 'm2', tier: 'FAST_MODE', effectiveFrom: utcDate('2026-08-02') }),
        baseEntry({ provider: 'aaa', model: 'm1', tier: 'BATCH', effectiveFrom: utcDate('2026-08-02') }),
        baseEntry({ provider: 'aaa', model: 'm2', tier: 'STANDARD', effectiveFrom: utcDate('2026-08-04') }),
        baseEntry({ provider: 'aaa', model: 'm1', tier: 'STANDARD', effectiveFrom: utcDate('2026-08-01') }),
      ],
    },
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.equal(selection.kind, 'found');
  if (selection.kind === 'found') {
    const keys = selection.snapshot.entries.map((e) => `${e.provider}/${e.model}/${e.tier}/${e.effectiveFrom.getTime()}`);
    // Ordering is provider ASC, model ASC, tier ASC (PostgreSQL enum ordinal:
    // STANDARD < BATCH < PRIORITY < FAST_MODE), effectiveFrom ASC, id ASC.
    assert.deepEqual(keys, [
      'aaa/m1/STANDARD/1785542400000',
      'aaa/m1/BATCH/1785628800000',
      'aaa/m2/STANDARD/1785801600000',
      'aaa/m2/FAST_MODE/1785628800000',
      'zzz/m3/STANDARD/1785715200000',
    ]);
  }
});

test('11. snapshot version is preserved in the selection result', async () => {
  const v = version();
  await createSnapshot({
    version: v,
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.equal(selection.kind, 'found');
  if (selection.kind === 'found') {
    assert.equal(selection.snapshot.version, v);
  }
});

test('12. ACTIVE status and window metadata are preserved', async () => {
  const v = version();
  await createSnapshot({
    version: v,
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    effectiveTo: utcDate('2026-08-31'),
    publishedAt: utcDate('2026-08-01'),
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.equal(selection.kind, 'found');
  if (selection.kind === 'found') {
    assert.equal(selection.snapshot.status, 'ACTIVE');
    assert.equal(selection.snapshot.effectiveFrom.getTime(), utcDate('2026-08-01').getTime());
    assert.equal(selection.snapshot.effectiveTo.getTime(), utcDate('2026-08-31').getTime());
  }
});

test('13. selection returns fresh plain row copies (mutating the result does not affect the database)', async () => {
  await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
    entries: { create: [baseEntry(), baseEntry({ provider: 'anthropic' })] },
  });
  const first = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.equal(first.kind, 'found');
  if (first.kind === 'found') {
    first.snapshot.entries.push({} as never);
    first.snapshot.entries[0] = { ...first.snapshot.entries[0], provider: 'mutated' } as never;
  }
  const second = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.equal(second.kind, 'found');
  if (second.kind === 'found') {
    assert.equal(second.snapshot.entries.length, 2);
    assert.equal(second.snapshot.entries.some((e) => e.provider === 'mutated'), false);
    assert.deepEqual(
      second.snapshot.entries.map((e) => e.provider).sort(),
      ['anthropic', 'google'],
    );
  }
});

// ---------------------------------------------------------------------------
// Conflict detection (14-19)
// ---------------------------------------------------------------------------

test('14. two overlapping ACTIVE snapshots -> conflict with versions + count', async () => {
  const v1 = version();
  const v2 = version();
  await createSnapshot({
    version: v1,
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
  });
  await createSnapshot({
    version: v2,
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-15'),
    publishedAt: utcDate('2026-08-10'),
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-20');
  assert.equal(selection.kind, 'conflict');
  if (selection.kind === 'conflict') {
    assert.deepEqual(new Set(selection.versions), new Set([v1, v2]));
    assert.equal(selection.count, 2);
    assert.equal(selection.pricingDate, '2026-08-20');
  }
});

test('15. conflict is never resolved by version ordering', async () => {
  const vA = version();
  const vB = version();
  await createSnapshot({
    version: vA,
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
  });
  await createSnapshot({
    version: vB,
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-15'),
    publishedAt: utcDate('2026-08-10'),
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-20');
  assert.equal(selection.kind, 'conflict');
  if (selection.kind === 'conflict') {
    assert.deepEqual(new Set(selection.versions), new Set([vA, vB]));
  }
});

test('16. conflict is never resolved by createdAt ordering', async () => {
  await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-15'),
    publishedAt: utcDate('2026-08-10'),
  });
  await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-20');
  assert.equal(selection.kind, 'conflict');
});

test('17. two ACTIVE snapshots with disjoint windows -> found for a date only in one', async () => {
  const early = await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    effectiveTo: utcDate('2026-08-15'),
    publishedAt: utcDate('2026-08-01'),
  });
  await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-09-01'),
    publishedAt: utcDate('2026-08-20'),
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-10');
  assert.equal(selection.kind, 'found');
  if (selection.kind === 'found') {
    assert.equal(selection.snapshot.id, early.id);
  }
});

test('18. overlapping ACTIVE + DRAFT -> found (DRAFT ignored)', async () => {
  const active = await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
  });
  await createSnapshot({ status: 'DRAFT', effectiveFrom: utcDate('2026-08-01'), publishedAt: null });
  const selection = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.equal(selection.kind, 'found');
  if (selection.kind === 'found') {
    assert.equal(selection.snapshot.id, active.id);
  }
});

test('19. overlapping ACTIVE + RETIRED -> found (RETIRED ignored)', async () => {
  const active = await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
  });
  await createSnapshot({
    status: 'RETIRED',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
    retiredAt: utcDate('2026-12-01'),
  });
  const selection = await repository.findActiveSnapshotForDate('2026-08-15');
  assert.equal(selection.kind, 'found');
  if (selection.kind === 'found') {
    assert.equal(selection.snapshot.id, active.id);
  }
});

// ---------------------------------------------------------------------------
// Version lookup (20-25)
// ---------------------------------------------------------------------------

test('20. a DRAFT snapshot loads by version', async () => {
  const v = version();
  await createSnapshot({ version: v, status: 'DRAFT', effectiveFrom: null, publishedAt: null });
  const row = await repository.findSnapshotByVersion(v);
  assert.ok(row !== null);
  assert.equal(row.version, v);
  assert.equal(row.status, 'DRAFT');
});

test('21. an ACTIVE snapshot loads by version', async () => {
  const v = version();
  await createSnapshot({ version: v, status: 'ACTIVE', effectiveFrom: utcDate('2026-08-01'), publishedAt: utcDate('2026-08-01') });
  const row = await repository.findSnapshotByVersion(v);
  assert.ok(row !== null);
  assert.equal(row.status, 'ACTIVE');
});

test('22. a RETIRED snapshot loads by version', async () => {
  const v = version();
  await createSnapshot({
    version: v,
    status: 'RETIRED',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
    retiredAt: utcDate('2026-12-01'),
  });
  const row = await repository.findSnapshotByVersion(v);
  assert.ok(row !== null);
  assert.equal(row.status, 'RETIRED');
});

test('23. an unknown version -> null (not an error)', async () => {
  const row = await repository.findSnapshotByVersion('nope-missing-version');
  assert.equal(row, null);
});

test('24. entries are included in the version lookup', async () => {
  const v = version();
  await createSnapshot({
    version: v,
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
    entries: { create: [baseEntry(), baseEntry({ provider: 'anthropic' })] },
  });
  const row = await repository.findSnapshotByVersion(v);
  assert.ok(row !== null);
  assert.equal(row.entries.length, 2);
});

test('25. version lookup does not filter by effective date', async () => {
  const v = version();
  await createSnapshot({
    version: v,
    status: 'ACTIVE',
    effectiveFrom: utcDate('2027-01-01'),
    publishedAt: utcDate('2026-12-15'),
  });
  const row = await repository.findSnapshotByVersion(v);
  assert.ok(row !== null);
  assert.equal(row.effectiveFrom.getTime(), utcDate('2027-01-01').getTime());
});

// ---------------------------------------------------------------------------
// Loader integration / mapping (26-32)
// ---------------------------------------------------------------------------

test('26. loader active selection returns the engine card contract', async () => {
  const v = version();
  await createSnapshot({
    version: v,
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
  });
  const result = await loadActiveRateCardForDate(deps, '2026-08-15');
  assert.equal(result.card.version, v);
  assert.equal(result.card.schemaVersion, RATE_CARD_SCHEMA_VERSION);
  assert.equal(result.card.currency, 'USD');
  assert.equal(result.card.entries.length, 1);
  assert.equal(result.snapshot.status, 'ACTIVE');
  assert.equal(result.snapshot.effectiveFrom, '2026-08-01');
});

test('27. BigInt monetary values reach the engine as safe numbers', async () => {
  await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
    entries: {
      create: [baseEntry({ inputMicrosPerMillion: 1_500_000n, outputMicrosPerMillion: 7_500_000n })],
    },
  });
  const result = await loadActiveRateCardForDate(deps, '2026-08-15');
  const entry = result.card.entries[0];
  assert.equal(entry.tokenRates?.inputMicrosPerMillion, 1_500_000);
  assert.equal(entry.tokenRates?.outputMicrosPerMillion, 7_500_000);
});

test('28. a zero BigInt value stays zero through the mapper', async () => {
  await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
    entries: {
      create: [baseEntry({ inputMicrosPerMillion: 0n, outputMicrosPerMillion: 0n })],
    },
  });
  const result = await loadActiveRateCardForDate(deps, '2026-08-15');
  assert.equal(result.card.entries[0].tokenRates?.inputMicrosPerMillion, 0);
});

test('29. NULL optional fields stay null (absent) in the engine contract', async () => {
  await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
    entries: {
      create: [
        baseEntry({
          inputMicrosPerMillion: 1_500_000n,
          outputMicrosPerMillion: null,
          cachedInputMicrosPerMillion: null,
          cachedOutputMicrosPerMillion: null,
          perUnitMicros: null,
          audioInputMicrosPerMillion: null,
          audioOutputMicrosPerMillion: null,
          tokensPerSecond: null,
          cachedInputAccounting: null,
          effectiveTo: null,
          verifiedAt: null,
          source: null,
        }),
      ],
    },
  });
  const result = await loadActiveRateCardForDate(deps, '2026-08-15');
  const entry = result.card.entries[0];
  assert.deepEqual(Object.keys(entry.tokenRates ?? {}), ['inputMicrosPerMillion']);
  assert.equal(entry.tokenRates?.inputMicrosPerMillion, 1_500_000);
  assert.equal(entry.effectiveTo, undefined);
  assert.equal(entry.cachedInputAccounting, undefined);
});

test('30. an out-of-engine-range BigInt -> RATE_CARD_SNAPSHOT_INVALID with range mapper code', async () => {
  const huge = 9_000_000_000_000_000_000n;
  await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
    entries: { create: [baseEntry({ inputMicrosPerMillion: huge, outputMicrosPerMillion: null, cachedInputMicrosPerMillion: null, cachedInputAccounting: null })] },
  });
  await assert.rejects(
    loadActiveRateCardForDate(deps, '2026-08-15'),
    (err: unknown) => {
      const e = asLoadError(err);
      assert.equal(e.code, 'RATE_CARD_SNAPSHOT_INVALID');
      assert.equal(e.mapperCode, 'SNAPSHOT_RATE_OUT_OF_ENGINE_RANGE');
      return true;
    },
  );
});

test('31. an invalid snapshot shape -> RATE_CARD_SNAPSHOT_INVALID with preserved mapper code', async () => {
  await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
    entries: { create: [] },
  });
  await assert.rejects(
    loadActiveRateCardForDate(deps, '2026-08-15'),
    (err: unknown) => {
      const e = asLoadError(err);
      assert.equal(e.code, 'RATE_CARD_SNAPSHOT_INVALID');
      assert.equal(e.mapperCode, 'SNAPSHOT_EMPTY_ENTRIES');
      return true;
    },
  );
});

test('32. an unknown provider/model remains accepted by the loader', async () => {
  await createSnapshot({
    status: 'ACTIVE',
    effectiveFrom: utcDate('2026-08-01'),
    publishedAt: utcDate('2026-08-01'),
    entries: {
      create: [baseEntry({ provider: 'brand-new-provider', model: 'brand-new-model' })],
    },
  });
  const result = await loadActiveRateCardForDate(deps, '2026-08-15');
  assert.deepEqual(result.providers, ['brand-new-provider']);
  assert.equal(result.card.entries[0].provider, 'brand-new-provider');
});

// ---------------------------------------------------------------------------
// Read-only guarantees (33-39)
// ---------------------------------------------------------------------------

test('33. loader active lookup performs no writes (rate-card rows unchanged)', async () => {
  const v = version();
  await createSnapshot({ version: v, status: 'ACTIVE', effectiveFrom: utcDate('2026-08-01'), publishedAt: utcDate('2026-08-01') });
  const beforeSnapshots = await prisma.providerRateCardSnapshot.count();
  const beforeEntries = await prisma.providerRateCardEntry.count();
  await loadActiveRateCardForDate(deps, '2026-08-15');
  const afterSnapshots = await prisma.providerRateCardSnapshot.count();
  const afterEntries = await prisma.providerRateCardEntry.count();
  assert.equal(afterSnapshots, beforeSnapshots);
  assert.equal(afterEntries, beforeEntries);
});

test('34. loader version lookup performs no writes (rate-card rows unchanged)', async () => {
  const v = version();
  await createSnapshot({ version: v, status: 'ACTIVE', effectiveFrom: utcDate('2026-08-01'), publishedAt: utcDate('2026-08-01') });
  const beforeSnapshots = await prisma.providerRateCardSnapshot.count();
  const beforeEntries = await prisma.providerRateCardEntry.count();
  await loadRateCardByVersion(deps, v);
  const afterSnapshots = await prisma.providerRateCardSnapshot.count();
  const afterEntries = await prisma.providerRateCardEntry.count();
  assert.equal(afterSnapshots, beforeSnapshots);
  assert.equal(afterEntries, beforeEntries);
});

test('35. repository selection performs no writes', async () => {
  await createSnapshot({ status: 'ACTIVE', effectiveFrom: utcDate('2026-08-01'), publishedAt: utcDate('2026-08-01') });
  const beforeSnapshots = await prisma.providerRateCardSnapshot.count();
  await repository.findActiveSnapshotForDate('2026-08-15');
  const afterSnapshots = await prisma.providerRateCardSnapshot.count();
  assert.equal(afterSnapshots, beforeSnapshots);
});

test('36. TokenWallet rows are untouched', async () => {
  await createSnapshot({ status: 'ACTIVE', effectiveFrom: utcDate('2026-08-01'), publishedAt: utcDate('2026-08-01') });
  const before = await prisma.tokenWallet.count();
  await loadActiveRateCardForDate(deps, '2026-08-15');
  assert.equal(await prisma.tokenWallet.count(), before);
});

test('37. TokenTransaction rows are untouched', async () => {
  await createSnapshot({ status: 'ACTIVE', effectiveFrom: utcDate('2026-08-01'), publishedAt: utcDate('2026-08-01') });
  const before = await prisma.tokenTransaction.count();
  await loadActiveRateCardForDate(deps, '2026-08-15');
  assert.equal(await prisma.tokenTransaction.count(), before);
});

test('38. TokenReservation and AIBillingOperation rows are untouched', async () => {
  await createSnapshot({ status: 'ACTIVE', effectiveFrom: utcDate('2026-08-01'), publishedAt: utcDate('2026-08-01') });
  const beforeReservations = await prisma.tokenReservation.count();
  const beforeBilling = await prisma.aIBillingOperation.count();
  await loadActiveRateCardForDate(deps, '2026-08-15');
  assert.equal(await prisma.tokenReservation.count(), beforeReservations);
  assert.equal(await prisma.aIBillingOperation.count(), beforeBilling);
});

test('39. User, Role, Payment and AiUsageLog rows are untouched', async () => {
  await createSnapshot({ status: 'ACTIVE', effectiveFrom: utcDate('2026-08-01'), publishedAt: utcDate('2026-08-01') });
  const beforeUsers = await prisma.user.count();
  const beforeRoles = await prisma.role.count();
  const beforePayments = await prisma.payment.count();
  const beforeUsage = await prisma.aiUsageLog.count();
  await loadActiveRateCardForDate(deps, '2026-08-15');
  assert.equal(await prisma.user.count(), beforeUsers);
  assert.equal(await prisma.role.count(), beforeRoles);
  assert.equal(await prisma.payment.count(), beforePayments);
  assert.equal(await prisma.aiUsageLog.count(), beforeUsage);
});

test('40. loader version lookup returns the engine card (full path for any lifecycle status)', async () => {
  const v = version();
  await createSnapshot({
    version: v,
    status: 'RETIRED',
    effectiveFrom: utcDate('2026-08-01'),
    effectiveTo: utcDate('2026-08-31'),
    publishedAt: utcDate('2026-08-01'),
    retiredAt: utcDate('2026-12-01'),
    entries: {
      create: [baseEntry({ provider: 'anthropic', model: 'claude-retired', tier: 'STANDARD' })],
    },
  });
  const result = await loadRateCardByVersion(deps, v);
  assert.equal(result.card.version, v);
  assert.equal(result.snapshot.status, 'RETIRED');
  assert.equal(result.snapshot.retiredAt, '2026-12-01T00:00:00.000Z');
  assert.deepEqual(result.providers, ['anthropic']);
  assert.equal(result.card.entries[0].provider, 'anthropic');
});
