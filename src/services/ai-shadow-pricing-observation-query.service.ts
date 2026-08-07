/**
 * Phase 2D-B pure observation query view.
 *
 * Transforms an immutable snapshot of `ShadowPricingObservation[]` into a
 * bounded, filtered, newest-first list of minimal admin summary rows.
 *
 * Guarantees:
 *  - never mutates the caller's snapshot (a copy is sorted, never the input)
 *  - newest observations first, deterministic
 *  - default limit 50, hard maximum 200
 *  - `ZERO_PROVIDER_CALLS` is a distinct request category and is NEVER
 *    surfaced as an ordinary UNPRICED failure
 *  - rows are minimal and JSON-safe: no prompts, responses, provider payloads,
 *    raw `providerCalls`, or raw errors
 *  - money fields are exact decimal strings
 */

import { DEFAULT_OBSERVATION_CAPACITY } from './ai-shadow-pricing-observation.service.js';
import type { ShadowPricingObservation } from './ai-shadow-pricing-observation.service.js';
import type { RequestSummaryStatus } from '../types/provider-pricing.js';
import { requestCategoryOf, type RequestCategory } from './ai-shadow-pricing-metrics.service.js';
import { attemptsIncludeRetry, computeAttemptRiskStatus } from '../utils/ai-usage.js';
import type { AttemptRiskStatus } from '../types/ai.js';

export interface ObservationQueryOptions {
  /** Maximum rows returned. Default 50; hard maximum 200 (clamped). */
  limit?: number;
  /** Exact source filter. */
  source?: string;
  /** Request-category filter (`ZERO_PROVIDER_CALLS` is supported). */
  status?: RequestCategory;
  /** Boolean filter on the observation's `noProviderCalls` flag. */
  noProviderCalls?: boolean;
  /** Buffer capacity surfaced in `meta` (for display). */
  capacity?: number;
}

export interface ObservationSummaryRow {
  observedAt: string;
  source: string;
  conversationId?: string;
  /** The engine's raw request status (may be UNPRICED for zero-call requests). */
  engineSummaryStatus: RequestSummaryStatus;
  /** The admin request category (distinguishes zero-call from unpriced). */
  requestCategory: RequestCategory;
  noProviderCalls: boolean;
  callCount: number;
  pricedCallCount: number;
  unpricedCallCount: number;
  pricedProviderCost: {
    nanoUsd: string;
    microUsd: string;
    usd: string;
  };
  unpricedReasons: Record<string, number>;
  rateCardVersion: string;
  /** Billing-safety risk derived from this request's provider attempts. */
  attemptRiskStatus: AttemptRiskStatus;
  attemptCount: number;
  failedAttemptCount: number;
  indeterminateAttemptCount: number;
  hasRetry: boolean;
}

export interface ObservationQueryMeta {
  returned: number;
  limit: number;
  storage: 'IN_MEMORY';
  ephemeral: true;
  perProcess: true;
  capacity: number;
}

export interface ObservationQueryResult {
  data: ObservationSummaryRow[];
  meta: ObservationQueryMeta;
}

function toSummaryRow(obs: ShadowPricingObservation): ObservationSummaryRow {
  const attempts = obs.attempts ?? [];
  const attemptRiskStatus = obs.attemptRiskStatus ?? computeAttemptRiskStatus(attempts);
  let failedAttemptCount = 0;
  let indeterminateAttemptCount = 0;
  for (const attempt of attempts) {
    if (attempt.outcome === 'FAILED') failedAttemptCount += 1;
    else if (attempt.outcome === 'INDETERMINATE') indeterminateAttemptCount += 1;
  }
  return {
    observedAt: obs.observedAt,
    source: obs.source,
    conversationId: obs.conversationId ?? undefined,
    engineSummaryStatus: obs.report.summaryStatus,
    requestCategory: requestCategoryOf(obs.report),
    noProviderCalls: obs.report.noProviderCalls,
    callCount: obs.report.totals.callCount,
    pricedCallCount: obs.report.totals.pricedCallCount,
    unpricedCallCount: obs.report.totals.unpricedCallCount,
    pricedProviderCost: {
      nanoUsd: obs.report.totals.pricedCostNanoUsd,
      microUsd: obs.report.totals.pricedCostMicroUsd,
      usd: obs.report.totals.pricedCostUsd,
    },
    unpricedReasons: { ...obs.report.totals.unpricedReasons },
    rateCardVersion: obs.report.rateCardVersion,
    attemptRiskStatus,
    attemptCount: attempts.length,
    failedAttemptCount,
    indeterminateAttemptCount,
    hasRetry: attemptsIncludeRetry(attempts),
  };
}

export function queryShadowPricingObservations(
  snapshot: readonly ShadowPricingObservation[],
  options: ObservationQueryOptions = {},
): ObservationQueryResult {
  const requestedLimit = options.limit ?? 50;
  const appliedLimit = Math.max(1, Math.min(requestedLimit, 200));
  const capacity = options.capacity ?? DEFAULT_OBSERVATION_CAPACITY;

  // Newest first by observedAt, deterministic; never touches the input array.
  const sorted = [...snapshot].sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1));

  let filtered = sorted;
  if (options.source !== undefined) {
    filtered = filtered.filter((o) => o.source === options.source);
  }
  if (options.status !== undefined) {
    filtered = filtered.filter((o) => requestCategoryOf(o.report) === options.status);
  }
  if (options.noProviderCalls !== undefined) {
    filtered = filtered.filter((o) => o.report.noProviderCalls === options.noProviderCalls);
  }

  const data = filtered.slice(0, appliedLimit).map(toSummaryRow);

  return {
    data,
    meta: {
      returned: data.length,
      limit: appliedLimit,
      storage: 'IN_MEMORY',
      ephemeral: true,
      perProcess: true,
      capacity,
    },
  };
}
