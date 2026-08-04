/**
 * Phase 2D-B pure metrics aggregation over in-memory shadow observations.
 *
 * Reads from an immutable snapshot of `ShadowPricingObservation[]` and produces
 * a JSON-safe aggregate result. Never mutates the snapshot or the buffer.
 *
 * Request buckets (mutually exclusive, sum to `requests.totalObserved`):
 *  - `FULLY_PRICED`          — at least one real call, all priced
 *  - `PARTIALLY_PRICED`      — at least one real call, some priced
 *  - `UNPRICED`              — at least one real call, none priced
 *  - `ZERO_PROVIDER_CALLS`   — an explicit authoritative zero-call request
 *    (cache hit). NOT a pricing failure and never counted as UNPRICED even
 *    though the engine reports `summaryStatus = "UNPRICED"` for it.
 *
 * Coverage rules (locked):
 *  - Coverage uses real authoritative provider calls only:
 *    pricedCalls / (pricedCalls + unpricedCalls). Zero-call observations are
 *    excluded from the denominator.
 *  - When the denominator is zero: coverageAvailable = false and
 *    coverageBasisPoints / coveragePercent are null (never 0, NaN, Infinity).
 *  - Basis points use integer arithmetic: Math.round(pricedCalls * 10000 /
 *    totalRealCalls). The deterministic rounding rule is round-half-away-from-
 *    zero (JavaScript `Math.round`). All operands stay far below 2^53 so no
 *    floating-point ambiguity is possible.
 *  - `coveragePercent` is the exact two-decimal string of basisPoints/100.
 *
 * Cost rules (locked):
 *  - Money is aggregated internally as bigint nUSD and exposed only as exact
 *    decimal strings (nanoUsd / microUsd / usd).
 *  - Only PRICED calls contribute cost. UNPRICED calls have UNKNOWN cost and
 *    are never treated as zero actual cost.
 *  - Breakdowns (bySource / byProvider / byModel) carry a pricedProviderCost.
 *
 * rateCardVersions semantics (locked):
 *  - Counts observations produced under each `report.rateCardVersion`, exactly
 *    once per observation — including zero-call observations. A single
 *    observation with multiple calls is still counted once.
 *
 * Money is always strings (never raw bigint).
 */

import { ceilDiv, NANO_PER_MICRO, nanoUsdToUsdString } from '../utils/provider-pricing/arithmetic.js';
import type { RequestSummaryStatus, UnpricedReason } from '../types/provider-pricing.js';
import type { ReportableShadow } from '../utils/provider-pricing/reporting.js';
import type { ShadowPricingObservation } from './ai-shadow-pricing-observation.service.js';

/** Mutually exclusive request-level buckets used by admin metrics/views. */
export type RequestCategory =
  | 'FULLY_PRICED'
  | 'PARTIALLY_PRICED'
  | 'UNPRICED'
  | 'ZERO_PROVIDER_CALLS';

/**
 * Deterministic request category for one observation.
 *
 * A `noProviderCalls` observation is a legitimate cache hit, not an unpriced
 * failure, regardless of the engine's `summaryStatus`.
 */
export function requestCategoryOf(report: ReportableShadow): RequestCategory {
  if (report.noProviderCalls) return 'ZERO_PROVIDER_CALLS';
  return report.summaryStatus as RequestCategory;
}

const ALL_UNPRICED_REASONS: readonly UnpricedReason[] = [
  'PROVIDER_NOT_IN_RATECARD',
  'MODEL_MISSING',
  'ACTUAL_MODEL_NOT_IN_RATECARD',
  'REQUESTED_MODEL_NOT_IN_RATECARD',
  'USAGE_MISSING',
  'USAGE_INVALID',
  'RATE_NOT_ACTIVE',
  'UNIT_UNPRICED',
  'MODALITY_INVALID',
  'OVERFLOW',
];

export interface MetricsMoney {
  nanoUsd: string;
  microUsd: string;
  usd: string;
}

export interface MetricsWindow {
  storage: 'IN_MEMORY';
  ephemeral: true;
  perProcess: true;
  capacity: number;
  retainedObservations: number;
  oldestObservedAt?: string;
  newestObservedAt?: string;
}

export interface MetricsRequests {
  totalObserved: number;
  fullyPriced: number;
  partiallyPriced: number;
  unpriced: number;
  zeroProviderCalls: number;
}

export interface MetricsProviderCalls {
  totalRealCalls: number;
  pricedCalls: number;
  unpricedCalls: number;
  coverageAvailable: boolean;
  coverageBasisPoints: number | null;
  coveragePercent: string | null;
}

export interface MetricsSourceBreakdown {
  source: string;
  totalObserved: number;
  fullyPriced: number;
  partiallyPriced: number;
  unpriced: number;
  zeroProviderCalls: number;
  pricedProviderCost: MetricsMoney;
}

export interface MetricsProviderBreakdown {
  provider: string;
  totalRealCalls: number;
  pricedCalls: number;
  unpricedCalls: number;
  pricedProviderCost: MetricsMoney;
}

export interface MetricsModelBreakdown {
  model: string;
  totalRealCalls: number;
  pricedCalls: number;
  unpricedCalls: number;
  pricedProviderCost: MetricsMoney;
}

export interface MetricsStatusBreakdown {
  summaryStatus: RequestSummaryStatus;
  count: number;
}

export interface MetricsRateCardVersion {
  version: string;
  count: number;
}

export interface ShadowPricingMetrics {
  generatedAt: string;
  window: MetricsWindow;
  requests: MetricsRequests;
  providerCalls: MetricsProviderCalls;
  pricedProviderCost: MetricsMoney;
  unpricedReasons: Record<string, number>;
  bySource: MetricsSourceBreakdown[];
  byProvider: MetricsProviderBreakdown[];
  byModel: MetricsModelBreakdown[];
  bySummaryStatus: MetricsStatusBreakdown[];
  rateCardVersions: MetricsRateCardVersion[];
}

/** Output boundary: exact decimal strings from one non-negative nUSD bigint. */
function money(totalNanoUsd: bigint): MetricsMoney {
  return {
    nanoUsd: totalNanoUsd.toString(),
    microUsd: ceilDiv(totalNanoUsd, NANO_PER_MICRO).toString(),
    usd: nanoUsdToUsdString(totalNanoUsd),
  };
}

function sumPricedCost(observations: readonly ShadowPricingObservation[]): bigint {
  let total = 0n;
  for (const obs of observations) {
    for (const call of obs.report.calls) {
      if (call.kind === 'PRICED') {
        total += BigInt(call.costNanoUsd);
      }
    }
  }
  return total;
}

/**
 * Deterministic coverage basis points using integer arithmetic:
 * Math.round(pricedCalls * 10000 / totalRealCalls). Round-half-away-from-zero.
 */
function computeCoverage(priced: number, unpriced: number): {
  coverageAvailable: boolean;
  coverageBasisPoints: number | null;
  coveragePercent: string | null;
} {
  const totalRealCalls = priced + unpriced;
  if (totalRealCalls === 0) {
    return { coverageAvailable: false, coverageBasisPoints: null, coveragePercent: null };
  }
  const numerator = priced * 10_000;
  const basisPoints = Math.round(numerator / totalRealCalls);
  const percent = (basisPoints / 100).toFixed(2);
  return { coverageAvailable: true, coverageBasisPoints: basisPoints, coveragePercent: percent };
}

function incrementSource(
  map: Map<string, MetricsSourceBreakdown>,
  source: string,
  category: RequestCategory,
  cost: bigint,
): void {
  let entry = map.get(source);
  if (!entry) {
    entry = {
      source,
      totalObserved: 0,
      fullyPriced: 0,
      partiallyPriced: 0,
      unpriced: 0,
      zeroProviderCalls: 0,
      pricedProviderCost: money(0n),
    };
    map.set(source, entry);
  }
  entry.totalObserved += 1;
  if (category === 'FULLY_PRICED') entry.fullyPriced += 1;
  else if (category === 'PARTIALLY_PRICED') entry.partiallyPriced += 1;
  else if (category === 'UNPRICED') entry.unpriced += 1;
  else entry.zeroProviderCalls += 1;
  entry.pricedProviderCost = money(BigInt(entry.pricedProviderCost.nanoUsd) + cost);
}

interface CallBreakdown {
  totalRealCalls: number;
  pricedCalls: number;
  unpricedCalls: number;
  pricedCostNanoUsd: bigint;
}

function incrementCallBreakdown(
  map: Map<string, CallBreakdown>,
  key: string,
  kind: 'PRICED' | 'UNPRICED',
  costNanoUsd: bigint,
): void {
  let entry = map.get(key);
  if (!entry) {
    entry = { totalRealCalls: 0, pricedCalls: 0, unpricedCalls: 0, pricedCostNanoUsd: 0n };
    map.set(key, entry);
  }
  entry.totalRealCalls += 1;
  if (kind === 'PRICED') {
    entry.pricedCalls += 1;
    entry.pricedCostNanoUsd += costNanoUsd;
  } else {
    entry.unpricedCalls += 1;
  }
}

export function computeShadowPricingMetrics(
  snapshot: readonly ShadowPricingObservation[],
  options?: { generatedAt?: string; capacity?: number },
): ShadowPricingMetrics {
  const generatedAt = options?.generatedAt ?? new Date().toISOString();
  const capacity = options?.capacity ?? 500;

  let totalObserved = 0;
  let fullyPriced = 0;
  let partiallyPriced = 0;
  let unpriced = 0;
  let zeroProviderCalls = 0;
  let totalRealCalls = 0;
  let pricedCalls = 0;
  let unpricedCalls = 0;
  let oldestObservedAt: string | undefined;
  let newestObservedAt: string | undefined;

  const reasonCounts: Record<string, number> = {};
  for (const r of ALL_UNPRICED_REASONS) reasonCounts[r] = 0;

  const sourceMap = new Map<string, MetricsSourceBreakdown>();
  const providerMap = new Map<string, CallBreakdown>();
  const modelMap = new Map<string, CallBreakdown>();
  const statusMap = new Map<RequestSummaryStatus, number>();
  const versionMap = new Map<string, number>();

  for (const obs of snapshot) {
    totalObserved += 1;
    const report = obs.report;
    if (!oldestObservedAt || obs.observedAt < oldestObservedAt) oldestObservedAt = obs.observedAt;
    if (!newestObservedAt || obs.observedAt > newestObservedAt) newestObservedAt = obs.observedAt;

    const category = requestCategoryOf(report);
    if (category === 'FULLY_PRICED') fullyPriced += 1;
    else if (category === 'PARTIALLY_PRICED') partiallyPriced += 1;
    else if (category === 'UNPRICED') unpriced += 1;
    else zeroProviderCalls += 1;

    statusMap.set(report.summaryStatus, (statusMap.get(report.summaryStatus) ?? 0) + 1);

    // rateCardVersions counts observations, exactly once each, including
    // zero-call observations. It never counts per-call.
    versionMap.set(report.rateCardVersion, (versionMap.get(report.rateCardVersion) ?? 0) + 1);

    let obsPricedCost = 0n;
    for (const call of report.calls) {
      totalRealCalls += 1;
      if (call.kind === 'PRICED') {
        pricedCalls += 1;
        obsPricedCost += BigInt(call.costNanoUsd);
        incrementCallBreakdown(providerMap, call.provider || 'UNKNOWN', 'PRICED', BigInt(call.costNanoUsd));
        incrementCallBreakdown(modelMap, call.rateCard.model, 'PRICED', BigInt(call.costNanoUsd));
      } else {
        unpricedCalls += 1;
        reasonCounts[call.reason] = (reasonCounts[call.reason] ?? 0) + 1;
        incrementCallBreakdown(providerMap, call.provider || 'UNKNOWN', 'UNPRICED', 0n);
        // PRICED model breakdown uses the applied rate-card model; UNPRICED
        // uses actualModel ?? requestedModel ?? "UNKNOWN". No inference.
        incrementCallBreakdown(
          modelMap,
          call.actualModel ?? call.requestedModel ?? 'UNKNOWN',
          'UNPRICED',
          0n,
        );
      }
    }

    incrementSource(sourceMap, obs.source, category, obsPricedCost);
  }

  const totalCost = sumPricedCost(snapshot);
  const coverage = computeCoverage(pricedCalls, unpricedCalls);

  return {
    generatedAt,
    window: {
      storage: 'IN_MEMORY',
      ephemeral: true,
      perProcess: true,
      capacity,
      retainedObservations: totalObserved,
      oldestObservedAt,
      newestObservedAt,
    },
    requests: { totalObserved, fullyPriced, partiallyPriced, unpriced, zeroProviderCalls },
    providerCalls: {
      totalRealCalls,
      pricedCalls,
      unpricedCalls,
      ...coverage,
    },
    pricedProviderCost: money(totalCost),
    unpricedReasons: reasonCounts,
    bySource: [...sourceMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, s]) => s),
    byProvider: [...providerMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([provider, p]) => ({
        provider,
        totalRealCalls: p.totalRealCalls,
        pricedCalls: p.pricedCalls,
        unpricedCalls: p.unpricedCalls,
        pricedProviderCost: money(p.pricedCostNanoUsd),
      })),
    byModel: [...modelMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([model, m]) => ({
        model,
        totalRealCalls: m.totalRealCalls,
        pricedCalls: m.pricedCalls,
        unpricedCalls: m.unpricedCalls,
        pricedProviderCost: money(m.pricedCostNanoUsd),
      })),
    bySummaryStatus: [...statusMap.entries()].map(([summaryStatus, count]) => ({ summaryStatus, count })),
    rateCardVersions: [...versionMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([version, count]) => ({ version, count })),
  };
}
