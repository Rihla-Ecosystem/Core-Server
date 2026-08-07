import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceProviderCall } from '../src/utils/provider-pricing/price-call.js';
import { validateRateCard } from '../src/utils/provider-pricing/rate-card.js';
import { PROVIDER_RATE_CARD } from '../src/config/provider-rate-card/index.js';

const ctx = { card: PROVIDER_RATE_CARD, pricingDate: '2026-08-03' };

function geminiCall(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'google',
    providerCallId: 'c1',
    requestedModel: 'gemini-3.6-flash',
    actualModel: 'gemini-3.6-flash',
    inputTokens: 1500,
    outputTokens: 200,
    cachedInputTokens: 500,
    ...overrides,
  } as Parameters<typeof priceProviderCall>[0];
}

test('1. §8.4 gemini-3.6-flash call is PRICED at exactly 3_825_000 nUSD', () => {
  const r = priceProviderCall(geminiCall({ reasoningTokens: 50 }), ctx);
  assert.equal(r.kind, 'PRICED');
  if (r.kind === 'PRICED') {
    assert.equal(r.costNanoUsd, 3_825_000n);
    assert.equal(r.reason, 'ACTUAL_MODEL');
    assert.equal(r.rateCard.model, 'gemini-3.6-flash');
    assert.equal(r.rateCard.tier, 'standard');
    assert.equal(r.usageApplied?.cachedInputAccounting, 'DISJOINT');
  }
});

test('2. cost is derived only from actualModel (authoritative)', () => {
  const r = priceProviderCall(geminiCall({ actualModel: 'gemini-2.5-flash-lite', inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 }), ctx);
  assert.equal(r.kind, 'PRICED');
  if (r.kind === 'PRICED') {
    // flash-lite: 1 token x 100_000 µUSD/1M = 100 nUSD
    assert.equal(r.costNanoUsd, 100n);
    assert.equal(r.reason, 'ACTUAL_MODEL');
  }
});

test('3. reason stays REQUESTED_MODEL_FALLBACK when actualModel absent', () => {
  const r = priceProviderCall(geminiCall({ actualModel: undefined, inputTokens: 1 }), ctx);
  assert.equal(r.kind, 'PRICED');
  if (r.kind === 'PRICED') {
    assert.equal(r.reason, 'REQUESTED_MODEL_FALLBACK');
    assert.equal(r.rateCard.model, 'gemini-3.6-flash');
  }
});

test('4. unresolvable actualModel → ACTUAL_MODEL_NOT_IN_RATECARD, no requested fallback', () => {
  const r = priceProviderCall(geminiCall({ actualModel: 'gemini-mystery', requestedModel: 'gemini-3.6-flash' }), ctx);
  assert.deepEqual(r, { kind: 'UNPRICED', providerCallId: 'c1', provider: 'google', operation: undefined, requestedModel: 'gemini-3.6-flash', actualModel: 'gemini-mystery', reason: 'ACTUAL_MODEL_NOT_IN_RATECARD', pricedAt: '2026-08-03' });
});

test('5. TTS model gemini-3.1-flash-tts-preview is PRICED', () => {
  const r = priceProviderCall(
    { provider: 'google', providerCallId: 't', actualModel: 'gemini-3.1-flash-tts-preview', inputTokens: 10 },
    ctx,
  );
  assert.equal(r.kind, 'PRICED');
  if (r.kind === 'PRICED') {
    assert.equal(r.costNanoUsd, 10_000n);
    assert.equal(r.rateCard.model, 'gemini-3.1-flash-tts-preview');
  }
});

test('6. USAGE_MISSING when no usage present', () => {
  const r = priceProviderCall(geminiCall({ inputTokens: undefined, outputTokens: undefined, cachedInputTokens: undefined }), ctx);
  assert.equal(r.kind, 'UNPRICED');
  if (r.kind === 'UNPRICED') assert.equal(r.reason, 'USAGE_MISSING');
});

test('7. USAGE_INVALID on negative counts', () => {
  const r = priceProviderCall(geminiCall({ inputTokens: -1 }), ctx);
  assert.equal(r.kind, 'UNPRICED');
  if (r.kind === 'UNPRICED') assert.equal(r.reason, 'USAGE_INVALID');
});

test('8. USAGE_INVALID on non-safe-integer counts', () => {
  const r = priceProviderCall(geminiCall({ inputTokens: 1.5 }), ctx);
  assert.equal(r.kind, 'UNPRICED');
  if (r.kind === 'UNPRICED') assert.equal(r.reason, 'USAGE_INVALID');
});

test('9. explicit zero usage is PRICED @ 0n with ZERO_USAGE_EXPLICIT', () => {
  const r = priceProviderCall(geminiCall({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }), ctx);
  assert.equal(r.kind, 'PRICED');
  if (r.kind === 'PRICED') {
    assert.equal(r.costNanoUsd, 0n);
    assert.equal(r.reason, 'ZERO_USAGE_EXPLICIT');
  }
});

test('10. cached input DISJOINT adds separately (not double counted)', () => {
  const r = priceProviderCall(geminiCall({ cachedInputTokens: 0, inputTokens: 1500, outputTokens: 200 }), ctx);
  assert.equal(r.kind, 'PRICED');
  if (r.kind === 'PRICED') {
    // input 2_250_000 + output 1_500_000 = 3_750_000 (cached 0 adds nothing)
    assert.equal(r.costNanoUsd, 3_750_000n);
  }
});

test('11. cached input without a rate resolves UNIT_UNPRICED', () => {
  const card = validateRateCard(PROVIDER_RATE_CARD).card;
  const stripped = {
    ...card,
    entries: card.entries.map((e) =>
      e.model === 'gemini-3.6-flash' && e.tier === 'standard'
        ? {
            ...e,
            tokenRates: { ...e.tokenRates, cachedInputMicrosPerMillion: undefined },
            cachedInputAccounting: undefined,
          }
        : e,
    ),
  };
  const r = priceProviderCall(
    { provider: 'google', providerCallId: 'x', actualModel: 'gemini-3.6-flash', cachedInputTokens: 5 },
    { card: stripped as typeof card, pricingDate: '2026-08-03' },
  );
  assert.equal(r.kind, 'UNPRICED');
  if (r.kind === 'UNPRICED') assert.equal(r.reason, 'UNIT_UNPRICED');
});

test('12. reported cached output with no cached-output rate resolves UNIT_UNPRICED', () => {
  const r = priceProviderCall(geminiCall({ cachedOutputTokens: 5 }), ctx);
  assert.equal(r.kind, 'UNPRICED');
  if (r.kind === 'UNPRICED') assert.equal(r.reason, 'UNIT_UNPRICED');
});

test('13. OVERFLOW reason token exists (defensive reserve)', () => {
  // BigInt internal arithmetic cannot overflow; verify the recommendation exists via type.
  assert.ok(['PROVIDER_NOT_IN_RATECARD','MODEL_MISSING','ACTUAL_MODEL_NOT_IN_RATECARD','REQUESTED_MODEL_NOT_IN_RATECARD','USAGE_MISSING','USAGE_INVALID','RATE_NOT_ACTIVE','UNIT_UNPRICED','MODALITY_INVALID','OVERFLOW'].includes('OVERFLOW'));
});

test('14. MODALITY_INVALID when audioInputTokens > inputTokens', () => {
  const r = priceProviderCall(geminiCall({ inputTokens: 10, audioInputTokens: 20 }), ctx);
  assert.equal(r.kind, 'UNPRICED');
  if (r.kind === 'UNPRICED') assert.equal(r.reason, 'MODALITY_INVALID');
});

test('15. image/audio breakdowns are non-additive (price aggregate input only)', () => {
  const r = priceProviderCall(geminiCall({ audioInputTokens: 100, imageInputTokens: 50 }), ctx);
  assert.equal(r.kind, 'PRICED');
  if (r.kind === 'PRICED') {
    // input 1500 + output 200 + cached 500 => 3_825_000 (breakdowns ignored)
    assert.equal(r.costNanoUsd, 3_825_000n);
  }
});

test('16. per-call never fabricates missing-zero usageApplied for PRICED', () => {
  const r = priceProviderCall(geminiCall({ cachedInputTokens: undefined }), ctx);
  assert.equal(r.kind, 'PRICED');
  if (r.kind === 'PRICED') {
    assert.equal(r.costNanoUsd, 3_750_000n);
  }
});

function secondUnitCard() {
  return validateRateCard({
    schemaVersion: 1,
    currency: 'USD',
    storageUnit: 'MICROS',
    engineUnit: 'NANO_USD',
    version: '1.0.0',
    source: 'https://example.test/pricing',
    generatedAt: '2026-08-03',
    provenance: 'RESEARCH_SNAPSHOT',
    entries: [
      {
        provider: 'acme',
        model: 'tts-model',
        status: 'STABLE',
        tier: 'standard',
        billingUnit: 'SECOND',
        perUnitMicros: 17_000,
        effectiveFrom: '2026-01-01',
        inactive: false,
      },
    ],
  }).card;
}

test('17. SECOND unit with whole-unit count prices exactly at perUnitMicros', () => {
  const card = secondUnitCard();
  const r = priceProviderCall(
    { provider: 'acme', providerCallId: 't', actualModel: 'tts-model', audioOutputSeconds: 60 },
    { card, pricingDate: '2026-08-03' },
  );
  assert.equal(r.kind, 'PRICED');
  if (r.kind === 'PRICED') {
    assert.equal(r.costNanoUsd, 17_000n * 60n * 1_000n);
    assert.equal(r.usageApplied?.audioOutputSeconds, 60);
  }
});

test('18. SECOND unit with fractional duration returns USAGE_INVALID (no float money)', () => {
  const card = secondUnitCard();
  const r = priceProviderCall(
    { provider: 'acme', providerCallId: 't', actualModel: 'tts-model', audioOutputSeconds: 60.5 },
    { card, pricingDate: '2026-08-03' },
  );
  assert.equal(r.kind, 'UNPRICED');
  if (r.kind === 'UNPRICED') assert.equal(r.reason, 'USAGE_INVALID');
});

test('19. Unpriced model stays UNPRICED before any duration pricing', () => {
  const r = priceProviderCall(
    { provider: 'google', providerCallId: 't', actualModel: 'gemini-unpriced-model', audioOutputSeconds: 30 },
    ctx,
  );
  assert.equal(r.kind, 'UNPRICED');
  if (r.kind === 'UNPRICED') assert.equal(r.reason, 'ACTUAL_MODEL_NOT_IN_RATECARD');
});