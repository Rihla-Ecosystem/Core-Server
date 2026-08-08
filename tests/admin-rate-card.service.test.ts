/**
 * Phase 2F-C Admin service orchestration tests (pure, no database).
 *
 * Drives the Admin service against an in-memory fake repository to prove the
 * orchestration contract without Prisma: validation gating, mapper-required
 * publishability, window coercion, static-card DRAFT-only import, stable
 * Admin error mapping, and fresh plain-object metadata output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ProviderRateCardSnapshotRow,
  ProviderRateCardEntryRow,
} from '../src/types/provider-pricing-snapshot.js';
import type {
  ProviderRateCardAdminRepository,
  AdminDraftCreateInput,
  AdminImportInput,
  AdminImportOutcome,
  AdminPublishInput,
  AdminPublishOutcome,
  AdminRetireInput,
  AdminRetireOutcome,
  AdminCloneInput,
  AdminCloneOutcome,
  AdminListQuery,
  AdminListResult,
  AdminSnapshotListItem,
} from '../src/repositories/provider-rate-card-admin.repository.js';
import type { ImportedEntryRow } from '../src/utils/provider-pricing/entry-import.js';
import {
  createDraftRateCard,
  importRateCardEntries,
  validateRateCardDraft,
  publishRateCard,
  retireRateCard,
  cloneRateCard,
  listRateCardSnapshots,
  getRateCardByVersion,
  importStaticRateCardAsDraft,
  PROVIDER_RATE_CARD,
} from '../src/services/admin-rate-card.service.js';
import { ProviderRateCardAdminError } from '../src/types/provider-rate-card-admin.js';

const ACTOR = 'actor-admin-test';

function toEntryRow(row: ImportedEntryRow, snapshotId: string, index: number): ProviderRateCardEntryRow {
  return {
    id: `${snapshotId}-e${index}`,
    snapshotId,
    provider: row.provider,
    model: row.model,
    status: row.status,
    tier: row.tier,
    billingUnit: row.billingUnit,
    inputMicrosPerMillion: row.inputMicrosPerMillion,
    outputMicrosPerMillion: row.outputMicrosPerMillion,
    cachedInputMicrosPerMillion: row.cachedInputMicrosPerMillion,
    cachedOutputMicrosPerMillion: row.cachedOutputMicrosPerMillion,
    perUnitMicros: row.perUnitMicros,
    audioInputMicrosPerMillion: row.audioInputMicrosPerMillion,
    audioOutputMicrosPerMillion: row.audioOutputMicrosPerMillion,
    tokensPerSecond: row.tokensPerSecond,
    cachedInputAccounting: row.cachedInputAccounting,
    aliases: row.aliases,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    inactive: row.inactive,
    source: row.source,
    verifiedAt: row.verifiedAt,
  };
}

function makeSnapshotRow(overrides: Partial<ProviderRateCardSnapshotRow> & { version: string }): ProviderRateCardSnapshotRow {
  const now = new Date();
  return {
    id: `snap-${overrides.version}`,
    version: overrides.version,
    status: overrides.status ?? 'DRAFT',
    schemaVersion: 1,
    currency: 'USD',
    storageUnit: 'MICROS',
    engineUnit: 'NANO_USD',
    source: overrides.source ?? 'https://example.test/pricing',
    generatedAt: overrides.generatedAt ?? new Date('2026-08-03T00:00:00Z'),
    provenance: 'RESEARCH_SNAPSHOT',
    effectiveFrom: overrides.effectiveFrom ?? null,
    effectiveTo: overrides.effectiveTo ?? null,
    publishedAt: overrides.publishedAt ?? null,
    retiredAt: overrides.retiredAt ?? null,
    createdAt: now,
    updatedAt: now,
    entries: overrides.entries ?? [],
    ...overrides,
  };
}

function toListItem(row: ProviderRateCardSnapshotRow): AdminSnapshotListItem {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    publishedAt: row.publishedAt,
    retiredAt: row.retiredAt,
    generatedAt: row.generatedAt,
    source: row.source,
    provenance: row.provenance,
    entryCount: row.entries.length,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

class FakeAdminRepository implements ProviderRateCardAdminRepository {
  drafts = new Map<string, ProviderRateCardSnapshotRow>();
  publishOutcome?: AdminPublishOutcome;
  importOutcome?: AdminImportOutcome;
  retireOutcome?: AdminRetireOutcome;
  cloneOutcome?: AdminCloneOutcome;
  findResult?: ProviderRateCardSnapshotRow | null | 'default';
  calls: Array<{ op: string; args: unknown }> = [];

  record(op: string, args: unknown): void {
    this.calls.push({ op, args });
  }

  async createDraft(input: AdminDraftCreateInput): Promise<ProviderRateCardSnapshotRow> {
    this.record('createDraft', { ...input });
    const row = makeSnapshotRow({
      version: input.version,
      source: input.source,
      generatedAt: input.generatedAt,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
    });
    this.drafts.set(input.version, row);
    return row;
  }

  async importEntries(input: AdminImportInput): Promise<AdminImportOutcome> {
    this.record('importEntries', {
      version: input.version,
      rows: input.rows,
      source: input.source,
      generatedAt: input.generatedAt,
      actorId: input.actorId,
      action: input.action,
    });
    if (this.importOutcome !== undefined) return this.importOutcome;
    const existing = this.drafts.get(input.version);
    if (existing === undefined) return { kind: 'not_found' };
    if (existing.status !== 'DRAFT') return { kind: 'not_draft' };
    const updated: ProviderRateCardSnapshotRow = {
      ...existing,
      source: input.source ?? existing.source,
      generatedAt: input.generatedAt ?? existing.generatedAt,
      updatedAt: new Date(),
      entries: input.rows.map((r, i) => toEntryRow(r, input.version, i)),
    };
    this.drafts.set(input.version, updated);
    return { kind: 'imported', snapshot: updated };
  }

  async publish(input: AdminPublishInput): Promise<AdminPublishOutcome> {
    this.record('publish', {
      version: input.version,
      publishedAt: input.publishedAt,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      replaceActiveVersion: input.replaceActiveVersion,
      retireAction: input.retireAction,
      actorId: input.actorId,
      action: input.action,
    });
    if (this.publishOutcome !== undefined) return this.publishOutcome;
    const existing = this.drafts.get(input.version);
    if (existing === undefined) return { kind: 'not_found' };
    if (existing.status !== 'DRAFT') return { kind: 'not_draft' };
    const updated: ProviderRateCardSnapshotRow = {
      ...existing,
      status: 'ACTIVE',
      publishedAt: input.publishedAt,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      updatedAt: new Date(),
    };
    this.drafts.set(input.version, updated);
    return { kind: 'published', snapshot: updated };
  }

  async retire(input: AdminRetireInput): Promise<AdminRetireOutcome> {
    this.record('retire', {
      version: input.version,
      retiredAt: input.retiredAt,
      effectiveTo: input.effectiveTo,
      actorId: input.actorId,
      action: input.action,
    });
    if (this.retireOutcome !== undefined) return this.retireOutcome;
    const existing = this.drafts.get(input.version);
    if (existing === undefined) return { kind: 'not_found' };
    if (existing.status !== 'ACTIVE') return { kind: 'not_active' };
    const updated: ProviderRateCardSnapshotRow = {
      ...existing,
      status: 'RETIRED',
      retiredAt: input.retiredAt,
      effectiveTo: input.effectiveTo ?? existing.effectiveTo,
      updatedAt: new Date(),
    };
    this.drafts.set(input.version, updated);
    return { kind: 'retired', snapshot: updated };
  }

  async cloneSnapshot(input: AdminCloneInput): Promise<AdminCloneOutcome> {
    this.record('cloneSnapshot', {
      sourceVersion: input.sourceVersion,
      newVersion: input.newVersion,
      actorId: input.actorId,
      action: input.action,
    });
    if (this.cloneOutcome !== undefined) return this.cloneOutcome;
    const source = this.drafts.get(input.sourceVersion);
    if (source === undefined) return { kind: 'source_not_found' };
    if (source.status !== 'ACTIVE') return { kind: 'source_not_active' };
    if (this.drafts.has(input.newVersion)) return { kind: 'target_version_taken' };
    const targetId = `snap-${input.newVersion}`;
    const cloned: ProviderRateCardSnapshotRow = {
      ...source,
      id: targetId,
      version: input.newVersion,
      status: 'DRAFT',
      publishedAt: null,
      retiredAt: null,
      effectiveFrom: null,
      effectiveTo: null,
      updatedAt: new Date(),
      entries: source.entries.map((entry) => ({
        ...entry,
        id: `entry-clone-${entry.id}`,
        snapshotId: targetId,
      })),
    };
    this.drafts.set(input.newVersion, cloned);
    return { kind: 'cloned', snapshot: cloned };
  }

  async list(query: AdminListQuery): Promise<AdminListResult> {
    this.record('list', query);
    const all = [...this.drafts.values()].filter((s) => (query.status ? s.status === query.status : true));
    const total = all.length;
    const start = (query.page - 1) * query.limit;
    const items = all.slice(start, start + query.limit).map(toListItem);
    return {
      items,
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  }

  async findSnapshotByVersion(version: string): Promise<ProviderRateCardSnapshotRow | null> {
    this.record('findSnapshotByVersion', { version });
    if (this.findResult !== undefined && this.findResult !== 'default') return this.findResult;
    return this.drafts.get(version) ?? null;
  }
}

function newRepo(): FakeAdminRepository {
  return new FakeAdminRepository();
}

function validCardEntries(): unknown[] {
  return [
    {
      provider: 'google',
      model: 'gemini-x',
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

async function seededDraft(repo: FakeAdminRepository, version = 'draft-1') {
  await createDraftRateCard(
    { repository: repo },
    { version, source: 'https://example.test/pricing', generatedAt: '2026-08-03' },
    ACTOR,
  );
  return importRateCardEntries(
    { repository: repo },
    { version, source: 'https://example.test/pricing', generatedAt: '2026-08-03', entries: validCardEntries() },
    ACTOR,
  );
}

function asAdminError(err: unknown, code: string): ProviderRateCardAdminError {
  assert.ok(err instanceof ProviderRateCardAdminError, `expected ProviderRateCardAdminError, got ${String(err)}`);
  assert.equal(err.code, code, `expected code ${code}, got ${err.code}: ${err.message}`);
  return err;
}

test('1. createDraftRateCard passes normalized inputs and returns fresh metadata', async () => {
  const repo = newRepo();
  const meta = await createDraftRateCard(
    { repository: repo },
    { version: '  draft-a  ', source: ' https://example.test/pricing ', generatedAt: '2026-08-03', effectiveFrom: '2026-08-03', effectiveTo: '2026-12-31' },
    ACTOR,
  );
  assert.equal(meta.status, 'DRAFT');
  assert.equal(meta.version, 'draft-a');
  assert.equal(meta.entryCount, 0);
  assert.equal(meta.effectiveFrom, '2026-08-03');
  assert.equal(meta.effectiveTo, '2026-12-31');
  const call = repo.calls.find((c) => c.op === 'createDraft');
  assert.ok(call);
  const args = call.args as AdminDraftCreateInput;
  assert.equal(args.version, 'draft-a');
  assert.equal(args.source, 'https://example.test/pricing');
  assert.equal(args.action, 'rate_card_draft_created');
  assert.equal(args.actorId, ACTOR);
  assert.equal(args.generatedAt.toISOString(), '2026-08-03T00:00:00.000Z');
});

test('2. createDraftRateCard blank version -> RATE_CARD_ADMIN_INVALID_VERSION', async () => {
  const repo = newRepo();
  await assert.rejects(
    createDraftRateCard({ repository: repo }, { version: '   ', source: 's', generatedAt: '2026-08-03' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_INVALID_VERSION'); return true; },
  );
});

test('3. createDraftRateCard invalid date -> RATE_CARD_ADMIN_INVALID_WINDOW', async () => {
  const repo = newRepo();
  await assert.rejects(
    createDraftRateCard({ repository: repo }, { version: 'v', source: 's', generatedAt: 'not-a-date' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_INVALID_WINDOW'); return true; },
  );
});

test('4. createDraftRateCard inverted window -> RATE_CARD_ADMIN_INVALID_WINDOW', async () => {
  const repo = newRepo();
  await assert.rejects(
    createDraftRateCard(
      { repository: repo },
      { version: 'v', source: 's', generatedAt: '2026-08-03', effectiveFrom: '2026-12-31', effectiveTo: '2026-08-03' },
      ACTOR,
    ),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_INVALID_WINDOW'); return true; },
  );
});

test('5. importRateCardEntries success returns metadata and exact bigint rows', async () => {
  const repo = newRepo();
  await createDraftRateCard({ repository: repo }, { version: 'draft-1', source: 's', generatedAt: '2026-08-03' }, ACTOR);
  const meta = await importRateCardEntries(
    { repository: repo },
    { version: 'draft-1', source: 'https://example.test/pricing', generatedAt: '2026-08-03', entries: validCardEntries() },
    ACTOR,
  );
  assert.equal(meta.entryCount, 1);
  const call = repo.calls.find((c) => c.op === 'importEntries');
  assert.ok(call);
  const args = call.args as AdminImportInput;
  assert.equal(args.rows[0].inputMicrosPerMillion, 1_500_000n);
  assert.equal(args.rows[0].tier, 'STANDARD');
  assert.equal(args.action, 'rate_card_entries_imported');
});

test('6. importRateCardEntries not_found -> RATE_CARD_ADMIN_NOT_FOUND', async () => {
  const repo = newRepo();
  await assert.rejects(
    importRateCardEntries(
      { repository: repo },
      { version: 'missing', source: 's', generatedAt: '2026-08-03', entries: validCardEntries() },
      ACTOR,
    ),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_NOT_FOUND'); return true; },
  );
});

test('7. importRateCardEntries not_draft -> RATE_CARD_ADMIN_IMMUTABLE', async () => {
  const repo = newRepo();
  repo.importOutcome = { kind: 'not_draft' };
  await assert.rejects(
    importRateCardEntries(
      { repository: repo },
      { version: 'draft-1', source: 's', generatedAt: '2026-08-03', entries: validCardEntries() },
      ACTOR,
    ),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_IMMUTABLE'); return true; },
  );
});

test('8. importRateCardEntries invalid payload -> RATE_CARD_ADMIN_INVALID_PAYLOAD', async () => {
  const repo = newRepo();
  await createDraftRateCard({ repository: repo }, { version: 'draft-1', source: 's', generatedAt: '2026-08-03' }, ACTOR);
  await assert.rejects(
    importRateCardEntries(
      { repository: repo },
      { version: 'draft-1', source: 's', generatedAt: '2026-08-03', entries: [] },
      ACTOR,
    ),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_INVALID_PAYLOAD'); return true; },
  );
});

test('9. importRateCardEntries duplicate identity -> RATE_CARD_ADMIN_DUPLICATE_IDENTITY', async () => {
  const repo = newRepo();
  await createDraftRateCard({ repository: repo }, { version: 'draft-1', source: 's', generatedAt: '2026-08-03' }, ACTOR);
  const entry = validCardEntries()[0] as Record<string, unknown>;
  await assert.rejects(
    importRateCardEntries(
      { repository: repo },
      {
        version: 'draft-1',
        source: 's',
        generatedAt: '2026-08-03',
        entries: [
          { ...entry, effectiveFrom: '2026-08-03', effectiveTo: '2026-12-31' },
          { ...entry, effectiveFrom: '2027-01-01', effectiveTo: '2027-12-31' },
        ],
      },
      ACTOR,
    ),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_DUPLICATE_IDENTITY'); return true; },
  );
});

test('10. validateRateCardDraft succeeds with card + providers', async () => {
  const repo = newRepo();
  await seededDraft(repo, 'draft-1');
  const result = await validateRateCardDraft({ repository: repo }, 'draft-1');
  assert.equal(result.valid, true);
  assert.equal(result.entryCount, 1);
  assert.deepEqual(result.providers, ['google']);
  assert.equal(result.card.entries.length, 1);
});

test('11. validateRateCardDraft not found -> RATE_CARD_ADMIN_NOT_FOUND', async () => {
  const repo = newRepo();
  await assert.rejects(validateRateCardDraft({ repository: repo }, 'nope'), (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_NOT_FOUND'); return true; },
  );
});

test('12. validateRateCardDraft on an unmappable row -> RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE with mapperCode', async () => {
  const repo = newRepo();
  await createDraftRateCard({ repository: repo }, { version: 'draft-1', source: 's', generatedAt: '2026-08-03' }, ACTOR);
  repo.drafts.set('draft-1', makeSnapshotRow({ version: 'draft-1' }));
  await assert.rejects(validateRateCardDraft({ repository: repo }, 'draft-1'), (e: unknown) => {
    const err = asAdminError(e, 'RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE');
    assert.equal(err.mapperCode, 'SNAPSHOT_EMPTY_ENTRIES');
    return true;
  });
});

test('13. publishRateCard success with request-body window', async () => {
  const repo = newRepo();
  await seededDraft(repo, 'draft-1');
  const meta = await publishRateCard(
    { repository: repo },
    { version: 'draft-1', effectiveFrom: '2026-08-03' },
    ACTOR,
  );
  assert.equal(meta.status, 'ACTIVE');
  assert.equal(meta.effectiveFrom, '2026-08-03');
  assert.ok(meta.publishedAt);
  const call = repo.calls.find((c) => c.op === 'publish');
  assert.ok(call);
  assert.equal((call.args as AdminPublishInput).action, 'rate_card_published');
});

test('14. publishRateCard uses the draft window when the body omits one', async () => {
  const repo = newRepo();
  await createDraftRateCard(
    { repository: repo },
    { version: 'draft-1', source: 's', generatedAt: '2026-08-03', effectiveFrom: '2026-09-01' },
    ACTOR,
  );
  await importRateCardEntries(
    { repository: repo },
    { version: 'draft-1', source: 's', generatedAt: '2026-08-03', entries: validCardEntries() },
    ACTOR,
  );
  const meta = await publishRateCard({ repository: repo }, { version: 'draft-1' }, ACTOR);
  assert.equal(meta.status, 'ACTIVE');
  assert.equal(meta.effectiveFrom, '2026-09-01');
});

test('15. publishRateCard on an already-ACTIVE row with a conflicting window -> RATE_CARD_ADMIN_DRAFT_REQUIRED', async () => {
  const repo = newRepo();
  repo.findResult = makeSnapshotRow({ version: 'draft-1', status: 'ACTIVE', publishedAt: new Date(), effectiveFrom: new Date('2026-08-03T00:00:00Z') });
  await assert.rejects(
    publishRateCard({ repository: repo }, { version: 'draft-1', effectiveFrom: '2027-01-01' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_DRAFT_REQUIRED'); return true; },
  );
});

test('15b. publishRateCard on a RETIRED row -> RATE_CARD_ADMIN_DRAFT_REQUIRED', async () => {
  const repo = newRepo();
  repo.findResult = makeSnapshotRow({
    version: 'draft-1',
    status: 'RETIRED',
    publishedAt: new Date('2026-08-03T00:00:00Z'),
    retiredAt: new Date('2026-09-01T00:00:00Z'),
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
  });
  await assert.rejects(
    publishRateCard({ repository: repo }, { version: 'draft-1', effectiveFrom: '2026-08-03' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_DRAFT_REQUIRED'); return true; },
  );
});

test('15c. publishRateCard on an already-ACTIVE row with a coherent window -> idempotent replay (no repository publish)', async () => {
  const repo = newRepo();
  repo.drafts.set('draft-1', makeSnapshotRow({
    version: 'draft-1',
    status: 'ACTIVE',
    publishedAt: new Date('2026-08-03T00:00:00Z'),
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
    effectiveTo: null,
    entries: [toEntryRow(importRowOf(validCardEntries()[0] as never), 'draft-1', 0)],
  }));
  const meta = await publishRateCard({ repository: repo }, { version: 'draft-1', effectiveFrom: '2026-08-03' }, ACTOR);
  assert.equal(meta.status, 'ACTIVE');
  assert.equal(meta.idempotentReplay, true);
  assert.ok(!repo.calls.some((c) => c.op === 'publish'), 'a coherent replay must not call the repository publish');
});

test('16. publishRateCard without any effectiveFrom -> RATE_CARD_ADMIN_INVALID_WINDOW', async () => {
  const repo = newRepo();
  await seededDraft(repo, 'draft-1');
  await assert.rejects(
    publishRateCard({ repository: repo }, { version: 'draft-1' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_INVALID_WINDOW'); return true; },
  );
});

test('17. publishRateCard inverted body window -> RATE_CARD_ADMIN_INVALID_WINDOW', async () => {
  const repo = newRepo();
  await seededDraft(repo, 'draft-1');
  await assert.rejects(
    publishRateCard({ repository: repo }, { version: 'draft-1', effectiveFrom: '2026-12-31', effectiveTo: '2026-08-03' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_INVALID_WINDOW'); return true; },
  );
});

test('18. publishRateCard on an unmappable draft -> RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE', async () => {
  const repo = newRepo();
  await createDraftRateCard({ repository: repo }, { version: 'draft-1', source: 's', generatedAt: '2026-08-03' }, ACTOR);
  repo.drafts.set('draft-1', makeSnapshotRow({ version: 'draft-1' }));
  await assert.rejects(
    publishRateCard({ repository: repo }, { version: 'draft-1', effectiveFrom: '2026-08-03' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE'); return true; },
  );
});

test('19. publishRateCard overlap outcome -> RATE_CARD_ADMIN_PUBLISH_CONFLICT with conflictingVersions', async () => {
  const repo = newRepo();
  repo.publishOutcome = { kind: 'overlap', conflictingVersions: ['other'], snapshotCount: 1 };
  const row = makeSnapshotRow({
    version: 'draft-1',
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
    entries: [toEntryRow(importRowOf(validCardEntries()[0] as never), 'draft-1', 0)],
  });
  repo.findResult = row;
  await assert.rejects(
    publishRateCard({ repository: repo }, { version: 'draft-1', effectiveFrom: '2026-08-03' }, ACTOR),
    (e: unknown) => {
      const err = asAdminError(e, 'RATE_CARD_ADMIN_PUBLISH_CONFLICT');
      assert.deepEqual(err.conflictingVersions, ['other']);
      assert.equal(err.snapshotCount, 1);
      return true;
    },
  );
});

test('20. publishRateCard concurrent outcome -> RATE_CARD_ADMIN_PUBLISH_CONFLICT', async () => {
  const repo = newRepo();
  repo.publishOutcome = { kind: 'concurrent' };
  const row = makeSnapshotRow({
    version: 'draft-1',
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
    entries: [toEntryRow(importRowOf(validCardEntries()[0] as never), 'draft-1', 0)],
  });
  repo.findResult = row;
  await assert.rejects(
    publishRateCard({ repository: repo }, { version: 'draft-1', effectiveFrom: '2026-08-03' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_PUBLISH_CONFLICT'); return true; },
  );
});

test('20b. publishRateCard forwards replaceActiveVersion and returns idempotentReplay: false', async () => {
  const repo = newRepo();
  await seededDraft(repo, 'draft-1');
  const meta = await publishRateCard(
    { repository: repo },
    { version: 'draft-1', effectiveFrom: '2026-08-03', replaceActiveVersion: 'active-0' },
    ACTOR,
  );
  assert.equal(meta.status, 'ACTIVE');
  assert.equal(meta.idempotentReplay, false);
  const call = repo.calls.find((c) => c.op === 'publish')!.args as AdminPublishInput;
  assert.equal(call.replaceActiveVersion, 'active-0');
  assert.equal(call.retireAction, 'rate_card_retired');
});

test('20c. publishRateCard replacement_mismatch outcome -> RATE_CARD_ADMIN_REPLACEMENT_VERSION_MISMATCH', async () => {
  const repo = newRepo();
  repo.publishOutcome = {
    kind: 'replacement_mismatch',
    expectedVersion: 'active-0',
    conflictingVersions: ['active-1'],
    snapshotCount: 1,
  };
  const row = makeSnapshotRow({
    version: 'draft-1',
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
    entries: [toEntryRow(importRowOf(validCardEntries()[0] as never), 'draft-1', 0)],
  });
  repo.findResult = row;
  await assert.rejects(
    publishRateCard(
      { repository: repo },
      { version: 'draft-1', effectiveFrom: '2026-08-03', replaceActiveVersion: 'active-0' },
      ACTOR,
    ),
    (e: unknown) => {
      const err = asAdminError(e, 'RATE_CARD_ADMIN_REPLACEMENT_VERSION_MISMATCH');
      assert.deepEqual(err.conflictingVersions, ['active-1']);
      assert.equal(err.snapshotCount, 1);
      return true;
    },
  );
});

test('20d. publishRateCard candidate_invalid outcome -> RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE with mapperCode', async () => {
  const repo = newRepo();
  repo.publishOutcome = { kind: 'candidate_invalid', mapperCode: 'SNAPSHOT_LIFECYCLE_INVALID', reason: 'boom' };
  const row = makeSnapshotRow({
    version: 'draft-1',
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
    entries: [toEntryRow(importRowOf(validCardEntries()[0] as never), 'draft-1', 0)],
  });
  repo.findResult = row;
  await assert.rejects(
    publishRateCard({ repository: repo }, { version: 'draft-1', effectiveFrom: '2026-08-03' }, ACTOR),
    (e: unknown) => {
      const err = asAdminError(e, 'RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE');
      assert.equal(err.mapperCode, 'SNAPSHOT_LIFECYCLE_INVALID');
      return true;
    },
  );
});

function importRowOf(entry: never): ImportedEntryRow {
  const raw = entry as Record<string, never>;
  return {
    provider: String(raw['provider']),
    model: String(raw['model']),
    status: 'STABLE',
    tier: 'STANDARD',
    billingUnit: 'TOKEN',
    inputMicrosPerMillion: 1_500_000n,
    outputMicrosPerMillion: 7_500_000n,
    cachedInputMicrosPerMillion: 150_000n,
    cachedOutputMicrosPerMillion: null,
    perUnitMicros: null,
    audioInputMicrosPerMillion: null,
    audioOutputMicrosPerMillion: null,
    tokensPerSecond: null,
    cachedInputAccounting: 'DISJOINT',
    aliases: null,
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
    effectiveTo: null,
    inactive: false,
    source: null,
    verifiedAt: new Date('2026-08-03T00:00:00Z'),
  };
}

test('21. retireRateCard success', async () => {
  const repo = newRepo();
  await seededDraft(repo, 'draft-1');
  await publishRateCard({ repository: repo }, { version: 'draft-1', effectiveFrom: '2026-08-03' }, ACTOR);
  const meta = await retireRateCard({ repository: repo }, { version: 'draft-1' }, ACTOR);
  assert.equal(meta.status, 'RETIRED');
  assert.ok(meta.retiredAt);
  const call = repo.calls.find((c) => c.op === 'retire');
  assert.ok(call);
  assert.equal((call.args as AdminRetireInput).action, 'rate_card_retired');
});

test('22. retireRateCard on a DRAFT row -> RATE_CARD_ADMIN_ACTIVE_REQUIRED', async () => {
  const repo = newRepo();
  await seededDraft(repo, 'draft-1');
  await assert.rejects(
    retireRateCard({ repository: repo }, { version: 'draft-1' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_ACTIVE_REQUIRED'); return true; },
  );
});

test('23. retireRateCard not found -> RATE_CARD_ADMIN_NOT_FOUND', async () => {
  const repo = newRepo();
  await assert.rejects(retireRateCard({ repository: repo }, { version: 'nope' }, ACTOR), (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_NOT_FOUND'); return true; },
  );
});

test('24. retireRateCard not_active outcome -> RATE_CARD_ADMIN_ACTIVE_REQUIRED', async () => {
  const repo = newRepo();
  repo.retireOutcome = { kind: 'not_active' };
  repo.findResult = makeSnapshotRow({ version: 'draft-1', status: 'ACTIVE', publishedAt: new Date(), effectiveFrom: new Date('2026-08-03T00:00:00Z') });
  await assert.rejects(
    retireRateCard({ repository: repo }, { version: 'draft-1' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_ACTIVE_REQUIRED'); return true; },
  );
});

test('25. retireRateCard with retiredAt before publishedAt -> RATE_CARD_ADMIN_INVALID_WINDOW', async () => {
  const repo = newRepo();
  const publishedAt = new Date('2026-09-01T00:00:00Z');
  repo.findResult = makeSnapshotRow({ version: 'draft-1', status: 'ACTIVE', publishedAt, effectiveFrom: new Date('2026-08-03T00:00:00Z') });
  await assert.rejects(
    retireRateCard({ repository: repo }, { version: 'draft-1', retiredAt: '2026-08-01T00:00:00Z' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_INVALID_WINDOW'); return true; },
  );
});

test('25b. retireRateCard on an already-RETIRED row with no body -> idempotent replay (no repository retire)', async () => {
  const repo = newRepo();
  const retiredAt = new Date('2026-09-01T00:00:00Z');
  repo.drafts.set('draft-1', makeSnapshotRow({
    version: 'draft-1',
    status: 'RETIRED',
    publishedAt: new Date('2026-08-03T00:00:00Z'),
    retiredAt,
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
  }));
  const meta = await retireRateCard({ repository: repo }, { version: 'draft-1' }, ACTOR);
  assert.equal(meta.status, 'RETIRED');
  assert.equal(meta.idempotentReplay, true);
  assert.ok(!repo.calls.some((c) => c.op === 'retire'), 'a coherent replay must not call the repository retire');
});

test('25c. retireRateCard on an already-RETIRED row with a matching retiredAt -> idempotent replay', async () => {
  const repo = newRepo();
  repo.drafts.set('draft-1', makeSnapshotRow({
    version: 'draft-1',
    status: 'RETIRED',
    publishedAt: new Date('2026-08-03T00:00:00Z'),
    retiredAt: new Date('2026-09-01T00:00:00Z'),
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
    effectiveTo: new Date('2026-12-31T00:00:00Z'),
  }));
  const meta = await retireRateCard(
    { repository: repo },
    { version: 'draft-1', retiredAt: '2026-09-01T00:00:00Z', effectiveTo: '2026-12-31' },
    ACTOR,
  );
  assert.equal(meta.idempotentReplay, true);
});

test('25d. retireRateCard on an already-RETIRED row with a conflicting retiredAt -> RATE_CARD_ADMIN_ACTIVE_REQUIRED', async () => {
  const repo = newRepo();
  repo.drafts.set('draft-1', makeSnapshotRow({
    version: 'draft-1',
    status: 'RETIRED',
    publishedAt: new Date('2026-08-03T00:00:00Z'),
    retiredAt: new Date('2026-09-01T00:00:00Z'),
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
  }));
  await assert.rejects(
    retireRateCard(
      { repository: repo },
      { version: 'draft-1', retiredAt: '2026-09-02T00:00:00Z' },
      ACTOR,
    ),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_ACTIVE_REQUIRED'); return true; },
  );
});

test('25e. retireRateCard forwards an optional effectiveTo and returns idempotentReplay: false', async () => {
  const repo = newRepo();
  await seededDraft(repo, 'draft-1');
  await publishRateCard({ repository: repo }, { version: 'draft-1', effectiveFrom: '2026-08-03' }, ACTOR);
  const meta = await retireRateCard(
    { repository: repo },
    { version: 'draft-1', effectiveTo: '2026-12-31' },
    ACTOR,
  );
  assert.equal(meta.status, 'RETIRED');
  assert.equal(meta.idempotentReplay, false);
  assert.equal(meta.effectiveTo, '2026-12-31');
  const call = repo.calls.find((c) => c.op === 'retire')!.args as AdminRetireInput;
  assert.equal((call.effectiveTo as Date).toISOString().slice(0, 10), '2026-12-31');
});

test('25f. retireRateCard rejects an effectiveTo that widens the persisted window -> RATE_CARD_ADMIN_INVALID_WINDOW', async () => {
  const repo = newRepo();
  const row = makeSnapshotRow({
    version: 'draft-1',
    status: 'ACTIVE',
    publishedAt: new Date('2026-08-03T00:00:00Z'),
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
    effectiveTo: new Date('2026-12-31T00:00:00Z'),
  });
  repo.findResult = row;
  await assert.rejects(
    retireRateCard({ repository: repo }, { version: 'draft-1', effectiveTo: '2027-06-30' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_INVALID_WINDOW'); return true; },
  );
});

test('25g. retireRateCard rejects an effectiveTo before effectiveFrom -> RATE_CARD_ADMIN_INVALID_WINDOW', async () => {
  const repo = newRepo();
  repo.findResult = makeSnapshotRow({
    version: 'draft-1',
    status: 'ACTIVE',
    publishedAt: new Date('2026-08-03T00:00:00Z'),
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
  });
  await assert.rejects(
    retireRateCard({ repository: repo }, { version: 'draft-1', effectiveTo: '2026-01-01' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_INVALID_WINDOW'); return true; },
  );
});

test('26. listRateCardSnapshots passes the query through and maps metadata', async () => {
  const repo = newRepo();
  await createDraftRateCard({ repository: repo }, { version: 'draft-a', source: 's', generatedAt: '2026-08-03' }, ACTOR);
  await createDraftRateCard({ repository: repo }, { version: 'draft-b', source: 's', generatedAt: '2026-08-03' }, ACTOR);
  const result = await listRateCardSnapshots({ repository: repo }, { page: 1, limit: 10, status: 'DRAFT' });
  assert.equal(result.pagination.total, 2);
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((i) => i.status === 'DRAFT'));
  const call = repo.calls.find((c) => c.op === 'list');
  assert.ok(call);
  assert.equal((call.args as AdminListQuery).status, 'DRAFT');
});

test('27. getRateCardByVersion returns mapped entries and providers', async () => {
  const repo = newRepo();
  await seededDraft(repo, 'draft-1');
  const detail = await getRateCardByVersion({ repository: repo }, 'draft-1');
  assert.equal(detail.entries.length, 1);
  assert.deepEqual(detail.providers, ['google']);
  assert.equal(detail.mappingError, null);
});

test('28. getRateCardByVersion on an unmappable row returns mappingError (no throw)', async () => {
  const repo = newRepo();
  repo.findResult = makeSnapshotRow({ version: 'draft-1' });
  const detail = await getRateCardByVersion({ repository: repo }, 'draft-1');
  assert.equal(detail.entries.length, 0);
  assert.ok(detail.mappingError);
  assert.equal(detail.mappingError.code, 'SNAPSHOT_EMPTY_ENTRIES');
});

test('29. getRateCardByVersion not found -> RATE_CARD_ADMIN_NOT_FOUND', async () => {
  const repo = newRepo();
  await assert.rejects(getRateCardByVersion({ repository: repo }, 'nope'), (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_NOT_FOUND'); return true; },
  );
});

test('30. importStaticRateCardAsDraft creates a DRAFT with the exact PROVIDER_RATE_CARD.version and never publishes', async () => {
  const repo = newRepo();
  const meta = await importStaticRateCardAsDraft({ repository: repo }, {}, ACTOR);
  assert.equal(meta.version, PROVIDER_RATE_CARD.version);
  assert.equal(meta.status, 'DRAFT');
  assert.equal(meta.entryCount, PROVIDER_RATE_CARD.entries.length);
  assert.equal(meta.idempotentReplay, false);
  const ops = repo.calls.map((c) => c.op);
  assert.ok(ops.includes('createDraft'));
  assert.ok(ops.includes('importEntries'));
  assert.ok(!ops.includes('publish'), 'static import must never publish');
  const draftCall = repo.calls.find((c) => c.op === 'createDraft')!.args as AdminDraftCreateInput;
  assert.equal(draftCall.action, 'rate_card_static_imported');
});

test('30b. importStaticRateCardAsDraft is idempotent: a second identical import replays without a write', async () => {
  const repo = newRepo();
  const first = await importStaticRateCardAsDraft({ repository: repo }, {}, ACTOR);
  assert.equal(first.idempotentReplay, false);
  repo.calls.length = 0;
  const second = await importStaticRateCardAsDraft({ repository: repo }, {}, ACTOR);
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.version, PROVIDER_RATE_CARD.version);
  assert.equal(second.entryCount, PROVIDER_RATE_CARD.entries.length);
  assert.ok(!repo.calls.some((c) => c.op === 'createDraft'), 'a replay must not create a draft');
  assert.ok(!repo.calls.some((c) => c.op === 'importEntries'), 'a replay must not import entries');
});

test('30c. importStaticRateCardAsDraft conflicts with a different-content DRAFT -> RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT', async () => {
  const repo = newRepo();
  await createDraftRateCard({ repository: repo }, { version: PROVIDER_RATE_CARD.version, source: 's', generatedAt: '2026-08-03' }, ACTOR);
  await importRateCardEntries(
    { repository: repo },
    { version: PROVIDER_RATE_CARD.version, source: 's', generatedAt: '2026-08-03', entries: validCardEntries() },
    ACTOR,
  );
  await assert.rejects(
    importStaticRateCardAsDraft({ repository: repo }, {}, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT'); return true; },
  );
});

test('30d. importStaticRateCardAsDraft conflicts with an ACTIVE snapshot -> RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT', async () => {
  const repo = newRepo();
  repo.drafts.set(PROVIDER_RATE_CARD.version, makeSnapshotRow({
    version: PROVIDER_RATE_CARD.version,
    status: 'ACTIVE',
    publishedAt: new Date('2026-08-03T00:00:00Z'),
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
  }));
  await assert.rejects(
    importStaticRateCardAsDraft({ repository: repo }, {}, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT'); return true; },
  );
});

test('31. importStaticRateCardAsDraft honors an explicit version', async () => {
  const repo = newRepo();
  const meta = await importStaticRateCardAsDraft({ repository: repo }, { version: 'custom-static' }, ACTOR);
  assert.equal(meta.version, 'custom-static');
  assert.equal(meta.entryCount, PROVIDER_RATE_CARD.entries.length);
});

test('32. static import passes bigint rows with exact static-card money', async () => {
  const repo = newRepo();
  await importStaticRateCardAsDraft({ repository: repo }, { version: 'custom-static' }, ACTOR);
  const call = repo.calls.find((c) => c.op === 'importEntries')!.args as AdminImportInput;
  assert.ok(call.rows.length > 0);
  for (const row of call.rows) {
    assert.ok(typeof row.inputMicrosPerMillion === 'bigint' || row.inputMicrosPerMillion === null);
    assert.ok(
      (['STANDARD', 'BATCH', 'PRIORITY', 'FAST_MODE'] as string[]).includes(row.tier),
      `unexpected tier ${row.tier}`,
    );
  }
});

test('33. metadata output objects are fresh (not repository references)', async () => {
  const repo = newRepo();
  const meta = await createDraftRateCard({ repository: repo }, { version: 'draft-1', source: 's', generatedAt: '2026-08-03' }, ACTOR);
  const stored = repo.drafts.get('draft-1')!;
  assert.notEqual(meta, stored);
  assert.ok(!Object.is(meta, stored));
});

test('34. importStaticRateCardAsDraft source/generatedAt mirror the static card', async () => {
  const repo = newRepo();
  const meta = await importStaticRateCardAsDraft({ repository: repo }, {}, ACTOR);
  assert.equal(meta.source, PROVIDER_RATE_CARD.source);
  assert.equal(meta.generatedAt, PROVIDER_RATE_CARD.generatedAt);
});

// ---------------------------------------------------------------------------
// CLONE (Update Prices: clone an existing snapshot into a fresh DRAFT)
// ---------------------------------------------------------------------------

test('35. cloneRateCard clones an ACTIVE snapshot into a DRAFT, copying all pricing entries', async () => {
  const repo = newRepo();
  await createDraftRateCard({ repository: repo }, { version: 'active-1', source: 's', generatedAt: '2026-08-03' }, ACTOR);
  await importRateCardEntries(
    { repository: repo },
    { version: 'active-1', source: 's', generatedAt: '2026-08-03', entries: validCardEntries() },
    ACTOR,
  );
  repo.drafts.set('active-1', makeSnapshotRow({
    version: 'active-1',
    status: 'ACTIVE',
    publishedAt: new Date('2026-08-03T00:00:00Z'),
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
    entries: (repo.drafts.get('active-1')?.entries ?? []).map((e) => ({ ...e, id: `src-${e.id}`, snapshotId: 'snap-active-1' })),
  }));

  const meta = await cloneRateCard({ repository: repo }, { sourceVersion: 'active-1', newVersion: '1.1.0' }, ACTOR);
  assert.equal(meta.status, 'DRAFT');
  assert.equal(meta.version, '1.1.0');
  assert.equal(meta.entryCount, 1);
  assert.equal(meta.publishedAt, null);
  assert.equal(meta.retiredAt, null);
  assert.equal(meta.effectiveFrom, null);
  assert.equal(meta.effectiveTo, null);
  const call = repo.calls.find((c) => c.op === 'cloneSnapshot');
  assert.ok(call);
  const args = call.args as AdminCloneInput;
  assert.equal(args.sourceVersion, 'active-1');
  assert.equal(args.newVersion, '1.1.0');
  assert.equal(args.action, 'rate_card_draft_cloned');
  assert.equal(args.actorId, ACTOR);
});

test('36. cloneRateCard cloned entries get new IDs and the source stays unchanged', async () => {
  const repo = newRepo();
  await seededDraft(repo, 'active-1');
  const sourceRow = makeSnapshotRow({
    version: 'active-1',
    status: 'ACTIVE',
    publishedAt: new Date('2026-08-03T00:00:00Z'),
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
    entries: (repo.drafts.get('active-1')?.entries ?? []).map((e) => ({
      ...e,
      id: `src-${e.id}`,
      snapshotId: 'snap-active-1',
    })),
  });
  repo.drafts.set('active-1', sourceRow);
  const sourceEntry = sourceRow.entries[0];

  const meta = await cloneRateCard({ repository: repo }, { sourceVersion: 'active-1', newVersion: '1.1.0' }, ACTOR);
  assert.equal(meta.entryCount, 1);

  const target = repo.drafts.get('1.1.0');
  assert.ok(target);
  assert.equal(target.status, 'DRAFT');
  assert.notEqual(target.id, sourceRow.id, 'the clone must be a NEW snapshot');
  assert.equal(target.entries.length, 1);
  assert.notEqual(target.entries[0].id, sourceEntry.id, 'cloned entries must have NEW database IDs');
  assert.equal(target.entries[0].snapshotId, target.id, 'cloned entries must point to the new snapshot');
  assert.equal(target.entries[0].provider, sourceEntry.provider);
  assert.equal(target.entries[0].model, sourceEntry.model);
  assert.equal(target.entries[0].inputMicrosPerMillion, sourceEntry.inputMicrosPerMillion);
  assert.equal(target.entries[0].outputMicrosPerMillion, sourceEntry.outputMicrosPerMillion);

  const stored = repo.drafts.get('active-1');
  assert.ok(stored);
  assert.equal(stored.status, 'ACTIVE', 'the source must remain unchanged');
  assert.deepEqual(stored, sourceRow, 'the source must remain unchanged');
});

test('37. cloneRateCard duplicate newVersion -> RATE_CARD_ADMIN_VERSION_TAKEN', async () => {
  const repo = newRepo();
  repo.cloneOutcome = { kind: 'target_version_taken' };
  await assert.rejects(
    cloneRateCard({ repository: repo }, { sourceVersion: 'active-1', newVersion: '1.1.0' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_VERSION_TAKEN'); return true; },
  );
});

test('38. cloneRateCard source not found -> RATE_CARD_ADMIN_NOT_FOUND', async () => {
  const repo = newRepo();
  repo.cloneOutcome = { kind: 'source_not_found' };
  await assert.rejects(
    cloneRateCard({ repository: repo }, { sourceVersion: 'missing', newVersion: '1.1.0' }, ACTOR),
    (e: unknown) => {
      const err = asAdminError(e, 'RATE_CARD_ADMIN_NOT_FOUND');
      assert.equal(err.version, 'missing');
      return true;
    },
  );
});

test('39. cloneRateCard same source and new version -> RATE_CARD_ADMIN_INVALID_PAYLOAD', async () => {
  const repo = newRepo();
  await assert.rejects(
    cloneRateCard({ repository: repo }, { sourceVersion: '1.1.0', newVersion: '1.1.0' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_INVALID_PAYLOAD'); return true; },
  );
  assert.ok(!repo.calls.some((c) => c.op === 'cloneSnapshot'), 'a same-version clone must not reach the repository');
});

test('40. cloneRateCard blank newVersion -> RATE_CARD_ADMIN_INVALID_VERSION', async () => {
  const repo = newRepo();
  await assert.rejects(
    cloneRateCard({ repository: repo }, { sourceVersion: 'active-1', newVersion: '   ' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_INVALID_VERSION'); return true; },
  );
});

test('41. cloneRateCard rejects a DRAFT source -> RATE_CARD_ADMIN_ACTIVE_REQUIRED', async () => {
  const repo = newRepo();
  await seededDraft(repo, 'draft-1');
  await assert.rejects(
    cloneRateCard({ repository: repo }, { sourceVersion: 'draft-1', newVersion: '1.1.0' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_ACTIVE_REQUIRED'); return true; },
  );
  assert.ok(!repo.drafts.has('1.1.0'), 'no clone may be created from a DRAFT source');
});

test('42. cloneRateCard rejects a RETIRED source -> RATE_CARD_ADMIN_ACTIVE_REQUIRED', async () => {
  const repo = newRepo();
  repo.drafts.set('retired-1', makeSnapshotRow({
    version: 'retired-1',
    status: 'RETIRED',
    publishedAt: new Date('2026-08-03T00:00:00Z'),
    retiredAt: new Date('2026-09-01T00:00:00Z'),
    effectiveFrom: new Date('2026-08-03T00:00:00Z'),
  }));
  await assert.rejects(
    cloneRateCard({ repository: repo }, { sourceVersion: 'retired-1', newVersion: '1.1.0' }, ACTOR),
    (e: unknown) => { asAdminError(e, 'RATE_CARD_ADMIN_ACTIVE_REQUIRED'); return true; },
  );
  assert.ok(!repo.drafts.has('1.1.0'), 'no clone may be created from a RETIRED source');
});
