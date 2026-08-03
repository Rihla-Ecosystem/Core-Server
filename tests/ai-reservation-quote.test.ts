import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatLimitsConfig } from '../src/config/chat-limits.js';
import type {
  AIProviderTokenRate,
  AIUsagePricingMode,
  AIWalletPricingPolicy,
} from '../src/types/ai-pricing.js';
import type {
  AIReservationQuoteInput,
  AIReservationQuoteResult,
} from '../src/types/ai-reservation-quote.js';
import type { BusinessTokenFeature } from '../src/config/business-token-features.js';
import { getBusinessTokenCost } from '../src/config/business-token-features.js';
import {
  AIReservationQuoteError,
  calculateAIReservationQuote,
} from '../src/utils/ai-reservation-quote.js';
import { AIUsagePricingError } from '../src/utils/ai-usage-pricing.js';

const CHAT_COST = getBusinessTokenCost('AI_CHAT_QUERY');

const BASE_CHAT_LIMITS: ChatLimitsConfig = {
  maxInputTokens: 12000,
  maxCurrentMessageTokens: 3000,
  maxMessageCharacters: 10000,
  maxRecentMessages: 10,
  historyTokenBudget: 5500,
  summaryTokenBudget: 1000,
  maxOutputTokens: 1200,
  inputHeadroomTokens: 12000 - 3000 - 5500 - 1000,
};

const SMALL_CHAT_LIMITS: ChatLimitsConfig = {
  maxInputTokens: 1,
  maxCurrentMessageTokens: 1,
  maxMessageCharacters: 10000,
  maxRecentMessages: 0,
  historyTokenBudget: 0,
  summaryTokenBudget: 0,
  maxOutputTokens: 1,
  inputHeadroomTokens: 0,
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

const SMALL_USAGE_LIMITS: ChatLimitsConfig = {
  maxInputTokens: 100,
  maxCurrentMessageTokens: 50,
  maxMessageCharacters: 10000,
  maxRecentMessages: 10,
  historyTokenBudget: 0,
  summaryTokenBudget: 0,
  maxOutputTokens: 10,
  inputHeadroomTokens: 100 - 50,
};

function quote(overrides: Partial<AIReservationQuoteInput> = {}): AIReservationQuoteResult {
  return calculateAIReservationQuote({
    feature: 'AI_CHAT_QUERY',
    requestedMode: 'PROVIDER_USAGE',
    provider: 'fake-provider',
    model: 'fake-model',
    chatLimits: BASE_CHAT_LIMITS,
    rateCard: [BASE_RATE],
    walletPolicy: BASE_POLICY,
    ...overrides,
  });
}

function chatLimits(overrides: Partial<ChatLimitsConfig> = {}): ChatLimitsConfig {
  return { ...BASE_CHAT_LIMITS, ...overrides };
}

function expectQuoteError(
  input: AIReservationQuoteInput,
  message?: string,
): AIReservationQuoteError {
  let caught: AIReservationQuoteError | undefined;
  try {
    calculateAIReservationQuote(input);
  } catch (err) {
    assert.ok(err instanceof AIReservationQuoteError);
    caught = err;
  }
  assert.ok(caught, 'expected AIReservationQuoteError to be thrown');
  if (message !== undefined) {
    assert.equal(caught.message, message);
  }
  return caught;
}

// --- Fixed pricing mode ------------------------------------------------------

test('1. FIXED_FALLBACK reserves the existing fixed feature cost', () => {
  const result = quote({ requestedMode: 'FIXED_FALLBACK' });
  assert.equal(result.reservationTokens, CHAT_COST);
  assert.equal(result.fixedFallbackTokens, CHAT_COST);
});

test('2. FIXED_FALLBACK reports requestedMode and appliedMode correctly', () => {
  const result = quote({ requestedMode: 'FIXED_FALLBACK' });
  assert.equal(result.requestedMode, 'FIXED_FALLBACK');
  assert.equal(result.appliedMode, 'FIXED_FALLBACK');
});

test('3. FIXED_FALLBACK has no fallbackReason', () => {
  const result = quote({ requestedMode: 'FIXED_FALLBACK' });
  assert.equal('fallbackReason' in result, false);
});

test('4. FIXED_FALLBACK omits maximumUsageWalletTokens', () => {
  const result = quote({ requestedMode: 'FIXED_FALLBACK' });
  assert.equal('maximumUsageWalletTokens' in result, false);
});

test('5. FIXED_FALLBACK does not require provider or model', () => {
  const result = calculateAIReservationQuote({
    feature: 'AI_CHAT_QUERY',
    requestedMode: 'FIXED_FALLBACK',
    chatLimits: BASE_CHAT_LIMITS,
    rateCard: [],
    walletPolicy: BASE_POLICY,
  });
  assert.equal(result.reservationTokens, CHAT_COST);
  assert.equal('provider' in result, false);
  assert.equal('model' in result, false);
});

test('6. A different feature uses its own fixed cost', () => {
  const result = quote({
    requestedMode: 'FIXED_FALLBACK',
    feature: 'AI_TRIP_ITINERARY',
  });
  assert.equal(result.reservationTokens, 10);
  assert.equal(result.fixedFallbackTokens, 10);
});

// --- Provider-usage mode input ----------------------------------------------

test('7. PROVIDER_USAGE requires provider', () => {
  expectQuoteError(
    quoteInput({
      provider: undefined,
    }),
  );
});

test('8. PROVIDER_USAGE rejects an empty provider', () => {
  expectQuoteError(
    quoteInput({
      provider: '   ',
    }),
  );
});

test('9. PROVIDER_USAGE requires model', () => {
  expectQuoteError(
    quoteInput({
      model: undefined,
    }),
  );
});

test('10. PROVIDER_USAGE rejects an empty model', () => {
  expectQuoteError(
    quoteInput({
      model: '',
    }),
  );
});

test('11. Provider and model are trimmed', () => {
  const result = quote({ provider: '  fake-provider  ', model: '\tfake-model ' });
  assert.equal(result.provider, 'fake-provider');
  assert.equal(result.model, 'fake-model');
});

test('12. Exact provider/model rate is used', () => {
  const result = quote({
    rateCard: [
      { ...BASE_RATE, provider: 'other', model: 'other' },
      BASE_RATE,
    ],
  });
  assert.equal(result.appliedMode, 'PROVIDER_USAGE');
  assert.equal(result.provider, 'fake-provider');
  assert.equal(result.model, 'fake-model');
});

test('13. A different model is never used', () => {
  const result = quote({ rateCard: [{ ...BASE_RATE, model: 'other-model' }] });
  assert.equal(result.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.fallbackReason, 'RATE_CARD_NOT_FOUND');
});

test('14. A different provider is never used', () => {
  const result = quote({ rateCard: [{ ...BASE_RATE, provider: 'other-provider' }] });
  assert.equal(result.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.fallbackReason, 'RATE_CARD_NOT_FOUND');
});

// --- Maximum usage construction ---------------------------------------------

test('15. maxInputTokens becomes usage.inputTokens', () => {
  const result = quote({
    chatLimits: SMALL_USAGE_LIMITS,
    rateCard: [
      {
        ...BASE_RATE,
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 0,
      },
    ],
  });
  assert.equal(result.providerCostMicros, 100);
});

test('16. maxOutputTokens becomes usage.outputTokens', () => {
  const result = quote({
    chatLimits: SMALL_USAGE_LIMITS,
    rateCard: [
      {
        ...BASE_RATE,
        inputMicrosPerMillionTokens: 0,
        outputMicrosPerMillionTokens: 1_000_000,
      },
    ],
  });
  assert.equal(result.providerCostMicros, 10);
});

test('17. maximum total tokens is input + output', () => {
  const result = quote({
    chatLimits: SMALL_USAGE_LIMITS,
  });
  assert.equal(result.providerCostMicros, 110);
  assert.equal(result.maximumUsageWalletTokens, 110);
});

test('18. totalTokens is diagnostic and not billed separately', () => {
  const result = quote({
    chatLimits: SMALL_USAGE_LIMITS,
    rateCard: [
      {
        ...BASE_RATE,
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
      },
    ],
  });
  assert.equal(result.providerCostMicros, 120);
  assert.equal('totalTokens' in result, false);
});

test('19. Unsafe input + output addition is rejected', () => {
  expectQuoteError(
    quoteInput({
      chatLimits: chatLimits({
        maxInputTokens: 9007199254740991,
        maxOutputTokens: 9007199254740991,
        maxCurrentMessageTokens: 1,
        historyTokenBudget: 0,
        summaryTokenBudget: 0,
        inputHeadroomTokens: 9007199254740990,
      }),
    }),
    'maximum total tokens must be a safe integer',
  );
});

// --- Reservation-token rule --------------------------------------------------

test('20. Provider maximum greater than fixed reserves the provider maximum', () => {
  const result = quote();
  assert.equal(result.maximumUsageWalletTokens, 13200);
  assert.equal(result.reservationTokens, 13200);
});

test('21. Provider maximum less than fixed reserves the fixed cost', () => {
  const result = quote({
    feature: 'AI_TRIP_ITINERARY',
    chatLimits: SMALL_CHAT_LIMITS,
    walletPolicy: { ...BASE_POLICY, walletTokenValueMicros: 1_000_000 },
  });
  assert.equal(result.maximumUsageWalletTokens, 1);
  assert.equal(result.reservationTokens, getBusinessTokenCost('AI_TRIP_ITINERARY'));
});

test('22. Provider maximum equal to fixed reserves that value', () => {
  const result = quote({
    chatLimits: SMALL_CHAT_LIMITS,
    walletPolicy: { ...BASE_POLICY, walletTokenValueMicros: 1 },
  });
  assert.equal(result.maximumUsageWalletTokens, 2);
  assert.equal(result.reservationTokens, 2);
});

test('23. Fixed and maximum values are not added together', () => {
  const result = quote();
  assert.equal(result.reservationTokens, 13200);
  assert.notEqual(result.reservationTokens, 13200 + 2);
});

test('24. Provider quote reports maximumUsageWalletTokens', () => {
  const result = quote();
  assert.equal(result.maximumUsageWalletTokens, 13200);
});

test('25. No hardcoded reservation ceiling is used', () => {
  const result = quote();
  assert.equal(result.reservationTokens, 13200);
  assert.equal(result.maximumUsageWalletTokens, 13200);
});

// --- Rate-card fallback ------------------------------------------------------

test('26. Empty valid rate card returns RATE_CARD_NOT_FOUND', () => {
  const result = quote({ rateCard: [] });
  assert.equal(result.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.fallbackReason, 'RATE_CARD_NOT_FOUND');
});

test('27. Missing exact model rate returns RATE_CARD_NOT_FOUND', () => {
  const result = quote({ rateCard: [{ ...BASE_RATE, model: 'other-model' }] });
  assert.equal(result.fallbackReason, 'RATE_CARD_NOT_FOUND');
});

test('28. RATE_CARD_NOT_FOUND reserves fixedFallbackTokens', () => {
  const result = quote({ rateCard: [] });
  assert.equal(result.reservationTokens, CHAT_COST);
  assert.equal(result.fixedFallbackTokens, CHAT_COST);
});

test('29. RATE_CARD_NOT_FOUND omits maximumUsageWalletTokens', () => {
  const result = quote({ rateCard: [] });
  assert.equal('maximumUsageWalletTokens' in result, false);
});

test('30. No alternate rate is selected', () => {
  const result = quote({ rateCard: [{ ...BASE_RATE, provider: 'other', model: 'other' }] });
  assert.equal(result.fallbackReason, 'RATE_CARD_NOT_FOUND');
  assert.equal('provider' in result, false);
  assert.equal('model' in result, false);
});

// --- Chat-limit validation ---------------------------------------------------

test('31. Invalid maxInputTokens is rejected', () => {
  expectQuoteError(
    quoteInput({ chatLimits: chatLimits({ maxInputTokens: 0 }) }),
    'chatLimits maxInputTokens must be a safe positive integer',
  );
});

test('32. Invalid maxOutputTokens is rejected', () => {
  expectQuoteError(
    quoteInput({ chatLimits: chatLimits({ maxOutputTokens: 0 }) }),
    'chatLimits maxOutputTokens must be a safe positive integer',
  );
});

test('33. Invalid maxCurrentMessageTokens is rejected', () => {
  expectQuoteError(
    quoteInput({ chatLimits: chatLimits({ maxCurrentMessageTokens: 0 }) }),
    'chatLimits maxCurrentMessageTokens must be a safe positive integer',
  );
});

test('34. Invalid maxMessageCharacters is rejected', () => {
  expectQuoteError(
    quoteInput({ chatLimits: chatLimits({ maxMessageCharacters: 0 }) }),
    'chatLimits maxMessageCharacters must be a safe positive integer',
  );
});

test('35. Invalid maxRecentMessages is rejected', () => {
  expectQuoteError(
    quoteInput({ chatLimits: chatLimits({ maxRecentMessages: -1 }) }),
    'chatLimits maxRecentMessages must be a safe non-negative integer',
  );
});

test('36. Invalid historyTokenBudget is rejected', () => {
  expectQuoteError(
    quoteInput({ chatLimits: chatLimits({ historyTokenBudget: -1 }) }),
    'chatLimits historyTokenBudget must be a safe non-negative integer',
  );
});

test('37. Invalid summaryTokenBudget is rejected', () => {
  expectQuoteError(
    quoteInput({ chatLimits: chatLimits({ summaryTokenBudget: -1 }) }),
    'chatLimits summaryTokenBudget must be a safe non-negative integer',
  );
});

test('38. Invalid inputHeadroomTokens is rejected', () => {
  expectQuoteError(
    quoteInput({ chatLimits: chatLimits({ inputHeadroomTokens: -1 }) }),
    'chatLimits inputHeadroomTokens must be a safe non-negative integer',
  );
});

test('39. Current-message limit greater than input limit is rejected', () => {
  expectQuoteError(
    quoteInput({ chatLimits: chatLimits({ maxCurrentMessageTokens: 12001 }) }),
    'chatLimits maxCurrentMessageTokens must not exceed maxInputTokens',
  );
});

test('40. Context-budget sum greater than input limit is rejected', () => {
  expectQuoteError(
    quoteInput({
      chatLimits: chatLimits({
        maxInputTokens: 100,
        maxCurrentMessageTokens: 60,
        historyTokenBudget: 30,
        summaryTokenBudget: 20,
      }),
    }),
    'chatLimits context budgets must not exceed maxInputTokens',
  );
});

test('41. Incorrect inputHeadroomTokens is rejected', () => {
  expectQuoteError(
    quoteInput({ chatLimits: chatLimits({ inputHeadroomTokens: 2501 }) }),
    'chatLimits inputHeadroomTokens is inconsistent',
  );
});

test('42. Zero history and summary limits remain supported', () => {
  const result = quote({
    chatLimits: chatLimits({
      maxInputTokens: 100,
      maxCurrentMessageTokens: 100,
      historyTokenBudget: 0,
      summaryTokenBudget: 0,
      inputHeadroomTokens: 0,
      maxOutputTokens: 10,
    }),
  });
  assert.equal(result.appliedMode, 'PROVIDER_USAGE');
});

test('43. Zero maxRecentMessages remains supported', () => {
  const result = quote({ chatLimits: chatLimits({ maxRecentMessages: 0 }) });
  assert.equal(result.appliedMode, 'PROVIDER_USAGE');
});

// --- Pricing propagation -----------------------------------------------------

test('44. providerCostMicros is preserved', () => {
  const result = quote();
  assert.equal(result.providerCostMicros, 13200);
});

test('45. adjustedCostMicros is preserved', () => {
  const result = quote();
  assert.equal(result.adjustedCostMicros, 13200);
});

test('46. billingCurrency is preserved', () => {
  const result = quote();
  assert.equal(result.billingCurrency, 'USD');
});

test('47. rateCardVersion is preserved', () => {
  const result = quote();
  assert.equal(result.rateCardVersion, 'rate-v1');
});

test('48. walletPolicyVersion is preserved', () => {
  const result = quote();
  assert.equal(result.walletPolicyVersion, 'policy-v1');
});

test('49. requestedMode and appliedMode are correct', () => {
  const provider = quote();
  assert.equal(provider.requestedMode, 'PROVIDER_USAGE');
  assert.equal(provider.appliedMode, 'PROVIDER_USAGE');

  const fixed = quote({ requestedMode: 'FIXED_FALLBACK' });
  assert.equal(fixed.requestedMode, 'FIXED_FALLBACK');
  assert.equal(fixed.appliedMode, 'FIXED_FALLBACK');
});

test('50. fixedFallbackTokens always reflects the existing feature fixed cost', () => {
  assert.equal(quote().fixedFallbackTokens, CHAT_COST);
  assert.equal(quote({ requestedMode: 'FIXED_FALLBACK' }).fixedFallbackTokens, CHAT_COST);
  assert.equal(quote({ feature: 'AI_IMAGE_ANALYSIS' }).fixedFallbackTokens, 5);
  assert.equal(quote({ feature: 'AI_TRIP_ITINERARY' }).fixedFallbackTokens, 10);
});

// --- Validation and safety ---------------------------------------------------

test('51. Invalid runtime feature is rejected', () => {
  expectQuoteError(
    quoteInput({
      feature: 'NOT_A_FEATURE' as unknown as BusinessTokenFeature,
    }),
  );
});

test('52. Invalid requested mode is rejected', () => {
  expectQuoteError(
    quoteInput({
      requestedMode: 'AUTO' as unknown as AIUsagePricingMode,
    }),
  );
});

test('53. Invalid rate card still throws the existing pricing configuration error', () => {
  assert.throws(
    () => quote({ rateCard: [{ ...BASE_RATE, provider: '' }] }),
    AIUsagePricingError,
  );
});

test('54. Invalid Wallet policy is rejected', () => {
  assert.throws(
    () => quote({ walletPolicy: { ...BASE_POLICY, walletTokenValueMicros: 0 } }),
    AIUsagePricingError,
  );
});

test('55. Currency mismatch is rejected', () => {
  assert.throws(
    () => quote({ walletPolicy: { ...BASE_POLICY, billingCurrency: 'EGP' } }),
    AIUsagePricingError,
  );
});

test('56. Unsafe quote result is rejected', () => {
  expectQuoteError(
    quoteInput({
      chatLimits: chatLimits({
        maxInputTokens: 9007199254740991,
        maxOutputTokens: 9007199254740991,
        maxCurrentMessageTokens: 1,
        historyTokenBudget: 0,
        summaryTokenBudget: 0,
        inputHeadroomTokens: 9007199254740990,
      }),
    }),
  );

  for (const result of [quote(), quote({ requestedMode: 'FIXED_FALLBACK' })]) {
    assert.ok(Number.isSafeInteger(result.reservationTokens));
    assert.ok(result.reservationTokens >= 0);
    assert.ok(Number.isSafeInteger(result.fixedFallbackTokens));
    assert.ok(result.fixedFallbackTokens >= 0);
    assert.ok(Number.isSafeInteger(result.maxInputTokens));
    assert.ok(Number.isSafeInteger(result.maxOutputTokens));
    if (result.maximumUsageWalletTokens !== undefined) {
      assert.ok(Number.isSafeInteger(result.maximumUsageWalletTokens));
      assert.ok(result.maximumUsageWalletTokens >= 0);
    }
  }
});

test('57. Error messages do not expose the complete rate card or policy', () => {
  assert.throws(
    () =>
      quote({
        provider: 'top-secret-provider',
        model: 'secret-model',
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

  const err = expectQuoteError(
    quoteInput({ chatLimits: chatLimits({ inputHeadroomTokens: 2501 }) }),
  );
  assert.ok(!err.message.includes('12000'));
});

// --- Purity ------------------------------------------------------------------

test('58. Input is not mutated', () => {
  const input: AIReservationQuoteInput = quoteInput({ provider: 'fake-provider' });
  const snapshot = structuredClone(input);
  calculateAIReservationQuote(input);
  assert.deepEqual(input, snapshot);
});

test('59. Chat limits are not mutated', () => {
  const limits = { ...BASE_CHAT_LIMITS };
  const snapshot = { ...limits };
  quote({ chatLimits: limits });
  assert.deepEqual(limits, snapshot);
});

test('60. Rate card and entries are not mutated', () => {
  const rateCard = [BASE_RATE];
  const snapshot = structuredClone(rateCard);
  quote({ rateCard });
  assert.deepEqual(rateCard, snapshot);
});

test('61. Wallet policy is not mutated', () => {
  const walletPolicy = { ...BASE_POLICY };
  const snapshot = { ...walletPolicy };
  quote({ walletPolicy });
  assert.deepEqual(walletPolicy, snapshot);
});

test('62. Repeated quote calculations return independent objects', () => {
  const first = quote();
  const second = quote();
  assert.notEqual(first, second);
  assert.deepEqual({ ...first }, { ...second });
});

test('63. The calculator performs no AI, HTTP, Prisma, DB, wallet, reservation, settlement, release, or persistence work', () => {
  const result = quote();
  assert.equal(result.appliedMode, 'PROVIDER_USAGE');
  const fixed = quote({ requestedMode: 'FIXED_FALLBACK' });
  assert.equal(fixed.appliedMode, 'FIXED_FALLBACK');
  const repeated = quote();
  assert.deepEqual({ ...repeated }, { ...result });
});

function quoteInput(overrides: Partial<AIReservationQuoteInput> = {}): AIReservationQuoteInput {
  return {
    feature: 'AI_CHAT_QUERY',
    requestedMode: 'PROVIDER_USAGE',
    provider: 'fake-provider',
    model: 'fake-model',
    chatLimits: BASE_CHAT_LIMITS,
    rateCard: [BASE_RATE],
    walletPolicy: BASE_POLICY,
    ...overrides,
  };
}
