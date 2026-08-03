/**
 * Phase 2D-A BigInt-safe reporting boundary for shadow pricing.
 *
 * The pure Phase 2C engine produces `ShadowPricingResult` with exact `bigint`
 * nano-USD money. This module converts authoritative monetary bigint values to
 * reportable shapes ONLY at this output boundary:
 *
 *  - `costNanoUsd`  → exact decimal string (the raw bigint rendered as text)
 *  - `costMicroUsd` → `nanoUsdToMicroUsdCeil(...).toString()` (whole micros, ceil)
 *  - `costUsd`      → `nanoUsdToUsdString(...)` (exact 9-decimal string)
 *
 * Safety rules enforced here (and by tests):
 *  - Never call `Number()` on money.
 *  - Never `JSON.stringify` a raw bigint.
 *  - Never attach a bigint to a reportable object.
 *  - Never round through floating point.
 *  - `UNPRICED` reportable calls contain NO cost field of any kind.
 *
 * The reportable shapes are pure JSON-safe plain objects: they are the ONLY
 * thing the observation buffer and the structured log may contain.
 */

import type {
  PricedVia,
  RequestSummaryStatus,
  ShadowPricedCall,
  ShadowPricingResult,
  UnpricedReason,
} from '../../types/provider-pricing.js';
import { nanoUsdToMicroUsdCeil, nanoUsdToUsdString } from './arithmetic.js';

/** Immutable snapshot of the rate-card line applied to a PRICED call. */
export interface ReportableRateCard {
  version: string;
  model: string;
  tier: string;
  billingUnit: string;
}

/** The `PRICED` reportable variant — carries reportable money as strings. */
export interface ReportablePricedCall {
  kind: 'PRICED';
  provider: string;
  providerCallId: string;
  operation?: string;
  requestedModel?: string;
  actualModel?: string;
  reason: PricedVia;
  rateCard: ReportableRateCard;
  costNanoUsd: string;
  costMicroUsd: string;
  costUsd: string;
}

/** The `UNPRICED` reportable variant — structurally carries NO cost field. */
export interface ReportableUnpricedCall {
  kind: 'UNPRICED';
  provider: string;
  providerCallId: string;
  operation?: string;
  requestedModel?: string;
  actualModel?: string;
  reason: UnpricedReason;
}

export type ReportableShadowCall = ReportablePricedCall | ReportableUnpricedCall;

/** Counts of every countable `UnpricedReason` (all keys present, zero-based). */
export type ReportableReasonCounts = Record<UnpricedReason, number>;

/** Request-level reportable totals; money fields are exact decimal strings. */
export interface ReportableTotals {
  callCount: number;
  pricedCallCount: number;
  unpricedCallCount: number;
  unpricedReasons: ReportableReasonCounts;
  pricedCostNanoUsd: string;
  pricedCostMicroUsd: string;
  pricedCostUsd: string;
}

/** Full request-level reportable shadow result (JSON-safe, no bigint). */
export interface ReportableShadow {
  pricedAt: string;
  noProviderCalls: boolean;
  summaryStatus: RequestSummaryStatus;
  calls: ReportableShadowCall[];
  totals: ReportableTotals;
  rateCardVersion: string;
}

/** Output boundary: convert one authoritative nUSD bigint into reportable strings. */
export function reportMonetary(nanoUsd: bigint): {
  costNanoUsd: string;
  costMicroUsd: string;
  costUsd: string;
} {
  return {
    costNanoUsd: nanoUsd.toString(),
    costMicroUsd: nanoUsdToMicroUsdCeil(nanoUsd).toString(),
    costUsd: nanoUsdToUsdString(nanoUsd),
  };
}

/** Output boundary: convert one `ShadowPricedCall` to a reportable shape. */
export function reportableShadowCall(call: ShadowPricedCall): ReportableShadowCall {
  const base = {
    kind: call.kind as ReportableShadowCall['kind'],
    provider: call.provider,
    providerCallId: call.providerCallId,
    operation: call.operation,
    requestedModel: call.requestedModel,
    actualModel: call.actualModel,
  };

  if (call.kind === 'PRICED') {
    const money = reportMonetary(call.costNanoUsd);
    return {
      ...base,
      kind: 'PRICED',
      reason: call.reason,
      rateCard: {
        version: call.rateCard.version,
        model: call.rateCard.model,
        tier: call.rateCard.tier,
        billingUnit: call.rateCard.billingUnit,
      },
      costNanoUsd: money.costNanoUsd,
      costMicroUsd: money.costMicroUsd,
      costUsd: money.costUsd,
    } as ReportablePricedCall;
  }

  // UNPRICED variant: no cost field of any kind.
  return {
    ...base,
    kind: 'UNPRICED',
    reason: call.reason,
  } as ReportableUnpricedCall;
}

/** Output boundary: convert request-level totals to a reportable shape. */
export function reportableTotals(totals: ShadowPricingResult['totals']): ReportableTotals {
  const money = reportMonetary(totals.pricedCostNanoUsd);
  return {
    callCount: totals.callCount,
    pricedCallCount: totals.pricedCallCount,
    unpricedCallCount: totals.unpricedCallCount,
    unpricedReasons: { ...totals.unpricedReasons },
    pricedCostNanoUsd: money.costNanoUsd,
    pricedCostMicroUsd: money.costMicroUsd,
    pricedCostUsd: money.costUsd,
  };
}

/**
 * Output boundary: convert a whole `ShadowPricingResult` into a JSON-safe
 * reportable object. `rateCardVersion` is the applied card's version.
 *
 * The function never mutates the engine result.
 */
export function toReportableShadow(
  result: ShadowPricingResult,
  rateCardVersion: string,
): ReportableShadow {
  return {
    pricedAt: result.pricedAt,
    noProviderCalls: result.noProviderCalls,
    summaryStatus: result.summaryStatus,
    calls: result.calls.map(reportableShadowCall),
    totals: reportableTotals(result.totals),
    rateCardVersion,
  };
}

/**
 * Derive the reportable unpriced-reason tally shape from a result (convenience
 * for the structured log; equals `totals.unpricedReasons`).
 */
export function reportableUnpricedReasons(
  result: ShadowPricingResult,
): ReportableReasonCounts {
  return { ...result.totals.unpricedReasons };
}
