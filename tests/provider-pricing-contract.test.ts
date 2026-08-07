import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  PricedVia,
  PricingIdentityCandidate,
  ProviderRateCard,
  RateCardApplied,
  RateCardBillingUnit,
  RateCardEntry,
  RateCardTier,
  RequestSummaryStatus,
  ShadowPricedCall,
  ShadowPricingInput,
  ShadowPricingResult,
  UnpricedReason,
} from '../src/types/provider-pricing.js';
import {
  RATE_CARD_CURRENCY,
  RATE_CARD_ENGINE_UNIT,
  RATE_CARD_SCHEMA_VERSION,
  RATE_CARD_STORAGE_UNIT,
} from '../src/types/provider-pricing.js';

const PRICED_AT = '2026-08-03T12:00:00.000Z';

const PRICED_VARIANT: ShadowPricedCall = {
  kind: 'PRICED',
  providerCallId: 'call-1',
  provider: 'google',
  operation: 'TEXT_CHAT',
  requestedModel: 'gemini-3.6-flash',
  actualModel: 'gemini-3.6-flash',
  reason: 'ACTUAL_MODEL',
  rateCard: { version: '2026-06-02.v1', model: 'gemini-3.6-flash', tier: 'standard', billingUnit: 'TOKEN' },
  costNanoUsd: 3825000n,
  usageApplied: { inputTokens: 1500, outputTokens: 200, cachedInputTokens: 500 },
  pricedAt: PRICED_AT,
};

const UNPRICED_VARIANT: ShadowPricedCall = {
  kind: 'UNPRICED',
  providerCallId: 'call-2',
  provider: 'google',
  actualModel: 'gemini-2.5-flash-tts-preview',
  reason: 'ACTUAL_MODEL_NOT_IN_RATECARD',
  pricedAt: PRICED_AT,
};

test('1. Contract exposes the PricedVia reasons', () => {
  const values: readonly PricedVia[] = [
    'ACTUAL_MODEL',
    'REQUESTED_MODEL_FALLBACK',
    'ZERO_USAGE_EXPLICIT',
  ];
  assert.deepEqual(values, values);
});

test('2. Contract exposes the UnpricedReason values', () => {
  const values: readonly UnpricedReason[] = [
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
  assert.equal(values.length, 10);
  assert.ok(values.includes('MODEL_MISSING'));
  assert.ok(values.includes('OVERFLOW'));
});

test('3. PRICED variant requires exact bigint costNanoUsd and a rate card snapshot', () => {
  const priced: ShadowPricedCall = PRICED_VARIANT;
  assert.equal(priced.kind, 'PRICED');
  assert.equal(typeof priced.costNanoUsd, 'bigint');
  assert.equal(priced.costNanoUsd, 3825000n);
  assert.deepEqual(priced.rateCard, {
    version: '2026-06-02.v1',
    model: 'gemini-3.6-flash',
    tier: 'standard',
    billingUnit: 'TOKEN',
  });
});

test('4. UNPRICED variant carries no costNanoUsd', () => {
  const call: ShadowPricedCall = UNPRICED_VARIANT;
  assert.equal(call.kind, 'UNPRICED');
  assert.equal('costNanoUsd' in call, false);
  assert.equal('costMicros' in call, false);
  assert.equal('costUsd' in call, false);
  assert.equal(call.reason, 'ACTUAL_MODEL_NOT_IN_RATECARD');
});

// Compile-time guards: UNPRICED must be structurally forbidden from carrying
// a cost field. Each line below carries @ts-expect-error and is verified by
// `tsc --noEmit` over this file; the file only type-checks because the
// annotated property accesses are genuine type errors.
const _unpriced = UNPRICED_VARIANT as Extract<ShadowPricedCall, { kind: 'UNPRICED' }>;
if (_unpriced.kind === 'UNPRICED') {
  // @ts-expect-error UNPRICED must not expose costNanoUsd
  const _costNanoUsd: bigint = _unpriced.costNanoUsd;
  // @ts-expect-error UNPRICED must not expose costMicros
  const _costMicros: number = _unpriced.costMicros;
  // @ts-expect-error UNPRICED must not expose costUsd
  const _costUsd: number = _unpriced.costUsd;
}

test('5. ZERO_USAGE_EXPLICIT is PRICED with zero costNanoUsd', () => {
  const call: ShadowPricedCall = {
    kind: 'PRICED',
    providerCallId: 'call-3',
    provider: 'google',
    actualModel: 'gemini-2.5-flash-lite',
    reason: 'ZERO_USAGE_EXPLICIT',
    rateCard: { version: 'v', model: 'm', tier: 'standard', billingUnit: 'TOKEN' },
    costNanoUsd: 0n,
    pricedAt: PRICED_AT,
  };
  assert.equal(call.kind, 'PRICED');
  assert.equal(call.costNanoUsd, 0n);
  assert.equal(call.reason, 'ZERO_USAGE_EXPLICIT');
});

test('6. Consumers can distinguish PRICED@0 from UNPRICED purely by kind', () => {
  const pricedZero: ShadowPricedCall = {
    kind: 'PRICED',
    providerCallId: 'a',
    provider: 'google',
    reason: 'ZERO_USAGE_EXPLICIT',
    rateCard: { version: 'v', model: 'm', tier: 'standard', billingUnit: 'TOKEN' },
    costNanoUsd: 0n,
    pricedAt: PRICED_AT,
  };
  const unpriced: ShadowPricedCall = {
    kind: 'UNPRICED',
    providerCallId: 'b',
    provider: 'google',
    reason: 'MODEL_MISSING',
    pricedAt: PRICED_AT,
  };
  assert.equal(pricedZero.kind === 'PRICED' && pricedZero.costNanoUsd === 0n, true);
  assert.equal(unpriced.kind === 'UNPRICED', true);
  assert.equal('costNanoUsd' in unpriced, false);
});

test('7. Rate card schema constants are exposed', () => {
  assert.equal(RATE_CARD_SCHEMA_VERSION, 1);
  assert.equal(RATE_CARD_CURRENCY, 'USD');
  assert.equal(RATE_CARD_STORAGE_UNIT, 'MICROS');
  assert.equal(RATE_CARD_ENGINE_UNIT, 'NANO_USD');
});

test('8. RateCardEntry and ProviderRateCard are representable', () => {
  const entry: RateCardEntry = {
    provider: 'google',
    model: 'gemini-3.6-flash',
    aliases: ['gemini-3.6-flash-preview'],
    status: 'STABLE',
    tier: 'standard',
    billingUnit: 'TOKEN',
    tokenRates: {
      inputMicrosPerMillion: 1500000,
      outputMicrosPerMillion: 7500000,
      cachedInputMicrosPerMillion: 150000,
    },
    effectiveFrom: '2026-05-01',
    inactive: false,
  };
  assert.equal(entry.provider, 'google');
  assert.equal(entry.tokenRates?.inputMicrosPerMillion, 1500000);
  assert.equal(entry.inactive, false);
});

test('9. RateCardTier is a closed set for shadow pricing input', () => {
  const tier: RateCardTier = 'standard';
  const input: ShadowPricingInput = { providerCalls: [], tier };
  assert.equal(input.tier, 'standard');
});

test('10. ShadowPricingResult carries exactly three summary statuses', () => {
  const statuses: readonly RequestSummaryStatus[] = [
    'FULLY_PRICED',
    'PARTIALLY_PRICED',
    'UNPRICED',
  ];
  assert.equal(statuses.length, 3);
  const result: ShadowPricingResult = {
    pricedAt: PRICED_AT,
    noProviderCalls: true,
    calls: [],
    totals: {
      callCount: 0,
      pricedCallCount: 0,
      unpricedCallCount: 0,
      unpricedReasons: {
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
      },
      pricedCostNanoUsd: 0n,
    },
    summaryStatus: 'UNPRICED',
  };
  assert.equal(result.noProviderCalls, true);
  assert.equal(result.totals.pricedCostNanoUsd, 0n);
});

test('11. BigInt money is not JSON-serializable by default (stays internal)', () => {
  assert.equal(typeof PRICED_VARIANT.costNanoUsd, 'bigint');
  assert.throws(() => JSON.stringify(PRICED_VARIANT.costNanoUsd), TypeError);
  assert.equal(
    Object.prototype.hasOwnProperty.call(PRICED_VARIANT.costNanoUsd, 'toJSON'),
    false,
  );
});

test('12. Empty providerCalls input with no cost fabrication', () => {
  const input: ShadowPricingInput = { providerCalls: [] };
  assert.deepEqual(input.providerCalls, []);
  assert.equal(input.pricingDate, undefined);
});

// Compile-time guards: ProviderRateCard header fields are literal types and
// RateCardApplied tier/billingUnit are closed unions. These @ts-expect-error
// lines are verified by `tsc --noEmit` over this file.

const _VALID_RATE_CARD: ProviderRateCard = {
  schemaVersion: 1,
  currency: 'USD',
  storageUnit: 'MICROS',
  engineUnit: 'NANO_USD',
  version: '2026-08-03.v1',
  source: 'references/ai-pricing/ai-provider-model-pricing.json',
  generatedAt: '2026-08-03T00:00:00.000Z',
  provenance: 'RESEARCH_SNAPSHOT',
  entries: [],
};

const _validApplied: RateCardApplied = {
  version: '2026-08-03.v1',
  model: 'gemini-3.6-flash',
  tier: 'standard',
  billingUnit: 'TOKEN',
};

// Invalid literal currency / schema version / storage / engine / provenance
// values must not be assignable to ProviderRateCard.
// @ts-expect-error ProviderRateCard.currency must be the literal "USD"
const _badCurrency: ProviderRateCard = { ..._VALID_RATE_CARD, currency: 'EUR' };
// @ts-expect-error ProviderRateCard.schemaVersion must be the literal 1
const _badSchema: ProviderRateCard = { ..._VALID_RATE_CARD, schemaVersion: 2 };
// @ts-expect-error ProviderRateCard.storageUnit must be the literal "MICROS"
const _badStorage: ProviderRateCard = { ..._VALID_RATE_CARD, storageUnit: 'FIELD' };
// @ts-expect-error ProviderRateCard.engineUnit must be the literal "NANO_USD"
const _badEngine: ProviderRateCard = { ..._VALID_RATE_CARD, engineUnit: 'MICROS' };
// @ts-expect-error ProviderRateCard.provenance must be the literal "RESEARCH_SNAPSHOT"
const _badProvenance: ProviderRateCard = { ..._VALID_RATE_CARD, provenance: 'LIVE' };

// RateCardApplied tier / billingUnit are their closed union types.
// @ts-expect-error RateCardApplied.tier must be a RateCardTier
const _badAppliedTier: RateCardApplied = { ..._validApplied, tier: 'ultra' };
// @ts-expect-error RateCardApplied.billingUnit must be a RateCardBillingUnit
const _badAppliedBilling: RateCardApplied = { ..._validApplied, billingUnit: 'BYTE' };

test('13. ProviderRateCard header fields accept only the hardened literal values', () => {
  const card: ProviderRateCard = _VALID_RATE_CARD;
  assert.equal(card.schemaVersion, 1);
  assert.equal(card.currency, 'USD');
  assert.equal(card.storageUnit, 'MICROS');
  assert.equal(card.engineUnit, 'NANO_USD');
  assert.equal(card.provenance, 'RESEARCH_SNAPSHOT');
});

test('14. RateCardApplied tier and billingUnit use their closed union types', () => {
  const applied: RateCardApplied = _validApplied;
  const tiers: RateCardTier[] = ['standard', 'batch', 'priority', 'fast_mode'];
  const units: RateCardBillingUnit[] = ['TOKEN', 'IMAGE', 'SECOND', 'MINUTE', 'CHARACTER'];
  assert.ok(tiers.includes(applied.tier));
  assert.ok(units.includes(applied.billingUnit));
});

test('15. SELECTED identity candidate always carries model, lookup key, and source', () => {
  const candidate: PricingIdentityCandidate = {
    kind: 'SELECTED',
    provider: 'google',
    model: 'gemini-3.6-flash',
    modelLookupKey: 'gemini-3.6-flash',
    source: 'ACTUAL_MODEL',
  };
  assert.equal(candidate.kind, 'SELECTED');
  if (candidate.kind === 'SELECTED') {
    assert.equal(typeof candidate.model, 'string');
    assert.equal(typeof candidate.modelLookupKey, 'string');
    assert.ok(['ACTUAL_MODEL', 'REQUESTED_MODEL_FALLBACK'].includes(candidate.source));
  }
});

test('16. MISSING_MODEL identity candidate carries no model or source', () => {
  const missing: PricingIdentityCandidate = { kind: 'MISSING_MODEL', reason: 'MODEL_MISSING' };
  assert.equal(missing.kind, 'MISSING_MODEL');
  if (missing.kind === 'MISSING_MODEL') {
    assert.equal(missing.reason, 'MODEL_MISSING');
  }
  assert.equal('model' in missing, false);
  assert.equal('modelLookupKey' in missing, false);
  assert.equal('source' in missing, false);
});

// MISSING_MODEL structurally cannot hold model / modelLookupKey / source.
const _missingNarrow: PricingIdentityCandidate = { kind: 'MISSING_MODEL', reason: 'MODEL_MISSING' };
if (_missingNarrow.kind === 'MISSING_MODEL') {
  // @ts-expect-error MISSING_MODEL carries no model field
  const _noModel: string = _missingNarrow.model;
  // @ts-expect-error MISSING_MODEL carries no source field
  const _noSource: string = _missingNarrow.source;
}