import type {
  ProviderRateCard,
  RateCardTier,
  ShadowPricedCall,
  ShadowPricingInput,
  ShadowPricingResult,
  ShadowPricingTotals,
  UnpricedReason,
} from '../../types/provider-pricing.js';
import { PROVIDER_RATE_CARD } from '../../config/provider-rate-card/index.js';
import type { PriceCallContext, PricingCallInput } from './price-call.js';
import { priceProviderCall } from './price-call.js';

/**
 * Phase 2C pure request-level aggregation.
 *
 * Accepts the authoritative `providerCalls` payload, drops
 * `providerCallMade=false` records defensively (the cache-hit representation
 * is an empty array), prices each real call exactly once, and reduces to a
 * `ShadowPricingResult`. Pure and stateless; never rounds, never mutates
 * input, never adds a call for a cache hit.
 */

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

function emptyReasons(): Record<UnpricedReason, number> {
  const out = {} as Record<UnpricedReason, number>;
  for (const r of ALL_UNPRICED_REASONS) out[r] = 0;
  return out;
}

interface RealCall {
  providerCallMade?: boolean;
  [key: string]: unknown;
}

function isRealCall(value: unknown): value is RealCall {
  return typeof value === 'object' && value !== null;
}

/**
 * Price every real provider call in the input and aggregate.
 */
export function aggregateProviderCalls(input: ShadowPricingInput): ShadowPricingResult {
  const pricingDate = input.pricingDate ?? new Date().toISOString().slice(0, 10);
  const tier: RateCardTier | undefined = input.tier;
  const card: ProviderRateCard = input.card ?? PROVIDER_RATE_CARD;

  const raw = input.providerCalls;
  const realCalls: Array<Record<string, unknown>> = [];
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (!isRealCall(c)) continue;
      // `providerCallMade=false` records are defensively ignored.
      if (c.providerCallMade === false) continue;
      realCalls.push(c);
    }
  }

  const pricedAt = new Date().toISOString();
  if (realCalls.length === 0) {
    return {
      pricedAt,
      noProviderCalls: true,
      calls: [],
      totals: {
        callCount: 0,
        pricedCallCount: 0,
        unpricedCallCount: 0,
        unpricedReasons: emptyReasons(),
        pricedCostNanoUsd: 0n,
      },
      summaryStatus: 'UNPRICED',
    };
  }

  const calls: ShadowPricedCall[] = [];
  let pricedCallCount = 0;
  const unpricedReasons = emptyReasons();
  let pricedCostNanoUsd = 0n;

  const ctx: PriceCallContext = { card, pricingDate, tier };

  for (const rawCall of realCalls) {
    const call = {
      provider: rawCall['provider'],
      providerCallId: rawCall['providerCallId'],
      requestedModel: rawCall['requestedModel'],
      actualModel: rawCall['actualModel'],
      operation: rawCall['operation'],
      inputTokens: rawCall['inputTokens'],
      outputTokens: rawCall['outputTokens'],
      cachedInputTokens: rawCall['cachedInputTokens'],
      cachedOutputTokens: rawCall['cachedOutputTokens'],
      reasoningTokens: rawCall['reasoningTokens'],
      imageInputTokens: rawCall['imageInputTokens'],
      audioInputTokens: rawCall['audioInputTokens'],
      generatedImageCount: rawCall['generatedImageCount'],
      audioOutputSeconds: rawCall['audioOutputSeconds'],
      inputCharacters: rawCall['inputCharacters'],
      outputCharacters: rawCall['outputCharacters'],
    };
    const priced = priceProviderCall(call as PricingCallInput, ctx);
    calls.push(priced);
    if (priced.kind === 'PRICED') {
      pricedCallCount += 1;
      pricedCostNanoUsd += priced.costNanoUsd;
    } else {
      unpricedReasons[priced.reason] += 1;
    }
  }

  const callCount = calls.length;
  const unpricedCallCount = callCount - pricedCallCount;
  let summaryStatus: ShadowPricingResult['summaryStatus'];
  if (pricedCallCount === callCount) {
    summaryStatus = 'FULLY_PRICED';
  } else if (pricedCallCount === 0) {
    summaryStatus = 'UNPRICED';
  } else {
    summaryStatus = 'PARTIALLY_PRICED';
  }

  const totals: ShadowPricingTotals = {
    callCount,
    pricedCallCount,
    unpricedCallCount,
    unpricedReasons,
    pricedCostNanoUsd,
  };

  return {
    pricedAt,
    noProviderCalls: false,
    calls,
    totals,
    summaryStatus,
  };
}