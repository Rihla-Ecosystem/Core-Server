/**
 * Phase 2F-B read-only database Rate Card repository.
 *
 * Loads persisted `ProviderRateCardSnapshot` rows (with nested entries) from
 * PostgreSQL using the existing Phase 2F-A schema. The repository:
 *  - selects the single ACTIVE snapshot applicable to a pricing date;
 *  - detects overlapping ACTIVE snapshots explicitly (never silently picks one);
 *  - loads any snapshot by immutable version regardless of lifecycle status;
 *  - returns plain persisted row objects (never mutable Prisma model refs);
 *  - does NOT call the Pricing Engine, the pure mapper, or the static card;
 *  - does NOT mutate, publish, retire, or write anything.
 *
 * Unwrapped Prisma/database failures are converted to a stable
 * `ProviderRateCardLoadError` with code `RATE_CARD_DATABASE_ERROR`. Row-level
 * "not found" outcomes are NOT errors: active-date selection returns `none`,
 * version lookup returns `null`, and the loader maps those to stable domain
 * errors.
 */

import type { PrismaClient } from '@prisma/client';
import type { ProviderRateCardSnapshotRow, ProviderRateCardEntryRow } from '../types/provider-pricing-snapshot.js';
import { ProviderRateCardLoadError } from '../types/provider-rate-card-load.js';
import { pricingDateToUtcDate, normalizePricingDate } from '../utils/provider-rate-card-date.js';

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

/**
 * The minimal Prisma surface the repository needs. The real `prisma` client
 * satisfies it structurally; tests inject a deliberately failing fake.
 */
export interface ProviderRateCardRepositoryClient {
  providerRateCardSnapshot: Pick<
    PrismaClient['providerRateCardSnapshot'],
    'findMany' | 'findUnique' | 'count'
  >;
}

/** Deterministic nested-entry ordering (stable for tests/audit/recompute). */
export const ENTRY_ORDER_BY: Array<
  { provider: 'asc' } | { model: 'asc' } | { tier: 'asc' } | { effectiveFrom: 'asc' } | { id: 'asc' }
> = [
  { provider: 'asc' },
  { model: 'asc' },
  { tier: 'asc' },
  { effectiveFrom: 'asc' },
  { id: 'asc' },
];

/**
 * Outcome of active-snapshot selection for a pricing date.
 *
 * - `none`     — no ACTIVE snapshot applies to the date (NOT a database error).
 * - `found`    — exactly one ACTIVE snapshot applies; its persisted row returns.
 * - `conflict` — more than one ACTIVE snapshot applies; the conflict is surfaced
 *   explicitly (versions + count) and never silently resolved by ordering.
 */
export type ActiveSnapshotSelection =
  | { kind: 'none' }
  | { kind: 'found'; snapshot: ProviderRateCardSnapshotRow }
  | { kind: 'conflict'; pricingDate: string; versions: string[]; count: number };

/** Read-only provider rate-card repository contract. */
export interface ProviderRateCardRepository {
  /**
   * Select the single ACTIVE snapshot applicable to a pricing date
   * (`YYYY-MM-DD`). Boundaries are inclusive (`effectiveFrom <= date <=
   * effectiveTo`; a null `effectiveTo` is open-ended). Throws
   * `RATE_CARD_INVALID_PRICING_DATE` for a malformed date and
   * `RATE_CARD_ACTIVE_CONFLICT`-data via the returned `conflict` variant for
   * overlapping ACTIVE snapshots. Never returns a DRAFT or RETIRED snapshot.
   */
  findActiveSnapshotForDate(pricingDate: string): Promise<ActiveSnapshotSelection>;

  /** Load any snapshot by immutable version, including all entries. Returns
   * null when not found. Ignores lifecycle status: DRAFT/ACTIVE/RETIRED all
   * load. */
  findSnapshotByVersion(version: string): Promise<ProviderRateCardSnapshotRow | null>;
}

/** Copy a Prisma snapshot (with entries) into a fresh plain row object. */
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

function databaseError(message: string, cause: unknown): ProviderRateCardLoadError {
  return new ProviderRateCardLoadError('RATE_CARD_DATABASE_ERROR', message, { cause });
}

/**
 * Build a Prisma-backed repository.
 *
 * The Prisma client is injected so unit tests can supply a deliberately
 * failing delegate without touching the real database or the shared client.
 * Defaults to the application `prisma` client.
 */
export function createPrismaProviderRateCardRepository(
  client: ProviderRateCardRepositoryClient,
): ProviderRateCardRepository {
  const entriesInclude = { entries: { orderBy: ENTRY_ORDER_BY } } as const;

  return {
    async findActiveSnapshotForDate(pricingDate) {
      const normalized = normalizePricingDate(pricingDate);
      const date = pricingDateToUtcDate(normalized);
      try {
        const snapshots = await client.providerRateCardSnapshot.findMany({
          where: {
            status: 'ACTIVE',
            effectiveFrom: { lte: date },
            AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }] }],
          },
          take: 2,
          orderBy: { version: 'asc' },
          include: entriesInclude,
        });
        if (snapshots.length === 0) {
          return { kind: 'none' };
        }
        if (snapshots.length === 1) {
          return { kind: 'found', snapshot: toSnapshotRow(snapshots[0] as unknown as PrismaSnapshot) };
        }
        // More than one ACTIVE snapshot applies to the date. Surface the
        // conflict explicitly; never pick by createdAt/version/anything.
        const versions = snapshots.map((s) => s.version);
        const count = await client.providerRateCardSnapshot.count({
          where: {
            status: 'ACTIVE',
            effectiveFrom: { lte: date },
            AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }] }],
          },
        });
        return { kind: 'conflict', pricingDate: normalized, versions, count };
      } catch (err) {
        throw databaseError(`could not load the active rate card for ${normalized}`, err);
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
