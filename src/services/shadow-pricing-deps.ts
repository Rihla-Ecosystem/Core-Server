/**
 * Phase 2F-D shadow pricing dependencies for database rate card comparison.
 *
 * Narrow contract injected into the shadow pricing service.
 * Does not import Prisma directly.
 */

import type { ProviderRateCardLoadResult } from '../services/provider-rate-card-loader.service.js';
import type { ProviderRateCard } from '../types/provider-pricing.js';
import type { ShadowPricingResult } from '../types/provider-pricing.js';
import { ProviderRateCardLoadError } from '../types/provider-rate-card-load.js';
import type { ShadowComparisonStatus } from '../utils/provider-pricing/shadow-comparison.js';

/** Error codes from the loader that we handle in shadow comparison. */
export type ShadowLoaderErrorCode =
  | 'RATE_CARD_NOT_FOUND'
  | 'RATE_CARD_ACTIVE_CONFLICT'
  | 'RATE_CARD_VERSION_NOT_FOUND'
  | 'RATE_CARD_SNAPSHOT_INVALID'
  | 'RATE_CARD_DATABASE_ERROR'
  | 'RATE_CARD_INVALID_VERSION'
  | 'RATE_CARD_INVALID_PRICING_DATE';

/** How the database rate card was selected. */
export type ShadowSelectionMode = 'ACTIVE_DATE' | 'EXPLICIT_VERSION';

/** Runtime pricing source for provider rate cards (Phase 2F-E). */
export type ProviderRateCardPricingSource =
  | 'STATIC'
  | 'DATABASE_SHADOW'
  | 'DATABASE_PRIMARY';

/** Shadow pricing dependencies for database comparison. */
export interface ShadowPricingDependencies {
  /** Whether the database shadow comparison feature is enabled. */
  dbShadowEnabled: boolean;

  /**
   * Effective pricing source (Phase 2F-E). Defaults to the configured
   * `PROVIDER_RATE_CARD_PRICING_SOURCE` (STATIC when unset/malformed).
   * - STATIC: the static card is authoritative; DB is comparison-only when the
   *   shadow flag is enabled.
   * - DATABASE_SHADOW: static remains authoritative and DB shadow comparison is
   *   enabled (equivalent to the 2F-D shadow flag).
   * - DATABASE_PRIMARY: the database rate card is the authoritative source and
   *   static pricing is never used.
   */
  pricingSource?: ProviderRateCardPricingSource;

  /** Load the ACTIVE rate card applicable to a pricing date. */
  loadActiveRateCardForDate?: (pricingDate: string) => Promise<ProviderRateCardLoadResult>;

  /** Load a rate card snapshot by exact version (for recompute). */
  loadRateCardByVersion?: (version: string) => Promise<ProviderRateCardLoadResult>;

  /** Optional clock for comparison duration measurement. */
  now?: () => number;

  /** Optional callback for structured comparison logging. */
  onComparison?: (result: {
    operationId: string;
    comparisonStatus: string;
    selectionMode: ShadowSelectionMode;
    pricingDate: string;
    staticRateCardVersion: string;
    databaseRateCardVersion: string | null;
    staticPricingStatus: string;
    databasePricingStatus: string | null;
    staticTotalCostNanoUsd: string;
    databaseTotalCostNanoUsd: string | null;
    deltaNanoUsd: string | null;
    mismatchFields: string[];
    mismatchCategories: string[];
    loaderErrorCode: string | null;
    providerCallCount: number;
    durationMs: number;
    featureEnabled: boolean;
  }) => void;
}

/** Result of attempting to load a database rate card for shadow comparison. */
export interface ShadowRateCardLoadResult {
  /** The loaded rate card, or null if loading failed. */
  card: ProviderRateCard | null;
  /** The snapshot metadata, or null if loading failed. */
  snapshot: ProviderRateCardLoadResult['snapshot'] | null;
  /** Loader error if loading failed. */
  error: { code: ShadowLoaderErrorCode; status: ShadowComparisonStatus } | null;
  /** Selection mode used. */
  selectionMode: ShadowSelectionMode;
}

/** Map an unexpected loader failure to a stable shadow error + status. */
function mapLoadError(
  err: unknown,
): { code: ShadowLoaderErrorCode; status: ShadowComparisonStatus } {
  if (err instanceof ProviderRateCardLoadError) {
    const code = err.code as ShadowLoaderErrorCode;
    let status: ShadowComparisonStatus;
    switch (code) {
      case 'RATE_CARD_NOT_FOUND':
        status = 'DB_RATE_CARD_NOT_FOUND';
        break;
      case 'RATE_CARD_ACTIVE_CONFLICT':
        status = 'DB_RATE_CARD_ACTIVE_CONFLICT';
        break;
      case 'RATE_CARD_VERSION_NOT_FOUND':
        status = 'DB_RATE_CARD_VERSION_NOT_FOUND';
        break;
      case 'RATE_CARD_SNAPSHOT_INVALID':
        status = 'DB_RATE_CARD_INVALID';
        break;
      case 'RATE_CARD_DATABASE_ERROR':
        status = 'DB_RATE_CARD_ERROR';
        break;
      case 'RATE_CARD_INVALID_VERSION':
      case 'RATE_CARD_INVALID_PRICING_DATE':
        status = 'DB_RATE_CARD_ERROR';
        break;
      default:
        status = 'DB_RATE_CARD_ERROR';
    }
    return { code, status };
  }
  return { code: 'RATE_CARD_DATABASE_ERROR', status: 'DB_RATE_CARD_ERROR' };
}

/** Load a database rate card for shadow comparison with full error handling. */
export async function loadShadowRateCard(
  deps: ShadowPricingDependencies,
  selectionMode: ShadowSelectionMode,
  pricingDateOrVersion: string,
): Promise<ShadowRateCardLoadResult> {
  if (!deps.dbShadowEnabled) {
    return {
      card: null,
      snapshot: null,
      error: null,
      selectionMode,
    };
  }

  try {
    if (selectionMode === 'ACTIVE_DATE') {
      if (!deps.loadActiveRateCardForDate) {
        return {
          card: null,
          snapshot: null,
          error: { code: 'RATE_CARD_DATABASE_ERROR', status: 'DB_RATE_CARD_ERROR' },
          selectionMode,
        };
      }
      const result = await deps.loadActiveRateCardForDate(pricingDateOrVersion);
      return {
        card: result.card,
        snapshot: result.snapshot,
        error: null,
        selectionMode,
      };
    } else {
      if (!deps.loadRateCardByVersion) {
        return {
          card: null,
          snapshot: null,
          error: { code: 'RATE_CARD_DATABASE_ERROR', status: 'DB_RATE_CARD_ERROR' as ShadowComparisonStatus },
          selectionMode,
        };
      }
      const result = await deps.loadRateCardByVersion(pricingDateOrVersion);
      return {
        card: result.card,
        snapshot: result.snapshot,
        error: null,
        selectionMode,
      };
    }
  } catch (err) {
    const mapped = mapLoadError(err);
    return {
      card: null,
      snapshot: null,
      error: mapped,
      selectionMode,
    };
  }
}

/**
 * Load the single ACTIVE database rate card unconditionally (Phase 2F-E
 * DATABASE_PRIMARY authoritative pricing). Unlike `loadShadowRateCard` it is
 * NOT gated by the shadow flag — DATABASE_PRIMARY requires the database card
 * as the pricing source. Error mapping is identical to the shadow path so both
 * modes surface the same stable codes/statuses.
 */
export async function loadPrimaryRateCard(
  deps: ShadowPricingDependencies,
  pricingDate: string,
): Promise<ShadowRateCardLoadResult> {
  if (!deps.loadActiveRateCardForDate) {
    return {
      card: null,
      snapshot: null,
      error: { code: 'RATE_CARD_DATABASE_ERROR', status: 'DB_RATE_CARD_ERROR' },
      selectionMode: 'ACTIVE_DATE',
    };
  }
  try {
    const result = await deps.loadActiveRateCardForDate(pricingDate);
    return {
      card: result.card,
      snapshot: result.snapshot,
      error: null,
      selectionMode: 'ACTIVE_DATE',
    };
  } catch (err) {
    const mapped = mapLoadError(err);
    return {
      card: null,
      snapshot: null,
      error: mapped,
      selectionMode: 'ACTIVE_DATE',
    };
  }
}

/** Default shadow dependencies factory. */
export function createDefaultShadowPricingDependencies(): ShadowPricingDependencies {
  return {
    dbShadowEnabled: false,
    pricingSource: 'STATIC',
    now: () => Date.now(),
  };
}