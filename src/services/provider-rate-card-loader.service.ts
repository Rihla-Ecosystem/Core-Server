/**
 * Phase 2F-B database Rate Card loader service.
 *
 * Pure orchestration over the repository: persisted row → existing pure mapper
 * → the existing Pricing Engine `ProviderRateCard` contract. The loader:
 *  - validates the canonical pricing date (`YYYY-MM-DD`) and version;
 *  - calls the repository only through its injected abstraction (never Prisma);
 *  - converts repository row-level outcomes into stable domain errors;
 *  - preserves the mapper's stable error code as safe metadata;
 *  - builds fresh output objects (never leaks mutable Prisma references);
 *  - does NOT import the static PROVIDER_RATE_CARD, does NOT implement a
 *    fallback, does NOT cache, and does NOT perform pricing arithmetic,
 *    model selection, or any database write.
 */

import type { ProviderRateCard } from '../types/provider-pricing.js';
import type { ProviderRateCardSnapshotStatus } from '../types/provider-pricing-snapshot.js';
import { ProviderRateCardLoadError } from '../types/provider-rate-card-load.js';
import type { ProviderRateCardLoadErrorOptions } from '../types/provider-rate-card-load.js';
import { ProviderRateCardSnapshotError } from '../utils/provider-pricing/snapshot.js';
import { mapProviderRateCardSnapshot } from '../utils/provider-pricing/snapshot.js';
import { isoDateOf } from '../utils/provider-pricing/snapshot.js';
import { normalizePricingDate } from '../utils/provider-rate-card-date.js';
import type {
  ProviderRateCardRepository,
  ActiveSnapshotSelection,
} from '../repositories/provider-rate-card.repository.js';

/** Safe snapshot metadata exposed by the loader (fresh plain object). */
export interface ProviderRateCardSnapshotMetadata {
  id: string;
  version: string;
  status: ProviderRateCardSnapshotStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  publishedAt: string | null;
  retiredAt: string | null;
}

/** Successful loader result: engine card + providers + safe snapshot metadata. */
export interface ProviderRateCardLoadResult {
  card: ProviderRateCard;
  providers: string[];
  snapshot: ProviderRateCardSnapshotMetadata;
}

export interface ProviderRateCardLoaderDependencies {
  repository: ProviderRateCardRepository;
}

function loadError(
  code: ProviderRateCardLoadError['code'],
  message: string,
  options: ProviderRateCardLoadErrorOptions = {},
): ProviderRateCardLoadError {
  return new ProviderRateCardLoadError(code, message, options);
}

function isSnapshotStatus(value: string): value is ProviderRateCardSnapshotStatus {
  return value === 'DRAFT' || value === 'ACTIVE' || value === 'RETIRED';
}

function metadataFromRow(row: {
  id: string;
  version: string;
  status: string;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  publishedAt: Date | null;
  retiredAt: Date | null;
}): ProviderRateCardSnapshotMetadata {
  return {
    id: row.id,
    version: row.version,
    status: isSnapshotStatus(row.status) ? row.status : 'DRAFT',
    effectiveFrom: row.effectiveFrom ? isoDateOf(row.effectiveFrom) : null,
    effectiveTo: row.effectiveTo ? isoDateOf(row.effectiveTo) : null,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
  };
}

function mapRowToResult(row: {
  id: string;
  version: string;
  status: string;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  publishedAt: Date | null;
  retiredAt: Date | null;
  entries: unknown[];
}): ProviderRateCardLoadResult {
  let mapped: { card: ProviderRateCard; providers: string[] };
  try {
    mapped = mapProviderRateCardSnapshot(row);
  } catch (err) {
    if (err instanceof ProviderRateCardSnapshotError) {
      throw loadError(
        'RATE_CARD_SNAPSHOT_INVALID',
        `rate card snapshot "${row.version}" could not be mapped to a valid engine rate card`,
        { version: row.version, mapperCode: err.code, cause: err },
      );
    }
    throw loadError(
      'RATE_CARD_SNAPSHOT_INVALID',
      `rate card snapshot "${row.version}" could not be mapped`,
      { version: row.version, cause: err },
    );
  }
  return {
    card: mapped.card,
    providers: mapped.providers,
    snapshot: metadataFromRow(row),
  };
}

function toResult(selection: ActiveSnapshotSelection, pricingDate: string): ProviderRateCardLoadResult {
  switch (selection.kind) {
    case 'found':
      return mapRowToResult(selection.snapshot);
    case 'none':
      throw loadError(
        'RATE_CARD_NOT_FOUND',
        `no active rate card applies to pricing date ${pricingDate}`,
        { pricingDate },
      );
    case 'conflict':
      throw loadError(
        'RATE_CARD_ACTIVE_CONFLICT',
        `more than one active rate card applies to pricing date ${pricingDate}`,
        {
          pricingDate,
          snapshotVersions: selection.versions,
          snapshotCount: selection.count,
        },
      );
  }
}

/** Build the default loader dependencies backed by the Prisma repository. */
export function createDefaultProviderRateCardLoaderDependencies(
  repository: ProviderRateCardRepository,
): ProviderRateCardLoaderDependencies {
  return { repository };
}

/** Validate a version string and return it trimmed, or throw a stable error. */
function requireVersion(version: string): string {
  if (typeof version !== 'string' || version.trim().length === 0) {
    throw loadError('RATE_CARD_INVALID_VERSION', 'rate card version must be a non-empty string');
  }
  return version.trim();
}

/**
 * Run a repository read and convert an unexpected (non-stable) failure into
 * RATE_CARD_DATABASE_ERROR. A stable `ProviderRateCardLoadError` raised by the
 * repository is rethrown unchanged — never reclassified.
 */
async function repositoryRead<T>(
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ProviderRateCardLoadError) {
      throw err;
    }
    throw loadError(
      'RATE_CARD_DATABASE_ERROR',
      `${operation} failed`,
      { cause: err },
    );
  }
}

/**
 * Load the single ACTIVE rate card applicable to `pricingDate`.
 *
 * Returns `{ card, providers, snapshot }`. Throws `ProviderRateCardLoadError`:
 *  - RATE_CARD_INVALID_PRICING_DATE for a malformed/invalid date;
 *  - RATE_CARD_NOT_FOUND when no ACTIVE snapshot applies;
 *  - RATE_CARD_ACTIVE_CONFLICT when overlapping ACTIVE snapshots apply;
 *  - RATE_CARD_SNAPSHOT_INVALID when the pure mapper rejects the row;
 *  - RATE_CARD_DATABASE_ERROR when the repository hits an unexpected failure.
 */
export async function loadActiveRateCardForDate(
  deps: ProviderRateCardLoaderDependencies,
  pricingDate: string,
): Promise<ProviderRateCardLoadResult> {
  const normalized = normalizePricingDate(pricingDate);
  const selection = await repositoryRead('active rate card lookup', () =>
    deps.repository.findActiveSnapshotForDate(normalized),
  );
  return toResult(selection, normalized);
}

/**
 * Load any rate card snapshot by immutable version (DRAFT/ACTIVE/RETIRED).
 *
 * Throws `ProviderRateCardLoadError`:
 *  - RATE_CARD_INVALID_VERSION for a blank/structurally invalid version;
 *  - RATE_CARD_VERSION_NOT_FOUND when no snapshot has that version;
 *  - RATE_CARD_SNAPSHOT_INVALID when the pure mapper rejects the row;
 *  - RATE_CARD_DATABASE_ERROR when the repository hits an unexpected failure.
 */
export async function loadRateCardByVersion(
  deps: ProviderRateCardLoaderDependencies,
  version: string,
): Promise<ProviderRateCardLoadResult> {
  const normalized = requireVersion(version);
  const row = await repositoryRead('rate card version lookup', () =>
    deps.repository.findSnapshotByVersion(normalized),
  );
  if (row === null) {
    throw loadError('RATE_CARD_VERSION_NOT_FOUND', `rate card version "${normalized}" was not found`, {
      version: normalized,
    });
  }
  return mapRowToResult(row);
}

export { ProviderRateCardLoadError };
