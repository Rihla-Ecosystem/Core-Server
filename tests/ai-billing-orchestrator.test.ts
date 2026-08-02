import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TokenReservationStatus, TokenTransactionSource } from '@prisma/client';
import type { AIProviderUsage } from '../src/types/ai.js';
import type {
  AIProviderTokenRate,
  AIUsagePricingInput,
  AIUsagePricingResult,
  AIWalletPricingPolicy,
} from '../src/types/ai-pricing.js';
import type { AIReservationQuoteInput, AIReservationQuoteResult } from '../src/types/ai-reservation-quote.js';
import type { ChatLimitsConfig } from '../src/config/chat-limits.js';
import type {
  AIBillingExecutionOutcome,
  AIBillingOrchestratorDependencies,
  AIBillingOrchestratorInput,
  AIBillingOrchestratorResult,
  AIBillingReservationMetadata,
} from '../src/types/ai-billing-orchestrator.js';
import type {
  ReleaseBusinessTokenReservationInput,
  ReleaseBusinessTokenReservationResult,
  ReserveBusinessTokensForAmountInput,
  ReserveBusinessTokensResult,
  SettleBusinessTokenReservationForAmountInput,
  SettleBusinessTokenReservationResult,
} from '../src/services/token-reservation.service.js';
import {
  AIBillingOrchestratorError,
  runAIBillingOrchestration,
} from '../src/services/ai-billing-orchestrator.service.js';
import { calculateAIReservationQuote } from '../src/utils/ai-reservation-quote.js';
import { calculateAIUsagePrice } from '../src/utils/ai-usage-pricing.js';
import { normalizeAIProviderUsage } from '../src/utils/ai-usage.js';
import { BUSINESS_TOKEN_PRICING_VERSION } from '../src/config/business-token-features.js';

interface SampleData {
  text: string;
}

const SAMPLE_DATA: SampleData = { text: 'hello' };

const BASE_USAGE: AIProviderUsage = {
  provider: 'fake-provider',
  model: 'fake-model',
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
};

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

function chatLimits(overrides: Partial<ChatLimitsConfig> = {}): ChatLimitsConfig {
  return { ...BASE_CHAT_LIMITS, ...overrides };
}

function rateCard(overrides: Partial<AIProviderTokenRate> = {}): AIProviderTokenRate[] {
  return [{ ...BASE_RATE, ...overrides }];
}

function policy(overrides: Partial<AIWalletPricingPolicy> = {}): AIWalletPricingPolicy {
  return { ...BASE_POLICY, ...overrides };
}

function defaultExecute(): Promise<AIBillingExecutionOutcome<SampleData>> {
  return Promise.resolve({ kind: 'SUCCESS', data: SAMPLE_DATA, usage: BASE_USAGE });
}

function recordExecute(
  calls: FakeCalls,
  fn: () => Promise<AIBillingExecutionOutcome<SampleData>> = defaultExecute,
): () => Promise<AIBillingExecutionOutcome<SampleData>> {
  return async () => {
    calls.order.push('execute');
    return fn();
  };
}

function buildInput(
  overrides: Partial<AIBillingOrchestratorInput<SampleData>> = {},
): AIBillingOrchestratorInput<SampleData> {
  return {
    userId: 'user-1',
    feature: 'AI_CHAT_QUERY',
    source: TokenTransactionSource.CHAT,
    idempotencyKey: 'key-1',
    requestedMode: 'PROVIDER_USAGE',
    provider: 'fake-provider',
    model: 'fake-model',
    chatLimits: chatLimits(),
    rateCard: rateCard(),
    walletPolicy: policy(),
    execute: defaultExecute,
    ...overrides,
  };
}

function expectedQuote(input: AIBillingOrchestratorInput<SampleData>): AIReservationQuoteResult {
  return calculateAIReservationQuote({
    feature: input.feature,
    requestedMode: input.requestedMode,
    provider: input.provider,
    model: input.model,
    chatLimits: input.chatLimits,
    rateCard: input.rateCard,
    walletPolicy: input.walletPolicy,
  });
}

function expectedPrice(
  input: AIBillingOrchestratorInput<SampleData>,
  usage: unknown,
): AIUsagePricingResult {
  return calculateAIUsagePrice({
    feature: input.feature,
    requestedMode: input.requestedMode,
    usage: usage as AIProviderUsage | undefined,
    rateCard: input.rateCard,
    walletPolicy: input.walletPolicy,
  });
}

function fakeReserve(input: ReserveBusinessTokensForAmountInput): ReserveBusinessTokensResult {
  return {
    reservationId: 'res-1',
    referenceId: `${input.userId}:${input.feature}:${input.idempotencyKey}`,
    walletId: 'wallet-1',
    userId: input.userId,
    feature: input.feature,
    source: input.source,
    tokens: input.tokens,
    pricingVersion: BUSINESS_TOKEN_PRICING_VERSION,
    status: TokenReservationStatus.PENDING,
    expiresAt: new Date(Date.now() + 100_000),
    metadata: input.metadata ?? null,
    availableBalance: 1_000_000 - input.tokens,
    reservedBalance: input.tokens,
    totalBalance: 1_000_000,
    idempotentReplay: false,
  };
}

function fakeSettle(
  input: SettleBusinessTokenReservationForAmountInput,
  reserved: number,
): SettleBusinessTokenReservationResult {
  return {
    reservationId: input.reservationId,
    referenceId: 'ref',
    walletId: 'wallet-1',
    userId: 'user-1',
    feature: 'AI_CHAT_QUERY',
    source: TokenTransactionSource.CHAT,
    tokens: reserved,
    actualTokens: input.actualTokens,
    releasedTokens: reserved - input.actualTokens,
    pricingVersion: BUSINESS_TOKEN_PRICING_VERSION,
    status: TokenReservationStatus.COMPLETED,
    settledAt: new Date(),
    consumeTransactionId: 'tx-1',
    idempotentReplay: false,
  };
}

function fakeRelease(
  input: ReleaseBusinessTokenReservationInput,
): ReleaseBusinessTokenReservationResult {
  return {
    reservationId: input.reservationId,
    referenceId: 'ref',
    walletId: 'wallet-1',
    userId: 'user-1',
    feature: 'AI_CHAT_QUERY',
    source: TokenTransactionSource.CHAT,
    tokens: 0,
    pricingVersion: BUSINESS_TOKEN_PRICING_VERSION,
    status: TokenReservationStatus.RELEASED,
    releasedAt: new Date(),
    releaseReason: input.reason ?? null,
    idempotentReplay: false,
  };
}

function priceResult(overrides: Partial<AIUsagePricingResult> = {}): AIUsagePricingResult {
  return {
    feature: 'AI_CHAT_QUERY',
    requestedMode: 'PROVIDER_USAGE',
    appliedMode: 'PROVIDER_USAGE',
    walletTokens: 30,
    fixedFallbackTokens: 2,
    provider: 'fake-provider',
    model: 'fake-model',
    billingCurrency: 'USD',
    rateCardVersion: 'rate-v1',
    walletPolicyVersion: 'policy-v1',
    ...overrides,
  };
}

interface FakeCalls {
  order: string[];
  normalizeCalls: number;
  quoteInputs: AIReservationQuoteInput[];
  reserveInputs: ReserveBusinessTokensForAmountInput[];
  priceInputs: AIUsagePricingInput[];
  settleInputs: SettleBusinessTokenReservationForAmountInput[];
  releaseInputs: ReleaseBusinessTokenReservationInput[];
}

function makeDeps(overrides: Partial<AIBillingOrchestratorDependencies> = {}): {
  deps: AIBillingOrchestratorDependencies;
  calls: FakeCalls;
} {
  const calls: FakeCalls = {
    order: [],
    normalizeCalls: 0,
    quoteInputs: [],
    reserveInputs: [],
    priceInputs: [],
    settleInputs: [],
    releaseInputs: [],
  };

  const reservedByReservation = new Map<string, number>();

  const deps: AIBillingOrchestratorDependencies = {
    calculateQuote: (input) => {
      calls.order.push('quote');
      calls.quoteInputs.push(input);
      if (overrides.calculateQuote) return overrides.calculateQuote(input);
      return calculateAIReservationQuote(input);
    },
    reserveForAmount: async (input) => {
      calls.order.push('reserve');
      calls.reserveInputs.push(input);
      if (overrides.reserveForAmount) return overrides.reserveForAmount(input);
      reservedByReservation.set('res-1', input.tokens);
      return fakeReserve(input);
    },
    normalizeUsage: (raw) => {
      calls.normalizeCalls += 1;
      if (overrides.normalizeUsage) return overrides.normalizeUsage(raw);
      return normalizeAIProviderUsage(raw);
    },
    calculateActualPrice: (input) => {
      calls.order.push('price');
      calls.priceInputs.push(input);
      if (overrides.calculateActualPrice) return overrides.calculateActualPrice(input);
      return calculateAIUsagePrice(input);
    },
    settleForAmount: async (input) => {
      calls.order.push('settle');
      calls.settleInputs.push(input);
      if (overrides.settleForAmount) return overrides.settleForAmount(input);
      const reserved = reservedByReservation.get(input.reservationId) ?? 0;
      return fakeSettle(input, reserved);
    },
    releaseReservation: async (input) => {
      calls.order.push('release');
      calls.releaseInputs.push(input);
      if (overrides.releaseReservation) return overrides.releaseReservation(input);
      return fakeRelease(input);
    },
  };

  return { deps, calls };
}

async function expectOrchestratorError(
  promise: Promise<unknown>,
  stage: string,
): Promise<AIBillingOrchestratorError> {
  let caught: AIBillingOrchestratorError | undefined;
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AIBillingOrchestratorError);
    caught = err;
  }
  assert.ok(caught, 'expected AIBillingOrchestratorError to be thrown');
  assert.equal(caught.stage, stage);
  return caught;
}

// --- Success and ordering ---------------------------------------------------

test('1. Quote is calculated before reservation', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.equal(calls.order[0], 'quote');
  assert.ok(calls.order.indexOf('quote') < calls.order.indexOf('reserve'));
});

test('2. Reservation is created before execute', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('reserve') < calls.order.indexOf('execute'));
});

test('3. Execute completes before actual pricing', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('execute') < calls.order.indexOf('price'));
});

test('4. Actual pricing completes before settlement', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.ok(calls.order.indexOf('price') < calls.order.indexOf('settle'));
});

test('5. Successful call order is exactly quote -> reserve -> execute -> price -> settle', async () => {
  const { deps, calls } = makeDeps();
  const input = buildInput({ execute: recordExecute(calls) });
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(calls.order, ['quote', 'reserve', 'execute', 'price', 'settle']);
  assert.ok(calls.normalizeCalls >= 1);
});

test('6. Successful result preserves generic AI data', async () => {
  const input = buildInput();
  const { deps } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.deepEqual(result.data, SAMPLE_DATA);
});

test('7. Reserved amount equals quote.reservationTokens', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  const quote = expectedQuote(input);
  assert.equal(calls.reserveInputs[0].tokens, quote.reservationTokens);
  assert.equal(result.billing.reservedTokens, quote.reservationTokens);
});

test('8. Settlement amount equals the pricing engine Wallet-token result', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  const price = expectedPrice(input, BASE_USAGE);
  assert.equal(calls.settleInputs[0].actualTokens, price.walletTokens);
  assert.equal(result.billing.actualTokens, price.walletTokens);
});

test('9. Released amount comes from the settlement result', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  const quote = expectedQuote(input);
  const price = expectedPrice(input, BASE_USAGE);
  assert.equal(result.billing.releasedTokens, quote.reservationTokens - price.walletTokens);
  assert.equal(result.billing.releasedTokens, quote.reservationTokens - calls.settleInputs[0].actualTokens);
});

// --- Quote and reservation failure ------------------------------------------

test('10. Quote failure performs no reservation or execution', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    calculateQuote: () => {
      throw new Error('quote boom');
    },
  });
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'QUOTE');
  assert.equal(err.recoveryRequired, false);
  assert.equal(err.reservationReleased, false);
  assert.deepEqual(calls.order, ['quote']);
});

test('11. Reservation failure performs no execution', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    reserveForAmount: async () => {
      throw new Error('reserve boom');
    },
  });
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'RESERVATION');
  assert.equal(err.recoveryRequired, false);
  assert.equal(err.reservationReleased, false);
  assert.deepEqual(calls.order, ['quote', 'reserve']);
});

test('12. Reservation failure performs no settlement or release', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    reserveForAmount: async () => {
      throw new Error('reserve boom');
    },
  });
  await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'RESERVATION');
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

// --- Replay ---------------------------------------------------------------

test('13. idempotentReplay = true prevents execute', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    reserveForAmount: async (reserveInput) => ({
      ...fakeReserve(reserveInput),
      idempotentReplay: true,
    }),
  });
  await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'RESERVATION_REPLAY');
  assert.deepEqual(calls.order, ['quote', 'reserve']);
});

test('14. Replay performs no pricing', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    reserveForAmount: async (reserveInput) => ({
      ...fakeReserve(reserveInput),
      idempotentReplay: true,
    }),
  });
  await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'RESERVATION_REPLAY');
  assert.ok(!calls.order.includes('price'));
});

test('15. Replay performs no settlement', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    reserveForAmount: async (reserveInput) => ({
      ...fakeReserve(reserveInput),
      idempotentReplay: true,
    }),
  });
  await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'RESERVATION_REPLAY');
  assert.ok(!calls.order.includes('settle'));
});

test('16. Replay performs no release', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    reserveForAmount: async (reserveInput) => ({
      ...fakeReserve(reserveInput),
      idempotentReplay: true,
    }),
  });
  await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'RESERVATION_REPLAY');
  assert.ok(!calls.order.includes('release'));
});

test('17. Replay returns recovery-required state with reservationId', async () => {
  const input = buildInput();
  const { deps } = makeDeps({
    reserveForAmount: async (reserveInput) => ({
      ...fakeReserve(reserveInput),
      idempotentReplay: true,
    }),
  });
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'RESERVATION_REPLAY');
  assert.equal(err.reservationId, 'res-1');
  assert.equal(err.recoveryRequired, true);
  assert.equal(err.reservationReleased, false);
});

// --- Non-billable failure ---------------------------------------------------

test('18. NON_BILLABLE failure releases the full reservation', async () => {
  const input = buildInput({
    execute: async () => ({ kind: 'FAILURE', disposition: 'NON_BILLABLE' }),
  });
  const { deps, calls } = makeDeps();
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'EXECUTION');
  assert.ok(calls.order.includes('release'));
  assert.equal(calls.releaseInputs[0].reservationId, 'res-1');
  assert.equal(err.reservationReleased, true);
  assert.equal(err.recoveryRequired, false);
});

test('19. NON_BILLABLE failure does not price or settle', async () => {
  const input = buildInput({
    execute: async () => ({ kind: 'FAILURE', disposition: 'NON_BILLABLE' }),
  });
  const { deps, calls } = makeDeps();
  await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'EXECUTION');
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
});

test('20. Successful release reports reservationReleased = true', async () => {
  const input = buildInput({
    execute: async () => ({ kind: 'FAILURE', disposition: 'NON_BILLABLE' }),
  });
  const { deps } = makeDeps();
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'EXECUTION');
  assert.equal(err.reservationReleased, true);
  assert.equal(err.reservationId, 'res-1');
});

test('21. Release failure reports stage RELEASE and recoveryRequired = true', async () => {
  const input = buildInput({
    execute: async () => ({ kind: 'FAILURE', disposition: 'NON_BILLABLE' }),
  });
  const { deps, calls } = makeDeps({
    releaseReservation: async () => {
      throw new Error('release boom');
    },
  });
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'RELEASE');
  assert.equal(err.reservationId, 'res-1');
  assert.equal(err.recoveryRequired, true);
  assert.equal(err.reservationReleased, false);
  assert.ok(calls.order.includes('release'));
});

// --- Indeterminate failure --------------------------------------------------

test('22. INDETERMINATE failure does not release', async () => {
  const input = buildInput({
    execute: async () => ({ kind: 'FAILURE', disposition: 'INDETERMINATE' }),
  });
  const { deps, calls } = makeDeps();
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'EXECUTION');
  assert.ok(!calls.order.includes('release'));
  assert.equal(err.reservationReleased, false);
  assert.equal(err.recoveryRequired, true);
});

test('23. INDETERMINATE failure does not price or settle', async () => {
  const input = buildInput({
    execute: async () => ({ kind: 'FAILURE', disposition: 'INDETERMINATE' }),
  });
  const { deps, calls } = makeDeps();
  await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'EXECUTION');
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
});

test('24. Unexpected thrown execution error is treated as indeterminate', async () => {
  const input = buildInput({
    execute: async () => {
      throw new Error('ai crash');
    },
  });
  const { deps, calls } = makeDeps();
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'EXECUTION');
  assert.equal(err.recoveryRequired, true);
  assert.equal(err.reservationReleased, false);
  assert.ok(!calls.order.includes('release'));
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
});

test('25. Indeterminate failure identifies the reservation for recovery', async () => {
  const input = buildInput({
    execute: async () => ({ kind: 'FAILURE', disposition: 'INDETERMINATE' }),
  });
  const { deps } = makeDeps();
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'EXECUTION');
  assert.equal(err.reservationId, 'res-1');
});

// --- Usage ---------------------------------------------------------------

test('26. Valid normalized provider/model matching the quote is accepted', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.actualTokens, 30);
  assert.equal(calls.normalizeCalls, 1);
});

test('27. Provider mismatch is rejected before pricing', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { ...BASE_USAGE, provider: 'other-provider' },
    }),
  });
  const { deps, calls } = makeDeps();
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'USAGE_VALIDATION');
  assert.equal(err.recoveryRequired, true);
  assert.ok(!calls.order.includes('price'));
});

test('28. Model mismatch is rejected before pricing', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { ...BASE_USAGE, model: 'other-model' },
    }),
  });
  const { deps, calls } = makeDeps();
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'USAGE_VALIDATION');
  assert.equal(err.recoveryRequired, true);
  assert.ok(!calls.order.includes('price'));
});

test('29. Input usage above maxInputTokens is rejected', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { ...BASE_USAGE, inputTokens: 13000 },
    }),
  });
  const { deps, calls } = makeDeps();
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'USAGE_VALIDATION');
  assert.equal(err.recoveryRequired, true);
  assert.ok(!calls.order.includes('price'));
});

test('30. Output usage above maxOutputTokens is rejected', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { ...BASE_USAGE, outputTokens: 1300 },
    }),
  });
  const { deps, calls } = makeDeps();
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'USAGE_VALIDATION');
  assert.equal(err.recoveryRequired, true);
  assert.ok(!calls.order.includes('price'));
});

test('31. Usage validation failure does not settle', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { ...BASE_USAGE, provider: 'other-provider' },
    }),
  });
  const { deps, calls } = makeDeps();
  await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'USAGE_VALIDATION');
  assert.ok(!calls.order.includes('settle'));
});

test('32. Usage validation failure does not release', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { ...BASE_USAGE, model: 'other-model' },
    }),
  });
  const { deps, calls } = makeDeps();
  await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'USAGE_VALIDATION');
  assert.ok(!calls.order.includes('release'));
});

test('33. Missing usage follows the existing fixed fallback', async () => {
  const input = buildInput({
    execute: async () => ({ kind: 'SUCCESS', data: SAMPLE_DATA }),
  });
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  const price = expectedPrice(input, undefined);
  assert.equal(price.appliedMode, 'FIXED_FALLBACK');
  assert.equal(price.fallbackReason, 'USAGE_MISSING');
  assert.equal(result.billing.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.billing.fallbackReason, 'USAGE_MISSING');
  assert.equal(result.billing.actualTokens, 2);
  assert.equal(calls.settleInputs[0].actualTokens, 2);
});

test('34. Invalid runtime usage follows the existing pricing-engine fallback', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { provider: 'fake-provider', model: 'fake-model', inputTokens: -5, outputTokens: 10, totalTokens: 5 },
    }),
  });
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  const price = expectedPrice(input, { provider: 'fake-provider', model: 'fake-model', inputTokens: -5, outputTokens: 10, totalTokens: 5 });
  assert.equal(price.appliedMode, 'FIXED_FALLBACK');
  assert.equal(price.fallbackReason, 'USAGE_INVALID');
  assert.equal(result.billing.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.billing.fallbackReason, 'USAGE_INVALID');
  assert.equal(result.billing.actualTokens, 2);
  assert.equal(calls.settleInputs[0].actualTokens, 2);
});

test('35. totalTokens is not independently billed by the orchestrator', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { ...BASE_USAGE, totalTokens: 999_999 },
    }),
  });
  const { deps, calls } = makeDeps({
    calculateActualPrice: () => priceResult({ walletTokens: 7 }),
  });
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(calls.settleInputs[0].actualTokens, 7);
  assert.equal(result.billing.actualTokens, 7);
});

// --- Pricing and settlement -------------------------------------------------

test('36. Provider usage pricing settles the actual amount', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  const price = expectedPrice(input, BASE_USAGE);
  assert.equal(result.billing.actualTokens, price.walletTokens);
  assert.equal(calls.settleInputs[0].actualTokens, price.walletTokens);
});

test('37. Fixed fallback pricing settles the fixed amount', async () => {
  const input = buildInput({ requestedMode: 'FIXED_FALLBACK', provider: undefined, model: undefined });
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  const quote = expectedQuote(input);
  assert.equal(quote.reservationTokens, 2);
  assert.equal(result.billing.actualTokens, 2);
  assert.equal(calls.settleInputs[0].actualTokens, 2);
});

test('38. Partial settlement returns unused reservation', async () => {
  const input = buildInput();
  const { deps } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  const quote = expectedQuote(input);
  const price = expectedPrice(input, BASE_USAGE);
  assert.equal(result.billing.reservedTokens, quote.reservationTokens);
  assert.ok(result.billing.releasedTokens > 0);
  assert.equal(result.billing.releasedTokens, quote.reservationTokens - price.walletTokens);
});

test('39. Full settlement returns zero unused tokens', async () => {
  const input = buildInput({ requestedMode: 'FIXED_FALLBACK', provider: undefined, model: undefined });
  const { deps } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.actualTokens, 2);
  assert.equal(result.billing.releasedTokens, 0);
});

test('40. Zero actual price is passed unchanged to settlement', async () => {
  const zeroRate = rateCard({
    inputMicrosPerMillionTokens: 0,
    outputMicrosPerMillionTokens: 0,
  });
  const zeroPolicy = policy({ minimumWalletTokens: 0 });
  const input = buildInput({ rateCard: zeroRate, walletPolicy: zeroPolicy });
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.actualTokens, 0);
  assert.equal(calls.settleInputs[0].actualTokens, 0);
  assert.equal(result.billing.releasedTokens, 2);
});

test('41. Actual price above reservation is rejected before settlement', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    calculateActualPrice: () => priceResult({ walletTokens: 999_999 }),
  });
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'PRICING');
  assert.equal(err.recoveryRequired, true);
  assert.equal(err.reservationReleased, false);
  assert.ok(!calls.order.includes('settle'));
});

test('42. Actual price above reservation does not release automatically', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    calculateActualPrice: () => priceResult({ walletTokens: 999_999 }),
  });
  await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'PRICING');
  assert.ok(!calls.order.includes('release'));
});

test('43. Pricing failure after successful execution does not release', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    calculateActualPrice: () => {
      throw new Error('price boom');
    },
  });
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'PRICING');
  assert.equal(err.recoveryRequired, true);
  assert.ok(!calls.order.includes('release'));
  assert.ok(!calls.order.includes('settle'));
});

test('44. Settlement failure after successful execution does not release', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    settleForAmount: async () => {
      throw new Error('settle boom');
    },
  });
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'SETTLEMENT');
  assert.equal(err.recoveryRequired, true);
  assert.equal(err.reservationReleased, false);
  assert.ok(!calls.order.includes('release'));
});

test('45. Settlement result is the source of actual/released values', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  const quote = expectedQuote(input);
  assert.equal(result.billing.actualTokens, calls.settleInputs[0].actualTokens);
  assert.equal(result.billing.releasedTokens, quote.reservationTokens - calls.settleInputs[0].actualTokens);
  assert.equal(result.billing.reservedTokens, quote.reservationTokens);
  assert.equal(result.billing.consumeTransactionId, 'tx-1');
});

// --- Snapshot consistency ---------------------------------------------------

test('46. Quote and actual pricing receive the same rate-card snapshot', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.strictEqual(calls.quoteInputs[0].rateCard, calls.priceInputs[0].rateCard);
});

test('47. Quote and actual pricing receive the same Wallet-policy snapshot', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.strictEqual(calls.quoteInputs[0].walletPolicy, calls.priceInputs[0].walletPolicy);
});

test('48. Quote receives a frozen independent Chat limits snapshot', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.notStrictEqual(calls.quoteInputs[0].chatLimits, input.chatLimits);
  assert.ok(Object.isFrozen(calls.quoteInputs[0].chatLimits));
  assert.deepEqual(calls.quoteInputs[0].chatLimits, input.chatLimits);
});

test('49. Mutating the original rateCard during execute does not affect pricing', async () => {
  const myRate = rateCard();
  const input = buildInput({
    rateCard: myRate,
    execute: async () => {
      myRate[0].inputMicrosPerMillionTokens = 999_999_999;
      return { kind: 'SUCCESS', data: SAMPLE_DATA, usage: BASE_USAGE };
    },
  });
  const { deps } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.actualTokens, 30);
});

test('50. Mutating the original Wallet policy during execute does not affect pricing', async () => {
  const myPolicy = policy();
  const input = buildInput({
    walletPolicy: myPolicy,
    execute: async () => {
      myPolicy.minimumWalletTokens = 999_999;
      return { kind: 'SUCCESS', data: SAMPLE_DATA, usage: BASE_USAGE };
    },
  });
  const { deps } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.actualTokens, 30);
});

test('51. Mutating the original Chat limits during execute does not affect quote validation', async () => {
  const myLimits = chatLimits();
  const input = buildInput({
    chatLimits: myLimits,
    execute: async () => {
      myLimits.maxInputTokens = 1;
      return { kind: 'SUCCESS', data: SAMPLE_DATA, usage: BASE_USAGE };
    },
  });
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(calls.quoteInputs[0].chatLimits.maxInputTokens, 12000);
  assert.equal(result.billing.actualTokens, 30);
});

test('52. Caller input is not mutated', async () => {
  const myRate = rateCard();
  const myPolicy = policy();
  const myLimits = chatLimits();
  const originalRate = myRate.map((r) => ({ ...r }));
  const originalPolicy = { ...myPolicy };
  const originalLimits = { ...myLimits };
  const input = buildInput({ rateCard: myRate, walletPolicy: myPolicy, chatLimits: myLimits });
  const { deps } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(input.rateCard, originalRate);
  assert.deepEqual(input.walletPolicy, originalPolicy);
  assert.deepEqual(input.chatLimits, originalLimits);
});

test('53. Rate-card entries are not mutated', async () => {
  const input = buildInput();
  const originalRate = input.rateCard.map((r) => ({ ...r }));
  const { deps } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(input.rateCard, originalRate);
});

test('54. Wallet policy is not mutated', async () => {
  const input = buildInput();
  const originalPolicy = { ...input.walletPolicy };
  const { deps } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.deepEqual(input.walletPolicy, originalPolicy);
});

test('55. Repeated orchestrations use independent snapshot objects', async () => {
  const firstInput = buildInput();
  const { deps: deps1, calls: calls1 } = makeDeps();
  await runAIBillingOrchestration(firstInput, deps1);

  const secondInput = buildInput();
  const { deps: deps2, calls: calls2 } = makeDeps();
  await runAIBillingOrchestration(secondInput, deps2);

  assert.notStrictEqual(calls1.quoteInputs[0].rateCard, calls2.quoteInputs[0].rateCard);
  assert.notStrictEqual(calls1.quoteInputs[0].rateCard[0], calls2.quoteInputs[0].rateCard[0]);
  assert.notStrictEqual(calls1.quoteInputs[0].walletPolicy, calls2.quoteInputs[0].walletPolicy);
  assert.notStrictEqual(calls1.quoteInputs[0].chatLimits, calls2.quoteInputs[0].chatLimits);
});

// --- Metadata -------------------------------------------------------------

function metadataOf(inputs: ReserveBusinessTokensForAmountInput[]): AIBillingReservationMetadata {
  const meta = inputs[0].metadata as AIBillingReservationMetadata;
  assert.ok(meta && typeof meta === 'object');
  return meta;
}

test('56. Reservation metadata contains sanitized aiBilling snapshot', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  const meta = metadataOf(calls.reserveInputs);
  assert.equal(meta.aiBilling.schemaVersion, 1);
  assert.equal(meta.aiBilling.requestedMode, 'PROVIDER_USAGE');
  assert.equal(meta.aiBilling.quoteAppliedMode, 'PROVIDER_USAGE');
  assert.equal(meta.aiBilling.maxInputTokens, 12000);
  assert.equal(meta.aiBilling.maxOutputTokens, 1200);
  assert.equal(meta.aiBilling.provider, 'fake-provider');
  assert.equal(meta.aiBilling.model, 'fake-model');
});

test('57. Metadata contains quotedTokens and versions', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  const meta = metadataOf(calls.reserveInputs);
  assert.equal(meta.aiBilling.quotedTokens, result.billing.reservedTokens);
  assert.equal(meta.aiBilling.rateCardVersion, 'rate-v1');
  assert.equal(meta.aiBilling.walletPolicyVersion, 'policy-v1');
  assert.equal(meta.aiBilling.maximumUsageWalletTokens, 13200);
});

test('58. Metadata omits full rate card and Wallet policy', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  const serialized = JSON.stringify(calls.reserveInputs[0].metadata);
  assert.ok(!serialized.includes('inputMicrosPerMillionTokens'));
  assert.ok(!serialized.includes('outputMicrosPerMillionTokens'));
  assert.ok(!serialized.includes('walletTokenValueMicros'));
  assert.ok(!serialized.includes('markupBasisPoints'));
  assert.ok(!serialized.includes('"rateCard"'));
  assert.ok(!serialized.includes('"walletPolicy"'));
});

test('59. Metadata omits prompts, AI response, and raw usage', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  const serialized = JSON.stringify(calls.reserveInputs[0].metadata);
  assert.ok(!serialized.includes('prompt'));
  assert.ok(!serialized.includes('message'));
  assert.ok(!serialized.includes('"data"'));
  assert.ok(!serialized.includes('"usage"'));
});

test('60. reservation.pricingVersion is not replaced by a rate-card version', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  await runAIBillingOrchestration(input, deps);
  assert.ok(!('pricingVersion' in calls.reserveInputs[0]));
  assert.equal(calls.reserveInputs[0].tokens, 13200);
  const meta = metadataOf(calls.reserveInputs);
  assert.equal(meta.aiBilling.rateCardVersion, 'rate-v1');
});

// --- Fixed mode -------------------------------------------------------------

test('61. Fixed mode does not require provider/model', async () => {
  const input = buildInput({ requestedMode: 'FIXED_FALLBACK', provider: undefined, model: undefined });
  const { deps } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.appliedMode, 'FIXED_FALLBACK');
});

test('62. Fixed mode reserves and settles the fixed feature amount', async () => {
  const input = buildInput({ requestedMode: 'FIXED_FALLBACK', provider: undefined, model: undefined });
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.reservedTokens, 2);
  assert.equal(result.billing.actualTokens, 2);
  assert.equal(result.billing.releasedTokens, 0);
  assert.equal(calls.settleInputs[0].actualTokens, 2);
});

test('63. Fixed mode does not switch to provider pricing because usage exists', async () => {
  const input = buildInput({
    requestedMode: 'FIXED_FALLBACK',
    provider: undefined,
    model: undefined,
    execute: async () => ({ kind: 'SUCCESS', data: SAMPLE_DATA, usage: BASE_USAGE }),
  });
  const { deps } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.billing.actualTokens, 2);
});

// --- Separation -------------------------------------------------------------

const serviceSource = readFileSync(
  new URL('../src/services/ai-billing-orchestrator.service.ts', import.meta.url),
  'utf8',
);

test('64. Orchestrator performs no direct Prisma call', () => {
  assert.ok(!serviceSource.includes('@prisma/client'));
  assert.ok(!/prisma\./.test(serviceSource));
});

test('65. Orchestrator performs no direct HTTP call', () => {
  assert.ok(!serviceSource.includes('node:http'));
  assert.ok(!serviceSource.includes('node:https'));
  assert.ok(!serviceSource.includes('fetch('));
});

test('66. Orchestrator performs no direct AI call except the supplied callback', () => {
  assert.ok(!serviceSource.includes('@google/generative-ai'));
  assert.ok(!serviceSource.includes('gemini'));
});

test('67. Orchestrator contains no Wallet arithmetic', () => {
  assert.ok(!serviceSource.includes('tokenBalance'));
  assert.ok(!serviceSource.includes('reservedBalance'));
  assert.ok(!serviceSource.includes('availableBalance'));
});

test('68. Orchestrator contains no duplicated provider pricing formula', () => {
  assert.ok(!serviceSource.includes('inputMicrosPerMillionTokens'));
  assert.ok(!serviceSource.includes('outputMicrosPerMillionTokens'));
  assert.ok(!serviceSource.includes('providerCostMicros'));
  assert.ok(!serviceSource.includes('microsPerMillion'));
});

test('69. No hardcoded reservation ceiling exists', () => {
  assert.ok(!/ceiling/i.test(serviceSource));
  assert.ok(!serviceSource.includes('MAX_RESERVATION'));
  assert.ok(!serviceSource.includes('> 8'));
});

test('70. A quote above 8 is passed unchanged to variable reservation', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  const quote = expectedQuote(input);
  assert.ok(quote.reservationTokens > 8);
  assert.equal(calls.reserveInputs[0].tokens, quote.reservationTokens);
  assert.equal(result.billing.reservedTokens, quote.reservationTokens);
});

// --- Additional implementation-based tests -----------------------------------

test('71. Result exposes no wallet balance or secret fields', async () => {
  const input = buildInput();
  const { deps } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('availableBalance'));
  assert.ok(!serialized.includes('reservedBalance'));
  assert.ok(!serialized.includes('apiKey'));
  assert.ok(!serialized.includes('secret'));
  assert.ok(!('walletId' in result.billing));
});

test('72. Error messages do not expose pricing input or AI content', async () => {
  const input = buildInput();
  const { deps } = makeDeps({
    calculateQuote: () => {
      throw new Error('quote boom');
    },
  });
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'QUOTE');
  assert.ok(!err.message.includes('rateCard'));
  assert.ok(!err.message.includes('walletPolicy'));
  assert.ok(!err.message.includes('prompt'));
});

test('73. Successful result returns a fresh quote object', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.notStrictEqual(result.quote, calls.quoteInputs[0]);
  assert.deepEqual(result.quote, expectedQuote(input));
});

test('74. normalizeUsage receives the raw execution usage', async () => {
  const input = buildInput();
  const rawUsage = { provider: 'fake-provider', model: 'fake-model', inputTokens: 5, outputTokens: 6, totalTokens: 11 };
  const inputWithExecute = buildInput({
    execute: async () => ({ kind: 'SUCCESS', data: SAMPLE_DATA, usage: rawUsage }),
  });
  let received: unknown;
  const { deps } = makeDeps({
    normalizeUsage: (raw) => {
      received = raw;
      return normalizeAIProviderUsage(raw);
    },
  });
  const result = await runAIBillingOrchestration(inputWithExecute, deps);
  assert.strictEqual(received, rawUsage);
  assert.equal(result.billing.actualTokens, 11);
});

test('75. Zero actual price result reports released tokens equal to the reservation', async () => {
  const zeroRate = rateCard({ inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 });
  const zeroPolicy = policy({ minimumWalletTokens: 0 });
  const input = buildInput({ rateCard: zeroRate, walletPolicy: zeroPolicy });
  const { deps, calls } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.actualTokens, 0);
  assert.equal(result.billing.releasedTokens, 2);
  assert.equal(calls.settleInputs[0].actualTokens, 0);
});

// --- Usage validation on fallback quotes and normalization --------------------

test('76. RATE_CARD_NOT_FOUND quote followed by usage from another priced model is rejected before pricing', async () => {
  const input = buildInput({
    rateCard: [{ ...BASE_RATE, model: 'other-model', version: 'rate-other' }],
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { provider: 'fake-provider', model: 'other-model', inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    }),
  });
  const quote = expectedQuote(input);
  assert.equal(quote.appliedMode, 'FIXED_FALLBACK');
  assert.equal(quote.fallbackReason, 'RATE_CARD_NOT_FOUND');
  const { deps, calls } = makeDeps();
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'USAGE_VALIDATION');
  assert.equal(err.reservationId, 'res-1');
  assert.equal(err.recoveryRequired, true);
  assert.equal(err.reservationReleased, false);
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('77. RATE_CARD_NOT_FOUND quote followed by usage from another provider is rejected before pricing', async () => {
  const input = buildInput({
    rateCard: [{ ...BASE_RATE, provider: 'other-provider', version: 'rate-other' }],
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { provider: 'other-provider', model: 'fake-model', inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    }),
  });
  const quote = expectedQuote(input);
  assert.equal(quote.appliedMode, 'FIXED_FALLBACK');
  assert.equal(quote.fallbackReason, 'RATE_CARD_NOT_FOUND');
  const { deps, calls } = makeDeps();
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'USAGE_VALIDATION');
  assert.equal(err.reservationId, 'res-1');
  assert.equal(err.recoveryRequired, true);
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('78. RATE_CARD_NOT_FOUND quote still enforces maxInputTokens', async () => {
  const input = buildInput({
    rateCard: [{ ...BASE_RATE, model: 'other-model', version: 'rate-other' }],
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { provider: 'fake-provider', model: 'fake-model', inputTokens: 13000, outputTokens: 20, totalTokens: 13020 },
    }),
  });
  const quote = expectedQuote(input);
  assert.equal(quote.appliedMode, 'FIXED_FALLBACK');
  assert.equal(quote.fallbackReason, 'RATE_CARD_NOT_FOUND');
  const { deps, calls } = makeDeps();
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'USAGE_VALIDATION');
  assert.equal(err.recoveryRequired, true);
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('79. RATE_CARD_NOT_FOUND quote still enforces maxOutputTokens', async () => {
  const input = buildInput({
    rateCard: [{ ...BASE_RATE, model: 'other-model', version: 'rate-other' }],
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { provider: 'fake-provider', model: 'fake-model', inputTokens: 10, outputTokens: 1300, totalTokens: 1310 },
    }),
  });
  const quote = expectedQuote(input);
  assert.equal(quote.appliedMode, 'FIXED_FALLBACK');
  assert.equal(quote.fallbackReason, 'RATE_CARD_NOT_FOUND');
  const { deps, calls } = makeDeps();
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'USAGE_VALIDATION');
  assert.equal(err.recoveryRequired, true);
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});

test('80. Valid snake_case usage is normalized and provider-priced, not treated as USAGE_INVALID', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { provider: 'fake-provider', model: 'fake-model', input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    }),
  });
  const { deps } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.appliedMode, 'PROVIDER_USAGE');
  assert.equal(result.billing.fallbackReason, undefined);
  assert.equal(result.billing.actualTokens, 30);
});

test('81. Valid mixed-case usage is normalized and provider-priced', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { provider: 'fake-provider', model: 'fake-model', inputTokens: 10, output_tokens: 20, totalTokens: 30 },
    }),
  });
  const { deps } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.appliedMode, 'PROVIDER_USAGE');
  assert.equal(result.billing.fallbackReason, undefined);
  assert.equal(result.billing.actualTokens, 30);
});

test('82. CamelCase usage behavior remains unchanged', async () => {
  const input = buildInput();
  const { deps } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.appliedMode, 'PROVIDER_USAGE');
  assert.equal(result.billing.fallbackReason, undefined);
  assert.equal(result.billing.actualTokens, 30);
});

test('83. Missing usage still produces USAGE_MISSING fallback', async () => {
  const input = buildInput({
    execute: async () => ({ kind: 'SUCCESS', data: SAMPLE_DATA }),
  });
  const { deps } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.fallbackReason, 'USAGE_MISSING');
  assert.equal(result.billing.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.billing.actualTokens, 2);
});

test('84. Invalid present usage still produces USAGE_INVALID fallback', async () => {
  const input = buildInput({
    execute: async () => ({
      kind: 'SUCCESS',
      data: SAMPLE_DATA,
      usage: { provider: 'fake-provider', model: 'fake-model', inputTokens: -5, outputTokens: 10, totalTokens: 5 },
    }),
  });
  const { deps } = makeDeps();
  const result = await runAIBillingOrchestration(input, deps);
  assert.equal(result.billing.fallbackReason, 'USAGE_INVALID');
  assert.equal(result.billing.appliedMode, 'FIXED_FALLBACK');
  assert.equal(result.billing.actualTokens, 2);
});

test('85. normalizeUsage throwing produces stage USAGE_VALIDATION and performs no price, settlement, or release', async () => {
  const input = buildInput();
  const { deps, calls } = makeDeps({
    normalizeUsage: () => {
      throw new Error('normalize boom');
    },
  });
  const err = await expectOrchestratorError(runAIBillingOrchestration(input, deps), 'USAGE_VALIDATION');
  assert.equal(err.reservationId, 'res-1');
  assert.equal(err.recoveryRequired, true);
  assert.equal(err.reservationReleased, false);
  assert.ok(!calls.order.includes('price'));
  assert.ok(!calls.order.includes('settle'));
  assert.ok(!calls.order.includes('release'));
});
