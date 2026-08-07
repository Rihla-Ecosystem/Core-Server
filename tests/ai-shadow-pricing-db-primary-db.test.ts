/**
 * Phase 2F-E real PostgreSQL integration tests for DATABASE_PRIMARY pricing.
 *
 * Self-contained: every fixture is created by this suite with a unique
 * `shadow-primary-db-it-<label>-<uuid>` version, and cleanup deletes ONLY rows
 * this suite created (matched by that version prefix). The suite never reads,
 * publishes, retires, modifies, or deletes unrelated snapshots, and it never
 * depends on the static import script or a pre-existing `1.0.0` DRAFT.
 *
 * Hard-gated to the test database `core_server_test`.
 *
 * Run with:
 *   node --env-file=.env.test --import tsx --test tests/ai-shadow-pricing-db-primary-db.test.ts
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPrismaProviderRateCardRepository } from '../src/repositories/provider-rate-card.repository.js';
import {
  createDefaultProviderRateCardLoaderDependencies,
  loadActiveRateCardForDate,
} from '../src/services/provider-rate-card-loader.service.js';
import { AiShadowPricingService } from '../src/services/ai-shadow-pricing.service.js';
import type { ShadowPricingDependencies } from '../src/services/shadow-pricing-deps.js';
import { aggregateProviderCalls } from '../src/utils/provider-pricing/aggregate.js';
import { PROVIDER_RATE_CARD } from '../src/config/provider-rate-card/index.js';

const DB_URL = process.env.DATABASE_URL;
assert.ok(DB_URL, 'DATABASE_URL must be set');
assert.equal(
  new URL(DB_URL).pathname,
  '/core_server_test',
  'must run against the core_server_test database',
);

const prisma = new PrismaClient();
const repo = createPrismaProviderRateCardRepository(prisma);
const loaderDeps = createDefaultProviderRateCardLoaderDependencies(repo);

/** Prefix that uniquely identifies every snapshot owned by this suite. */
const VERSION_PREFIX = 'shadow-primary-db-it-';

const DEFAULT_PRICING_DATE = '2026-08-05';

const VALID_CALL = {
  provider: 'google',
  providerCallMade: true,
  providerCallId: 'call-1',
  actualModel: 'gemini-3.6-flash',
  inputTokens: 1500,
  outputTokens: 200,
  cachedInputTokens: 500,
};

const STATIC_ENTRY = PROVIDER_RATE_CARD.entries.find(
  (e) => e.provider === 'google' && e.model === 'gemini-3.6-flash' && e.tier === 'standard',
);
assert.ok(STATIC_ENTRY, 'static rate card must contain the google/gemini-3.6-flash/standard entry');
assert.ok(STATIC_ENTRY.tokenRates, 'static entry must carry token rates');

const PARITY_RATES = {
  inputMicrosPerMillion: BigInt(STATIC_ENTRY.tokenRates.inputMicrosPerMillion!),
  outputMicrosPerMillion: BigInt(STATIC_ENTRY.tokenRates.outputMicrosPerMillion!),
  cachedInputMicrosPerMillion: BigInt(STATIC_ENTRY.tokenRates.cachedInputMicrosPerMillion!),
};

function uniqueVersion(label: string): string {
  return `${VERSION_PREFIX}${label}-${crypto.randomUUID()}`;
}

function parityEntry(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'google',
    model: 'gemini-3.6-flash',
    status: 'STABLE',
    tier: 'STANDARD',
    billingUnit: 'TOKEN',
    inputMicrosPerMillion: PARITY_RATES.inputMicrosPerMillion,
    outputMicrosPerMillion: PARITY_RATES.outputMicrosPerMillion,
    cachedInputMicrosPerMillion: PARITY_RATES.cachedInputMicrosPerMillion,
    cachedOutputMicrosPerMillion: null,
    perUnitMicros: null,
    audioInputMicrosPerMillion: null,
    audioOutputMicrosPerMillion: null,
    tokensPerSecond: null,
    cachedInputAccounting: 'DISJOINT',
    effectiveFrom: new Date('2026-08-01'),
    inactive: false,
    source: 'test',
    verifiedAt: new Date('2026-08-01'),
    ...overrides,
  };
}

async function createSnapshot(input: {
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  version: string;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  publishedAt?: Date | null;
  retiredAt?: Date | null;
  entries?: Record<string, unknown>[];
}) {
  return prisma.providerRateCardSnapshot.create({
    data: {
      id: crypto.randomUUID(),
      version: input.version,
      status: input.status,
      schemaVersion: 1,
      currency: 'USD',
      storageUnit: 'MICROS',
      engineUnit: 'NANO_USD',
      source: 'test',
      generatedAt: new Date('2026-08-03'),
      provenance: 'RESEARCH_SNAPSHOT',
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
      publishedAt: input.publishedAt ?? null,
      retiredAt: input.retiredAt ?? null,
      entries: { create: input.entries ?? [] },
    },
  });
}

async function createActive(
  version: string,
  entryOverrides: Record<string, unknown> = {},
  snapshotOverrides: Partial<{ effectiveFrom?: Date | null; effectiveTo?: Date | null }> = {},
) {
  await createSnapshot({
    status: 'ACTIVE',
    version,
    effectiveFrom: snapshotOverrides.effectiveFrom ?? new Date('2026-08-01'),
    effectiveTo: snapshotOverrides.effectiveTo ?? null,
    publishedAt: new Date('2026-08-01'),
    entries: [parityEntry(entryOverrides)],
  });
}

async function cleanupOwnedSnapshots() {
  const owned = await prisma.providerRateCardSnapshot.findMany({
    where: { version: { startsWith: VERSION_PREFIX } },
    select: { id: true },
  });
  const ids = owned.map((s) => s.id);
  if (ids.length) {
    await prisma.providerRateCardEntry.deleteMany({ where: { snapshotId: { in: ids } } });
    await prisma.providerRateCardSnapshot.deleteMany({ where: { id: { in: ids } } });
  }
}

interface Baseline {
  snapshots: number;
  entries: number;
  tokenWallet: number;
  tokenTransaction: number;
  tokenReservation: number;
  aiBillingOperation: number;
  payment: number;
  tokenPackage: number;
  aiUsageLog: number;
}

async function captureBaseline(): Promise<Baseline> {
  const [
    snapshots,
    entries,
    tokenWallet,
    tokenTransaction,
    tokenReservation,
    aiBillingOperation,
    payment,
    tokenPackage,
    aiUsageLog,
  ] = await Promise.all([
    prisma.providerRateCardSnapshot.count(),
    prisma.providerRateCardEntry.count(),
    prisma.tokenWallet.count(),
    prisma.tokenTransaction.count(),
    prisma.tokenReservation.count(),
    prisma.aIBillingOperation.count(),
    prisma.payment.count(),
    prisma.tokenPackage.count(),
    prisma.aiUsageLog.count(),
  ]);
  return {
    snapshots,
    entries,
    tokenWallet,
    tokenTransaction,
    tokenReservation,
    aiBillingOperation,
    payment,
    tokenPackage,
    aiUsageLog,
  };
}

let baseline: Baseline;

before(async () => {
  await cleanupOwnedSnapshots();
  baseline = await captureBaseline();
});

beforeEach(async () => {
  await cleanupOwnedSnapshots();
});

after(async () => {
  await cleanupOwnedSnapshots();
  try {
    const now = await captureBaseline();
    assert.deepEqual(
      now,
      baseline,
      'this suite must restore the database to its original baseline and must not touch unrelated rows',
    );
  } finally {
    await prisma.$disconnect();
  }
});

async function runPrimary(
  calls: unknown[] = [VALID_CALL],
  opts: { pricingDate?: string } = {},
): Promise<{
  outcome: Awaited<ReturnType<AiShadowPricingService['record']>>;
  infos: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
  loadCount: number;
  engineCalls: number;
}> {
  const infos: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];
  let loadCount = 0;
  let engineCalls = 0;
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: false,
    pricingSource: 'DATABASE_PRIMARY',
    loadActiveRateCardForDate: async (d) => {
      loadCount++;
      return loadActiveRateCardForDate(loaderDeps, d);
    },
  };
  const svc = new AiShadowPricingService({
    shadowDeps: deps,
    logger: {
      info: (_e, p) => infos.push(p),
      error: (_e, p) => errors.push(p),
    },
    engine: (input) => {
      engineCalls++;
      return aggregateProviderCalls(input);
    },
  });
  const outcome = await svc.record(calls, { source: 'chat', pricingDate: opts.pricingDate ?? DEFAULT_PRICING_DATE });
  return { outcome, infos, errors, loadCount, engineCalls };
}

// ---------------------------------------------------------------------------
// Safety gate
// ---------------------------------------------------------------------------

test('hard gate: DATABASE_URL points at /core_server_test', () => {
  assert.ok(DB_URL);
  assert.equal(new URL(DB_URL).pathname, '/core_server_test');
});

// ---------------------------------------------------------------------------
// Authoritative DB pricing
// ---------------------------------------------------------------------------

test('ACTIVE DB snapshot → authoritative DB result, DB version recorded', async () => {
  const version = uniqueVersion('primary');
  await createActive(version, { inputMicrosPerMillion: 2_000_000n });

  const { outcome, infos, errors, loadCount, engineCalls } = await runPrimary();

  assert.equal(outcome.kind, 'priced');
  assert.equal(loadCount, 1, 'exactly one DB load per operation');
  assert.equal(engineCalls, 1, 'engine runs exactly once (DB card priced once)');
  assert.equal(errors.length, 0, 'no error log on success');

  // DB input rate 2.0 vs static 1.5 micros/M → +0.5 micros/token × 1500 tokens = 750 micros = 750_000 nano USD.
  const staticCost = aggregateProviderCalls({
    providerCalls: [VALID_CALL],
    pricingDate: DEFAULT_PRICING_DATE,
    card: PROVIDER_RATE_CARD,
  }).totals.pricedCostNanoUsd;
  const dbCost = (outcome as { kind: 'priced'; result: { totals: { pricedCostNanoUsd: bigint } } }).result.totals.pricedCostNanoUsd;
  assert.equal(dbCost - staticCost, 750_000n, 'DB authority must change the priced cost by exactly the rate delta');

  const log = infos.find((l) => l.event === 'ai_shadow_pricing');
  assert.equal(log.configuredPricingSource, 'DATABASE_PRIMARY');
  assert.equal(log.actualPricingSource, 'DATABASE_PRIMARY');
  assert.equal(log.rateCardVersion, version);
  assert.equal(log.pricingStatus, 'FULLY_PRICED');
  assert.equal(log.loaderErrorCode, null);
  assert.equal(log.rollbackToStatic, false);
  assert.equal(typeof log.durationMs, 'number');
});

test('single DB load serves multiple provider calls', async () => {
  const version = uniqueVersion('multi');
  await createActive(version);
  const calls = [
    { ...VALID_CALL, providerCallId: 'call-1' },
    { ...VALID_CALL, providerCallId: 'call-2' },
  ];
  const { outcome, loadCount, engineCalls } = await runPrimary(calls);
  assert.equal(outcome.kind, 'priced');
  assert.equal(
    (outcome as { kind: 'priced'; result: { totals: { callCount: number } } }).result.totals.callCount,
    2,
  );
  assert.equal(loadCount, 1, 'one DB load must serve the whole operation');
  assert.equal(engineCalls, 1, 'engine prices the whole operation once');
});

// ---------------------------------------------------------------------------
// Fail-closed paths
// ---------------------------------------------------------------------------

test('no ACTIVE snapshot → dbPricingError NOT_FOUND (no static fallback, no zero cost)', async () => {
  const { outcome, infos, errors } = await runPrimary();
  assert.equal(outcome.kind, 'dbPricingError');
  assert.equal((outcome as { kind: 'dbPricingError'; status: string }).status, 'DB_RATE_CARD_NOT_FOUND');
  assert.equal((outcome as { kind: 'dbPricingError'; errorCode: string }).errorCode, 'RATE_CARD_NOT_FOUND');
  assert.equal((outcome as { kind: 'dbPricingError'; errorMessage: string }).errorMessage, 'database rate card pricing unavailable');
  const errLog = errors.find((l) => l.event === 'ai_shadow_pricing_primary_error');
  assert.ok(errLog, 'primary error log must be emitted');
  assert.equal(errLog.pricingStatus, 'DB_RATE_CARD_NOT_FOUND');
  assert.equal(errLog.rollbackToStatic, false);
  assert.equal(infos.find((l) => l.event === 'ai_shadow_pricing'), undefined, 'no success log on failure');
});

test('DRAFT-only DB → dbPricingError NOT_FOUND (active-date ignores DRAFT)', async () => {
  const version = uniqueVersion('draft');
  await createSnapshot({ status: 'DRAFT', version, entries: [parityEntry()] });
  const { outcome } = await runPrimary();
  assert.equal(outcome.kind, 'dbPricingError');
  assert.equal((outcome as { kind: 'dbPricingError'; status: string }).status, 'DB_RATE_CARD_NOT_FOUND');
});

test('RETIRED-only DB → dbPricingError NOT_FOUND (active-date ignores RETIRED)', async () => {
  const version = uniqueVersion('retired');
  await createSnapshot({
    status: 'RETIRED',
    version,
    effectiveFrom: new Date('2026-07-01'),
    effectiveTo: new Date('2026-07-31'),
    publishedAt: new Date('2026-07-01'),
    retiredAt: new Date('2026-08-01'),
    entries: [parityEntry({ effectiveFrom: new Date('2026-07-01'), verifiedAt: new Date('2026-07-01') })],
  });
  const { outcome } = await runPrimary();
  assert.equal(outcome.kind, 'dbPricingError');
  assert.equal((outcome as { kind: 'dbPricingError'; status: string }).status, 'DB_RATE_CARD_NOT_FOUND');
});

test('overlapping ACTIVE snapshots → dbPricingError ACTIVE_CONFLICT', async () => {
  await createActive(uniqueVersion('conflict-a'));
  await createActive(uniqueVersion('conflict-b'));
  const { outcome } = await runPrimary();
  assert.equal(outcome.kind, 'dbPricingError');
  assert.equal((outcome as { kind: 'dbPricingError'; status: string }).status, 'DB_RATE_CARD_ACTIVE_CONFLICT');
});

test('huge BIGINT DB rate → dbPricingError INVALID (boundary rejects overflow)', async () => {
  await createActive(uniqueVersion('bigint'), { inputMicrosPerMillion: 9_000_000_000_000_000_000n });
  const { outcome } = await runPrimary();
  assert.equal(outcome.kind, 'dbPricingError');
  assert.equal((outcome as { kind: 'dbPricingError'; status: string }).status, 'DB_RATE_CARD_INVALID');
});

// ---------------------------------------------------------------------------
// Read-only guarantees
// ---------------------------------------------------------------------------

test('read-only — no snapshot lifecycle or entry mutation', async () => {
  const version = uniqueVersion('no-mutation');
  await createActive(version);
  const before = await prisma.providerRateCardSnapshot.findUniqueOrThrow({ where: { version } });
  const beforeEntry = await prisma.providerRateCardEntry.findFirstOrThrow({
    where: { snapshotId: before.id },
  });

  const { outcome } = await runPrimary();
  assert.equal(outcome.kind, 'priced');

  const after = await prisma.providerRateCardSnapshot.findUniqueOrThrow({ where: { version } });
  const afterEntry = await prisma.providerRateCardEntry.findFirstOrThrow({
    where: { snapshotId: after.id },
  });
  assert.equal(after.status, before.status);
  assert.equal(after.effectiveFrom?.toISOString(), before.effectiveFrom?.toISOString());
  assert.equal(after.effectiveTo?.toISOString(), before.effectiveTo?.toISOString());
  assert.equal(after.publishedAt?.toISOString(), before.publishedAt?.toISOString());
  assert.equal(after.retiredAt?.toISOString(), before.retiredAt?.toISOString());
  assert.equal(afterEntry.inputMicrosPerMillion, beforeEntry.inputMicrosPerMillion);
  assert.equal(afterEntry.outputMicrosPerMillion, beforeEntry.outputMicrosPerMillion);
  assert.equal(afterEntry.cachedInputMicrosPerMillion, beforeEntry.cachedInputMicrosPerMillion);
  assert.equal(afterEntry.cachedInputAccounting, beforeEntry.cachedInputAccounting);
});

test('no Wallet/billing/usage mutations', async () => {
  await createActive(uniqueVersion('billing'));
  const before = await captureBaseline();
  const { outcome } = await runPrimary();
  assert.equal(outcome.kind, 'priced');
  const after = await captureBaseline();
  assert.equal(after.tokenWallet, before.tokenWallet);
  assert.equal(after.tokenTransaction, before.tokenTransaction);
  assert.equal(after.tokenReservation, before.tokenReservation);
  assert.equal(after.aiBillingOperation, before.aiBillingOperation);
  assert.equal(after.payment, before.payment);
  assert.equal(after.tokenPackage, before.tokenPackage);
  assert.equal(after.aiUsageLog, before.aiUsageLog);
});
