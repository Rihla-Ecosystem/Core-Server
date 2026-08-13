import type { AIExecutionBudget } from '../config/ai-execution-budget.js';
import type { WalletPolicyConfig } from '../config/wallet-policy.js';
import type { ProviderRateCard } from '../types/provider-pricing.js';
import { aggregateProviderCalls } from './provider-pricing/aggregate.js';
import { computeWalletCharge } from './wallet-conversion.js';
import { AI_RUNTIME_MODEL_ROUTES } from '../config/ai-runtime-routing.js';
import type { UsageBasedAIFeature } from '../config/ai-runtime-routing.js';

export class DynamicAIReservationQuoteError extends Error {}

export interface DynamicAIReservationQuoteInput {
  feature: UsageBasedAIFeature;
  executionBudget: AIExecutionBudget;
  estimatedInputTokens: number;
  rateCard: ProviderRateCard;
  walletPolicy: WalletPolicyConfig;
}

/**
 * Prices only the models the selected runtime operation can reach. Each
 * logical call uses its most expensive reachable model; Voice additionally
 * includes its actual TTS route. DB entries unrelated to this route cannot
 * affect reservation cost.
 */
export function calculateDynamicAIReservationQuote(input: DynamicAIReservationQuoteInput): number {
  if (!Number.isSafeInteger(input.estimatedInputTokens) || input.estimatedInputTokens < 0) {
    throw new DynamicAIReservationQuoteError('estimated input tokens must be a safe non-negative integer');
  }
  const boundedInput = Math.min(input.estimatedInputTokens, input.executionBudget.maxInputTokens);
  const route = AI_RUNTIME_MODEL_ROUTES[input.feature];
  const walletConfig = {
    walletTokenValueNanoUsd: input.walletPolicy.walletTokenValueNanoUsd,
    markupBasisPoints: input.walletPolicy.markupBasisPoints,
    minimumWalletTokens: input.walletPolicy.minimumWalletTokens,
  };
  const quoteOneCall = (models: readonly string[], call: Record<string, unknown>): bigint => {
    let maximum: bigint | undefined;
    for (const model of models) {
      const entry = input.rateCard.entries.find((candidate) =>
        candidate.inactive === false && candidate.provider === 'google' && candidate.model === model && candidate.billingUnit === 'TOKEN',
      );
      if (!entry || entry.tokenRates?.inputMicrosPerMillion === undefined || entry.tokenRates.outputMicrosPerMillion === undefined) {
        throw new DynamicAIReservationQuoteError(`database rate card cannot price reachable model ${model}`);
      }
    const pricing = aggregateProviderCalls({
      card: input.rateCard,
      providerCalls: [{
        providerCallMade: true,
        provider: 'google', requestedModel: model, actualModel: model,
        operation: input.feature, ...call,
      }],
    });
    if (pricing.summaryStatus !== 'FULLY_PRICED') {
      throw new DynamicAIReservationQuoteError(`database rate card cannot price reachable model ${model}`);
    }
    const charge = computeWalletCharge(pricing, walletConfig);
    if (maximum === undefined || charge.tokens > maximum) maximum = charge.tokens;
  }
    if (maximum === undefined) throw new DynamicAIReservationQuoteError('no reachable priceable model');
    return maximum;
  };

  // Image and audio inputs are never inferred from bytes. Exact multimodal
  // tokenization is unavailable pre-provider, so their Phase 2 bounded input
  // allowance is the conservative token exposure.
  const textCall: Record<string, unknown> = input.feature === 'AI_IMAGE_ANALYSIS'
    ? { inputTokens: input.executionBudget.maxInputTokens, imageInputTokens: input.executionBudget.maxInputTokens, outputTokens: input.executionBudget.maxOutputTokens }
    : input.feature === 'REAL_TIME_TRANSLATION'
      ? {
          inputTokens: Math.max(boundedInput, input.executionBudget.maxAudioInputTokens ?? 0),
          audioInputTokens: input.executionBudget.maxAudioInputTokens ?? 0,
          outputTokens: input.executionBudget.maxOutputTokens,
        }
      : { inputTokens: boundedInput, outputTokens: input.executionBudget.maxOutputTokens };
  let maximum = quoteOneCall(route.textModels, textCall);
  if (route.ttsModels) {
    const tts = quoteOneCall(route.ttsModels, {
      inputTokens: Math.ceil((input.executionBudget.maxTtsCharacters ?? 0) / 4),
      outputTokens: input.executionBudget.maxTtsOutputTokens ?? 0,
    });
    maximum += tts;
  }
  if (maximum === undefined || maximum > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DynamicAIReservationQuoteError('dynamic reservation quote is invalid');
  }
  return Number(maximum);
}
