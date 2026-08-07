/**
 * Phase 2 provider-neutral shadow-pricing contracts.
 *
 * This module is the Phase 2B contract-hardening surface: it declares the
 * discriminated-union result contract, the PRICED/UNPRICED reason enums,
 * the rate-card schema, and the request-level aggregation result. It carries
 * no pricing engine, no rate resolution, and no Wallet/AiUsageLog coupling.
 *
 * Safety invariants enforced by these types:
 *  - `ShadowPricedCall` is a discriminated union keyed on `kind`.
 *  - `PRICED` carries `costNanoUsd: bigint` and a `PricedVia` reason.
 *  - `UNPRICED` structurally forbids any cost field (`costNanoUsd` /
 *    `costMicros` / `costUsd` do not exist on the variant). Zero cost is
 *    never fabricated; unknown/malformed calls are `UNPRICED`.
 *  - All internal money is integer nano-USD (`1 USD = 1_000_000_000 nUSD`).
 */

/** How a priced call was valued on the model it reports. */
export type PricedVia =
  | 'ACTUAL_MODEL'
  | 'REQUESTED_MODEL_FALLBACK'
  | 'ZERO_USAGE_EXPLICIT';

/** Why a call could not be priced. No cost is attached by design. */
export type UnpricedReason =
  | 'PROVIDER_NOT_IN_RATECARD'
  | 'MODEL_MISSING'
  | 'ACTUAL_MODEL_NOT_IN_RATECARD'
  | 'REQUESTED_MODEL_NOT_IN_RATECARD'
  | 'USAGE_MISSING'
  | 'USAGE_INVALID'
  | 'RATE_NOT_ACTIVE'
  | 'UNIT_UNPRICED'
  | 'MODALITY_INVALID'
  | 'OVERFLOW';

/** Which model identity source drove a `PRICED` valuation. */
export type PricingIdentitySource =
  | 'ACTUAL_MODEL'
  | 'REQUESTED_MODEL_FALLBACK';

/** Request-level aggregate statuses (exactly three values). */
export type RequestSummaryStatus =
  | 'FULLY_PRICED'
  | 'PARTIALLY_PRICED'
  | 'UNPRICED';

/** Identity-selection failure kinds (Phase 2B). */
export type ModelIdentityFailureReason = 'MODEL_MISSING';

/**
 * Canonical identity selected for one provider call (Phase 2B).
 *
 * `SELECTED` — a model identity was selected from the reported strings. The
 * model display identity, its lookup key, and the pricing source are required.
 * Provider fields remain optional because Phase 2B does not fail model
 * identity selection solely because the provider is missing.
 *
 * `MISSING_MODEL` — neither `actualModel` nor `requestedModel` was present.
 * This variant structurally contains no `model` / `modelLookupKey` / `source`
 * fields, mirroring the discriminated-union discipline of `ShadowPricedCall`.
 *
 * Whether a selected model exists in the rate card is a Phase 2C concern, not
 * part of this candidate.
 */
export type PricingIdentityCandidate =
  | {
      kind: 'SELECTED';
      provider?: string;
      providerLookupKey?: string;
      model: string;
      modelLookupKey: string;
      source: PricingIdentitySource;
    }
  | {
      kind: 'MISSING_MODEL';
      provider?: string;
      providerLookupKey?: string;
      reason: ModelIdentityFailureReason;
    };

export type RateCardTier =
  | 'standard'
  | 'batch'
  | 'priority'
  | 'fast_mode';

export type RateCardBillingUnit =
  | 'TOKEN'
  | 'IMAGE'
  | 'SECOND'
  | 'MINUTE'
  | 'CHARACTER';

export type RateCardStatus =
  | 'STABLE'
  | 'PREVIEW'
  | 'DEPRECATED'
  | 'LIMITED_AVAILABILITY';

export type RateCardProvenance = 'RESEARCH_SNAPSHOT';

export const RATE_CARD_STORAGE_UNIT = 'MICROS' as const;
export const RATE_CARD_ENGINE_UNIT = 'NANO_USD' as const;
export const RATE_CARD_CURRENCY = 'USD' as const;
export const RATE_CARD_SCHEMA_VERSION = 1 as const;

/** Token-based rates, integer micro-USD per 1M tokens. null/absent = unpublished. */
export interface RateCardTokenRates {
  inputMicrosPerMillion?: number;
  outputMicrosPerMillion?: number;
  cachedInputMicrosPerMillion?: number;
  cachedOutputMicrosPerMillion?: number;
}

/**
 * Accounting semantics for a published cached-input rate.
 *
 * - `DISJOINT` — cached input tokens are counted separately from `inputTokens`
 *   and billed at the cached-input rate (Gemini `cachedContentTokenCount` is a
 *   disjoint count from `promptTokenCount`).
 * - `INCLUDED_IN_INPUT` — cached input tokens are already a subset of
 *   `inputTokens`; they must never be counted a second time.
 *
 * An entry that publishes a cached-input rate must declare this explicitly;
 * there is no undocumented default.
 */
export type CachedInputAccountingSemantic = 'DISJOINT' | 'INCLUDED_IN_INPUT';

/** Optional modality overrides: micro-USD per 1M for a distinct modality. */
export interface RateCardModalityRates {
  audioInputMicrosPerMillion?: number;
}

/** TTS conversion + rate (audio output priced per output token). */
export interface RateCardTts {
  audioOutputMicrosPerMillion?: number;
  tokensPerSecond?: number;
}

/** A single versioned, dated, provider-neutral rate-card entry. */
export interface RateCardEntry {
  provider: string;
  model: string;
  aliases?: string[];
  status: RateCardStatus;
  tier?: RateCardTier;
  billingUnit: RateCardBillingUnit;
  tokenRates?: RateCardTokenRates;
  perUnitMicros?: number;
  modalityRates?: RateCardModalityRates;
  tts?: RateCardTts;
  /** Required (explicit) whenever a cached-input rate is published. */
  cachedInputAccounting?: CachedInputAccountingSemantic;
  effectiveFrom: string;
  effectiveTo?: string;
  inactive: boolean;
  source?: string;
  verifiedAt?: string;
}

/** The versioned rate card, materialized from research baselines. */
export interface ProviderRateCard {
  schemaVersion: typeof RATE_CARD_SCHEMA_VERSION;
  currency: typeof RATE_CARD_CURRENCY;
  storageUnit: typeof RATE_CARD_STORAGE_UNIT;
  engineUnit: typeof RATE_CARD_ENGINE_UNIT;
  version: string;
  source: string;
  generatedAt: string;
  provenance: RateCardProvenance;
  entries: RateCardEntry[];
}

/** The token/unit counts actually applied when valuing a `PRICED` call. */
export interface UsageApplied {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cachedOutputTokens?: number;
  generatedImageCount?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  imageInputTokens?: number;
  audioOutputSeconds?: number;
  inputCharacters?: number;
  outputCharacters?: number;
  /** The explicit cached-input accounting semantic that was applied. */
  cachedInputAccounting?: CachedInputAccountingSemantic;
}

/** Immutable snapshot of the rate-card line used to value a `PRICED` call. */
export interface RateCardApplied {
  version: string;
  model: string;
  tier: RateCardTier;
  billingUnit: RateCardBillingUnit;
}

/** The `PRICED` variant of the per-call discriminated union. */
export interface PricedShadowCall {
  kind: 'PRICED';
  providerCallId: string;
  provider: string;
  operation?: string;
  requestedModel?: string;
  actualModel?: string;
  reason: PricedVia;
  rateCard: RateCardApplied;
  costNanoUsd: bigint;
  usageApplied?: UsageApplied;
  pricedAt: string;
}

/** The `UNPRICED` variant. Carries no cost field of any kind. */
export interface UnpricedShadowCall {
  kind: 'UNPRICED';
  providerCallId: string;
  provider: string;
  operation?: string;
  requestedModel?: string;
  actualModel?: string;
  reason: UnpricedReason;
  pricedAt: string;
}

/**
 * Discriminated-union per-call result. `PRICED` uniquely carries the exact
 * internal `costNanoUsd`; `UNPRICED` uniquely carries an `UnpricedReason`
 * and is structurally incapable of holding a cost.
 */
export type ShadowPricedCall = PricedShadowCall | UnpricedShadowCall;

export interface ShadowPricingTotals {
  callCount: number;
  pricedCallCount: number;
  unpricedCallCount: number;
  unpricedReasons: Record<UnpricedReason, number>;
  pricedCostNanoUsd: bigint;
}

/** Request-level aggregation with exactly three summary statuses. */
export interface ShadowPricingResult {
  pricedAt: string;
  noProviderCalls: boolean;
  calls: ShadowPricedCall[];
  totals: ShadowPricingTotals;
  summaryStatus: RequestSummaryStatus;
}

/**
 * Engine input. `providerCalls` is `unknown` so the engine defends against
 * unvalidated payloads (Phase 2C normalizes before risking); `pricingDate`
 * and `tier` are injectable for tests / historical recompute, and `card`
 * defaults to the materialized provider rate card.
 */
export interface ShadowPricingInput {
  providerCalls: unknown;
  pricingDate?: string;
  tier?: RateCardTier;
  card?: ProviderRateCard;
}

/**
 * Result of resolving a `SELECTED` model identity to a single, active,
 * effective rate-card line (Phase 2C).
 *
 * `RESOLVED` — a unique line matched for canonical provider + canonical model
 * + explicit alias + tier + effective window; `entry` is the applied line and
 * `appliedTier` the concrete tier used.
 *
 * `UNRESOLVED` — carries the exact provider-neutral `UnpricedReason`. It is
 * structurally incapable of carrying a rate/entry field.
 */
export type RateResolution =
  | {
      kind: 'RESOLVED';
      provider: string;
      model: string;
      modelLookupKey: string;
      appliedTier: RateCardTier;
      entry: RateCardEntry;
    }
  | {
      kind: 'UNRESOLVED';
      reason: UnpricedReason;
    };