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
import { Gender } from '@prisma/client';
import { ensureAdminRole } from './helpers/test-role-fixtures.js';
import { createPrismaProviderRateCardAdminRepository } from '../src/repositories/provider-rate-card-admin.repository.js';
import type { ProviderRateCardAdminRepository } from '../src/repositories/provider-rate-card-admin.repository.js';
import { createPrismaProviderRateCardRepository } from '../src/repositories/provider-rate-card.repository.js';
import {
  createDraftRateCard,
  importRateCardEntries,
  validateRateCardDraft,
  publishRateCard,
  retireRateCard,
  listRateCardSnapshots,
  getRateCardByVersion,
  importStaticRateCardAsDraft,
} from '../src/services/admin-rate-card.service.js';
import type { ProviderRateCardAdminDependencies } from '../src/services/admin-rate-card.service.js';
import {
  loadRateCardByVersion,
  loadActiveRateCardForDate,
  createDefaultProviderRateCardLoaderDependencies,
} from '../src/services/provider-rate-card-loader.service.js';
import type { ProviderRateCardLoaderDependencies } from '../src/services/provider-rate-card-loader.service.js';
import { ProviderRateCardAdminError } from '../src/types/provider-rate-card-admin.js';
import { ProviderRateCardLoadError } from '../src/types/provider-rate-card-load.js';
import { PROVIDER_RATE_CARD, RATE_CARD_PROVIDERS } from '../src/config/provider-rate-card/index.js';
import type { ProviderRateCard } from '../src/types/provider-pricing.js';

const VERSION_PREFIX = 'test-admin-';
const ACTOR = '22222222-2222-4222-8222-222222222222';

function version(): string {
  return `${VERSION_PREFIX}${crypto.randomUUID()}`;
}

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function cardEntries(): unknown[] {
  return [
    {
      provider: 'google',
      model: `gemini-${crypto.randomUUID().slice(0, 8)}`,
      status: 'STABLE',
      tier: 'standard',
      billingUnit: 'TOKEN',
      tokenRates: {
        inputMicrosPerMillion: 1_500_000,
        outputMicrosPerMillion: 7_500_000,
        cachedInputMicrosPerMillion: 150_000,
      },
      cachedInputAccounting: 'DISJOINT',
      effectiveFrom: '2026-08-03',
      inactive: false,
      source: 'https://example.test/pricing',
      verifiedAt: '2026-08-03',
    },
  ];
}

const AUDIT_ACTIONS = [
  'rate_card_draft_created',
  'rate_card_entries_imported',
  'rate_card_published',
  'rate_card_retired',
  'rate_card_static_imported',
];

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
  await prisma.auditLog.deleteMany({
    where: { actorId: ACTOR, action: { in: AUDIT_ACTIONS } },
  });
}

async function cleanupUser(): Promise<void> {
  await prisma.user.deleteMany({ where: { id: ACTOR } });
}

interface IsolationCounts {
  users: number;
  roles: number;
  payments: number;
  tokenTransactions: number;
  tokenReservations: number;
  aiBillingOperations: number;
  aiUsageLogs: number;
  tokenWallet: number;
  auditLog: number;
}

async function captureIsolationCounts(): Promise<IsolationCounts> {
  const [users, roles, payments, tokenTransactions, tokenReservations, aiBillingOperations, aiUsageLogs, tokenWallet, auditLog] =
    await Promise.all([
      prisma.user.count(),
      prisma.role.count(),
      prisma.payment.count(),
      prisma.tokenTransaction.count(),
      prisma.tokenReservation.count(),
      prisma.aIBillingOperation.count(),
      prisma.aiUsageLog.count(),
      prisma.tokenWallet.count(),
      prisma.auditLog.count(),
    ]);
  return { users, roles, payments, tokenTransactions, tokenReservations, aiBillingOperations, aiUsageLogs, tokenWallet, auditLog };
}

function asAdminError(err: unknown, code: string): ProviderRateCardAdminError {
  assert.ok(err instanceof ProviderRateCardAdminError, `expected ProviderRateCardAdminError, got ${String(err)}`);
  assert.equal(err.code, code, `expected code ${code}, got ${err.code}: ${err.message}`);
  return err;
}

function rejectsWith(code: string): (err: unknown) => boolean {
  return (err: unknown) => {
    asAdminError(err, code);
    return true;
  };
}

const adminRepository: ProviderRateCardAdminRepository = createPrismaProviderRateCardAdminRepository(prisma);
const adminDeps: ProviderRateCardAdminDependencies = { repository: adminRepository };
const readRepository = createPrismaProviderRateCardRepository(prisma);
const readDeps: ProviderRateCardLoaderDependencies = createDefaultProviderRateCardLoaderDependencies(readRepository);

async function createDraft(v: string, window?: { effectiveFrom?: string; effectiveTo?: string }): Promise<string> {
  await createDraftRateCard(
    adminDeps,
    {
      version: v,
      source: 'https://example.test/pricing',
      generatedAt: '2026-08-03',
      ...(window?.effectiveFrom ? { effectiveFrom: window.effectiveFrom } : {}),
      ...(window?.effectiveTo ? { effectiveTo: window.effectiveTo } : {}),
    },
    ACTOR,
  );
  return v;
}

async function createSeededDraft(v: string, window?: { effectiveFrom?: string; effectiveTo?: string }): Promise<string> {
  await createDraft(v, window);
  await importRateCardEntries(
    adminDeps,
    { version: v, source: 'https://example.test/pricing', generatedAt: '2026-08-03', entries: cardEntries() },
    ACTOR,
  );
  return v;
}

async function createPublished(v: string, window?: { effectiveFrom: string }): Promise<string> {
  await createSeededDraft(v, { effectiveFrom: window?.effectiveFrom ?? '2026-08-03' });
  await publishRateCard(
    adminDeps,
    { version: v, effectiveFrom: window?.effectiveFrom ?? '2026-08-03' },
    ACTOR,
  );
  return v;
}

async function auditCountFor(action: string, versionValue: string): Promise<number> {
  return prisma.auditLog.count({
    where: {
      actorId: ACTOR,
      action,
      metadata: { path: ['version'], equals: versionValue },
    },
  });
}

let baseline: IsolationCounts;

before(async () => {
  await cleanupRateCardData();
  await cleanupUser();
  await ensureAdminRole();
  baseline = await captureIsolationCounts();
  await prisma.user.upsert({
    where: { id: ACTOR },
    update: {},
    create: {
      id: ACTOR,
      email: 'test_admin_rate_card@example.com',
      passwordHash: 'hash',
      displayName: 'Admin Rate Card Test User',
      gender: Gender.MALE,
      nationality: 'Egyptian',
      roleId: (await ensureAdminRole()).id,
      isEmailVerified: true,
    },
  });
});

beforeEach(async () => {
  await cleanupRateCardData();
});

after(async () => {
  try {
    await cleanupRateCardData();
    await cleanupUser();
  } finally {
    const now = await captureIsolationCounts();
    assert.deepEqual(now, baseline, 'Admin rate-card tests must not leave any database modifications');
    await prisma.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// DRAFT lifecycle
// ---------------------------------------------------------------------------

test('1. createDraftRateCard persists a DRAFT row and writes audit evidence', async () => {
  const v = version();
  const meta = await createDraftRateCard(
    adminDeps,
    { version: v, source: 'https://example.test/pricing', generatedAt: '2026-08-03', effectiveFrom: '2026-08-03', effectiveTo: '2026-12-31' },
    ACTOR,
  );
  assert.equal(meta.status, 'DRAFT');
  assert.equal(meta.entryCount, 0);
  assert.equal(meta.effectiveFrom, '2026-08-03');
  assert.equal(meta.effectiveTo, '2026-12-31');
  const row = await prisma.providerRateCardSnapshot.findUnique({ where: { version: v } });
  assert.ok(row);
  assert.equal(row.status, 'DRAFT');
  assert.equal(await auditCountFor('rate_card_draft_created', v), 1);
});

test('2. duplicate version -> RATE_CARD_ADMIN_VERSION_TAKEN', async () => {
  const v = version();
  await createDraft(v);
  await assert.rejects(createDraft(v), rejectsWith('RATE_CARD_ADMIN_VERSION_TAKEN'));
});

test('3. importRateCardEntries replaces entries with exact bigint rows', async () => {
  const v = version();
  await createDraft(v);
  const meta = await importRateCardEntries(
    adminDeps,
    { version: v, source: 'https://example.test/pricing', generatedAt: '2026-08-03', entries: cardEntries() },
    ACTOR,
  );
  assert.equal(meta.entryCount, 1);
  const row = await prisma.providerRateCardEntry.findFirst({ where: { snapshot: { version: v } } });
  assert.ok(row);
  assert.equal(row.inputMicrosPerMillion, 1_500_000n);
  assert.equal(row.tier, 'STANDARD');
  assert.equal(await auditCountFor('rate_card_entries_imported', v), 1);
});

test('4. a second import atomically replaces the first batch', async () => {
  const v = version();
  await createDraft(v);
  const entries = cardEntries();
  const entries2 = cardEntries();
  await importRateCardEntries(adminDeps, { version: v, source: 's', generatedAt: '2026-08-03', entries }, ACTOR);
  const model = (entries2[0] as { model: string }).model;
  await importRateCardEntries(adminDeps, { version: v, source: 's', generatedAt: '2026-08-03', entries: entries2 }, ACTOR);
  const all = await prisma.providerRateCardEntry.findMany({ where: { snapshot: { version: v } } });
  assert.equal(all.length, 1);
  assert.equal(all[0].model, model);
});

test('5. import into an unknown version -> RATE_CARD_ADMIN_NOT_FOUND', async () => {
  await assert.rejects(
    importRateCardEntries(adminDeps, { version: version(), source: 's', generatedAt: '2026-08-03', entries: cardEntries() }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_NOT_FOUND'),
  );
});

test('6. import into a published snapshot -> RATE_CARD_ADMIN_IMMUTABLE', async () => {
  const v = version();
  await createPublished(v);
  await assert.rejects(
    importRateCardEntries(adminDeps, { version: v, source: 's', generatedAt: '2026-08-03', entries: cardEntries() }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_IMMUTABLE'),
  );
});

test('7. import into a retired snapshot -> RATE_CARD_ADMIN_IMMUTABLE', async () => {
  const v = version();
  await createPublished(v);
  await retireRateCard(adminDeps, { version: v }, ACTOR);
  await assert.rejects(
    importRateCardEntries(adminDeps, { version: v, source: 's', generatedAt: '2026-08-03', entries: cardEntries() }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_IMMUTABLE'),
  );
});

test('8. validateRateCardDraft reports a valid engine card', async () => {
  const v = version();
  await createSeededDraft(v);
  const result = await validateRateCardDraft(adminDeps, v);
  assert.equal(result.valid, true);
  assert.equal(result.entryCount, 1);
  assert.deepEqual(result.providers, ['google']);
});

test('9. validateRateCardDraft on an empty-entries draft -> RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE with mapperCode', async () => {
  const v = version();
  await createDraft(v);
  await assert.rejects(validateRateCardDraft(adminDeps, v), (err: unknown) => {
    const e = asAdminError(err, 'RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE');
    assert.equal(e.mapperCode, 'SNAPSHOT_EMPTY_ENTRIES');
    return true;
  });
});

test('10. publishRateCard transitions a DRAFT to ACTIVE with the body window', async () => {
  const v = version();
  await createSeededDraft(v);
  const meta = await publishRateCard(adminDeps, { version: v, effectiveFrom: '2026-08-03', effectiveTo: '2026-12-31' }, ACTOR);
  assert.equal(meta.status, 'ACTIVE');
  assert.equal(meta.effectiveFrom, '2026-08-03');
  assert.equal(meta.effectiveTo, '2026-12-31');
  assert.ok(meta.publishedAt);
  const row = await prisma.providerRateCardSnapshot.findUnique({ where: { version: v } });
  assert.ok(row);
  assert.equal(row.status, 'ACTIVE');
  assert.equal(await auditCountFor('rate_card_published', v), 1);
});

test('11. publishRateCard uses the draft window when the body omits one', async () => {
  const v = version();
  await createDraft(v, { effectiveFrom: '2026-09-01' });
  await importRateCardEntries(adminDeps, { version: v, source: 's', generatedAt: '2026-08-03', entries: cardEntries() }, ACTOR);
  const meta = await publishRateCard(adminDeps, { version: v }, ACTOR);
  assert.equal(meta.status, 'ACTIVE');
  assert.equal(meta.effectiveFrom, '2026-09-01');
});

test('12. publish unknown version -> RATE_CARD_ADMIN_NOT_FOUND', async () => {
  await assert.rejects(
    publishRateCard(adminDeps, { version: version(), effectiveFrom: '2026-08-03' }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_NOT_FOUND'),
  );
});

test('13. publish an already-ACTIVE snapshot -> RATE_CARD_ADMIN_DRAFT_REQUIRED', async () => {
  const v = version();
  await createPublished(v);
  await assert.rejects(
    publishRateCard(adminDeps, { version: v, effectiveFrom: '2027-01-01' }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_DRAFT_REQUIRED'),
  );
});

test('14. publish a RETIRED snapshot -> RATE_CARD_ADMIN_DRAFT_REQUIRED', async () => {
  const v = version();
  await createPublished(v);
  await retireRateCard(adminDeps, { version: v }, ACTOR);
  await assert.rejects(
    publishRateCard(adminDeps, { version: v, effectiveFrom: '2027-01-01' }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_DRAFT_REQUIRED'),
  );
});

test('15. publish overlapping an ACTIVE snapshot -> RATE_CARD_ADMIN_PUBLISH_CONFLICT', async () => {
  const vActive = version();
  await createPublished(vActive, { effectiveFrom: '2026-08-01' });
  const vNew = version();
  await createSeededDraft(vNew, { effectiveFrom: '2026-08-15' });
  await assert.rejects(
    publishRateCard(adminDeps, { version: vNew, effectiveFrom: '2026-08-15' }, ACTOR),
    (err: unknown) => {
      const e = asAdminError(err, 'RATE_CARD_ADMIN_PUBLISH_CONFLICT');
      assert.ok(e.conflictingVersions?.includes(vActive));
      assert.ok((e.snapshotCount ?? 0) >= 1);
      return true;
    },
  );
  const row = await prisma.providerRateCardSnapshot.findUnique({ where: { version: vNew } });
  assert.ok(row);
  assert.equal(row.status, 'DRAFT', 'a conflicted publish must leave the draft DRAFT');
});

test('16. publish without any effectiveFrom -> RATE_CARD_ADMIN_INVALID_WINDOW', async () => {
  const v = version();
  await createSeededDraft(v);
  await assert.rejects(
    publishRateCard(adminDeps, { version: v }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_INVALID_WINDOW'),
  );
});

test('17. publish with an inverted body window -> RATE_CARD_ADMIN_INVALID_WINDOW', async () => {
  const v = version();
  await createSeededDraft(v);
  await assert.rejects(
    publishRateCard(adminDeps, { version: v, effectiveFrom: '2026-12-31', effectiveTo: '2026-08-03' }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_INVALID_WINDOW'),
  );
});

test('18. CONCURRENCY: two overlapping concurrent publishes activate exactly one snapshot', async () => {
  const vA = version();
  const vB = version();
  await createSeededDraft(vA, { effectiveFrom: '2026-08-01' });
  await createSeededDraft(vB, { effectiveFrom: '2026-08-15' });

  const results = await Promise.allSettled([
    publishRateCard(adminDeps, { version: vA, effectiveFrom: '2026-08-01' }, ACTOR),
    publishRateCard(adminDeps, { version: vB, effectiveFrom: '2026-08-15' }, ACTOR),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, `exactly one publish must succeed, got ${fulfilled.length}`);
  assert.equal(rejected.length, 1, `exactly one publish must fail, got ${rejected.length}`);
  const reason = rejected[0] as PromiseRejectedResult;
  asAdminError(reason.reason, 'RATE_CARD_ADMIN_PUBLISH_CONFLICT');

  const activeRows = await prisma.providerRateCardSnapshot.findMany({
    where: { status: 'ACTIVE', version: { in: [vA, vB] } },
  });
  assert.equal(activeRows.length, 1, 'exactly one ACTIVE snapshot must exist after concurrent publishes');
  const draftRows = await prisma.providerRateCardSnapshot.findMany({
    where: { status: 'DRAFT', version: { in: [vA, vB] } },
  });
  assert.equal(draftRows.length, 1, 'the loser must remain DRAFT');
});

test('19. retireRateCard transitions ACTIVE to RETIRED', async () => {
  const v = version();
  await createPublished(v);
  const meta = await retireRateCard(adminDeps, { version: v }, ACTOR);
  assert.equal(meta.status, 'RETIRED');
  assert.ok(meta.retiredAt);
  const row = await prisma.providerRateCardSnapshot.findUnique({ where: { version: v } });
  assert.ok(row);
  assert.equal(row.status, 'RETIRED');
  assert.ok(row.retiredAt);
  assert.equal(await auditCountFor('rate_card_retired', v), 1);
});

test('20. retire a DRAFT -> RATE_CARD_ADMIN_ACTIVE_REQUIRED', async () => {
  const v = version();
  await createSeededDraft(v);
  await assert.rejects(retireRateCard(adminDeps, { version: v }, ACTOR), rejectsWith('RATE_CARD_ADMIN_ACTIVE_REQUIRED'));
});

test('21. retire a RETIRED snapshot with a conflicting retiredAt -> RATE_CARD_ADMIN_ACTIVE_REQUIRED', async () => {
  const v = version();
  await createPublished(v);
  await retireRateCard(adminDeps, { version: v }, ACTOR);
  await assert.rejects(
    retireRateCard(adminDeps, { version: v, retiredAt: '2099-01-01T00:00:00Z' }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_ACTIVE_REQUIRED'),
  );
});

test('22. retire unknown version -> RATE_CARD_ADMIN_NOT_FOUND', async () => {
  await assert.rejects(retireRateCard(adminDeps, { version: version() }, ACTOR), rejectsWith('RATE_CARD_ADMIN_NOT_FOUND'));
});

test('23. retire with retiredAt before publishedAt -> RATE_CARD_ADMIN_INVALID_WINDOW', async () => {
  const v = version();
  await createPublished(v);
  await assert.rejects(
    retireRateCard(adminDeps, { version: v, retiredAt: '2020-01-01T00:00:00Z' }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_INVALID_WINDOW'),
  );
});

test('24. published and retired snapshots are immutable (no import, no publish, no retire reversal)', async () => {
  const v = version();
  await createPublished(v);
  await assert.rejects(
    importRateCardEntries(adminDeps, { version: v, source: 's', generatedAt: '2026-08-03', entries: cardEntries() }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_IMMUTABLE'),
  );
  await assert.rejects(
    publishRateCard(adminDeps, { version: v, effectiveFrom: '2027-01-01' }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_DRAFT_REQUIRED'),
  );
  await retireRateCard(adminDeps, { version: v }, ACTOR);
  await assert.rejects(
    importRateCardEntries(adminDeps, { version: v, source: 's', generatedAt: '2026-08-03', entries: cardEntries() }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_IMMUTABLE'),
  );
  const replay = await retireRateCard(adminDeps, { version: v }, ACTOR);
  assert.equal(replay.idempotentReplay, true, 'a second retire is an idempotent replay, not an error');
  await assert.rejects(
    publishRateCard(adminDeps, { version: v, effectiveFrom: '2027-01-01' }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_DRAFT_REQUIRED'),
  );
});

test('25. listRateCardSnapshots paginates and filters by status', async () => {
  const v1 = version();
  const v2 = version();
  const v3 = version();
  await createPublished(v1);
  await createSeededDraft(v2);
  await createDraft(v3);
  await retireRateCard(adminDeps, { version: v1 }, ACTOR);

  const drafts = await listRateCardSnapshots(adminDeps, { page: 1, limit: 10, status: 'DRAFT' });
  assert.ok(drafts.items.some((i) => i.version === v2));
  assert.ok(drafts.items.some((i) => i.version === v3));
  assert.ok(drafts.items.every((i) => i.status === 'DRAFT'));

  const actives = await listRateCardSnapshots(adminDeps, { page: 1, limit: 10, status: 'ACTIVE' });
  assert.equal(actives.items.length, 0);

  const retired = await listRateCardSnapshots(adminDeps, { page: 1, limit: 10, status: 'RETIRED' });
  assert.ok(retired.items.some((i) => i.version === v1));

  const all = await listRateCardSnapshots(adminDeps, { page: 1, limit: 1 });
  assert.equal(all.items.length, 1);
  assert.ok(all.pagination.total >= 3);
  assert.ok(all.pagination.totalPages >= 3);
});

test('26. getRateCardByVersion returns mapped engine entries + providers', async () => {
  const v = version();
  await createSeededDraft(v);
  const detail = await getRateCardByVersion(adminDeps, v);
  assert.equal(detail.entries.length, 1);
  assert.deepEqual(detail.providers, ['google']);
  assert.equal(detail.mappingError, null);
  assert.equal(detail.entryCount, 1);
});

// ---------------------------------------------------------------------------
// Publish idempotent replay + explicit ACTIVE replacement
// ---------------------------------------------------------------------------

test('27. publish replay: republishing an ACTIVE snapshot with the matching window is a coherent no-op', async () => {
  const v = version();
  await createPublished(v);
  const before = await prisma.providerRateCardSnapshot.findUnique({ where: { version: v } });
  const meta = await publishRateCard(adminDeps, { version: v, effectiveFrom: '2026-08-03' }, ACTOR);
  assert.equal(meta.status, 'ACTIVE');
  assert.equal(meta.idempotentReplay, true);
  const after = await prisma.providerRateCardSnapshot.findUnique({ where: { version: v } });
  assert.ok(before && after);
  assert.equal(before.publishedAt!.toISOString(), after.publishedAt!.toISOString());
  assert.equal(before.updatedAt.toISOString(), after.updatedAt.toISOString(), 'replay must not touch the row');
  assert.equal(await auditCountFor('rate_card_published', v), 1, 'replay must not add audit evidence');
});

test('28. publish replay: an ACTIVE snapshot with a conflicting window is still rejected', async () => {
  const v = version();
  await createPublished(v);
  await assert.rejects(
    publishRateCard(adminDeps, { version: v, effectiveFrom: '2027-01-01' }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_DRAFT_REQUIRED'),
  );
});

test('29. replacement: publish with replaceActiveVersion atomically retires the old ACTIVE and activates the draft', async () => {
  const oldV = version();
  await createPublished(oldV, { effectiveFrom: '2026-08-01' });
  const newV = version();
  await createSeededDraft(newV);

  const meta = await publishRateCard(
    adminDeps,
    { version: newV, effectiveFrom: '2026-09-01', replaceActiveVersion: oldV },
    ACTOR,
  );
  assert.equal(meta.status, 'ACTIVE');
  assert.equal(meta.effectiveFrom, '2026-09-01');
  assert.equal(meta.idempotentReplay, false);

  const oldRow = await prisma.providerRateCardSnapshot.findUnique({ where: { version: oldV } });
  assert.ok(oldRow);
  assert.equal(oldRow.status, 'RETIRED');
  assert.ok(oldRow.retiredAt);
  assert.equal(oldRow.effectiveFrom.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(
    oldRow.effectiveTo!.toISOString().slice(0, 10),
    '2026-08-31',
    'the replaced open-ended window must close the day before the new effectiveFrom',
  );

  const newRow = await prisma.providerRateCardSnapshot.findUnique({ where: { version: newV } });
  assert.ok(newRow);
  assert.equal(newRow.status, 'ACTIVE');
  assert.equal(await auditCountFor('rate_card_published', newV), 1);
  assert.equal(await auditCountFor('rate_card_retired', oldV), 1);

  // The read path serves ACTIVE snapshots only: the replaced card is RETIRED (its
  // window intentionally ended the day before the new effectiveFrom), so no active
  // card applies before the replacement; the new card serves from its effectiveFrom.
  await assert.rejects(loadActiveRateCardForDate(readDeps, '2026-08-15'), (err: unknown) => {
    assert.ok(err instanceof ProviderRateCardLoadError, `expected a load error, got ${String(err)}`);
    assert.equal(err.code, 'RATE_CARD_NOT_FOUND');
    return true;
  });
  const newCard = await loadActiveRateCardForDate(readDeps, '2026-09-01');
  assert.equal(newCard.snapshot.version, newV);
});

test('30. replacement with a non-forward window -> RATE_CARD_ADMIN_REPLACEMENT_VERSION_MISMATCH', async () => {
  const oldV = version();
  await createPublished(oldV, { effectiveFrom: '2026-08-01' });
  const newV = version();
  await createSeededDraft(newV);
  await assert.rejects(
    publishRateCard(
      adminDeps,
      { version: newV, effectiveFrom: '2026-07-15', effectiveTo: '2026-08-15', replaceActiveVersion: oldV },
      ACTOR,
    ),
    (err: unknown) => {
      const e = asAdminError(err, 'RATE_CARD_ADMIN_REPLACEMENT_VERSION_MISMATCH');
      assert.ok(e.conflictingVersions?.includes(oldV));
      return true;
    },
  );
  const oldRow = await prisma.providerRateCardSnapshot.findUnique({ where: { version: oldV } });
  assert.equal(oldRow!.status, 'ACTIVE', 'a mismatched replacement must not touch the ACTIVE snapshot');
  const newRow = await prisma.providerRateCardSnapshot.findUnique({ where: { version: newV } });
  assert.equal(newRow!.status, 'DRAFT', 'a mismatched replacement must leave the draft DRAFT');
});

test('31. replacement with a version that is not the current ACTIVE overlap -> RATE_CARD_ADMIN_REPLACEMENT_VERSION_MISMATCH', async () => {
  const oldV = version();
  await createPublished(oldV, { effectiveFrom: '2026-08-01' });
  const newV = version();
  await createSeededDraft(newV);
  await assert.rejects(
    publishRateCard(
      adminDeps,
      { version: newV, effectiveFrom: '2026-09-01', replaceActiveVersion: 'nonexistent-active' },
      ACTOR,
    ),
    rejectsWith('RATE_CARD_ADMIN_REPLACEMENT_VERSION_MISMATCH'),
  );
  const oldRow = await prisma.providerRateCardSnapshot.findUnique({ where: { version: oldV } });
  assert.equal(oldRow!.status, 'ACTIVE');
});

test('32. CONCURRENCY: two concurrent replacements of the same ACTIVE snapshot activate exactly one new card', async () => {
  const oldV = version();
  await createPublished(oldV, { effectiveFrom: '2026-08-01' });
  const newA = version();
  const newB = version();
  await createSeededDraft(newA);
  await createSeededDraft(newB);

  const results = await Promise.allSettled([
    publishRateCard(adminDeps, { version: newA, effectiveFrom: '2026-09-01', replaceActiveVersion: oldV }, ACTOR),
    publishRateCard(adminDeps, { version: newB, effectiveFrom: '2026-09-15', replaceActiveVersion: oldV }, ACTOR),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one replacement must succeed');
  assert.equal(rejected.length, 1, 'exactly one replacement must fail');
  const reason = rejected[0] as PromiseRejectedResult;
  assert.ok(reason.reason instanceof ProviderRateCardAdminError, 'the loser must fail with a stable Admin error');

  const actives = await prisma.providerRateCardSnapshot.findMany({
    where: { status: 'ACTIVE', version: { in: [newA, newB] } },
  });
  assert.equal(actives.length, 1, 'exactly one new snapshot must be ACTIVE after concurrent replacements');
  const oldRow = await prisma.providerRateCardSnapshot.findUnique({ where: { version: oldV } });
  assert.equal(oldRow!.status, 'RETIRED', 'the replaced ACTIVE snapshot must be retired exactly once');
});

// ---------------------------------------------------------------------------
// Retire replay + effectiveTo window-close policy
// ---------------------------------------------------------------------------

test('33. retire replay: retiring an already-RETIRED snapshot is a coherent no-op (timestamps/entries unchanged)', async () => {
  const v = version();
  await createPublished(v);
  await retireRateCard(adminDeps, { version: v }, ACTOR);
  const before = await prisma.providerRateCardSnapshot.findUnique({ where: { version: v } });
  const beforeEntries = await prisma.providerRateCardEntry.findMany({
    where: { snapshot: { version: v } },
    orderBy: { id: 'asc' },
  });
  const meta = await retireRateCard(adminDeps, { version: v }, ACTOR);
  assert.equal(meta.status, 'RETIRED');
  assert.equal(meta.idempotentReplay, true);
  const after = await prisma.providerRateCardSnapshot.findUnique({ where: { version: v } });
  const afterEntries = await prisma.providerRateCardEntry.findMany({
    where: { snapshot: { version: v } },
    orderBy: { id: 'asc' },
  });
  assert.ok(before && after);
  assert.equal(before.publishedAt!.toISOString(), after.publishedAt!.toISOString());
  assert.equal(before.retiredAt!.toISOString(), after.retiredAt!.toISOString());
  assert.equal(before.createdAt.toISOString(), after.createdAt.toISOString());
  assert.equal(before.updatedAt.toISOString(), after.updatedAt.toISOString(), 'replay must not touch the row');
  assert.deepEqual(beforeEntries, afterEntries);
  assert.equal(await auditCountFor('rate_card_retired', v), 1, 'replay must not add audit evidence');
});

test('34. retire with effectiveTo closes the business window atomically', async () => {
  const v = version();
  await createPublished(v);
  const meta = await retireRateCard(adminDeps, { version: v, effectiveTo: '2026-10-15' }, ACTOR);
  assert.equal(meta.status, 'RETIRED');
  assert.equal(meta.effectiveTo, '2026-10-15');
  const row = await prisma.providerRateCardSnapshot.findUnique({ where: { version: v } });
  assert.equal(row!.effectiveTo!.toISOString().slice(0, 10), '2026-10-15');
  assert.ok(row!.retiredAt);
});

test('35. retire with effectiveTo widening a closed persisted window -> RATE_CARD_ADMIN_INVALID_WINDOW', async () => {
  const v = version();
  await createDraft(v, { effectiveFrom: '2026-08-03', effectiveTo: '2026-12-31' });
  await importRateCardEntries(
    adminDeps,
    { version: v, source: 's', generatedAt: '2026-08-03', entries: cardEntries() },
    ACTOR,
  );
  await publishRateCard(adminDeps, { version: v, effectiveFrom: '2026-08-03', effectiveTo: '2026-12-31' }, ACTOR);
  await assert.rejects(
    retireRateCard(adminDeps, { version: v, effectiveTo: '2027-06-30' }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_INVALID_WINDOW'),
  );
  const row = await prisma.providerRateCardSnapshot.findUnique({ where: { version: v } });
  assert.equal(row!.status, 'ACTIVE', 'a rejected retire must leave the snapshot ACTIVE');
});

// ---------------------------------------------------------------------------
// Static PROVIDER_RATE_CARD import as DRAFT-only + parity
// ---------------------------------------------------------------------------

test('36. static import creates a DRAFT with the full static entry set and never activates it', async () => {
  const v = `${VERSION_PREFIX}static-${crypto.randomUUID().slice(0, 8)}`;
  const meta = await importStaticRateCardAsDraft(adminDeps, { version: v }, ACTOR);
  assert.equal(meta.version, v);
  assert.equal(meta.status, 'DRAFT');
  assert.equal(meta.entryCount, PROVIDER_RATE_CARD.entries.length);
  assert.equal(meta.idempotentReplay, false);
  const row = await prisma.providerRateCardSnapshot.findUnique({ where: { version: v } });
  assert.ok(row);
  assert.equal(row.status, 'DRAFT');
  assert.equal(await auditCountFor('rate_card_static_imported', v), 1);
  const published = await prisma.providerRateCardSnapshot.findMany({
    where: { status: 'ACTIVE', version: { startsWith: VERSION_PREFIX } },
  });
  assert.equal(published.length, 0, 'no static import may ever activate');
});

test('37. static import is idempotent: a second identical import replays without a write', async () => {
  const v = `${VERSION_PREFIX}static-${crypto.randomUUID().slice(0, 8)}`;
  const first = await importStaticRateCardAsDraft(adminDeps, { version: v }, ACTOR);
  assert.equal(first.idempotentReplay, false);

  const before = await prisma.providerRateCardSnapshot.findUnique({ where: { version: v } });
  const second = await importStaticRateCardAsDraft(adminDeps, { version: v }, ACTOR);
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.entryCount, PROVIDER_RATE_CARD.entries.length);
  const after = await prisma.providerRateCardSnapshot.findUnique({ where: { version: v } });
  assert.ok(before && after);
  assert.equal(before.updatedAt.toISOString(), after.updatedAt.toISOString(), 'a replay must not touch the row');
  assert.equal(await auditCountFor('rate_card_static_imported', v), 1, 'a replay must not add audit evidence');
  const entries = await prisma.providerRateCardEntry.count({ where: { snapshot: { version: v } } });
  assert.equal(entries, PROVIDER_RATE_CARD.entries.length);
});

test('38. static import under the exact PROVIDER_RATE_CARD.version is a DRAFT and never activates', async () => {
  const meta = await importStaticRateCardAsDraft(adminDeps, {}, ACTOR);
  assert.equal(meta.version, PROVIDER_RATE_CARD.version);
  assert.equal(meta.status, 'DRAFT');
  assert.equal(meta.entryCount, PROVIDER_RATE_CARD.entries.length);
  try {
    const row = await prisma.providerRateCardSnapshot.findUnique({ where: { version: PROVIDER_RATE_CARD.version } });
    assert.ok(row);
    assert.equal(row.status, 'DRAFT');
    const active = await prisma.providerRateCardSnapshot.count({
      where: { status: 'ACTIVE', version: PROVIDER_RATE_CARD.version },
    });
    assert.equal(active, 0, 'the exact-version static import must never activate');
  } finally {
    const rows = await prisma.providerRateCardSnapshot.findMany({
      where: { version: PROVIDER_RATE_CARD.version },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await prisma.providerRateCardEntry.deleteMany({ where: { snapshotId: { in: ids } } });
      await prisma.providerRateCardSnapshot.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.auditLog.deleteMany({
      where: { actorId: ACTOR, action: { in: AUDIT_ACTIONS } },
    });
  }
});

test('39. static import conflicts with a different-content DRAFT -> RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT (never overwrites)', async () => {
  const v = `${VERSION_PREFIX}static-${crypto.randomUUID().slice(0, 8)}`;
  await createDraft(v);
  await importRateCardEntries(
    adminDeps,
    { version: v, source: 's', generatedAt: '2026-08-03', entries: cardEntries() },
    ACTOR,
  );
  await assert.rejects(
    importStaticRateCardAsDraft(adminDeps, { version: v }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT'),
  );
  const rows = await prisma.providerRateCardEntry.count({ where: { snapshot: { version: v } } });
  assert.equal(rows, 1, 'a conflicting static import must never replace the draft entries');
});

test('40. static import conflicts with an ACTIVE snapshot -> RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT (never touches published)', async () => {
  const v = version();
  await createPublished(v);
  await assert.rejects(
    importStaticRateCardAsDraft(adminDeps, { version: v }, ACTOR),
    rejectsWith('RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT'),
  );
  const row = await prisma.providerRateCardSnapshot.findUnique({ where: { version: v } });
  assert.equal(row!.status, 'ACTIVE', 'a conflicting static import must never modify the ACTIVE snapshot');
});

test('41. static-vs-DB PARITY: the imported DRAFT maps back to the exact static card via the read path', async () => {
  const v = `${VERSION_PREFIX}parity-${crypto.randomUUID().slice(0, 8)}`;
  await importStaticRateCardAsDraft(adminDeps, { version: v }, ACTOR);

  const loaded = await loadRateCardByVersion(readDeps, v);
  assert.equal(loaded.snapshot.status, 'DRAFT');

  const sortKey = (e: { provider: string; model: string; tier?: string }) =>
    `${e.provider}\u0000${e.model.toLowerCase()}\u0000${e.tier ?? 'standard'}`;
  const loadedEntries = [...loaded.card.entries].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  const staticEntries = [...PROVIDER_RATE_CARD.entries].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  assert.deepStrictEqual(loadedEntries, staticEntries, 'imported DRAFT entries must map back to the exact static card entries');
  const expectedCard: ProviderRateCard = { ...PROVIDER_RATE_CARD, version: v, entries: staticEntries };
  assert.deepStrictEqual({ ...loaded.card, entries: loadedEntries }, expectedCard);
  assert.deepEqual(loaded.providers, [...RATE_CARD_PROVIDERS]);
});

test('42. static parity: every DB row keeps exact bigint money, UTC dates, and DB tier spellings', async () => {
  const v = `${VERSION_PREFIX}parity-${crypto.randomUUID().slice(0, 8)}`;
  await importStaticRateCardAsDraft(adminDeps, { version: v }, ACTOR);
  const rows = await prisma.providerRateCardEntry.findMany({ where: { snapshot: { version: v } } });
  assert.equal(rows.length, PROVIDER_RATE_CARD.entries.length);
  for (const row of rows) {
    assert.equal(typeof row.inputMicrosPerMillion, 'bigint');
    assert.equal(row.effectiveFrom.getUTCHours(), 0);
    assert.ok(['STANDARD', 'BATCH', 'PRIORITY', 'FAST_MODE'].includes(row.tier ?? ''));
  }
});
