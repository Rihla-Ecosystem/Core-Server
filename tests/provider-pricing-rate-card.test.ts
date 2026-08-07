import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RateCardValidationError,
  resolveRate,
  validateRateCard,
} from '../src/utils/provider-pricing/rate-card.js';
import { RATE_CARD_CURRENCY, RATE_CARD_ENGINE_UNIT, RATE_CARD_SCHEMA_VERSION, RATE_CARD_STORAGE_UNIT } from '../src/types/provider-pricing.js';
import type { RateCardTier } from '../src/types/provider-pricing.js';
import { PROVIDER_RATE_CARD, RATE_CARD_PROVIDERS } from '../src/config/provider-rate-card/index.js';

/** A minimal valid card (custom provider/model) that then gets mutated. */
function makeCard(): any {
  return {
    schemaVersion: RATE_CARD_SCHEMA_VERSION,
    currency: RATE_CARD_CURRENCY,
    storageUnit: RATE_CARD_STORAGE_UNIT,
    engineUnit: RATE_CARD_ENGINE_UNIT,
    version: '1.0.0',
    source: 'https://example.test/pricing',
    generatedAt: '2026-08-03',
    provenance: 'RESEARCH_SNAPSHOT',
    entries: [
      {
        provider: 'google',
        model: 'model-a',
        status: 'STABLE',
        tier: 'standard',
        billingUnit: 'TOKEN',
        tokenRates: {
          inputMicrosPerMillion: 100_000,
          outputMicrosPerMillion: 400_000,
          cachedInputMicrosPerMillion: 10_000,
        },
        cachedInputAccounting: 'DISJOINT',
        effectiveFrom: '2026-01-01',
        inactive: false,
        source: 'https://example.test/pricing',
        verifiedAt: '2026-08-03',
      },
    ],
  };
}

test('1. validated materialized card exposes google and jina as the derived providers', () => {
  const { card, providers } = validateRateCard(PROVIDER_RATE_CARD);
  assert.ok(providers.includes('google'));
  assert.ok(providers.includes('jina'));
  assert.equal(providers.length, RATE_CARD_PROVIDERS.length);
  assert.equal(card.entries.length, 13);
});

test('1b. materialized card has the Rihla models including Jina v4', () => {
  const { providers } = validateRateCard(PROVIDER_RATE_CARD);
  assert.deepEqual([...providers].sort(), ['google', 'jina']);
  const models = validateRateCard(PROVIDER_RATE_CARD).card.entries.map((e) => e.model);
  assert.deepEqual([...new Set(models)].sort(), [
    'gemini-2.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'jina-embeddings-v4',
  ]);
});

test('2. valid minimal card passes and derives providers', () => {
  const { providers } = validateRateCard(makeCard());
  assert.deepEqual(providers, ['google']);
});

test('3. rejects non-object card', () => {
  assert.throws(() => validateRateCard(42), RateCardValidationError);
  assert.throws(() => validateRateCard([]), RateCardValidationError);
});

test('4. rejects wrong schemaVersion literal', () => {
  assert.throws(() => validateRateCard({ ...makeCard(), schemaVersion: 2 }), RateCardValidationError);
});

test('5. rejects wrong currency lazy', () => {
  assert.throws(() => validateRateCard({ ...makeCard(), currency: 'EUR' }), RateCardValidationError);
});

test('6. rejects wrong storageUnit', () => {
  assert.throws(() => validateRateCard({ ...makeCard(), storageUnit: 'MILLI' }), RateCardValidationError);
});

test('7. rejects wrong engineUnit', () => {
  assert.throws(() => validateRateCard({ ...makeCard(), engineUnit: 'DOLLARS' }), RateCardValidationError);
});

test('8. rejects wrong provenance', () => {
  assert.throws(() => validateRateCard({ ...makeCard(), provenance: 'FAKE' }), RateCardValidationError);
});

test('9. rejects empty entries array', () => {
  assert.throws(() => validateRateCard({ ...makeCard(), entries: [] }), RateCardValidationError);
});

test('10. rejects missing version', () => {
  assert.throws(() => validateRateCard({ ...makeCard(), version: '  ' }), RateCardValidationError);
});

test('11. rejects invalid generatedAt date', () => {
  assert.throws(() => validateRateCard({ ...makeCard(), generatedAt: 'not-a-date' }), RateCardValidationError);
});

test('12. rejects TOKEN entry without tokenRates', () => {
  const c = makeCard();
  delete c.entries[0].tokenRates;
  assert.throws(() => validateRateCard(c), RateCardValidationError);
});

test('13. rejects TOKEN entry that also carries perUnitMicros', () => {
  const c = makeCard();
  (c.entries[0] as Record<string, unknown>).perUnitMicros = 500;
  assert.throws(() => validateRateCard(c), RateCardValidationError);
});

test('14. rejects non-TOKEN billing without perUnitMicros', () => {
  const c = makeCard();
  c.entries[0].billingUnit = 'IMAGE';
  // IMAGE without perUnitMicros is an error; also lacks tokenRates once we clear it.
  delete (c.entries[0] as Record<string, unknown>).tokenRates;
  delete (c.entries[0] as Record<string, unknown>).cachedInputAccounting;
  assert.throws(() => validateRateCard(c), RateCardValidationError);
});

test('15. accepts IMAGE billing with perUnitMicros and no tokenRates', () => {
  const c = makeCard();
  c.entries[0].billingUnit = 'IMAGE';
  delete (c.entries[0] as Record<string, unknown>).tokenRates;
  delete (c.entries[0] as Record<string, unknown>).cachedInputAccounting;
  (c.entries[0] as Record<string, unknown>).perUnitMicros = 39_000;
  const { providers } = validateRateCard(c);
  assert.deepEqual(providers, ['google']);
});

test('16. rejects per-unit billing carrying tokenRates', () => {
  const c = makeCard();
  c.entries[0].billingUnit = 'IMAGE';
  (c.entries[0] as Record<string, unknown>).perUnitMicros = 39_000;
  // tokenRates still present -> incompatible -> error
  assert.throws(() => validateRateCard(c), RateCardValidationError);
});

test('17. cachedInputAccounting without a cached rate is rejected', () => {
  const c = makeCard();
  delete c.entries[0].tokenRates.cachedInputMicrosPerMillion;
  assert.throws(() => validateRateCard(c), RateCardValidationError);
});

test('18. invalid cachedInputAccounting literal is rejected', () => {
  const c = makeCard();
  (c.entries[0] as Record<string, unknown>).cachedInputAccounting = 'KINDA';
  assert.throws(() => validateRateCard(c), RateCardValidationError);
});

test('19. negative rate is rejected', () => {
  const c = makeCard();
  c.entries[0].tokenRates.inputMicrosPerMillion = -1;
  assert.throws(() => validateRateCard(c), RateCardValidationError);
});

test('20. non-safe-integer rate is rejected', () => {
  const c = makeCard();
  c.entries[0].tokenRates.outputMicrosPerMillion = 1.5;
  assert.throws(() => validateRateCard(c), RateCardValidationError);
  c.entries[0].tokenRates.outputMicrosPerMillion = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => validateRateCard(c), RateCardValidationError);
});

test('21. effectiveTo before effectiveFrom is rejected', () => {
  const c = makeCard();
  c.entries[0].effectiveTo = '2020-01-01';
  assert.throws(() => validateRateCard(c), RateCardValidationError);
});

test('22. overlapping windows for same provider+model+tier are rejected', () => {
  const c = makeCard();
  c.entries.push({
    provider: 'google',
    model: 'model-a',
    status: 'STABLE',
    tier: 'standard',
    billingUnit: 'TOKEN',
    tokenRates: { inputMicrosPerMillion: 100_000 },
    effectiveFrom: '2026-06-01',
    inactive: false,
  });
  assert.throws(() => validateRateCard(c), RateCardValidationError);
});

test('23. non-overlapping windows for same key pass', () => {
  const c = makeCard();
  c.entries[0].effectiveTo = '2026-12-31';
  c.entries.push({
    provider: 'google',
    model: 'model-a',
    status: 'STABLE',
    tier: 'standard',
    billingUnit: 'TOKEN',
    tokenRates: { inputMicrosPerMillion: 100_000 },
    effectiveFrom: '2027-01-01',
    inactive: false,
  });
  assert.doesNotThrow(() => validateRateCard(c));
});

test('24. alias mapping to two different canonical models is rejected', () => {
  const c = makeCard();
  c.entries[0].aliases = ['alias-x'];
  c.entries.push({
    provider: 'google',
    model: 'model-b',
    status: 'STABLE',
    tier: 'standard',
    billingUnit: 'TOKEN',
    tokenRates: { inputMicrosPerMillion: 50_000 },
    aliases: ['alias-x'],
    effectiveFrom: '2026-01-01',
    inactive: false,
  });
  assert.throws(() => validateRateCard(c), RateCardValidationError);
});

test('25. empty aliases array is accepted', () => {
  const c = makeCard();
  c.entries[0].aliases = [];
  assert.doesNotThrow(() => validateRateCard(c));
});

test('26. wildcard alias is rejected', () => {
  const c = makeCard();
  c.entries[0].aliases = ['model-*'];
  assert.throws(() => validateRateCard(c), RateCardValidationError);
});

// ---- resolution ---------------------------------------------------------

test('27. resolves exact canonical model at standard tier', () => {
  const { card } = validateRateCard(PROVIDER_RATE_CARD);
  const r = resolveRate({
    card,
    provider: 'google',
    modelLookupKey: 'gemini-3.6-flash',
    source: 'ACTUAL_MODEL',
    tier: 'standard',
    pricingDate: '2026-08-03',
  });
  assert.equal(r.kind, 'RESOLVED');
  if (r.kind === 'RESOLVED') {
    assert.equal(r.entry.model, 'gemini-3.6-flash');
    assert.equal(r.appliedTier, 'standard');
    assert.equal(r.entry.tokenRates?.inputMicrosPerMillion, 1_500_000);
  }
});

test('28. provider trim + lowercase case-insensitivity', () => {
  const { card } = validateRateCard(PROVIDER_RATE_CARD);
  const r = resolveRate({
    card,
    provider: '  Google  ',
    modelLookupKey: 'GEMINI-3.6-FLASH',
    source: 'REQUESTED_MODEL_FALLBACK',
    tier: 'standard',
    pricingDate: '2026-08-03',
  });
  assert.equal(r.kind, 'RESOLVED');
});

test('29. tier batch resolves to batch rate', () => {
  const { card } = validateRateCard(PROVIDER_RATE_CARD);
  const r = resolveRate({
    card,
    provider: 'google',
    modelLookupKey: 'gemini-3.6-flash',
    source: 'ACTUAL_MODEL',
    tier: 'batch',
    pricingDate: '2026-08-03',
  });
  if (r.kind === 'RESOLVED') {
    assert.equal(r.appliedTier, 'batch');
    assert.equal(r.entry.tokenRates?.inputMicrosPerMillion, 750_000);
  }
});

test('30. priority tier resolves to priority rate', () => {
  const { card } = validateRateCard(PROVIDER_RATE_CARD);
  const r = resolveRate({
    card,
    provider: 'google',
    modelLookupKey: 'gemini-3.5-flash-lite',
    source: 'ACTUAL_MODEL',
    tier: 'priority',
    pricingDate: '2026-08-03',
  });
  if (r.kind === 'RESOLVED') {
    assert.equal(r.entry.tokenRates?.inputMicrosPerMillion, 540_000);
  }
});

test('31. unknown provider is PROVIDER_NOT_IN_RATECARD', () => {
  const { card } = validateRateCard(PROVIDER_RATE_CARD);
  const r = resolveRate({
    card,
    provider: 'anthropic',
    modelLookupKey: 'claude-3',
    source: 'ACTUAL_MODEL',
    pricingDate: '2026-08-03',
  });
  assert.deepEqual(r, { kind: 'UNRESOLVED', reason: 'PROVIDER_NOT_IN_RATECARD' });
});

test('32. known provider unknown model (actual) is ACTUAL_MODEL_NOT_IN_RATECARD', () => {
  const { card } = validateRateCard(PROVIDER_RATE_CARD);
  const r = resolveRate({
    card,
    provider: 'google',
    modelLookupKey: 'gemini-9.9-flash',
    source: 'ACTUAL_MODEL',
    pricingDate: '2026-08-03',
  });
  assert.deepEqual(r, { kind: 'UNRESOLVED', reason: 'ACTUAL_MODEL_NOT_IN_RATECARD' });
});

test('33. unknown model via requested source is REQUESTED_MODEL_NOT_IN_RATECARD', () => {
  const { card } = validateRateCard(PROVIDER_RATE_CARD);
  const r = resolveRate({
    card,
    provider: 'google',
    modelLookupKey: 'gemini-9.9-flash',
    source: 'REQUESTED_MODEL_FALLBACK',
    pricingDate: '2026-08-03',
  });
  assert.deepEqual(r, { kind: 'UNRESOLVED', reason: 'REQUESTED_MODEL_NOT_IN_RATECARD' });
});

test('34. future pricing date is RATE_NOT_ACTIVE', () => {
  const { card } = validateRateCard(PROVIDER_RATE_CARD);
  const r = resolveRate({
    card,
    provider: 'google',
    modelLookupKey: 'gemini-3.6-flash',
    source: 'ACTUAL_MODEL',
    pricingDate: '2020-01-01',
  });
  assert.deepEqual(r, { kind: 'UNRESOLVED', reason: 'RATE_NOT_ACTIVE' });
});

test('35. missing tier entry maps to RATE_NOT_ACTIVE (no priority line declared)', () => {
  const c = makeCard();
  const r = resolveRate({
    card: validateRateCard(c).card,
    provider: 'google',
    modelLookupKey: 'model-a',
    source: 'ACTUAL_MODEL',
    tier: 'priority',
    pricingDate: '2026-06-01',
  });
  assert.deepEqual(r, { kind: 'UNRESOLVED', reason: 'RATE_NOT_ACTIVE' });
});

test('36. sub-string model does not match', () => {
  const { card } = validateRateCard(PROVIDER_RATE_CARD);
  const r = resolveRate({
    card,
    provider: 'google',
    modelLookupKey: 'flash',
    source: 'ACTUAL_MODEL',
    pricingDate: '2026-08-03',
  });
  assert.equal(r.kind, 'UNRESOLVED');
});

test('37. model absent (empty) resolves UNRESOLVED for provider present', () => {
  const { card } = validateRateCard(PROVIDER_RATE_CARD);
  const r = resolveRate({
    card,
    provider: 'google',
    modelLookupKey: '',
    source: 'ACTUAL_MODEL',
    pricingDate: '2026-08-03',
  });
  assert.equal(r.kind, 'UNRESOLVED');
});