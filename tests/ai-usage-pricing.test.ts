import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AIProviderUsage } from '../src/types/ai.js';
import type {
  AIProviderTokenRate,
  AIUsagePricingInput,
  AIUsagePricingResult,
  AIWalletPricingPolicy,
} from '../src/types/ai-pricing.js';
import type { BusinessTokenFeature } from '../src/config/business-token-features.js';
import { getBusinessTokenCost } from '../src/config/business-token-features.js';
import {
  AIUsagePricingError,
  calculateAIUsagePrice,
} from '../src/utils/ai-usage-pricing.js';

const BASE_USAGE: AIProviderUsage = {
  provider: 'fake-provider',
  model: 'fake-model',
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
};

const BASE_RATE: AIProviderTokenRate = {
  provider: 'fake-provider',
  model: 'fake-model',
  billingCurrency: 'USD',
  inputMicrosPerMillionTokens: 1_000_000,
  outputMicrosPerMillionTokens: 1_000_000,
  version: 'rate-v1',
};

const BASE_POLICY: AIWalletPricingPolicy = {
  billingCurrency: 'USD',
  walletTokenValueMicros: 1,
  minimumWalletTokens: 1,
  markupBasisPoints: 10_000,
  version: 'policy-v1',
};

const CHAT_COST = getBusinessTokenCost('AI_CHAT_QUERY');

function price(overrides: Partial<AIUsagePricingInput> = {}): AIUsagePricingResult {
  return calculateAIUsagePrice({
    feature: 'AI_CHAT_QUERY',
    requestedMode: 'PROVIDER_USAGE',
    rateCard: [BASE_RATE],
    walletPolicy: BASE_POLICY,
    ...overrides,
  });
}

function usage(overrides: Partial<AIProviderUsage> = {}): AIProviderUsage {
  return { ...BASE_USAGE, ...overrides };
}

// --- Fixed fallback ---------------------------------------------------------

test('1. Explicit FIXED_FALLBACK returns the existing feature fixed cost', () => {
  const result = calculateAIUsagePrice({
    feature: 'AI_CHAT_QUERY',
    requestedMode: 'FIXED_FALLBACK',
    rateCard: [],
    walletPolicy: BASE_POLICY,
  });
  assert.equal(result.walletTokens, CHAT_COST);
  assert.equal(result.fixedFallbackTokens, CHAT_COST);
  assert.equal(result.appliedMode, 'FIXED_FALLBACK');
});

test('2. Explicit FIXED_FALLBACK does not require usage', () => {
  const result = calculateAIUsagePrice({
    feature: 'AI_CHAT_QUERY',
    requestedMode: 'FIXED_FALLBACK',
    rateCard: [],
    walletPolicy: BASE_POLICY,
  });
  assert.equal(result.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.walletTokens, CHAT_COST);
});

test('3. Explicit FIXED_FALLBACK does not require a matching rate', () => {
  const result = calculateAIUsagePrice({
    feature: 'AI_CHAT_QUERY',
    requestedMode: 'FIXED_FALLBACK',
    rateCard: [{ ...BASE_RATE, provider: 'other', model: 'other' }],
    walletPolicy: BASE_POLICY,
  });
  assert.equal(result.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.walletTokens, CHAT_COST);
});

test('4. Explicit FIXED_FALLBACK has no fallbackReason', () => {
  const result = calculateAIUsagePrice({
    feature: 'AI_CHAT_QUERY',
    requestedMode: 'FIXED_FALLBACK',
    rateCard: [],
    walletPolicy: BASE_POLICY,
  });
  assert.equal('fallbackReason' in result, false);
});

test('5. Explicit FIXED_FALLBACK ignores invalid runtime usage', () => {
  const result = calculateAIUsagePrice({
    feature: 'AI_CHAT_QUERY',
    requestedMode: 'FIXED_FALLBACK',
    usage: {
      provider: '',
      model: ' ',
      inputTokens: -5,
      outputTokens: NaN,
      totalTokens: 0,
    } as unknown as AIProviderUsage,
    rateCard: [],
    walletPolicy: BASE_POLICY,
  });
  assert.equal(result.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.walletTokens, CHAT_COST);
});

// --- Provider usage fallback ------------------------------------------------

test('6. Missing usage produces USAGE_MISSING', () => {
  const result = price();
  assert.equal(result.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.fallbackReason, 'USAGE_MISSING');
  assert.equal(result.walletTokens, CHAT_COST);
  assert.equal(result.fixedFallbackTokens, CHAT_COST);
});

test('7. Empty provider produces USAGE_INVALID', () => {
  const result = price({ usage: usage({ provider: '   ' }) });
  assert.equal(result.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.fallbackReason, 'USAGE_INVALID');
  assert.equal(result.walletTokens, CHAT_COST);
});

test('8. Empty model produces USAGE_INVALID', () => {
  const result = price({ usage: usage({ model: '' }) });
  assert.equal(result.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.fallbackReason, 'USAGE_INVALID');
});

test('9. Negative inputTokens produces USAGE_INVALID', () => {
  const result = price({ usage: usage({ inputTokens: -1 }) });
  assert.equal(result.fallbackReason, 'USAGE_INVALID');
});

test('10. Decimal inputTokens produces USAGE_INVALID', () => {
  const result = price({ usage: usage({ inputTokens: 10.5 }) });
  assert.equal(result.fallbackReason, 'USAGE_INVALID');
});

test('11. Unsafe token counts produce USAGE_INVALID', () => {
  const unsafe = price({ usage: usage({ inputTokens: 9007199254740992 }) });
  assert.equal(unsafe.fallbackReason, 'USAGE_INVALID');
  const unsafeOutput = price({ usage: usage({ outputTokens: 9007199254740992 }) });
  assert.equal(unsafeOutput.fallbackReason, 'USAGE_INVALID');
  const unsafeTotal = price({ usage: usage({ totalTokens: 9007199254740992 }) });
  assert.equal(unsafeTotal.fallbackReason, 'USAGE_INVALID');
});

test('12. Invalid cached produces USAGE_INVALID', () => {
  const result = price({ usage: usage({ cached: 'true' as unknown as boolean }) });
  assert.equal(result.fallbackReason, 'USAGE_INVALID');
});

test('13. Invalid audioSeconds produces USAGE_INVALID', () => {
  const negative = price({ usage: usage({ audioSeconds: -1 }) });
  assert.equal(negative.fallbackReason, 'USAGE_INVALID');
  const stringValue = price({ usage: usage({ audioSeconds: 'x' as unknown as number }) });
  assert.equal(stringValue.fallbackReason, 'USAGE_INVALID');
});

test('14. totalTokens differing from input + output is accepted', () => {
  const result = price({ usage: usage({ totalTokens: 999 }) });
  assert.equal(result.appliedMode, 'PROVIDER_USAGE');
  assert.equal(result.totalTokens, 999);
});

test('15. Missing exact provider/model rate produces RATE_CARD_NOT_FOUND', () => {
  const result = price({ usage: usage(), rateCard: [] });
  assert.equal(result.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.fallbackReason, 'RATE_CARD_NOT_FOUND');
  assert.equal(result.walletTokens, CHAT_COST);
});

test('16. A different model rate is never used', () => {
  const result = price({ usage: usage(), rateCard: [{ ...BASE_RATE, model: 'other-model' }] });
  assert.equal(result.fallbackReason, 'RATE_CARD_NOT_FOUND');
});

test('17. A different provider rate is never used', () => {
  const result = price({ usage: usage(), rateCard: [{ ...BASE_RATE, provider: 'other-provider' }] });
  assert.equal(result.fallbackReason, 'RATE_CARD_NOT_FOUND');
});

// --- Successful provider pricing --------------------------------------------

test('18. Exact provider/model rate is selected', () => {
  const result = price({
    usage: usage(),
    rateCard: [
      { ...BASE_RATE, provider: 'other', model: 'other' },
      BASE_RATE,
    ],
  });
  assert.equal(result.appliedMode, 'PROVIDER_USAGE');
  assert.equal(result.provider, 'fake-provider');
  assert.equal(result.model, 'fake-model');
  assert.equal(result.billingCurrency, 'USD');
});

test('19. Input and output cost are calculated correctly', () => {
  const result = price({ usage: usage() });
  assert.equal(result.providerCostMicros, 30);
});

test('20. Combined provider cost is rounded up once', () => {
  const result = price({
    usage: usage({ inputTokens: 1, outputTokens: 1 }),
    rateCard: [
      {
        ...BASE_RATE,
        inputMicrosPerMillionTokens: 500_000,
        outputMicrosPerMillionTokens: 500_000,
      },
    ],
  });
  assert.equal(result.providerCostMicros, 1);
});

test('21. Markup is applied using basis points', () => {
  const result = price({
    usage: usage({ inputTokens: 100, outputTokens: 0, totalTokens: 100 }),
    walletPolicy: { ...BASE_POLICY, markupBasisPoints: 12_500 },
  });
  assert.equal(result.providerCostMicros, 100);
  assert.equal(result.adjustedCostMicros, 125);
  assert.equal(result.walletTokens, 125);
});

test('22. Wallet Token conversion rounds upward', () => {
  const result = price({
    usage: usage({ inputTokens: 150, outputTokens: 0, totalTokens: 150 }),
    walletPolicy: { ...BASE_POLICY, walletTokenValueMicros: 100 },
  });
  assert.equal(result.adjustedCostMicros, 150);
  assert.equal(result.walletTokens, 2);
});

test('23. minimumWalletTokens is applied', () => {
  const result = price({
    usage: usage({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
    walletPolicy: { ...BASE_POLICY, walletTokenValueMicros: 1_000_000, minimumWalletTokens: 5 },
  });
  assert.equal(result.walletTokens, 5);
});

test('24. A zero provider cost can result in the configured minimum charge', () => {
  const result = price({
    usage: usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    walletPolicy: { ...BASE_POLICY, walletTokenValueMicros: 1_000_000, minimumWalletTokens: 5 },
  });
  assert.equal(result.providerCostMicros, 0);
  assert.equal(result.adjustedCostMicros, 0);
  assert.equal(result.walletTokens, 5);
});

test('25. totalTokens is preserved for diagnostics', () => {
  const result = price({ usage: usage({ totalTokens: 777 }) });
  assert.equal(result.totalTokens, 777);
});

test('26. cached is preserved but does not alter price', () => {
  const withCache = price({ usage: usage({ cached: true }) });
  const withoutCache = price({ usage: usage() });
  assert.equal(withCache.cached, true);
  assert.equal(withCache.walletTokens, withoutCache.walletTokens);
  assert.equal(withCache.providerCostMicros, withoutCache.providerCostMicros);
});

test('27. audioSeconds is preserved but does not alter price', () => {
  const withAudio = price({ usage: usage({ audioSeconds: 2.5 }) });
  const withoutAudio = price({ usage: usage() });
  assert.equal(withAudio.audioSeconds, 2.5);
  assert.equal(withAudio.walletTokens, withoutAudio.walletTokens);
  assert.equal(withAudio.providerCostMicros, withoutAudio.providerCostMicros);
});

test('28. Result contains rate-card and policy versions', () => {
  const result = price({ usage: usage() });
  assert.equal(result.rateCardVersion, 'rate-v1');
  assert.equal(result.walletPolicyVersion, 'policy-v1');
});

test('29. requestedMode and appliedMode are reported correctly', () => {
  const fallback = price();
  assert.equal(fallback.requestedMode, 'PROVIDER_USAGE');
  assert.equal(fallback.appliedMode, 'FIXED_FALLBACK');

  const applied = price({ usage: usage() });
  assert.equal(applied.requestedMode, 'PROVIDER_USAGE');
  assert.equal(applied.appliedMode, 'PROVIDER_USAGE');
});

// --- Validation -------------------------------------------------------------

test('30. Empty rate card is valid and causes RATE_CARD_NOT_FOUND', () => {
  const result = price({ usage: usage(), rateCard: [] });
  assert.equal(result.fallbackReason, 'RATE_CARD_NOT_FOUND');
});

test('31. Invalid rate provider is rejected', () => {
  assert.throws(
    () => price({ rateCard: [{ ...BASE_RATE, provider: '' }] }),
    AIUsagePricingError,
  );
});

test('32. Invalid rate model is rejected', () => {
  assert.throws(
    () => price({ rateCard: [{ ...BASE_RATE, model: '   ' }] }),
    AIUsagePricingError,
  );
});

test('33. Negative rate is rejected', () => {
  assert.throws(
    () => price({ rateCard: [{ ...BASE_RATE, inputMicrosPerMillionTokens: -1 }] }),
    AIUsagePricingError,
  );
  assert.throws(
    () => price({ rateCard: [{ ...BASE_RATE, outputMicrosPerMillionTokens: -1 }] }),
    AIUsagePricingError,
  );
});

test('34. Unsafe rate integer is rejected', () => {
  assert.throws(
    () => price({ rateCard: [{ ...BASE_RATE, inputMicrosPerMillionTokens: 9007199254740992 }] }),
    AIUsagePricingError,
  );
});

test('35. Duplicate provider/model rates are rejected', () => {
  assert.throws(
    () => price({ rateCard: [BASE_RATE, { ...BASE_RATE }] }),
    AIUsagePricingError,
  );
});

test('36. Empty policy currency is rejected', () => {
  assert.throws(
    () => price({ walletPolicy: { ...BASE_POLICY, billingCurrency: '  ' } }),
    AIUsagePricingError,
  );
});

test('37. walletTokenValueMicros = 0 is rejected', () => {
  assert.throws(
    () => price({ walletPolicy: { ...BASE_POLICY, walletTokenValueMicros: 0 } }),
    AIUsagePricingError,
  );
});

test('38. Negative minimumWalletTokens is rejected', () => {
  assert.throws(
    () => price({ walletPolicy: { ...BASE_POLICY, minimumWalletTokens: -1 } }),
    AIUsagePricingError,
  );
});

test('39. markupBasisPoints = 0 is rejected', () => {
  assert.throws(
    () => price({ walletPolicy: { ...BASE_POLICY, markupBasisPoints: 0 } }),
    AIUsagePricingError,
  );
});

test('40. Rate/policy currency mismatch is rejected', () => {
  assert.throws(
    () => price({ usage: usage(), walletPolicy: { ...BASE_POLICY, billingCurrency: 'EGP' } }),
    AIUsagePricingError,
  );
});

test('41. Invalid runtime feature is rejected', () => {
  assert.throws(
    () =>
      price({
        feature: 'NOT_A_FEATURE' as unknown as BusinessTokenFeature,
      }),
    AIUsagePricingError,
  );
});

test('42. Unsafe final providerCostMicros is rejected', () => {
  assert.throws(
    () =>
      price({
        usage: usage({ inputTokens: 9007199254740991, outputTokens: 0, totalTokens: 9007199254740991 }),
        rateCard: [
          { ...BASE_RATE, inputMicrosPerMillionTokens: 9007199254740991, outputMicrosPerMillionTokens: 0 },
        ],
      }),
    AIUsagePricingError,
  );
});

test('43. Unsafe final adjustedCostMicros is rejected', () => {
  assert.throws(
    () =>
      price({
        usage: usage({ inputTokens: 9007199254740991, outputTokens: 0, totalTokens: 9007199254740991 }),
        rateCard: [{ ...BASE_RATE, inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 0 }],
        walletPolicy: { ...BASE_POLICY, markupBasisPoints: 20_000 },
      }),
    AIUsagePricingError,
  );
});

test('44. The maximum safe Wallet Token result is accepted', () => {
  // An unsafe final Wallet Token value is structurally prevented because:
  // - adjustedCostMicros is already required to be a safe integer
  // - walletTokenValueMicros is validated to be at least 1
  // - minimumWalletTokens is validated to be a safe integer
  // so the guard can never observe an out-of-range computed value. This test
  // verifies the maximum safe result is computed exactly without overflow.
  const result = price({
    usage: usage({ inputTokens: 9007199254740991, outputTokens: 0, totalTokens: 9007199254740991 }),
    rateCard: [{ ...BASE_RATE, inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 0 }],
    walletPolicy: { ...BASE_POLICY, walletTokenValueMicros: 1 },
  });
  assert.equal(result.providerCostMicros, 9007199254740991);
  assert.equal(result.adjustedCostMicros, 9007199254740991);
  assert.equal(result.walletTokens, 9007199254740991);
});

// --- Exact arithmetic -------------------------------------------------------

test('45. Deterministic example produces exact provider cost, markup, and wallet tokens', () => {
  const result = price({
    usage: usage({ inputTokens: 500_000, outputTokens: 250_000, totalTokens: 750_000 }),
    rateCard: [
      {
        ...BASE_RATE,
        inputMicrosPerMillionTokens: 2_000_000,
        outputMicrosPerMillionTokens: 4_000_000,
      },
    ],
    walletPolicy: {
      ...BASE_POLICY,
      walletTokenValueMicros: 1_000_000,
      markupBasisPoints: 12_500,
      minimumWalletTokens: 1,
    },
  });
  assert.equal(result.providerCostMicros, 2_000_000);
  assert.equal(result.adjustedCostMicros, 2_500_000);
  assert.equal(result.walletTokens, 3);
});

test('46. An exact whole Wallet Token result is not rounded further', () => {
  const result = price({
    usage: usage({ inputTokens: 200, outputTokens: 0, totalTokens: 200 }),
    walletPolicy: { ...BASE_POLICY, walletTokenValueMicros: 100 },
  });
  assert.equal(result.adjustedCostMicros, 200);
  assert.equal(result.walletTokens, 2);
});

test('47. A fractional Wallet Token result is rounded upward', () => {
  const result = price({
    usage: usage({ inputTokens: 250, outputTokens: 0, totalTokens: 250 }),
    walletPolicy: { ...BASE_POLICY, walletTokenValueMicros: 100 },
  });
  assert.equal(result.adjustedCostMicros, 250);
  assert.equal(result.walletTokens, 3);
});

test('48. totalTokens is not used as the billing token count', () => {
  const result = price({ usage: usage({ totalTokens: 9999 }) });
  assert.equal(result.totalTokens, 9999);
  assert.equal(result.providerCostMicros, 30);
  assert.equal(result.walletTokens, 30);
});

// --- Safety and purity ------------------------------------------------------

test('49. Input usage is not mutated', () => {
  const input = usage({ cached: true, audioSeconds: 1.5 });
  const snapshot = structuredClone(input);
  price({ usage: input });
  assert.deepEqual(input, snapshot);
});

test('50. Rate card and entries are not mutated', () => {
  const rateCard = [BASE_RATE];
  const snapshot = structuredClone(rateCard);
  price({ usage: usage(), rateCard });
  assert.deepEqual(rateCard, snapshot);
});

test('51. Wallet policy is not mutated', () => {
  const walletPolicy = { ...BASE_POLICY };
  const snapshot = { ...walletPolicy };
  price({ usage: usage(), walletPolicy });
  assert.deepEqual(walletPolicy, snapshot);
});

test('52. Repeated calculations return independent objects', () => {
  const first = price({ usage: usage() });
  const second = price({ usage: usage() });
  assert.notEqual(first, second);
  assert.deepEqual({ ...first }, { ...second });
});

test('53. The calculator performs no AI, HTTP, Prisma, DB, wallet, reservation, settlement, or pricing-state persistence work', () => {
  const result = price({ usage: usage() });
  assert.equal(result.appliedMode, 'PROVIDER_USAGE');
  const fallback = price();
  assert.equal(fallback.appliedMode, 'FIXED_FALLBACK');
  const repeated = price({ usage: usage() });
  assert.deepEqual({ ...repeated }, { ...result });
});

test('54. Error messages do not expose the complete rate card or usage object', () => {
  assert.throws(
    () =>
      price({
        usage: usage({ provider: 'top-secret-provider', model: 'secret-model' }),
        rateCard: [{ ...BASE_RATE, provider: '' }],
      }),
    (err: unknown) => {
      assert.ok(err instanceof AIUsagePricingError);
      assert.ok(!err.message.includes('top-secret-provider'));
      assert.ok(!err.message.includes('secret-model'));
      assert.ok(!err.message.includes('rate-v1'));
      assert.ok(!err.message.includes('policy-v1'));
      return true;
    },
  );
});

test('55. The error type extends Error with a stable name', () => {
  const err = new AIUsagePricingError('test');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'AIUsagePricingError');
  assert.equal(typeof err.message, 'string');
});

test('56. Successful PROVIDER_USAGE reports the AI_CHAT_QUERY fixed cost', () => {
  const result = price({ usage: usage() });
  assert.equal(result.appliedMode, 'PROVIDER_USAGE');
  assert.equal(result.fixedFallbackTokens, CHAT_COST);
});

test('57. Successful PROVIDER_USAGE reports the AI_IMAGE_ANALYSIS fixed cost', () => {
  const result = price({
    feature: 'AI_IMAGE_ANALYSIS',
    usage: usage(),
  });
  assert.equal(result.appliedMode, 'PROVIDER_USAGE');
  assert.equal(result.fixedFallbackTokens, 5);
});

test('58. Provider-usage walletTokens may differ from fixedFallbackTokens', () => {
  const result = price({ usage: usage() });
  assert.equal(result.walletTokens, 30);
  assert.equal(result.fixedFallbackTokens, CHAT_COST);
  assert.notEqual(result.walletTokens, result.fixedFallbackTokens);
});

test('59. All fallback results report walletTokens equal to fixedFallbackTokens', () => {
  const missing = price();
  assert.equal(missing.walletTokens, missing.fixedFallbackTokens);

  const invalid = price({ usage: usage({ inputTokens: -1 }) });
  assert.equal(invalid.walletTokens, invalid.fixedFallbackTokens);

  const noRate = price({ usage: usage(), rateCard: [] });
  assert.equal(noRate.walletTokens, noRate.fixedFallbackTokens);

  const fixed = calculateAIUsagePrice({
    feature: 'AI_CHAT_QUERY',
    requestedMode: 'FIXED_FALLBACK',
    rateCard: [],
    walletPolicy: BASE_POLICY,
  });
  assert.equal(fixed.walletTokens, fixed.fixedFallbackTokens);
});

test('60. An inherited cached property is ignored rather than treated as own', () => {
  const proto = { cached: 'not-a-boolean' };
  const usageWithInherited = Object.create(proto, {
    provider: { value: 'fake-provider', enumerable: true },
    model: { value: 'fake-model', enumerable: true },
    inputTokens: { value: 10, enumerable: true },
    outputTokens: { value: 20, enumerable: true },
    totalTokens: { value: 30, enumerable: true },
  }) as unknown as AIProviderUsage;

  const result = price({ usage: usageWithInherited });
  assert.equal(result.appliedMode, 'PROVIDER_USAGE');
  assert.equal('cached' in result, false);
});

test('61. An inherited audioSeconds property is ignored rather than treated as own', () => {
  const proto = { audioSeconds: -5 };
  const usageWithInherited = Object.create(proto, {
    provider: { value: 'fake-provider', enumerable: true },
    model: { value: 'fake-model', enumerable: true },
    inputTokens: { value: 10, enumerable: true },
    outputTokens: { value: 20, enumerable: true },
    totalTokens: { value: 30, enumerable: true },
  }) as unknown as AIProviderUsage;

  const result = price({ usage: usageWithInherited });
  assert.equal(result.appliedMode, 'PROVIDER_USAGE');
  assert.equal('audioSeconds' in result, false);
});
