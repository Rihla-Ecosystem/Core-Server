/**
 * Phase 2D-B/2F-D limited historical recompute preview with database shadow comparison.
 *
 * Reads a bounded selection of existing AiUsageLog rows (purely in read-only
 * mode) and runs each row through the Phase 2C engine ONLY when the row
 * carries complete authoritative pricing identity and usage inputs. Nothing is
 * written, backfilled, migrated, or persisted.
 *
 * Truthfulness rules (locked):
 *  - A historical row is recomputed only when the typed row contract carries
 *    authoritative `provider`, `actualModel`/`requestedModel`, and usage.
 *  - Provider identity is NEVER inferred from model name, source, feature,
 *    current default provider, application configuration, string matching,
 *    `computeAiCost`, or fixed Wallet pricing.
 *  - The legacy AiUsageLog `model` column is a single collapsed value; it is
 *    not definitely the actualModel and not definitely the requestedModel, so
 *    it is never assigned to either.
 *  - The current AiUsageLog schema persists NO provider identity and NO
 *    authoritative model identity, so the production mapper always produces
 *    rows that are skipped. No invented historical cost is ever produced.
 *  - Legacy fixed-price `cost` / `computeAiCost` are never read as pricing
 *    inputs.
 *
 * Database Shadow Comparison (Phase 2F-D):
 *  - When enabled, loads the database rate card for comparison
 *  - Prefers exact version lookup when the row records a rateCardVersion
 *  - Falls back to ACTIVE date selection when no version is recorded
 *  - Comparison is observational only; authoritative result is always static
 *  - Never modifies historical records or billing
 *
 * Explicit per-row outcomes:
 *  - RECOMPUTED_PRICED / RECOMPUTED_UNPRICED
 *  - SKIPPED_MISSING_PROVIDER_IDENTITY
 *  - SKIPPED_MISSING_MODEL_IDENTITY
 *  - SKIPPED_MISSING_USAGE / SKIPPED_INVALID_USAGE
 *  - SKIPPED_UNSUPPORTED_LEGACY_SHAPE
 *
 * Request-level aggregation is NOT available: AiUsageLog has no reliable
 * operationId / request-grouping key. Row-level preview only; no
 * conversation/timestamp/userId/source/model heuristics.
 */

import { aggregateProviderCalls } from '../utils/provider-pricing/aggregate.js';
import { toReportableShadow } from '../utils/provider-pricing/reporting.js';
import { PROVIDER_RATE_CARD } from '../config/provider-rate-card/index.js';
import { compareShadowPricingResults } from '../utils/provider-pricing/shadow-comparison.js';
import type { ShadowComparisonResult, ShadowComparisonStatus } from '../utils/provider-pricing/shadow-comparison.js';
import { loadShadowRateCard, ShadowPricingDependencies } from './shadow-pricing-deps.js';
import { computeShadowPricingMetrics } from './ai-shadow-pricing-metrics.service.js';
import type { ReportableShadow, ReportableReasonCounts } from '../utils/provider-pricing/reporting.js';
import type { UnpricedReason } from '../types/provider-pricing.js';
import { env } from '../config/env.js';

export type RecomputeRowOutcome =
  | 'RECOMPUTED_PRICED'
  | 'RECOMPUTED_UNPRICED'
  | 'SKIPPED_MISSING_PROVIDER_IDENTITY'
  | 'SKIPPED_MISSING_MODEL_IDENTITY'
  | 'SKIPPED_MISSING_USAGE'
  | 'SKIPPED_INVALID_USAGE'
  | 'SKIPPED_UNSUPPORTED_LEGACY_SHAPE';

export type RecomputeSkipReason = Extract<RecomputeRowOutcome, `SKIPPED_${string}`>;
export type RecomputeSkipReasonCounts = Record<RecomputeSkipReason, number>;

/** Database shadow comparison result for a recompute row. */
export interface RecomputeShadowComparison {
  status: ShadowComparisonStatus;
  selectionMode: 'ACTIVE_DATE' | 'EXPLICIT_VERSION';
  staticRateCardVersion: string;
  databaseRateCardVersion: string | null;
  staticTotalCostNanoUsd: string;
  databaseTotalCostNanoUsd: string | null;
  deltaNanoUsd: string | null;
  mismatchCategories: string[];
}

/** Extended historical row with optional recorded rate card version. */
export interface HistoricalPricingRow {
  id: string;
  source: string;
  createdAt: Date;
  /** Authoritative provider identity, or null when the schema cannot supply it. */
  provider: string | null;
  /** Authoritative actual model, or null. */
  actualModel: string | null;
  /** Authoritative requested model, or null. */
  requestedModel: string | null;
  /** Authoritative input token count, or null when not stored. */
  inputTokens: number | null;
  /** Authoritative output token count, or null when not stored. */
  outputTokens: number | null;
  /** Rate card version recorded at the time of the original request (if any). */
  rateCardVersion?: string | null;
  /**
   * True when the row shape is in principle recomputable (a hypothetical
   * future schema with authoritative fields). The current AiUsageLog legacy
   * shape is always false.
   */
  recomputeSupported: boolean;
}

export interface RecomputePreviewOptions {
  from: string;
  to: string;
  limit?: number;
}

export interface RecomputeSelection {
  from: string;
  to: string;
  requestedLimit: number;
  appliedLimit: number;
}

export interface RecomputeRowResult {
  id: string;
  outcome: RecomputeRowOutcome;
  staticReport: ReportableShadow;
  shadowComparison?: RecomputeShadowComparison;
}

export interface RecomputePreviewResult {
  mode: 'READ_ONLY_PREVIEW';
  requestAggregationAvailable: false;
  selection: RecomputeSelection;
  rows: {
    scanned: number;
    recomputedPriced: number;
    recomputedUnpriced: number;
    skipped: number;
    shadowComparisons: {
      match: number;
      mismatch: number;
      dbNotFound: number;
      dbConflict: number;
      dbVersionNotFound: number;
      dbInvalid: number;
      dbError: number;
      dbPricingError: number;
    };
  };
  pricedProviderCost: { nanoUsd: string; microUsd: string; usd: string };
  unpricedReasons: Record<string, number>;
  skipReasons: RecomputeSkipReasonCounts;
  rowResults: RecomputeRowResult[];
  warnings: string[];
}

export interface RecomputeRepository {
  fetchRows(opts: { from: Date; to: Date; limit: number }): Promise<HistoricalPricingRow[]>;
}

const EMPTY_SKIP_REASONS = (): RecomputeSkipReasonCounts => ({
  SKIPPED_MISSING_PROVIDER_IDENTITY: 0,
  SKIPPED_MISSING_MODEL_IDENTITY: 0,
  SKIPPED_MISSING_USAGE: 0,
  SKIPPED_INVALID_USAGE: 0,
  SKIPPED_UNSUPPORTED_LEGACY_SHAPE: 0,
});

const EMPTY_REPORTABLE_REASONS = (): ReportableReasonCounts => ({
  PROVIDER_NOT_IN_RATECARD: 0,
  MODEL_MISSING: 0,
  ACTUAL_MODEL_NOT_IN_RATECARD: 0,
  REQUESTED_MODEL_NOT_IN_RATECARD: 0,
  USAGE_MISSING: 0,
  USAGE_INVALID: 0,
  RATE_NOT_ACTIVE: 0,
  UNIT_UNPRICED: 0,
  MODALITY_INVALID: 0,
  OVERFLOW: 0,
});

function isNonNegativeInteger(value: number | null): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Classify one typed historical row into an outcome (or the internal
 * `ELIGIBLE` sentinel meaning the row can be recomputed). Pure and
 * deterministic.
 */
export function classifyRecomputeRow(row: HistoricalPricingRow): RecomputeRowOutcome | 'ELIGIBLE' {
  if (!row.recomputeSupported) {
    return 'SKIPPED_UNSUPPORTED_LEGACY_SHAPE';
  }
  if (!row.provider) {
    return 'SKIPPED_MISSING_PROVIDER_IDENTITY';
  }
  if (!row.actualModel && !row.requestedModel) {
    return 'SKIPPED_MISSING_MODEL_IDENTITY';
  }
  if (row.inputTokens === null && row.outputTokens === null) {
    return 'SKIPPED_MISSING_USAGE';
  }
  if ((row.inputTokens !== null && !isNonNegativeInteger(row.inputTokens)) ||
      (row.outputTokens !== null && !isNonNegativeInteger(row.outputTokens))) {
    return 'SKIPPED_INVALID_USAGE';
  }
  return 'ELIGIBLE';
}

/** Build shadow comparison for a recompute row. */
async function buildRecomputeShadowComparison(
  deps: ShadowPricingDependencies,
  staticResult: ReturnType<typeof aggregateProviderCalls>,
  providerCalls: unknown,
  pricingDate: string,
  recordedVersion: string | null | undefined,
  staticRateCardVersion: string,
): Promise<RecomputeShadowComparison | undefined> {
  const shadowEnabled = deps.dbShadowEnabled || deps.pricingSource === 'DATABASE_SHADOW';
  if (!shadowEnabled) return undefined;

  const selectionMode = recordedVersion ? 'EXPLICIT_VERSION' : 'ACTIVE_DATE';
  const lookupKey = recordedVersion ?? pricingDate;

  const loadResult = await loadShadowRateCard(deps, selectionMode, lookupKey);
  let dbResult: ReturnType<typeof aggregateProviderCalls> | null = null;
  let dbRateCardVersion: string | null = loadResult.snapshot?.version ?? null;

  if (loadResult.card && !loadResult.error) {
    const dbInput = {
      providerCalls,
      pricingDate,
      card: loadResult.card,
    };
    dbResult = aggregateProviderCalls(dbInput);
  }

  const comparison = compareShadowPricingResults(
    staticResult,
    dbResult,
    loadResult.error,
    selectionMode,
    pricingDate,
    staticRateCardVersion,
    dbRateCardVersion,
    0, // duration not measured per-row in recompute
    true,
    PROVIDER_RATE_CARD,
    loadResult.card,
  );

  return {
    status: comparison.status,
    selectionMode,
    staticRateCardVersion: comparison.aggregate.staticRateCardVersion,
    databaseRateCardVersion: comparison.aggregate.dbRateCardVersion,
    staticTotalCostNanoUsd: comparison.aggregate.staticTotalCostNanoUsd.toString(),
    databaseTotalCostNanoUsd: comparison.aggregate.dbTotalCostNanoUsd?.toString() ?? null,
    deltaNanoUsd: comparison.aggregate.deltaNanoUsd?.toString() ?? null,
    mismatchCategories: comparison.mismatchCategories,
  };
}

/**
 * Pure recompute over typed historical rows with optional database shadow comparison.
 * Requires an injectable repository so focused tests use fakes and never touch the database.
 */
export async function recomputePreview(
  deps: { repository: RecomputeRepository; shadowDeps?: ShadowPricingDependencies },
  options: RecomputePreviewOptions,
): Promise<RecomputePreviewResult> {
  const requestedLimit = options.limit ?? 100;
  const appliedLimit = Math.max(1, Math.min(requestedLimit, 500));

  const fromDate = new Date(options.from);
  const toDate = new Date(options.to);

  const rows = await deps.repository.fetchRows({ from: fromDate, to: toDate, limit: appliedLimit });

  const outcomes: Record<RecomputeRowOutcome, number> = {
    RECOMPUTED_PRICED: 0,
    RECOMPUTED_UNPRICED: 0,
    ...EMPTY_SKIP_REASONS(),
  };
  const unpricedReasonCounts: Record<string, number> = {};
  const miniObs: Array<{ observedAt: string; source: string; report: ReportableShadow }> = [];
  const rowResults: RecomputeRowResult[] = [];

  const shadowCounts = {
    match: 0,
    mismatch: 0,
    dbNotFound: 0,
    dbConflict: 0,
    dbVersionNotFound: 0,
    dbInvalid: 0,
    dbError: 0,
    dbPricingError: 0,
  };

  const shadowDeps: ShadowPricingDependencies = {
    ...createDefaultShadowPricingDependencies(),
    ...deps.shadowDeps,
    dbShadowEnabled:
      deps.shadowDeps?.dbShadowEnabled ??
      env.PROVIDER_RATE_CARD_DB_SHADOW_ENABLED,
    pricingSource:
      deps.shadowDeps?.pricingSource ?? env.PROVIDER_RATE_CARD_PRICING_SOURCE,
  };

  for (const row of rows) {
    const classification = classifyRecomputeRow(row);

    if (classification === 'ELIGIBLE') {
      // Authoritative provider + model + usage are all present on the typed row.
      const staticResult = aggregateProviderCalls({
        providerCalls: [{
          provider: row.provider,
          providerCallMade: true,
          providerCallId: `recompute-${row.id}`,
          actualModel: row.actualModel ?? undefined,
          requestedModel: row.requestedModel ?? undefined,
          inputTokens: row.inputTokens ?? 0,
          outputTokens: row.outputTokens ?? 0,
        }],
        pricingDate: row.createdAt.toISOString().slice(0, 10),
      });

      const staticReport = toReportableShadow(staticResult, PROVIDER_RATE_CARD.version);
      miniObs.push({
        observedAt: row.createdAt.toISOString(),
        source: row.source,
        report: staticReport,
      });

      // Build database shadow comparison
      const providerCallsForComparison = [{
        provider: row.provider,
        providerCallMade: true,
        providerCallId: `recompute-${row.id}`,
        actualModel: row.actualModel ?? undefined,
        requestedModel: row.requestedModel ?? undefined,
        inputTokens: row.inputTokens ?? 0,
        outputTokens: row.outputTokens ?? 0,
      }];

      const shadowComparison = await buildRecomputeShadowComparison(
        shadowDeps,
        staticResult,
        providerCallsForComparison,
        row.createdAt.toISOString().slice(0, 10),
        row.rateCardVersion,
        PROVIDER_RATE_CARD.version,
      );

      if (shadowComparison) {
        switch (shadowComparison.status) {
          case 'MATCH':
            shadowCounts.match += 1;
            break;
          case 'MISMATCH':
            shadowCounts.mismatch += 1;
            break;
          case 'DB_RATE_CARD_NOT_FOUND':
            shadowCounts.dbNotFound += 1;
            break;
          case 'DB_RATE_CARD_ACTIVE_CONFLICT':
            shadowCounts.dbConflict += 1;
            break;
          case 'DB_RATE_CARD_VERSION_NOT_FOUND':
            shadowCounts.dbVersionNotFound += 1;
            break;
          case 'DB_RATE_CARD_INVALID':
            shadowCounts.dbInvalid += 1;
            break;
          case 'DB_RATE_CARD_ERROR':
            shadowCounts.dbError += 1;
            break;
          case 'DB_PRICING_ERROR':
            shadowCounts.dbPricingError += 1;
            break;
        }
      }

      rowResults.push({
        id: row.id,
        outcome: staticResult.totals.pricedCallCount > 0 ? 'RECOMPUTED_PRICED' : 'RECOMPUTED_UNPRICED',
        staticReport,
        shadowComparison,
      });

      if (staticResult.totals.pricedCallCount > 0) {
        outcomes.RECOMPUTED_PRICED += 1;
      } else {
        outcomes.RECOMPUTED_UNPRICED += 1;
        for (const call of staticResult.calls) {
          if (call.kind === 'UNPRICED') {
            unpricedReasonCounts[call.reason] = (unpricedReasonCounts[call.reason] ?? 0) + 1;
          }
        }
      }
      continue;
    }

    outcomes[classification] += 1;
    rowResults.push({
      id: row.id,
      outcome: classification,
      staticReport: {
        pricedAt: new Date().toISOString(),
        noProviderCalls: false,
        summaryStatus: 'UNPRICED',
        calls: [],
        totals: {
          callCount: 0,
          pricedCallCount: 0,
          unpricedCallCount: 0,
          unpricedReasons: EMPTY_REPORTABLE_REASONS(),
          pricedCostNanoUsd: '0',
          pricedCostMicroUsd: '0',
          pricedCostUsd: '0',
        },
        rateCardVersion: PROVIDER_RATE_CARD.version,
      },
    });
  }

  const metrics = computeShadowPricingMetrics(miniObs, { capacity: appliedLimit });

  const skipReasons: RecomputeSkipReasonCounts = EMPTY_SKIP_REASONS();
  let skipped = 0;
  const skipKeys = Object.keys(skipReasons) as RecomputeSkipReason[];
  for (const key of skipKeys) {
    skipReasons[key] = outcomes[key];
    skipped += outcomes[key];
  }

  return {
    mode: 'READ_ONLY_PREVIEW',
    requestAggregationAvailable: false,
    selection: {
      from: options.from,
      to: options.to,
      requestedLimit,
      appliedLimit,
    },
    rows: {
      scanned: rows.length,
      recomputedPriced: outcomes.RECOMPUTED_PRICED,
      recomputedUnpriced: outcomes.RECOMPUTED_UNPRICED,
      skipped,
      shadowComparisons: shadowCounts,
    },
    pricedProviderCost: metrics.pricedProviderCost,
    unpricedReasons: unpricedReasonCounts,
    skipReasons,
    rowResults,
    warnings: [
      'READ_ONLY_PREVIEW: this is a read-only preview',
      'READ_ONLY_PREVIEW: no database data was changed',
      'priced provider cost excludes unresolved/skipped historical usage',
      'request aggregation is unavailable without an authoritative request grouping key',
      'no provider or model identity was inferred for any historical row',
    ],
  };
}

/** Minimal Prisma AiUsageLog row shape the mapper reads (no cost fields). */
export interface AiUsageLogRowSource {
  id: string;
  source: string;
  createdAt: Date;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Map one Prisma AiUsageLog row into the typed historical row contract.
 *
 * The current legacy schema has no provider column and only a single collapsed
 * `model` column (not definitely actual and not definitely requested), so the
 * mapped row is ALWAYS classified as an unsupported legacy shape and never
 * recomputed. Legacy `cost` is never read as a pricing input.
 */
export function toHistoricalPricingRow(row: AiUsageLogRowSource): HistoricalPricingRow {
  return {
    id: row.id,
    source: row.source,
    createdAt: row.createdAt,
    provider: null,
    actualModel: null,
    requestedModel: null,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    rateCardVersion: null,
    recomputeSupported: false,
  };
}

/** Default shadow dependencies factory for recompute. */
function createDefaultShadowPricingDependencies(): ShadowPricingDependencies {
  return {
    dbShadowEnabled: false,
    pricingSource: 'STATIC',
    now: () => Date.now(),
  };
}