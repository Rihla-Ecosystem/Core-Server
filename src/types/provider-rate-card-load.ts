/**
 * Phase 2F-B repository/loader error contract for database rate cards.
 *
 * Pure types + one stable `ProviderRateCardLoadError` class. Carries no
 * Prisma import, no repository, no Pricing Engine, and no runtime wiring, so
 * both the repository and the loader can raise/consume it without coupling.
 *
 * Error metadata is limited to safe diagnostic values: pricing date, snapshot
 * version, conflicting snapshot versions/count, and the underlying mapper
 * stable code. Credentials, connection URLs, raw SQL, and full rate-card
 * contents are never attached.
 */

import type { ProviderRateCardSnapshotMappingErrorCode } from './provider-pricing-snapshot.js';

/** Stable repository/loader error codes (Phase 2F-B). */
export type ProviderRateCardLoadErrorCode =
  | 'RATE_CARD_NOT_FOUND'
  | 'RATE_CARD_ACTIVE_CONFLICT'
  | 'RATE_CARD_VERSION_NOT_FOUND'
  | 'RATE_CARD_INVALID_PRICING_DATE'
  | 'RATE_CARD_INVALID_VERSION'
  | 'RATE_CARD_SNAPSHOT_INVALID'
  | 'RATE_CARD_DATABASE_ERROR';

export interface ProviderRateCardLoadErrorOptions {
  /** Pricing date involved in a not-found/conflict/invalid-date failure. */
  pricingDate?: string;
  /** Snapshot version involved in a not-found/invalid-version failure. */
  version?: string;
  /** Versions of the ACTIVE snapshots that overlap the pricing date. */
  snapshotVersions?: string[];
  /** Number of matching ACTIVE snapshots when known. */
  snapshotCount?: number;
  /** The underlying pure-mapper stable code for SNAPSHOT_INVALID. */
  mapperCode?: ProviderRateCardSnapshotMappingErrorCode | string;
  /** Original cause; never serialized. */
  cause?: unknown;
}

/** Raised by the rate-card repository/loader on a stable failure. */
export class ProviderRateCardLoadError extends Error {
  readonly code: ProviderRateCardLoadErrorCode;
  readonly pricingDate?: string;
  readonly version?: string;
  readonly snapshotVersions?: string[];
  readonly snapshotCount?: number;
  readonly mapperCode?: ProviderRateCardSnapshotMappingErrorCode | string;
  readonly cause?: unknown;

  constructor(
    code: ProviderRateCardLoadErrorCode,
    message: string,
    options: ProviderRateCardLoadErrorOptions = {},
  ) {
    super(message);
    this.name = 'ProviderRateCardLoadError';
    this.code = code;
    this.pricingDate = options.pricingDate;
    this.version = options.version;
    this.snapshotVersions = options.snapshotVersions;
    this.snapshotCount = options.snapshotCount;
    this.mapperCode = options.mapperCode;
    this.cause = options.cause;
  }
}
