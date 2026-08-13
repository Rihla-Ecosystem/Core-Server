import { aggregateProviderCalls } from '../utils/provider-pricing/aggregate.js';
import { summarizeProviderAttemptExposure } from '../utils/provider-attempt-exposure.js';
import type { ProviderRateCard } from '../types/provider-pricing.js';

export const CONTEXT_ANALYZE_FUNDING_POLICY = 'SYSTEM_FUNDED' as const;

export interface ContextAnalyzeAudit {
  operationId: string;
  fundingPolicy: typeof CONTEXT_ANALYZE_FUNDING_POLICY;
  status: 'PRICED' | 'NON_BILLABLE_CONFIRMED' | 'INDETERMINATE' | 'RATE_CARD_UNAVAILABLE';
  rateCardSource: 'DATABASE_PRIMARY';
  rateCardVersion?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  providerCostNanoUsd?: string;
  occurredAt: string;
  reason?: string;
  providerAttemptExposure?: ReturnType<typeof summarizeProviderAttemptExposure>;
}

/**
 * Creates a JSON-safe, durable audit payload. It deliberately never performs
 * Wallet reservation or conversion: Context Analyze is paid by the system.
 */
export function priceSystemFundedContextAnalyze(input: {
  operationId: string;
  providerCalls: unknown;
  providerAttempts?: unknown;
  rateCard: ProviderRateCard;
  now?: () => Date;
}): ContextAnalyzeAudit {
  const occurredAt = (input.now ?? (() => new Date()))().toISOString();
  const providerAttemptExposure = summarizeProviderAttemptExposure(input.providerAttempts);
  if (!Array.isArray(input.providerCalls)) {
    return {
      operationId: input.operationId, fundingPolicy: CONTEXT_ANALYZE_FUNDING_POLICY,
      status: 'INDETERMINATE', rateCardSource: 'DATABASE_PRIMARY', rateCardVersion: input.rateCard.version,
      occurredAt, reason: 'PROVIDER_USAGE_MISSING', providerAttemptExposure,
    };
  }
  if (input.providerCalls.length === 0) {
    return {
      operationId: input.operationId, fundingPolicy: CONTEXT_ANALYZE_FUNDING_POLICY,
      status: 'NON_BILLABLE_CONFIRMED', rateCardSource: 'DATABASE_PRIMARY', rateCardVersion: input.rateCard.version,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, providerCostNanoUsd: '0', occurredAt, providerAttemptExposure,
    };
  }
  const pricing = aggregateProviderCalls({ providerCalls: input.providerCalls, card: input.rateCard });
  if (pricing.summaryStatus !== 'FULLY_PRICED') {
    return {
      operationId: input.operationId, fundingPolicy: CONTEXT_ANALYZE_FUNDING_POLICY,
      status: 'INDETERMINATE', rateCardSource: 'DATABASE_PRIMARY', rateCardVersion: input.rateCard.version,
      occurredAt, reason: 'PROVIDER_USAGE_UNPRICEABLE', providerAttemptExposure,
    };
  }
  const usage = pricing.calls.reduce((sum, call) => ({
    inputTokens: sum.inputTokens + (call.kind === 'PRICED' ? call.usageApplied?.inputTokens ?? 0 : 0),
    outputTokens: sum.outputTokens + (call.kind === 'PRICED' ? call.usageApplied?.outputTokens ?? 0 : 0),
  }), { inputTokens: 0, outputTokens: 0 });
  const call = pricing.calls[0];
  return {
    operationId: input.operationId, fundingPolicy: CONTEXT_ANALYZE_FUNDING_POLICY,
    status: 'PRICED', rateCardSource: 'DATABASE_PRIMARY', rateCardVersion: input.rateCard.version,
    provider: call?.provider, model: call?.actualModel ?? call?.requestedModel,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    providerCostNanoUsd: pricing.totals.pricedCostNanoUsd.toString(), occurredAt, providerAttemptExposure,
  };
}

export function unavailableSystemFundedContextAnalyze(operationId: string, reason: string): ContextAnalyzeAudit {
  return {
    operationId, fundingPolicy: CONTEXT_ANALYZE_FUNDING_POLICY, status: 'RATE_CARD_UNAVAILABLE',
    rateCardSource: 'DATABASE_PRIMARY', occurredAt: new Date().toISOString(), reason,
  };
}

export function indeterminateSystemFundedContextAnalyze(operationId: string, reason: string, rateCardVersion?: string): ContextAnalyzeAudit {
  return {
    operationId, fundingPolicy: CONTEXT_ANALYZE_FUNDING_POLICY, status: 'INDETERMINATE',
    rateCardSource: 'DATABASE_PRIMARY', rateCardVersion, occurredAt: new Date().toISOString(), reason,
  };
}
