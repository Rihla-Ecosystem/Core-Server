import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAIExecutionBudget } from '../src/config/ai-execution-budget.js';
import { GEMINI_TEXT_RUNTIME_MODELS, GEMINI_TTS_RUNTIME_MODEL } from '../src/config/ai-runtime-routing.js';
import { calculateDynamicAIReservationQuote } from '../src/utils/dynamic-ai-reservation-quote.js';
import { deriveAffordableAIExecutionBudget } from '../src/utils/affordable-ai-execution-budget.js';
import type { ProviderRateCard, RateCardEntry } from '../src/types/provider-pricing.js';
import type { WalletPolicyConfig } from '../src/config/wallet-policy.js';

const walletPolicy: WalletPolicyConfig = {
  signupTokenGrant: 400, walletTokenValueNanoUsd: 100_000, markupBasisPoints: 10_000,
  minimumWalletTokens: 1, maxReservationTokensByFeature: { AI_CHAT_QUERY: 10_000, AI_IMAGE_ANALYSIS: 10_000, REAL_TIME_TRANSLATION: 10_000, AI_TRIP_ITINERARY: 10_000 }, version: 'test',
};
const entry = (model: string): RateCardEntry => ({ provider: 'google', model, status: 'STABLE', tier: 'standard', billingUnit: 'TOKEN', tokenRates: { inputMicrosPerMillion: 10_000_000, outputMicrosPerMillion: 10_000_000 }, effectiveFrom: '2026-01-01', inactive: false });
const card: ProviderRateCard = {
  schemaVersion: 1, currency: 'USD', storageUnit: 'MICROS', engineUnit: 'NANO_USD', version: 'db-test', source: 'database', generatedAt: '2026-08-12T00:00:00Z', provenance: 'RESEARCH_SNAPSHOT',
  entries: [...GEMINI_TEXT_RUNTIME_MODELS.map(entry), entry(GEMINI_TTS_RUNTIME_MODEL)],
};
const quote = (budget = getAIExecutionBudget('AI_CHAT_QUERY')) => calculateDynamicAIReservationQuote({ feature: 'AI_CHAT_QUERY', executionBudget: budget, estimatedInputTokens: 100, rateCard: card, walletPolicy });
const chatEstimate = (budget = getAIExecutionBudget('AI_CHAT_QUERY')) =>
  (budget.maxHistoryTokens ?? 0) + 2_000;
const historyQuote = (budget = getAIExecutionBudget('AI_CHAT_QUERY')) => calculateDynamicAIReservationQuote({
  feature: 'AI_CHAT_QUERY', executionBudget: budget,
  estimatedInputTokens: chatEstimate(budget), rateCard: card, walletPolicy,
});
const historyInput = (availableBalance: number, budget = getAIExecutionBudget('AI_CHAT_QUERY')) => ({
  feature: 'AI_CHAT_QUERY' as const, budget, estimatedInputTokens: chatEstimate(budget),
  optionalHistoryInputTokens: budget.maxHistoryTokens, availableBalance, rateCard: card, walletPolicy,
});

test('keeps the normal execution budget when its exact quote fits', () => {
  const budget = getAIExecutionBudget('AI_CHAT_QUERY');
  const normal = quote(budget);
  const result = deriveAffordableAIExecutionBudget({ feature: 'AI_CHAT_QUERY', budget, estimatedInputTokens: 100, availableBalance: normal, rateCard: card, walletPolicy });
  assert.deepEqual(result, { budget, reservationTokens: normal, reduced: false });
});

test('reduces only provider output and re-quotes the reduced envelope', () => {
  const budget = getAIExecutionBudget('AI_CHAT_QUERY');
  const normal = quote(budget);
  const floor = { ...budget, maxOutputTokens: 64 };
  const floorQuote = quote(floor);
  assert.ok(floorQuote < normal);
  const result = deriveAffordableAIExecutionBudget({ feature: 'AI_CHAT_QUERY', budget, estimatedInputTokens: 100, availableBalance: floorQuote, rateCard: card, walletPolicy });
  assert.ok(result);
  assert.equal(result.reduced, true);
  assert.ok(result.budget.maxOutputTokens >= 64);
  assert.ok(result.budget.maxOutputTokens < budget.maxOutputTokens);
  assert.ok(result.reservationTokens <= floorQuote);
  assert.equal(result.budget.maxCurrentMessageTokens, budget.maxCurrentMessageTokens);
});

test('fails before reservation when even the output floor does not fit', () => {
  const budget = getAIExecutionBudget('AI_CHAT_QUERY');
  assert.equal(deriveAffordableAIExecutionBudget({ feature: 'AI_CHAT_QUERY', budget, estimatedInputTokens: 100, availableBalance: 0, rateCard: card, walletPolicy }), null);
});

test('Chat removes only optional oldest-first history after the output floor is reached', () => {
  const budget = getAIExecutionBudget('AI_CHAT_QUERY');
  const outputFloor = { ...budget, maxOutputTokens: 64 };
  const noHistory = { ...outputFloor, maxHistoryTokens: 0, maxHistoryMessages: 0 };
  const noHistoryQuote = historyQuote(noHistory);
  const floorWithHistoryQuote = historyQuote(outputFloor);
  assert.ok(noHistoryQuote < floorWithHistoryQuote);

  const result = deriveAffordableAIExecutionBudget(historyInput(noHistoryQuote));
  assert.ok(result);
  assert.equal(result.budget.maxOutputTokens, 64);
  assert.equal(result.budget.maxHistoryTokens, 0);
  assert.equal(result.budget.maxHistoryMessages, 0);
  assert.equal(result.budget.maxCurrentMessageTokens, budget.maxCurrentMessageTokens);
  assert.equal(result.reservationTokens, noHistoryQuote);
});

test('Chat keeps the newest optional history allowance that still fits', () => {
  const budget = getAIExecutionBudget('AI_CHAT_QUERY');
  const outputFloor = { ...budget, maxOutputTokens: 64 };
  const halfHistory = {
    ...outputFloor,
    maxHistoryTokens: Math.floor((budget.maxHistoryTokens ?? 0) / 2),
    maxHistoryMessages: Math.ceil((budget.maxHistoryMessages ?? 0) / 2),
  };
  const result = deriveAffordableAIExecutionBudget(historyInput(historyQuote(halfHistory)));
  assert.ok(result);
  assert.equal(result.budget.maxOutputTokens, 64);
  assert.ok((result.budget.maxHistoryTokens ?? 0) >= halfHistory.maxHistoryTokens);
  assert.ok((result.budget.maxHistoryTokens ?? 0) < (budget.maxHistoryTokens ?? 0));
  assert.ok((result.budget.maxHistoryMessages ?? 0) >= halfHistory.maxHistoryMessages);
});
