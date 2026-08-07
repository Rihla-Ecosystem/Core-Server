/**
 * Phase 2F-C Admin error contract for the rate-card Draft / Import /
 * Validate / Publish / Retire workflow.
 *
 * Pure types + one stable `ProviderRateCardAdminError` class. Carries no
 * Prisma import, no repository, no Pricing Engine, and no runtime wiring, so
 * the admin repository and the admin service can raise/consume it without
 * coupling. The HTTP mapping to a status code lives in the pure
 * `providerRateCardAdminStatus` helper so controllers, middleware, and tests
 * agree on one mapping.
 *
 * Error metadata is limited to safe diagnostic values: snapshot version,
 * effective-window reason, the underlying pure-mapper stable code, entry
 * counts, and conflicting snapshot versions/counts. Credentials, connection
 * URLs, raw SQL, and full rate-card contents are never attached.
 */

import type { ProviderRateCardSnapshotMappingErrorCode } from './provider-pricing-snapshot.js';

/** Stable Admin error codes (Phase 2F-C). */
export type ProviderRateCardAdminErrorCode =
  | 'RATE_CARD_ADMIN_INVALID_VERSION'
  | 'RATE_CARD_ADMIN_VERSION_TAKEN'
  | 'RATE_CARD_ADMIN_NOT_FOUND'
  | 'RATE_CARD_ADMIN_ENTRY_NOT_FOUND'
  | 'RATE_CARD_ADMIN_INVALID_PAYLOAD'
  | 'RATE_CARD_ADMIN_DUPLICATE_IDENTITY'
  | 'RATE_CARD_ADMIN_INVALID_WINDOW'
  | 'RATE_CARD_ADMIN_DRAFT_REQUIRED'
  | 'RATE_CARD_ADMIN_ACTIVE_REQUIRED'
  | 'RATE_CARD_ADMIN_IMMUTABLE'
  | 'RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE'
  | 'RATE_CARD_ADMIN_PUBLISH_CONFLICT'
  | 'RATE_CARD_ADMIN_REPLACEMENT_VERSION_MISMATCH'
  | 'RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT'
  | 'RATE_CARD_ADMIN_DATABASE_ERROR';

export interface ProviderRateCardAdminErrorOptions {
  /** Snapshot version involved in the failure. */
  version?: string;
  /** Human-readable validation/window reason. */
  reason?: string;
  /** The underlying pure-mapper stable code for DRAFT_NOT_PUBLISHABLE. */
  mapperCode?: ProviderRateCardSnapshotMappingErrorCode | string;
  /** Number of entries involved in an import/publish. */
  entryCount?: number;
  /** Number of ACTIVE snapshots overlapping the publish window. */
  snapshotCount?: number;
  /** Versions of the ACTIVE snapshots that overlap the publish window. */
  conflictingVersions?: string[];
  /** Original cause; never serialized. */
  cause?: unknown;
}

/** Raised by the rate-card Admin repository/service on a stable failure. */
export class ProviderRateCardAdminError extends Error {
  readonly code: ProviderRateCardAdminErrorCode;
  readonly version?: string;
  readonly reason?: string;
  readonly mapperCode?: ProviderRateCardSnapshotMappingErrorCode | string;
  readonly entryCount?: number;
  readonly snapshotCount?: number;
  readonly conflictingVersions?: string[];
  readonly cause?: unknown;

  constructor(
    code: ProviderRateCardAdminErrorCode,
    message: string,
    options: ProviderRateCardAdminErrorOptions = {},
  ) {
    super(message);
    this.name = 'ProviderRateCardAdminError';
    this.code = code;
    this.version = options.version;
    this.reason = options.reason;
    this.mapperCode = options.mapperCode;
    this.entryCount = options.entryCount;
    this.snapshotCount = options.snapshotCount;
    this.conflictingVersions = options.conflictingVersions;
    this.cause = options.cause;
  }
}

/**
 * Pure HTTP status mapping for the Admin error contract. 4xx for user/state
 * errors, 5xx only for unexpected database failures.
 */
export function providerRateCardAdminStatus(code: ProviderRateCardAdminErrorCode): number {
  switch (code) {
    case 'RATE_CARD_ADMIN_INVALID_VERSION':
    case 'RATE_CARD_ADMIN_INVALID_PAYLOAD':
    case 'RATE_CARD_ADMIN_DUPLICATE_IDENTITY':
    case 'RATE_CARD_ADMIN_INVALID_WINDOW':
    case 'RATE_CARD_ADMIN_DRAFT_NOT_PUBLISHABLE':
      return 400;
    case 'RATE_CARD_ADMIN_VERSION_TAKEN':
    case 'RATE_CARD_ADMIN_DRAFT_REQUIRED':
    case 'RATE_CARD_ADMIN_ACTIVE_REQUIRED':
    case 'RATE_CARD_ADMIN_IMMUTABLE':
    case 'RATE_CARD_ADMIN_PUBLISH_CONFLICT':
    case 'RATE_CARD_ADMIN_REPLACEMENT_VERSION_MISMATCH':
    case 'RATE_CARD_ADMIN_STATIC_IMPORT_CONFLICT':
      return 409;
    case 'RATE_CARD_ADMIN_NOT_FOUND':
    case 'RATE_CARD_ADMIN_ENTRY_NOT_FOUND':
      return 404;
    case 'RATE_CARD_ADMIN_DATABASE_ERROR':
      return 500;
  }
}
