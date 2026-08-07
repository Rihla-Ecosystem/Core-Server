/**
 * Phase 2F-D real PostgreSQL integration tests for DB shadow comparison.
 *
 * Self-contained: every fixture is created by this suite with a unique
 * `shadow-db-it-<label>-<uuid>` version, and cleanup deletes ONLY rows this
 * suite created (matched by that version prefix). The suite never reads,
 * publishes, retires, modifies, or deletes unrelated snapshots, and it never
 * depends on the static import script or a pre-existing `1.0.0` DRAFT.
 *
 * Snapshot IDs are real UUIDs (explicitly generated); `ProviderRateCardEntry`
 * uses flat DB columns with exact BIGINT rates; `tier` uses the DB enum
 * spellings `STANDARD` / `BATCH` / `PRIORITY` / `FAST_MODE`.
 *
 * Hard-gated to the test database `core_server_test`.
 *
 * Run with:
 *   DATABASE_URL=postgresql://core_user:core_pass@localhost:5434/core_server_test \
 *   node --env-file=.env.test --import tsx --test tests/ai-shadow-pricing-db-rate-card-db.test.ts
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPrismaProviderRateCardRepository } from '../src/repositories/provider-rate-card.repository.js';
import {
  createDefaultProviderRateCardLoaderDependencies,
  loadActiveRateCardForDate,
  loadRateCardByVersion,
} from '../src/services/provider-rate-card-loader.service.js';
import { AiShadowPricingService } from '../src/services/ai-shadow-pricing.service.js';
import type { ShadowPricingDependencies } from '../src/services/shadow-pricing-deps.js';
import type { ProviderRateCard } from '../src/types/provider-pricing.js';
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
const VERSION_PREFIX = 'shadow-db-it-';

/** Pricing date used by the parity fixtures (after the static entry window). */
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

/** Exact BIGINT transcription of the static standard-tier token rates. */
const PARITY_RATES = {
  inputMicrosPerMillion: BigInt(STATIC_ENTRY.tokenRates.inputMicrosPerMillion!),
  outputMicrosPerMillion: BigInt(STATIC_ENTRY.tokenRates.outputMicrosPerMillion!),
  cachedInputMicrosPerMillion: BigInt(STATIC_ENTRY.tokenRates.cachedInputMicrosPerMillion!),
};

function uniqueVersion(label: string): string {
  return `${VERSION_PREFIX}${label}-${crypto.randomUUID()}`;
}

/** Static-parity DB entry using flat columns and DB enum spellings. */
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

interface SnapshotFixture {
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  version: string;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  publishedAt?: Date | null;
  retiredAt?: Date | null;
  entries?: Record<string, unknown>[];
}

async function createSnapshot(input: SnapshotFixture) {
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

/** Create an ACTIVE snapshot covering the default pricing date by default. */
async function createActive(
  version: string,
  entryOverrides: Record<string, unknown> = {},
  snapshotOverrides: Partial<SnapshotFixture> = {},
) {
  await createSnapshot({
    status: 'ACTIVE',
    version,
    effectiveFrom: new Date('2026-08-01'),
    effectiveTo: null,
    publishedAt: new Date('2026-08-01'),
    entries: [parityEntry(entryOverrides)],
    ...snapshotOverrides,
  });
}

/** Delete ONLY snapshots (and their entries) owned by this suite's prefix. */
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

/** Every test starts from a clean owned-fixture slate. */
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

/** Build a service card whose version matches a unique DB fixture version. */
function cardWithVersion(version: string): ProviderRateCard {
  return { ...PROVIDER_RATE_CARD, version };
}

type ComparisonPayload = Parameters<NonNullable<ShadowPricingDependencies['onComparison']>>[0];

/**
 * Run the real shadow pipeline (real repository → loader → mapper → engine →
 * comparator) and return the captured comparison payload plus the number of
 * times the DB ACTIVE loader was invoked.
 */
async function runRecordAndCapture(
  calls: unknown[] = [VALID_CALL],
  opts: { pricingDate?: string; card?: ProviderRateCard } = {},
): Promise<{ payload: ComparisonPayload; loadCount: number }> {
  let captured: ComparisonPayload | null = null;
  let loadCount = 0;
  const deps: ShadowPricingDependencies = {
    dbShadowEnabled: true,
    loadActiveRateCardForDate: async (d) => {
      loadCount++;
      return loadActiveRateCardForDate(loaderDeps, d);
    },
    onComparison: (r) => {
      captured = r;
    },
  };
  const svc = new AiShadowPricingService({ shadowDeps: deps, card: opts.card });
  const outcome = await svc.record(calls, {
    source: 'chat',
    pricingDate: opts.pricingDate ?? DEFAULT_PRICING_DATE,
  });
  assert.equal(outcome.kind, 'priced');
  assert.ok(captured, 'onComparison must fire whenever DB shadow is enabled');
  return { payload: captured, loadCount };
}

// ---------------------------------------------------------------------------
// Safety gate
// ---------------------------------------------------------------------------

test('hard gate: DATABASE_URL points at /core_server_test', () => {
  assert.ok(DB_URL);
  assert.equal(new URL(DB_URL).pathname, '/core_server_test');
});

// ---------------------------------------------------------------------------
// Active-date parity and rate changes
// ---------------------------------------------------------------------------

test('exact-parity ACTIVE snapshot → MATCH', async () => {
  const version = uniqueVersion('match');
  await createActive(version);
  const { payload, loadCount } = await runRecordAndCapture([VALID_CALL], {
    pricingDate: DEFAULT_PRICING_DATE,
    card: cardWithVersion(version),
  });
  assert.equal(payload.comparisonStatus, 'MATCH');
  assert.deepEqual(payload.mismatchCategories, []);
  assert.equal(loadCount, 1);
});

test('changed ACTIVE rate → MISMATCH (INPUT_COST)', async () => {
  const version = uniqueVersion('mismatch');
  await createActive(version, { inputMicrosPerMillion: 2_000_000n });
  const { payload } = await runRecordAndCapture([VALID_CALL], {
    pricingDate: DEFAULT_PRICING_DATE,
    card: cardWithVersion(version),
  });
  assert.equal(payload.comparisonStatus, 'MISMATCH');
  assert.ok(payload.mismatchCategories.includes('INPUT_COST'), JSON.stringify(payload.mismatchCategories));
});

// ---------------------------------------------------------------------------
// Active-date selection semantics
// ---------------------------------------------------------------------------

test('DRAFT snapshot ignored by active-date lookup → NOT_FOUND', async () => {
  const version = uniqueVersion('draft');
  await createSnapshot({ status: 'DRAFT', version, entries: [parityEntry()] });
  const { payload } = await runRecordAndCapture([VALID_CALL], { pricingDate: DEFAULT_PRICING_DATE });
  assert.equal(payload.comparisonStatus, 'DB_RATE_CARD_NOT_FOUND');
  assert.equal(payload.loaderErrorCode, 'RATE_CARD_NOT_FOUND');
});

test('RETIRED snapshot ignored by active-date lookup → NOT_FOUND', async () => {
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
  const { payload } = await runRecordAndCapture([VALID_CALL], { pricingDate: DEFAULT_PRICING_DATE });
  assert.equal(payload.comparisonStatus, 'DB_RATE_CARD_NOT_FOUND');
  assert.equal(payload.loaderErrorCode, 'RATE_CARD_NOT_FOUND');
});

test('effectiveFrom inclusive boundary → MATCH', async () => {
  const version = uniqueVersion('from');
  const boundary = '2026-08-10';
  await createActive(version, {}, {
    effectiveFrom: new Date(`${boundary}T00:00:00Z`),
    publishedAt: new Date(`${boundary}T00:00:00Z`),
  });
  const { payload } = await runRecordAndCapture([VALID_CALL], {
    pricingDate: boundary,
    card: cardWithVersion(version),
  });
  assert.equal(payload.comparisonStatus, 'MATCH');
});

test('effectiveTo inclusive boundary → MATCH', async () => {
  const version = uniqueVersion('to');
  await createActive(version, {}, {
    effectiveFrom: new Date('2026-08-01T00:00:00Z'),
    effectiveTo: new Date('2026-08-10T00:00:00Z'),
  });
  const { payload } = await runRecordAndCapture([VALID_CALL], {
    pricingDate: '2026-08-10',
    card: cardWithVersion(version),
  });
  assert.equal(payload.comparisonStatus, 'MATCH');
});

test('open-ended effectiveTo (null) → MATCH', async () => {
  const version = uniqueVersion('open');
  await createActive(version);
  const { payload } = await runRecordAndCapture([VALID_CALL], {
    pricingDate: '2026-09-01',
    card: cardWithVersion(version),
  });
  assert.equal(payload.comparisonStatus, 'MATCH');
});

test('no ACTIVE snapshot → DB_RATE_CARD_NOT_FOUND, static result returned', async () => {
  const { payload } = await runRecordAndCapture([VALID_CALL], { pricingDate: DEFAULT_PRICING_DATE });
  assert.equal(payload.comparisonStatus, 'DB_RATE_CARD_NOT_FOUND');
  assert.equal(payload.loaderErrorCode, 'RATE_CARD_NOT_FOUND');
});

test('overlapping ACTIVE snapshots → DB_RATE_CARD_ACTIVE_CONFLICT', async () => {
  await createActive(uniqueVersion('conflict-a'));
  await createActive(uniqueVersion('conflict-b'));
  const { payload } = await runRecordAndCapture([VALID_CALL], { pricingDate: DEFAULT_PRICING_DATE });
  assert.equal(payload.comparisonStatus, 'DB_RATE_CARD_ACTIVE_CONFLICT');
  assert.equal(payload.loaderErrorCode, 'RATE_CARD_ACTIVE_CONFLICT');
});

// ---------------------------------------------------------------------------
// Exact version lookup (DRAFT / RETIRED)
// ---------------------------------------------------------------------------

test('exact DRAFT version lookup works', async () => {
  const version = uniqueVersion('exact-draft');
  await createSnapshot({ status: 'DRAFT', version, entries: [parityEntry()] });
  const result = await loadRateCardByVersion(loaderDeps, version);
  assert.equal(result.snapshot.version, version);
  assert.equal(result.snapshot.status, 'DRAFT');
  assert.ok(result.card.entries.length > 0);
});

test('exact RETIRED version lookup works', async () => {
  const version = uniqueVersion('exact-retired');
  await createSnapshot({
    status: 'RETIRED',
    version,
    effectiveFrom: new Date('2026-07-01'),
    effectiveTo: new Date('2026-07-31'),
    publishedAt: new Date('2026-07-01'),
    retiredAt: new Date('2026-08-01'),
    entries: [parityEntry({ effectiveFrom: new Date('2026-07-01'), verifiedAt: new Date('2026-07-01') })],
  });
  const result = await loadRateCardByVersion(loaderDeps, version);
  assert.equal(result.snapshot.version, version);
  assert.equal(result.snapshot.status, 'RETIRED');
  assert.ok(result.card.entries.length > 0);
});

// ---------------------------------------------------------------------------
// BigInt exactness
// ---------------------------------------------------------------------------

test('bigint exactness — DB stores huge value exactly; engine boundary rejects it', async () => {
  const version = uniqueVersion('bigint');
  const huge = 9_000_000_000_000_000_000n;
  await createActive(version, { inputMicrosPerMillion: huge });

  const selection = await repo.findActiveSnapshotForDate(DEFAULT_PRICING_DATE);
  assert.equal(selection.kind, 'found');
  if (selection.kind === 'found') {
    assert.equal(selection.snapshot.entries[0].inputMicrosPerMillion, huge);
  }

  const { payload } = await runRecordAndCapture([VALID_CALL], {
    pricingDate: DEFAULT_PRICING_DATE,
    card: cardWithVersion(version),
  });
  assert.equal(payload.comparisonStatus, 'DB_RATE_CARD_INVALID');
  assert.equal(payload.loaderErrorCode, 'RATE_CARD_SNAPSHOT_INVALID');
});

// ---------------------------------------------------------------------------
// Reuse and read-only guarantees
// ---------------------------------------------------------------------------

test('same snapshot reused for multiple provider calls', async () => {
  const version = uniqueVersion('reuse');
  await createActive(version);
  const calls = [
    { ...VALID_CALL, providerCallId: 'call-1' },
    { ...VALID_CALL, providerCallId: 'call-2' },
  ];
  const { payload, loadCount } = await runRecordAndCapture(calls, {
    pricingDate: DEFAULT_PRICING_DATE,
    card: cardWithVersion(version),
  });
  assert.equal(payload.comparisonStatus, 'MATCH');
  assert.equal(loadCount, 1, 'one DB snapshot must serve all provider calls in the operation');
  assert.equal(payload.providerCallCount, 2);
});

test('read-only — no snapshot lifecycle or entry mutation', async () => {
  const version = uniqueVersion('no-mutation');
  await createActive(version);
  const before = await prisma.providerRateCardSnapshot.findUniqueOrThrow({ where: { version } });
  const beforeEntry = await prisma.providerRateCardEntry.findFirstOrThrow({
    where: { snapshotId: before.id },
  });

  const { payload } = await runRecordAndCapture([VALID_CALL], {
    pricingDate: DEFAULT_PRICING_DATE,
    card: cardWithVersion(version),
  });
  assert.equal(payload.comparisonStatus, 'MATCH');

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
  const before = await captureBaseline();
  const { payload } = await runRecordAndCapture([VALID_CALL], { pricingDate: DEFAULT_PRICING_DATE });
  assert.ok(payload.comparisonStatus);
  const after = await captureBaseline();
  assert.equal(after.tokenWallet, before.tokenWallet);
  assert.equal(after.tokenTransaction, before.tokenTransaction);
  assert.equal(after.tokenReservation, before.tokenReservation);
  assert.equal(after.aiBillingOperation, before.aiBillingOperation);
  assert.equal(after.payment, before.payment);
  assert.equal(after.tokenPackage, before.tokenPackage);
  assert.equal(after.aiUsageLog, before.aiUsageLog);
});
