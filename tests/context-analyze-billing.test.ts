import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceSystemFundedContextAnalyze, CONTEXT_ANALYZE_FUNDING_POLICY } from '../src/services/context-analyze-billing.service.js';
import type { ProviderRateCard, RateCardEntry } from '../src/types/provider-pricing.js';

const entry = (model: string, rate = 1_000_000): RateCardEntry => ({
  provider: 'google', model, status: 'STABLE', tier: 'standard', billingUnit: 'TOKEN',
  tokenRates: { inputMicrosPerMillion: rate, outputMicrosPerMillion: rate }, effectiveFrom: '2026-01-01', inactive: false,
});
const card = (entries: RateCardEntry[]): ProviderRateCard => ({
  schemaVersion: 1, currency: 'USD', storageUnit: 'MICROS', engineUnit: 'NANO_USD', version: 'active-db-v1',
  source: 'database', generatedAt: '2026-08-13T00:00:00Z', provenance: 'RESEARCH_SNAPSHOT', entries,
});
const successfulCall = {
  providerCallMade: true, provider: 'google', requestedModel: 'gemini-3.5-flash-lite',
  actualModel: 'gemini-3.5-flash-lite', operation: 'TEXT_GENERATION', inputTokens: 120, outputTokens: 40,
};

test('Context Analyze is system-funded and records actual model cost from the active DB card', () => {
  const result = priceSystemFundedContextAnalyze({
    operationId: 'context-analyze:one', providerCalls: [successfulCall],
    rateCard: card([entry('gemini-3.5-flash-lite')]), now: () => new Date('2026-08-13T00:00:00Z'),
  });
  assert.equal(result.fundingPolicy, CONTEXT_ANALYZE_FUNDING_POLICY);
  assert.equal(result.status, 'PRICED');
  assert.equal(result.rateCardSource, 'DATABASE_PRIMARY');
  assert.equal(result.model, 'gemini-3.5-flash-lite');
  assert.equal(result.inputTokens, 120);
  assert.equal(result.outputTokens, 40);
  assert.ok(BigInt(result.providerCostNanoUsd!) > 0n);
});

test('unrelated DB models cannot affect actual Context Analyze cost', () => {
  const base = priceSystemFundedContextAnalyze({ operationId: 'a', providerCalls: [successfulCall], rateCard: card([entry('gemini-3.5-flash-lite')]) });
  const extra = priceSystemFundedContextAnalyze({ operationId: 'b', providerCalls: [successfulCall], rateCard: card([entry('gemini-3.5-flash-lite'), entry('unrelated-model', 999_999_999)]) });
  assert.equal(extra.providerCostNanoUsd, base.providerCostNanoUsd);
});

test('missing or incomplete provider usage is indeterminate and never invents a cost', () => {
  const result = priceSystemFundedContextAnalyze({ operationId: 'missing', providerCalls: [successfulCall], rateCard: card([]) });
  assert.equal(result.status, 'INDETERMINATE');
  assert.equal(result.providerCostNanoUsd, undefined);
});

test('an explicit no-provider-call result is recorded as non-billable system-funded work', () => {
  const result = priceSystemFundedContextAnalyze({ operationId: 'zero', providerCalls: [], rateCard: card([]) });
  assert.equal(result.status, 'NON_BILLABLE_CONFIRMED');
  assert.equal(result.providerCostNanoUsd, '0');
});
