/**
 * Phase 2F-C database Admin repository for provider rate-card snapshots.
 *
 * Write-side persistence seam over Prisma for the Admin Draft / Import /
 * Publish / Retire workflow. The repository:
 *  - creates empty DRAFT snapshots (unique version, P2002 → VERSION_TAKEN);
 *  - replaces a DRAFT snapshot's entries atomically (delete + createMany) and
 *    writes its audit evidence in one transaction;
 *  - publishes a DRAFT transactionally: it builds the would-be ACTIVE row and
 *    validates it through the pure mapper BEFORE any write (a snapshot that
 *    maps as a valid engine card in ACTIVE lifecycle form is provably
 *    publishable), detects overlapping ACTIVE windows at SERIALIZABLE
 *    isolation (see below), and writes the lifecycle transition — optionally
 *    performing an atomic ACTIVE replacement that retires the superseded
 *    snapshot and tightens its business window;
 *  - retires an ACTIVE snapshot transactionally (optionally closing its
 *    business window in the same write);
 *  - lists snapshots and loads any snapshot by immutable version;
 *  - returns plain persisted row objects (never mutable Prisma model refs);
 *  - calls the pure mapper ONLY for the final ACTIVE-candidate validation on
 *    publish (never for pricing arithmetic or model selection), never imports
 *    the static card, and never implements pricing, caching, or fallback.
 *
 * Publish concurrency: overlapping ACTIVE windows are rejected inside a
 * SERIALIZABLE transaction using the same inclusive-window predicate the read
 * repository uses for active-date selection. When two snapshots with
 * overlapping windows are published concurrently, PostgreSQL's serializable
 * snapshot isolation (SSI) aborts exactly one transaction (Prisma P2034),
 * which the repository reports as `{ kind: 'concurrent' }` — never as a silent
 * double-active. `updateMany({ where: { version, status: 'DRAFT' } })` guards
 * the DRAFT→ACTIVE transition itself. An explicit replacement names the
 * ACTIVE snapshot being superseded; a mismatch (missing, multiple overlaps, or
 * non-forward window movement) returns `{ kind: 'replacement_mismatch' }` so a
 * racing replace is never resolved silently.
 *
 * Unwrapped Prisma/database failures are converted to a stable
 * `ProviderRateCardAdminError` with code `RATE_CARD_ADMIN_DATABASE_ERROR`.
 * Row-level "not found"/"wrong state"/conflict outcomes are values, not
 * exceptions; the service converts them to stable domain errors.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { ProviderRateCardSnapshotRow, ProviderRateCardEntryRow } from '../types/provider-pricing-snapshot.js';
import { ProviderRateCardAdminError } from '../types/provider-rate-card-admin.js';
import type { ImportedEntryRow } from '../utils/provider-pricing/entry-import.js';
import { ProviderRateCardSnapshotError } from '../utils/provider-pricing/snapshot.js';
import { mapProviderRateCardSnapshot } from '../utils/provider-pricing/snapshot.js';

/** Prisma model row shapes (result of `include: { entries: true }`). */
type PrismaSnapshot = {
  id: string;
  version: string;
  status: string;
  schemaVersion: number;
  currency: string;
  storageUnit: string;
  engineUnit: string;
  source: string;
  generatedAt: Date;
  provenance: string;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  publishedAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  entries: PrismaEntry[];
};

type PrismaEntry = {
  id: string;
  snapshotId: string;
  provider: string;
  model: string;
  status: string;
  tier: string | null;
  billingUnit: string;
  inputMicrosPerMillion: bigint | null;
  outputMicrosPerMillion: bigint | null;
  cachedInputMicrosPerMillion: bigint | null;
  cachedOutputMicrosPerMillion: bigint | null;
  perUnitMicros: bigint | null;
  audioInputMicrosPerMillion: bigint | null;
  audioOutputMicrosPerMillion: bigint | null;
  tokensPerSecond: number | null;
  cachedInputAccounting: string | null;
  aliases: unknown;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  inactive: boolean;
  source: string | null;
  verifiedAt: Date | null;
};

/** The minimal Prisma transaction surface the repository's transactions need. */
export interface RateCardAdminTransactionClient {
  providerRateCardSnapshot: Pick<
    PrismaClient['providerRateCardSnapshot'],
    'create' | 'findUnique' | 'findMany' | 'update' | 'updateMany' | 'count'
  >;
  providerRateCardEntry: Pick<
    PrismaClient['providerRateCardEntry'],
    'deleteMany' | 'createMany' | 'create' | 'update' | 'updateMany' | 'delete'
  >;
  auditLog: Pick<PrismaClient['auditLog'], 'create'>;
}

/**
 * The minimal Prisma surface the repository needs outside transactions. The
 * real `prisma` client satisfies it structurally; tests inject a fake.
 */
export interface ProviderRateCardAdminRepositoryClient {
  providerRateCardSnapshot: Pick<
    PrismaClient['providerRateCardSnapshot'],
    'create' | 'findUnique' | 'findMany' | 'count'
  >;
  providerRateCardEntry: Pick<PrismaClient['providerRateCardEntry'], 'deleteMany'>;
  $transaction<R>(
    fn: (tx: RateCardAdminTransactionClient) => Promise<R>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<R>;
}

/** Deterministic nested-entry ordering (stable for tests/audit/recompute). */
export const ADMIN_ENTRY_ORDER_BY: Array<
  { provider: 'asc' } | { model: 'asc' } | { tier: 'asc' } | { effectiveFrom: 'asc' } | { id: 'asc' }
> = [
  { provider: 'asc' },
  { model: 'asc' },
  { tier: 'asc' },
  { effectiveFrom: 'asc' },
  { id: 'asc' },
];

/** Audit evidence carried by every mutation (persisted in the same tx). */
export interface AdminAuditInput {
  actorId: string;
  action: string;
  metadata?: Prisma.InputJsonValue;
}

export interface AdminDraftCreateInput extends AdminAuditInput {
  version: string;
  source: string;
  generatedAt: Date;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}

export type AdminImportOutcome =
  | { kind: 'imported'; snapshot: ProviderRateCardSnapshotRow }
  | { kind: 'not_found' }
  | { kind: 'not_draft' };

export interface AdminImportInput extends AdminAuditInput {
  version: string;
  rows: ImportedEntryRow[];
  source?: string;
  generatedAt?: Date;
}

export type AdminPublishOutcome =
  | { kind: 'published'; snapshot: ProviderRateCardSnapshotRow }
  | { kind: 'not_found' }
  | { kind: 'not_draft' }
  | { kind: 'overlap'; conflictingVersions: string[]; snapshotCount: number }
  | {
      kind: 'replacement_mismatch';
      expectedVersion: string;
      conflictingVersions: string[];
      snapshotCount: number;
    }
  | { kind: 'candidate_invalid'; mapperCode: string; reason: string }
  | { kind: 'concurrent' };

export interface AdminPublishInput extends AdminAuditInput {
  version: string;
  publishedAt: Date;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  /** Explicit ACTIVE snapshot to replace (atomic retire + activate). */
  replaceActiveVersion?: string;
  /** Audit action for the retired/replaced ACTIVE snapshot (default retired). */
  retireAction?: string;
}

export type AdminRetireOutcome =
  | { kind: 'retired'; snapshot: ProviderRateCardSnapshotRow }
  | { kind: 'not_found' }
  | { kind: 'not_active' };

export interface AdminRetireInput extends AdminAuditInput {
  version: string;
  retiredAt: Date;
  /** Optional business-date window close written atomically with the retire. */
  effectiveTo?: Date;
}

export type AdminEntryCreateOutcome =
  | { kind: 'created'; snapshot: ProviderRateCardSnapshotRow }
  | { kind: 'not_found' }
  | { kind: 'not_draft' }
  | { kind: 'duplicate_identity' };

export interface AdminEntryCreateInput extends AdminAuditInput {
  version: string;
  row: ImportedEntryRow;
}

export type AdminEntryUpdateOutcome =
  | { kind: 'updated'; snapshot: ProviderRateCardSnapshotRow }
  | { kind: 'not_found' }
  | { kind: 'not_draft' }
  | { kind: 'entry_not_found' }
  | { kind: 'duplicate_identity' };

export interface AdminEntryUpdateInput extends AdminAuditInput {
  version: string;
  entryId: string;
  row: ImportedEntryRow;
}

export type AdminEntryDeleteOutcome =
  | { kind: 'deleted'; snapshot: ProviderRateCardSnapshotRow }
  | { kind: 'not_found' }
  | { kind: 'not_draft' }
  | { kind: 'entry_not_found' };

export interface AdminEntryDeleteInput extends AdminAuditInput {
  version: string;
  entryId: string;
}

export interface AdminSnapshotListItem {
  id: string;
  version: string;
  status: 'DRAFT' | 'ACTIVE' | 'RETIRED';
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  publishedAt: Date | null;
  retiredAt: Date | null;
  generatedAt: Date;
  source: string;
  provenance: string;
  entryCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminListQuery {
  page: number;
  limit: number;
  status?: 'DRAFT' | 'ACTIVE' | 'RETIRED';
}

export interface AdminListResult {
  items: AdminSnapshotListItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

/** Write-side provider rate-card Admin repository contract. */
export interface ProviderRateCardAdminRepository {
  createDraft(input: AdminDraftCreateInput): Promise<ProviderRateCardSnapshotRow>;
  importEntries(input: AdminImportInput): Promise<AdminImportOutcome>;
  publish(input: AdminPublishInput): Promise<AdminPublishOutcome>;
  retire(input: AdminRetireInput): Promise<AdminRetireOutcome>;
  createEntry(input: AdminEntryCreateInput): Promise<AdminEntryCreateOutcome>;
  updateEntry(input: AdminEntryUpdateInput): Promise<AdminEntryUpdateOutcome>;
  deleteEntry(input: AdminEntryDeleteInput): Promise<AdminEntryDeleteOutcome>;
  list(query: AdminListQuery): Promise<AdminListResult>;
  findSnapshotByVersion(version: string): Promise<ProviderRateCardSnapshotRow | null>;
}

const entriesInclude = { entries: { orderBy: ADMIN_ENTRY_ORDER_BY } } as const;

function toEntryRow(entry: PrismaEntry): ProviderRateCardEntryRow {
  return {
    id: entry.id,
    snapshotId: entry.snapshotId,
    provider: entry.provider,
    model: entry.model,
    status: entry.status,
    tier: entry.tier,
    billingUnit: entry.billingUnit,
    inputMicrosPerMillion: entry.inputMicrosPerMillion,
    outputMicrosPerMillion: entry.outputMicrosPerMillion,
    cachedInputMicrosPerMillion: entry.cachedInputMicrosPerMillion,
    cachedOutputMicrosPerMillion: entry.cachedOutputMicrosPerMillion,
    perUnitMicros: entry.perUnitMicros,
    audioInputMicrosPerMillion: entry.audioInputMicrosPerMillion,
    audioOutputMicrosPerMillion: entry.audioOutputMicrosPerMillion,
    tokensPerSecond: entry.tokensPerSecond,
    cachedInputAccounting: entry.cachedInputAccounting,
    aliases: entry.aliases,
    effectiveFrom: entry.effectiveFrom,
    effectiveTo: entry.effectiveTo,
    inactive: entry.inactive,
    source: entry.source,
    verifiedAt: entry.verifiedAt,
  };
}

function toSnapshotRow(snapshot: PrismaSnapshot): ProviderRateCardSnapshotRow {
  return {
    id: snapshot.id,
    version: snapshot.version,
    status: snapshot.status as ProviderRateCardSnapshotRow['status'],
    schemaVersion: snapshot.schemaVersion,
    currency: snapshot.currency,
    storageUnit: snapshot.storageUnit,
    engineUnit: snapshot.engineUnit,
    source: snapshot.source,
    generatedAt: snapshot.generatedAt,
    provenance: snapshot.provenance,
    effectiveFrom: snapshot.effectiveFrom,
    effectiveTo: snapshot.effectiveTo,
    publishedAt: snapshot.publishedAt,
    retiredAt: snapshot.retiredAt,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    entries: snapshot.entries.map((entry) => toEntryRow(entry)),
  };
}

function databaseError(operation: string, cause: unknown): ProviderRateCardAdminError {
  return new ProviderRateCardAdminError(
    'RATE_CARD_ADMIN_DATABASE_ERROR',
    `${operation} failed`,
    { cause },
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002'
  );
}

function isSerializationFailure(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
}

function isIdentityUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  if (err.meta?.modelName !== 'ProviderRateCardEntry') return false;
  const target = err.meta?.target;
  if (Array.isArray(target)) {
    const fields = target.filter((item): item is string => typeof item === 'string');
    return fields.includes('provider') && fields.includes('model') && fields.includes('tier');
  }
  return typeof target === 'string' && target.includes('provider') && target.includes('model');
}

function entryMutationData(
  row: ImportedEntryRow,
): Omit<Prisma.ProviderRateCardEntryUncheckedCreateInput, 'snapshotId'> {
  return {
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
    aliases: row.aliases === null ? Prisma.DbNull : row.aliases,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    inactive: row.inactive,
    source: row.source,
    verifiedAt: row.verifiedAt,
  };
}

/**
 * Build a Prisma-backed Admin repository.
 *
 * The Prisma client is injected so unit tests can supply a deliberately
 * failing fake without touching the real database or the shared client.
 * Defaults to the application `prisma` client.
 */
export function createPrismaProviderRateCardAdminRepository(
  client: ProviderRateCardAdminRepositoryClient,
): ProviderRateCardAdminRepository {
  return {
    async createDraft(input) {
      try {
        return await client.$transaction(async (tx) => {
          const snapshot = await tx.providerRateCardSnapshot.create({
            data: {
              version: input.version,
              status: 'DRAFT',
              source: input.source,
              generatedAt: input.generatedAt,
              effectiveFrom: input.effectiveFrom,
              effectiveTo: input.effectiveTo,
            },
            include: entriesInclude,
          });
          await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              action: input.action,
              metadata: input.metadata ?? { version: input.version, snapshotId: snapshot.id },
            },
          });
          return toSnapshotRow(snapshot as unknown as PrismaSnapshot);
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ProviderRateCardAdminError(
            'RATE_CARD_ADMIN_VERSION_TAKEN',
            `rate card version "${input.version}" already exists`,
            { version: input.version },
          );
        }
        throw databaseError(`could not create rate card draft "${input.version}"`, err);
      }
    },

    async importEntries(input) {
      try {
        return await client.$transaction(async (tx) => {
          const existing = await tx.providerRateCardSnapshot.findUnique({
            where: { version: input.version },
            select: { id: true, status: true },
          });
          if (existing === null) {
            return { kind: 'not_found' as const };
          }
          if (existing.status !== 'DRAFT') {
            return { kind: 'not_draft' as const };
          }
          await tx.providerRateCardEntry.deleteMany({ where: { snapshotId: existing.id } });
          await tx.providerRateCardEntry.createMany({
            data: input.rows.map((row) => ({
              ...row,
              aliases: row.aliases === null ? Prisma.DbNull : row.aliases,
              snapshotId: existing.id,
            })),
          });
          if (input.source !== undefined || input.generatedAt !== undefined) {
            await tx.providerRateCardSnapshot.update({
              where: { id: existing.id },
              data: {
                ...(input.source !== undefined ? { source: input.source } : {}),
                ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}),
              },
            });
          }
          await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              action: input.action,
              metadata:
                input.metadata ?? {
                  version: input.version,
                  snapshotId: existing.id,
                  entryCount: input.rows.length,
                },
            },
          });
          const snapshot = await tx.providerRateCardSnapshot.findUnique({
            where: { id: existing.id },
            include: entriesInclude,
          });
          return {
            kind: 'imported' as const,
            snapshot: toSnapshotRow(snapshot as unknown as PrismaSnapshot),
          };
        });
      } catch (err) {
        throw databaseError(`could not import entries into draft "${input.version}"`, err);
      }
    },

    async publish(input) {
      try {
        return await client.$transaction(
          async (tx) => {
            const existing = await tx.providerRateCardSnapshot.findUnique({
              where: { version: input.version },
              include: entriesInclude,
            });
            if (existing === null) {
              return { kind: 'not_found' as const };
            }
            if (existing.status !== 'DRAFT') {
              return { kind: 'not_draft' as const };
            }

            // Inclusive-window overlap against every ACTIVE snapshot
            // (effectiveFrom <= newEffectiveTo AND newEffectiveFrom <=
            // effectiveTo-or-open-ended). Matches the read-repository
            // active-date predicate semantics.
            const overlaps = await tx.providerRateCardSnapshot.findMany({
              where: {
                status: 'ACTIVE',
                effectiveFrom: { lte: input.effectiveTo ?? input.effectiveFrom },
                AND: [
                  {
                    OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.effectiveFrom } }],
                  },
                ],
              },
              select: { id: true, version: true, effectiveFrom: true, effectiveTo: true },
            });

            // Explicit replacement: the caller names the ACTIVE snapshot being
            // superseded. It must exist, be the ONLY overlap, and the new
            // window must start strictly after the old one (forward movement).
            let replacement:
              | { id: string; version: string; effectiveFrom: Date; effectiveTo: Date | null }
              | null = null;
            if (input.replaceActiveVersion !== undefined) {
              const target = overlaps.find((o) => o.version === input.replaceActiveVersion);
              if (
                target === undefined ||
                overlaps.length !== 1 ||
                target.effectiveFrom === null ||
                input.effectiveFrom.getTime() <= target.effectiveFrom.getTime()
              ) {
                return {
                  kind: 'replacement_mismatch' as const,
                  expectedVersion: input.replaceActiveVersion,
                  conflictingVersions: overlaps.map((o) => o.version),
                  snapshotCount: overlaps.length,
                };
              }
              replacement = {
                id: target.id,
                version: target.version,
                effectiveFrom: target.effectiveFrom,
                effectiveTo: target.effectiveTo,
              };
            } else if (overlaps.length > 0) {
              return {
                kind: 'overlap' as const,
                conflictingVersions: overlaps.map((o) => o.version),
                snapshotCount: overlaps.length,
              };
            }

            // Final ACTIVE-candidate validation: build the would-be ACTIVE row
            // and run the pure mapper BEFORE any write. A snapshot that maps
            // as a valid engine card in ACTIVE lifecycle form is provably
            // publishable; anything else aborts the whole transaction.
            const candidate = toSnapshotRow(existing as unknown as PrismaSnapshot);
            candidate.status = 'ACTIVE';
            candidate.publishedAt = input.publishedAt;
            candidate.retiredAt = null;
            candidate.effectiveFrom = input.effectiveFrom;
            candidate.effectiveTo = input.effectiveTo;
            try {
              mapProviderRateCardSnapshot(candidate);
            } catch (err) {
              if (err instanceof ProviderRateCardSnapshotError) {
                return {
                  kind: 'candidate_invalid' as const,
                  mapperCode: err.code,
                  reason: err.message,
                };
              }
              return {
                kind: 'candidate_invalid' as const,
                mapperCode: 'SNAPSHOT_INVALID',
                reason: String((err as Error).message),
              };
            }

            const updated = await tx.providerRateCardSnapshot.updateMany({
              where: { version: input.version, status: 'DRAFT' },
              data: {
                status: 'ACTIVE',
                publishedAt: input.publishedAt,
                effectiveFrom: input.effectiveFrom,
                effectiveTo: input.effectiveTo,
              },
            });
            if (updated.count !== 1) {
              return { kind: 'not_draft' as const };
            }

            // Replacement: retire the superseded ACTIVE snapshot atomically.
            // Its business window is tightened to the day before the new
            // effectiveFrom only when that narrows it (open-ended, or a
            // closed window that would otherwise overlap the new one).
            if (replacement !== null) {
              const dayBeforeNew = new Date(input.effectiveFrom);
              dayBeforeNew.setUTCDate(dayBeforeNew.getUTCDate() - 1);
              const oldEffectiveTo =
                replacement.effectiveTo === null ||
                replacement.effectiveTo.getTime() >= input.effectiveFrom.getTime()
                  ? dayBeforeNew
                  : replacement.effectiveTo;
              await tx.providerRateCardSnapshot.update({
                where: { version: replacement.version },
                data: {
                  status: 'RETIRED',
                  retiredAt: input.publishedAt,
                  effectiveTo: oldEffectiveTo,
                },
              });
              await tx.auditLog.create({
                data: {
                  actorId: input.actorId,
                  action: input.retireAction ?? 'rate_card_retired',
                  metadata: {
                    version: replacement.version,
                    snapshotId: replacement.id,
                    retiredAt: input.publishedAt.toISOString(),
                    effectiveTo: oldEffectiveTo.toISOString().slice(0, 10),
                    replacedBy: input.version,
                  },
                },
              });
            }

            await tx.auditLog.create({
              data: {
                actorId: input.actorId,
                action: input.action,
                metadata:
                  input.metadata ?? {
                    version: input.version,
                    snapshotId: existing.id,
                    effectiveFrom: input.effectiveFrom.toISOString().slice(0, 10),
                    effectiveTo:
                      input.effectiveTo === null
                        ? null
                        : input.effectiveTo.toISOString().slice(0, 10),
                    ...(replacement !== null ? { replacedActiveVersion: replacement.version } : {}),
                  },
              },
            });

            const snapshot = await tx.providerRateCardSnapshot.findUnique({
              where: { id: existing.id },
              include: entriesInclude,
            });
            return {
              kind: 'published' as const,
              snapshot: toSnapshotRow(snapshot as unknown as PrismaSnapshot),
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (err) {
        if (isSerializationFailure(err)) {
          return { kind: 'concurrent' };
        }
        throw databaseError(`could not publish rate card version "${input.version}"`, err);
      }
    },

    async retire(input) {
      try {
        return await client.$transaction(async (tx) => {
          const existing = await tx.providerRateCardSnapshot.findUnique({
            where: { version: input.version },
            select: { id: true, status: true },
          });
          if (existing === null) {
            return { kind: 'not_found' as const };
          }
          if (existing.status !== 'ACTIVE') {
            return { kind: 'not_active' as const };
          }
          const updated = await tx.providerRateCardSnapshot.updateMany({
            where: { version: input.version, status: 'ACTIVE' },
            data: {
              status: 'RETIRED',
              retiredAt: input.retiredAt,
              ...(input.effectiveTo !== undefined ? { effectiveTo: input.effectiveTo } : {}),
            },
          });
          if (updated.count !== 1) {
            return { kind: 'not_active' as const };
          }
          await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              action: input.action,
              metadata:
                input.metadata ?? {
                  version: input.version,
                  snapshotId: existing.id,
                  retiredAt: input.retiredAt.toISOString(),
                  ...(input.effectiveTo !== undefined
                    ? { effectiveTo: input.effectiveTo.toISOString().slice(0, 10) }
                    : {}),
                },
            },
          });
          const snapshot = await tx.providerRateCardSnapshot.findUnique({
            where: { id: existing.id },
            include: entriesInclude,
          });
          return {
            kind: 'retired' as const,
            snapshot: toSnapshotRow(snapshot as unknown as PrismaSnapshot),
          };
        });
      } catch (err) {
        throw databaseError(`could not retire rate card version "${input.version}"`, err);
      }
    },

    async createEntry(input) {
      try {
        return await client.$transaction(async (tx) => {
          const existing = await tx.providerRateCardSnapshot.findUnique({
            where: { version: input.version },
            select: { id: true, status: true },
          });
          if (existing === null) {
            return { kind: 'not_found' as const };
          }
          if (existing.status !== 'DRAFT') {
            return { kind: 'not_draft' as const };
          }
          const created = await tx.providerRateCardEntry.create({
            data: {
              ...entryMutationData(input.row),
              snapshotId: existing.id,
            },
          });
          await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              action: input.action,
              metadata:
                input.metadata ?? {
                  version: input.version,
                  snapshotId: existing.id,
                  entryId: created.id,
                  provider: created.provider,
                  model: created.model,
                  tier: created.tier,
                },
            },
          });
          const snapshot = await tx.providerRateCardSnapshot.findUnique({
            where: { id: existing.id },
            include: entriesInclude,
          });
          return {
            kind: 'created' as const,
            snapshot: toSnapshotRow(snapshot as unknown as PrismaSnapshot),
          };
        });
      } catch (err) {
        if (isIdentityUniqueViolation(err)) {
          return { kind: 'duplicate_identity' as const };
        }
        throw databaseError(`could not create entry in draft "${input.version}"`, err);
      }
    },

    async updateEntry(input) {
      try {
        return await client.$transaction(async (tx) => {
          const existing = await tx.providerRateCardSnapshot.findUnique({
            where: { version: input.version },
            select: { id: true, status: true },
          });
          if (existing === null) {
            return { kind: 'not_found' as const };
          }
          if (existing.status !== 'DRAFT') {
            return { kind: 'not_draft' as const };
          }
          const updated = await tx.providerRateCardEntry.updateMany({
            where: { id: input.entryId, snapshotId: existing.id },
            data: entryMutationData(input.row),
          });
          if (updated.count !== 1) {
            return { kind: 'entry_not_found' as const };
          }
          await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              action: input.action,
              metadata:
                input.metadata ?? {
                  version: input.version,
                  snapshotId: existing.id,
                  entryId: input.entryId,
                  provider: input.row.provider,
                  model: input.row.model,
                  tier: input.row.tier,
                },
            },
          });
          const snapshot = await tx.providerRateCardSnapshot.findUnique({
            where: { id: existing.id },
            include: entriesInclude,
          });
          return {
            kind: 'updated' as const,
            snapshot: toSnapshotRow(snapshot as unknown as PrismaSnapshot),
          };
        });
      } catch (err) {
        if (isIdentityUniqueViolation(err)) {
          return { kind: 'duplicate_identity' as const };
        }
        throw databaseError(`could not update entry in draft "${input.version}"`, err);
      }
    },

    async deleteEntry(input) {
      try {
        return await client.$transaction(async (tx) => {
          const existing = await tx.providerRateCardSnapshot.findUnique({
            where: { version: input.version },
            select: { id: true, status: true },
          });
          if (existing === null) {
            return { kind: 'not_found' as const };
          }
          if (existing.status !== 'DRAFT') {
            return { kind: 'not_draft' as const };
          }
          const deleted = await tx.providerRateCardEntry.deleteMany({
            where: { id: input.entryId, snapshotId: existing.id },
          });
          if (deleted.count !== 1) {
            return { kind: 'entry_not_found' as const };
          }
          await tx.auditLog.create({
            data: {
              actorId: input.actorId,
              action: input.action,
              metadata:
                input.metadata ?? {
                  version: input.version,
                  snapshotId: existing.id,
                  entryId: input.entryId,
                },
            },
          });
          const snapshot = await tx.providerRateCardSnapshot.findUnique({
            where: { id: existing.id },
            include: entriesInclude,
          });
          return {
            kind: 'deleted' as const,
            snapshot: toSnapshotRow(snapshot as unknown as PrismaSnapshot),
          };
        });
      } catch (err) {
        throw databaseError(`could not delete entry from draft "${input.version}"`, err);
      }
    },

    async list(query) {
      try {
        const where = query.status !== undefined ? { status: query.status } : {};
        const skip = (query.page - 1) * query.limit;
        const [total, rows] = await Promise.all([
          client.providerRateCardSnapshot.count({ where }),
          client.providerRateCardSnapshot.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: query.limit,
            select: {
              id: true,
              version: true,
              status: true,
              effectiveFrom: true,
              effectiveTo: true,
              publishedAt: true,
              retiredAt: true,
              generatedAt: true,
              source: true,
              provenance: true,
              createdAt: true,
              updatedAt: true,
              _count: { select: { entries: true } },
            },
          }),
        ]);
        const items: AdminSnapshotListItem[] = rows.map((row) => ({
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
          entryCount: row._count.entries,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }));
        return {
          items,
          pagination: {
            page: query.page,
            limit: query.limit,
            total,
            totalPages: total > 0 ? Math.ceil(total / query.limit) : 0,
          },
        };
      } catch (err) {
        throw databaseError('could not list rate card snapshots', err);
      }
    },

    async findSnapshotByVersion(version) {
      try {
        const snapshot = await client.providerRateCardSnapshot.findUnique({
          where: { version },
          include: entriesInclude,
        });
        return snapshot ? toSnapshotRow(snapshot as unknown as PrismaSnapshot) : null;
      } catch (err) {
        throw databaseError(`could not load rate card version "${version}"`, err);
      }
    },
  };
}
