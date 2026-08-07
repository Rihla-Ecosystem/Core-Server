import type {
  ProviderRateCard,
  RateCardBillingUnit,
  RateCardEntry,
  RateCardTier,
  ShadowPricedCall,
  UnpricedReason,
  UsageApplied,
} from '../../types/provider-pricing.js';
import { selectPricingIdentity } from './model-identity.js';
import { resolveRate } from './rate-card.js';
import {
  isSafeNonNegativeInteger,
  isSafeNonNegativeNumber,
  perUnitCostNanoUsd,
  tokenComponentCostNanoUsd,
} from './arithmetic.js';

/**
 * Phase 2C pure per-call pricing.
 *
 * Takes one real provider call and the effective rate card; returns exactly
 * one `ShadowPricedCall` (PRICED or UNPRICED). Pure and stateless — no I/O,
 * no mutation, no persisted side effects.
 *
 * Callers MUST drop `providerCallMade=false` records before invoking this
 * (the authoritative cache-hit representation is an empty `providerCalls`
 * array); this module prices a single real call only.
 */

/** Minimal subset of `ProviderCallUsage` the engine reads. */
export interface PricingCallInput {
  provider?: string;
  providerCallId?: string;
  requestedModel?: string;
  actualModel?: string;
  operation?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cachedOutputTokens?: number;
  reasoningTokens?: number;
  imageInputTokens?: number;
  audioInputTokens?: number;
  generatedImageCount?: number;
  audioOutputSeconds?: number;
  inputCharacters?: number;
  outputCharacters?: number;
}

export interface PriceCallContext {
  card: ProviderRateCard;
  pricingDate: string;
  tier?: RateCardTier;
}

type PresentField = keyof PricingCallInput;

/** Fields that a billing unit may price or read. */
function unitFields(unit: RateCardBillingUnit): PresentField[] {
  switch (unit) {
    case 'TOKEN':
      return [
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'cachedOutputTokens',
        'imageInputTokens',
        'audioInputTokens',
      ];
    case 'IMAGE':
      return ['generatedImageCount'];
    case 'CHARACTER':
      return ['inputCharacters', 'outputCharacters'];
    case 'SECOND':
    case 'MINUTE':
      return ['audioOutputSeconds'];
    default:
      return [];
  }
}

function isPresent(value: unknown): value is number {
  return typeof value === 'number';
}

function asBig(value: number): bigint {
  return BigInt(value);
}

function appliedRateSnapshot(entry: RateCardEntry, tier: RateCardTier, model: string) {
  return { version: '1.0.0', model, tier, billingUnit: entry.billingUnit };
}

/**
 * Price one real provider call.
 */
export function priceProviderCall(call: PricingCallInput, ctx: PriceCallContext): ShadowPricedCall {
  const base = {
    providerCallId: call.providerCallId ?? 'unknown',
    provider: call.provider ?? 'unknown',
    operation: call.operation,
    requestedModel: call.requestedModel,
    actualModel: call.actualModel,
    pricedAt: ctx.pricingDate,
  };

  const identity = selectPricingIdentity({
    provider: call.provider,
    requestedModel: call.requestedModel,
    actualModel: call.actualModel,
  });
  if (identity.kind === 'MISSING_MODEL') {
    return { kind: 'UNPRICED', ...base, reason: 'MODEL_MISSING' };
  }

  const resolution = resolveRate({
    card: ctx.card,
    provider: call.provider,
    modelLookupKey: identity.modelLookupKey,
    source: identity.source,
    tier: ctx.tier,
    pricingDate: ctx.pricingDate,
  });
  if (resolution.kind === 'UNRESOLVED') {
    return { kind: 'UNPRICED', ...base, reason: resolution.reason };
  }

  const entry = resolution.entry;
  const unit = entry.billingUnit;
  const fields = unitFields(unit);

  // TTS audio output seconds are priced via entry.tts when defined.
  const ttsFields: PresentField[] =
    unit === 'TOKEN' && entry.tts?.audioOutputMicrosPerMillion ? ['audioOutputSeconds'] : [];

  const presentRelevant = [...new Set([...fields, ...ttsFields])].filter((f) => isPresent(call[f]));

  if (presentRelevant.length === 0) {
    return { kind: 'UNPRICED', ...base, reason: 'USAGE_MISSING' };
  }

  for (const f of presentRelevant) {
    const v = call[f] as number;
    if (f === 'audioOutputSeconds') {
      if (!isSafeNonNegativeNumber(v)) {
        return { kind: 'UNPRICED', ...base, reason: 'USAGE_INVALID' };
      }
    } else if (!isSafeNonNegativeInteger(v)) {
      return { kind: 'UNPRICED', ...base, reason: 'USAGE_INVALID' };
    }
  }

  const allZero = presentRelevant.every((f) => (call[f] as number) === 0);
  const rateCardSnapshot = appliedRateSnapshot(entry, resolution.appliedTier, resolution.model);

  if (allZero) {
    return {
      kind: 'PRICED',
      ...base,
      reason: 'ZERO_USAGE_EXPLICIT',
      rateCard: rateCardSnapshot,
      costNanoUsd: 0n,
      usageApplied: usageForZero(call, presentRelevant),
    };
  }

  const cost = computeCost(entry, call);
  if (cost.outcome === 'unpriced') {
    return { kind: 'UNPRICED', ...base, reason: cost.reason };
  }

  return {
    kind: 'PRICED',
    ...base,
    reason: identity.source === 'ACTUAL_MODEL' ? 'ACTUAL_MODEL' : 'REQUESTED_MODEL_FALLBACK',
    rateCard: rateCardSnapshot,
    costNanoUsd: cost.costNanoUsd,
    usageApplied: cost.usage,
  };
}

function usageForZero(call: PricingCallInput, fields: PresentField[]): UsageApplied {
  const u: UsageApplied = {};
  for (const f of fields) {
    const v = call[f] as number;
    if (f === 'inputTokens') u.inputTokens = v;
    else if (f === 'outputTokens') u.outputTokens = v;
    else if (f === 'cachedInputTokens') u.cachedInputTokens = v;
    else if (f === 'cachedOutputTokens') u.cachedOutputTokens = v;
    else if (f === 'imageInputTokens') u.imageInputTokens = v;
    else if (f === 'audioInputTokens') u.audioInputTokens = v;
    else if (f === 'generatedImageCount') u.generatedImageCount = v;
    else if (f === 'audioOutputSeconds') u.audioOutputSeconds = v;
    else if (f === 'inputCharacters') u.inputCharacters = v;
    else if (f === 'outputCharacters') u.outputCharacters = v;
  }
  return u;
}

type CostOutcome =
  | { outcome: 'priced'; costNanoUsd: bigint; usage: UsageApplied }
  | { outcome: 'unpriced'; reason: UnpricedReason };

function computeCost(
  entry: RateCardEntry,
  call: PricingCallInput,
): CostOutcome {
  const usage: UsageApplied = {};
  let total = 0n;

  if (entry.billingUnit === 'TOKEN') {
    return computeTokenCost(entry, call, usage);
  }

  // Non-Token per-unit billing (IMAGE / CHARACTER / SECOND / MINUTE).
  const unit = entry.billingUnit;
  const perUnitMicros = entry.perUnitMicros;
  if (perUnitMicros === undefined) {
    return { outcome: 'unpriced', reason: 'UNIT_UNPRICED' };
  }

  if (unit === 'IMAGE') {
    if (!isPresent(call.generatedImageCount)) {
      return { outcome: 'unpriced', reason: 'UNIT_UNPRICED' };
    }
    total = perUnitCostNanoUsd(asBig(call.generatedImageCount), asBig(perUnitMicros));
    usage.generatedImageCount = call.generatedImageCount;
    return { outcome: 'priced', costNanoUsd: total, usage };
  }

  if (unit === 'CHARACTER') {
    if (!isPresent(call.inputCharacters) && !isPresent(call.outputCharacters)) {
      return { outcome: 'unpriced', reason: 'UNIT_UNPRICED' };
    }
    let sum = 0n;
    if (isPresent(call.inputCharacters)) {
      sum += perUnitCostNanoUsd(asBig(call.inputCharacters), asBig(perUnitMicros));
      usage.inputCharacters = call.inputCharacters;
    }
    if (isPresent(call.outputCharacters)) {
      sum += perUnitCostNanoUsd(asBig(call.outputCharacters), asBig(perUnitMicros));
      usage.outputCharacters = call.outputCharacters;
    }
    return { outcome: 'priced', costNanoUsd: sum, usage };
  }

  if (unit === 'SECOND' || unit === 'MINUTE') {
    if (!isPresent(call.audioOutputSeconds)) {
      return { outcome: 'unpriced', reason: 'UNIT_UNPRICED' };
    }
    // Phase 2C supports only whole-unit duration counts. A fractional
    // duration would require floating-point money arithmetic to promote to a
    // sub-unit, so it is rejected as USAGE_INVALID rather than silently
    // approximated (never floor, never round, never split a unit into a float).
    // No Phase 2 rate card exercises this path: TTS has no verified rate and
    // remains UNPRICED, so no fractional duration is ever priced here.
    if (!isSafeNonNegativeInteger(call.audioOutputSeconds)) {
      return { outcome: 'unpriced', reason: 'USAGE_INVALID' };
    }
    total = perUnitCostNanoUsd(asBig(call.audioOutputSeconds), asBig(perUnitMicros));
    usage.audioOutputSeconds = call.audioOutputSeconds;
    return { outcome: 'priced', costNanoUsd: total, usage };
  }

  return { outcome: 'unpriced', reason: 'UNIT_UNPRICED' };
}

function computeTokenCost(
  entry: RateCardEntry,
  call: PricingCallInput,
  usage: UsageApplied,
): CostOutcome {
  const rates = entry.tokenRates;
  if (!rates) {
    return { outcome: 'unpriced', reason: 'UNIT_UNPRICED' };
  }

  let total = 0n;

  // ---- input aggregate (with optional audio split) ----------------------
  if (isPresent(call.inputTokens)) {
    // Guard: a reported breakdown cannot exceed its aggregate.
    if (isPresent(call.audioInputTokens) && call.audioInputTokens > call.inputTokens) {
      return { outcome: 'unpriced', reason: 'MODALITY_INVALID' };
    }
    if (isPresent(call.imageInputTokens) && call.imageInputTokens > call.inputTokens) {
      return { outcome: 'unpriced', reason: 'MODALITY_INVALID' };
    }

    if (
      entry.modalityRates?.audioInputMicrosPerMillion !== undefined &&
      isPresent(call.audioInputTokens)
    ) {
      if (rates.inputMicrosPerMillion === undefined) {
        return { outcome: 'unpriced', reason: 'UNIT_UNPRICED' };
      }
      const audioNano = tokenComponentCostNanoUsd(
        asBig(call.audioInputTokens),
        asBig(entry.modalityRates.audioInputMicrosPerMillion),
      );
      const textNano = tokenComponentCostNanoUsd(
        asBig(call.inputTokens - call.audioInputTokens),
        asBig(rates.inputMicrosPerMillion),
      );
      total += audioNano + textNano;
      usage.audioInputTokens = call.audioInputTokens;
    } else if (rates.inputMicrosPerMillion !== undefined) {
      total += tokenComponentCostNanoUsd(asBig(call.inputTokens), asBig(rates.inputMicrosPerMillion));
    } else {
      return { outcome: 'unpriced', reason: 'UNIT_UNPRICED' };
    }
    usage.inputTokens = call.inputTokens;
    if (isPresent(call.imageInputTokens)) usage.imageInputTokens = call.imageInputTokens;
  }

  // ---- output -----------------------------------------------------------
  if (isPresent(call.outputTokens)) {
    if (rates.outputMicrosPerMillion === undefined) {
      return { outcome: 'unpriced', reason: 'UNIT_UNPRICED' };
    }
    total += tokenComponentCostNanoUsd(asBig(call.outputTokens), asBig(rates.outputMicrosPerMillion));
    usage.outputTokens = call.outputTokens;
  }

  // ---- cached input (disjoint vs included) ------------------------------
  if (isPresent(call.cachedInputTokens)) {
    if (entry.cachedInputAccounting === 'INCLUDED_IN_INPUT') {
      // Already a subset of inputTokens — never counted a second time.
      usage.cachedInputTokens = call.cachedInputTokens;
      usage.cachedInputAccounting = 'INCLUDED_IN_INPUT';
    } else {
      if (rates.cachedInputMicrosPerMillion === undefined) {
        return { outcome: 'unpriced', reason: 'UNIT_UNPRICED' };
      }
      total += tokenComponentCostNanoUsd(
        asBig(call.cachedInputTokens),
        asBig(rates.cachedInputMicrosPerMillion),
      );
      usage.cachedInputTokens = call.cachedInputTokens;
      usage.cachedInputAccounting = entry.cachedInputAccounting;
    }
  }

  // ---- cached output ----------------------------------------------------
  if (isPresent(call.cachedOutputTokens)) {
    if (rates.cachedOutputMicrosPerMillion === undefined) {
      return { outcome: 'unpriced', reason: 'UNIT_UNPRICED' };
    }
    total += tokenComponentCostNanoUsd(
      asBig(call.cachedOutputTokens),
      asBig(rates.cachedOutputMicrosPerMillion),
    );
    usage.cachedOutputTokens = call.cachedOutputTokens;
  }

  return { outcome: 'priced', costNanoUsd: total, usage };
}