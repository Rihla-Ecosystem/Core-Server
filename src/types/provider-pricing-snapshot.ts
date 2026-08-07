/**
 * Phase 2F-A persistence contracts for versioned provider rate-card snapshots.
 *
 * This module declares the persisted row shapes for `ProviderRateCardSnapshot`
 * / `ProviderRateCardEntry` (the raw database representation, `Date`s, DB enum
 * spellings, and exact BigInt monetary rates intact) and the mapping error
 * contract for turning a row into the validated engine `ProviderRateCard`. It
 * carries no mapper logic, no repository, and no runtime wiring.
 *
 * Mapping rules that make the DB rows (kept in DB-native uppercase enum
 * spellings and PostgreSQL BIGINT) safe for the engine (which consumes safe JS
 * numbers and domain spellings):
 *  - `tier`: DB `STANDARD`/`BATCH`/`PRIORITY`/`FAST_MODE` →
 *    engine `standard`/`batch`/`priority`/`fast_mode`; a missing/null tier is
 *    the engine default `standard`.
 *  - `status`, `billingUnit`, `cachedInputAccounting`: DB spellings already
 *    match the engine domain and pass through after validation.
 *  - `effectiveFrom`/`effectiveTo`/`generatedAt`/`verifiedAt`: DB `Date` →
 *    engine ISO `YYYY-MM-DD` strings.
 *  - `aliases`: DB JSON array → engine `string[]`.
 *  - Monetary rate columns are persisted as PostgreSQL BIGINT / Prisma BigInt
 *    so the database stores values beyond `Number.MAX_SAFE_INTEGER` exactly.
 *    The mapper converts bigint → safe JS number only inside
 *    `[0n, BigInt(Number.MAX_SAFE_INTEGER)]`; anything outside is rejected
 *    with `SNAPSHOT_RATE_OUT_OF_ENGINE_RANGE` (never truncated, never
 *    silently rounded).
 *
 * Snapshot lifecycle is DRAFT / ACTIVE / RETIRED for immutable financial
 * snapshots. `generatedAt` (research/source snapshot date) is distinct from
 * the business validity window (`effectiveFrom`/`effectiveTo`) and the
 * lifecycle timestamps (`publishedAt`/`retiredAt`).
 */

export type ProviderRateCardSnapshotStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';

/**
 * The persisted provider rate-card snapshot row with its nested entries.
 *
 * Structurally mirrors the Prisma model shape (`include: { entries: true }`)
 * so the mapper stays a pure function over plain data with no Prisma runtime
 * dependency, while still being assignable from a Prisma query result.
 */
export interface ProviderRateCardSnapshotRow {
  id: string;
  version: string;
  status: ProviderRateCardSnapshotStatus;
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
  entries: ProviderRateCardEntryRow[];
}

/**
 * The persisted provider rate-card entry row.
 *
 * Monetary rates are `bigint | null` (PostgreSQL BIGINT). NULL means the rate
 * is unpublished/absent; an explicit zero is `0n`. Both must stay distinct
 * through the mapper.
 */
export interface ProviderRateCardEntryRow {
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
}

/** Why a snapshot row could not be mapped to a valid engine rate card. */
export type ProviderRateCardSnapshotMappingErrorCode =
  | 'SNAPSHOT_INVALID'
  | 'SNAPSHOT_MISSING_ENTRIES'
  | 'SNAPSHOT_EMPTY_ENTRIES'
  | 'SNAPSHOT_ENTRY_INVALID'
  | 'SNAPSHOT_ENTRY_INVALID_ALIASES'
  | 'SNAPSHOT_LIFECYCLE_INVALID'
  | 'SNAPSHOT_RATE_OUT_OF_ENGINE_RANGE'
  | 'SNAPSHOT_DUPLICATE_ENTRY_IDENTITY'
  | 'SNAPSHOT_INVALID_INVARIANT';
