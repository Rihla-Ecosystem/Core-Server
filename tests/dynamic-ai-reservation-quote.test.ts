import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateDynamicAIReservationQuote, DynamicAIReservationQuoteError } from '../src/utils/dynamic-ai-reservation-quote.js';
import { getAIExecutionBudget } from '../src/config/ai-execution-budget.js';
import { GEMINI_TEXT_RUNTIME_MODELS, GEMINI_TTS_RUNTIME_MODEL } from '../src/config/ai-runtime-routing.js';
import type { WalletPolicyConfig } from '../src/config/wallet-policy.js';
import type { ProviderRateCard, RateCardEntry } from '../src/types/provider-pricing.js';

const walletPolicy: WalletPolicyConfig = { signupTokenGrant: 400, walletTokenValueNanoUsd: 100_000, markupBasisPoints: 10_000, minimumWalletTokens: 1, maxReservationTokensByFeature: { AI_CHAT_QUERY: 150, AI_IMAGE_ANALYSIS: 75, REAL_TIME_TRANSLATION: 313, AI_TRIP_ITINERARY: 195 }, version: 'test' };
const tokenEntry = (model: string, rate = 100_000): RateCardEntry => ({ provider: 'google', model, status: 'STABLE', tier: 'standard', billingUnit: 'TOKEN', tokenRates: { inputMicrosPerMillion: rate, outputMicrosPerMillion: rate }, effectiveFrom: '2026-01-01', inactive: false });
const cardOf = (entries: RateCardEntry[]): ProviderRateCard => ({ schemaVersion: 1, currency: 'USD', storageUnit: 'MICROS', engineUnit: 'NANO_USD', version: 'db-test-v1', source: 'database', generatedAt: '2026-08-12T00:00:00Z', provenance: 'RESEARCH_SNAPSHOT', entries });
const routeEntries = GEMINI_TEXT_RUNTIME_MODELS.map((model, index) => tokenEntry(model, 100_000 + index * 50_000));
const baseCard = cardOf([...routeEntries, tokenEntry(GEMINI_TTS_RUNTIME_MODEL, 200_000)]);
function quote(feature: 'AI_CHAT_QUERY' | 'AI_IMAGE_ANALYSIS' | 'REAL_TIME_TRANSLATION' | 'AI_TRIP_ITINERARY', estimatedInputTokens: number, rateCard = baseCard) {
  return calculateDynamicAIReservationQuote({ feature, estimatedInputTokens, executionBudget: getAIExecutionBudget(feature), rateCard, walletPolicy });
}

test('unreachable expensive DB model cannot inflate Chat while a reachable expensive fallback can', () => {
  const baseline = quote('AI_CHAT_QUERY', 10);
  const unrelated = quote('AI_CHAT_QUERY', 10, cardOf([...baseCard.entries, tokenEntry('unreachable-expensive', 99_000_000)]));
  assert.equal(unrelated, baseline);
  const expensiveFallback = cardOf(baseCard.entries.map((entry) => entry.model === GEMINI_TEXT_RUNTIME_MODELS[3] ? tokenEntry(entry.model, 99_000_000) : entry));
  assert.ok(quote('AI_CHAT_QUERY', 10, expensiveFallback) > baseline);
});

test('small Chat quote is below legacy 150 and larger request quote grows deterministically', () => {
  const small = quote('AI_CHAT_QUERY', 10);
  assert.ok(small < 150);
  assert.ok(quote('AI_CHAT_QUERY', 2_000) > small);
  assert.equal(quote('AI_CHAT_QUERY', 100), quote('AI_CHAT_QUERY', 100));
});

test('missing price for a reachable runtime model fails closed', () => {
  assert.throws(() => quote('AI_CHAT_QUERY', 100, cardOf(baseCard.entries.filter((entry) => entry.model !== GEMINI_TEXT_RUNTIME_MODELS[1]))), DynamicAIReservationQuoteError);
});

test('Image ignores raw byte-like estimate and stays within its execution budget', () => {
  assert.equal(quote('AI_IMAGE_ANALYSIS', 1), quote('AI_IMAGE_ANALYSIS', 10_000_000));
  assert.ok(quote('AI_IMAGE_ANALYSIS', 0) > 0);
});

test('Voice ignores raw byte-like estimate, includes bounded audio and only actual TTS model', () => {
  const voice = quote('REAL_TIME_TRANSLATION', 1);
  assert.equal(voice, quote('REAL_TIME_TRANSLATION', 10_000_000));
  const unrelatedTts = cardOf([...baseCard.entries, tokenEntry('unrelated-tts', 99_000_000)]);
  assert.equal(voice, quote('REAL_TIME_TRANSLATION', 1, unrelatedTts));
  assert.throws(() => quote('REAL_TIME_TRANSLATION', 1, cardOf(baseCard.entries.filter((entry) => entry.model !== GEMINI_TTS_RUNTIME_MODEL))), DynamicAIReservationQuoteError);
});
