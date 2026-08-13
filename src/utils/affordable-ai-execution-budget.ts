import type { AIExecutionBudget } from '../config/ai-execution-budget.js';
import type { BusinessTokenFeature } from '../config/business-token-features.js';
import type { ProviderRateCard } from '../types/provider-pricing.js';
import type { WalletPolicyConfig } from '../config/wallet-policy.js';
import { calculateDynamicAIReservationQuote } from './dynamic-ai-reservation-quote.js';

const MIN_OUTPUT: Record<BusinessTokenFeature, number> = {
  AI_CHAT_QUERY: 64,
  AI_IMAGE_ANALYSIS: 64,
  REAL_TIME_TRANSLATION: 64,
  AI_TRIP_ITINERARY: 128,
};

export interface AffordableBudgetInput {
  feature: BusinessTokenFeature;
  budget: AIExecutionBudget;
  estimatedInputTokens: number;
  /** The optional Chat-history portion already included in estimatedInputTokens. */
  optionalHistoryInputTokens?: number;
  availableBalance: number;
  rateCard: ProviderRateCard;
  walletPolicy: WalletPolicyConfig;
}

export interface AffordableBudgetResult { budget: AIExecutionBudget; reservationTokens: number; reduced: boolean; }

function quote(input: AffordableBudgetInput, budget: AIExecutionBudget): number {
  const optionalHistory = input.optionalHistoryInputTokens ?? 0;
  const adjustedInputTokens = input.feature === 'AI_CHAT_QUERY'
    ? Math.max(0, input.estimatedInputTokens - optionalHistory) + Math.min(optionalHistory, budget.maxHistoryTokens ?? 0)
    : input.estimatedInputTokens;
  return calculateDynamicAIReservationQuote({ feature: input.feature, executionBudget: budget, estimatedInputTokens: adjustedInputTokens, rateCard: input.rateCard, walletPolicy: input.walletPolicy });
}

/** Find the richest safe output, then optional Chat-history, allocation affordable at the current balance. */
export function deriveAffordableAIExecutionBudget(input: AffordableBudgetInput): AffordableBudgetResult | null {
  if (!Number.isSafeInteger(input.availableBalance) || input.availableBalance < 0) return null;
  const normal = quote(input, input.budget);
  if (normal <= input.availableBalance) return { budget: input.budget, reservationTokens: normal, reduced: false };
  const floor = Math.min(MIN_OUTPUT[input.feature], input.budget.maxOutputTokens);
  const withOutput = (maxOutputTokens: number): AIExecutionBudget => ({
    ...input.budget,
    maxOutputTokens,
  });
  const minimum = withOutput(floor);
  const minimumQuote = quote(input, minimum);
  if (minimumQuote > input.availableBalance) {
    if (input.feature !== 'AI_CHAT_QUERY' || input.budget.maxHistoryTokens === undefined) return null;
    const maximumHistoryTokens = input.budget.maxHistoryTokens;
    const maximumHistoryMessages = input.budget.maxHistoryMessages ?? 0;
    const withHistory = (maxHistoryTokens: number): AIExecutionBudget => ({
      ...minimum,
      maxHistoryTokens,
      // AI Service selects newest-first within both caps. Scaling the message
      // cap with the token cap therefore removes only the oldest optional turns.
      maxHistoryMessages: maxHistoryTokens === 0 || maximumHistoryTokens === 0
        ? 0
        : Math.max(1, Math.ceil((maximumHistoryMessages * maxHistoryTokens) / maximumHistoryTokens)),
    });
    const noHistory = withHistory(0);
    const noHistoryQuote = quote(input, noHistory);
    if (noHistoryQuote > input.availableBalance) return null;
    let lowHistory = 0;
    let highHistory = maximumHistoryTokens;
    let bestHistory = noHistory;
    let bestHistoryQuote = noHistoryQuote;
    while (lowHistory <= highHistory) {
      const mid = Math.floor((lowHistory + highHistory) / 2);
      const candidate = withHistory(mid);
      const candidateQuote = quote(input, candidate);
      if (candidateQuote <= input.availableBalance) {
        bestHistory = candidate; bestHistoryQuote = candidateQuote; lowHistory = mid + 1;
      } else highHistory = mid - 1;
    }
    return { budget: bestHistory, reservationTokens: bestHistoryQuote, reduced: true };
  }
  let low = floor;
  let high = input.budget.maxOutputTokens;
  let best = minimum;
  let bestQuote = minimumQuote;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = withOutput(mid);
    const candidateQuote = quote(input, candidate);
    if (candidateQuote <= input.availableBalance) {
      best = candidate; bestQuote = candidateQuote; low = mid + 1;
    } else high = mid - 1;
  }
  return { budget: best, reservationTokens: bestQuote, reduced: true };
}
