import type { AIProviderUsage } from '../types/ai.js';
import type {
  AIReservationQuoteInput,
  AIReservationQuoteResult,
} from '../types/ai-reservation-quote.js';
import type { ChatLimitsConfig } from '../config/chat-limits.js';
import type { BusinessTokenFeature } from '../config/business-token-features.js';
import {
  getBusinessTokenCost,
  isBusinessTokenFeature,
} from '../config/business-token-features.js';
import { calculateAIUsagePrice } from './ai-usage-pricing.js';

export class AIReservationQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIReservationQuoteError';
  }
}

/**
 * Pure maximum reservation quote calculator. It computes the maximum Wallet
 * Token amount that should be reserved before an AI request is executed. It
 * never creates a reservation, modifies a wallet, executes AI, settles or
 * releases a reservation, or persists anything.
 */
export function calculateAIReservationQuote(
  input: AIReservationQuoteInput,
): AIReservationQuoteResult {
  validateQuoteInput(input);

  const maxInputTokens = input.chatLimits.maxInputTokens;
  const maxOutputTokens = input.chatLimits.maxOutputTokens;

  if (input.requestedMode === 'FIXED_FALLBACK') {
    const fixedCost = getBusinessTokenCost(input.feature);
    const result = buildFixedResult(input.feature, fixedCost, maxInputTokens, maxOutputTokens);
    assertSafeResult(result);
    return result;
  }

  const provider = requireTrimmed(input.provider, 'provider');
  const model = requireTrimmed(input.model, 'model');

  if (maxInputTokens > Number.MAX_SAFE_INTEGER - maxOutputTokens) {
    throw new AIReservationQuoteError('maximum total tokens must be a safe integer');
  }
  const maximumTotalTokens = maxInputTokens + maxOutputTokens;

  // The maximum configured chat usage is used only as an internal quote input.
  // It never represents actual provider usage.
  const usage: AIProviderUsage = {
    provider,
    model,
    inputTokens: maxInputTokens,
    outputTokens: maxOutputTokens,
    totalTokens: maximumTotalTokens,
  };

  const pricing = calculateAIUsagePrice({
    feature: input.feature,
    requestedMode: 'PROVIDER_USAGE',
    usage,
    rateCard: input.rateCard,
    walletPolicy: input.walletPolicy,
  });

  if (pricing.appliedMode === 'FIXED_FALLBACK') {
    const result: AIReservationQuoteResult = {
      feature: input.feature,
      requestedMode: 'PROVIDER_USAGE',
      appliedMode: 'FIXED_FALLBACK',
      reservationTokens: pricing.fixedFallbackTokens,
      fixedFallbackTokens: pricing.fixedFallbackTokens,
      maxInputTokens,
      maxOutputTokens,
      ...(pricing.fallbackReason === undefined
        ? {}
        : { fallbackReason: pricing.fallbackReason }),
    };
    assertSafeResult(result);
    return result;
  }

  const maximumUsageWalletTokens = pricing.walletTokens;
  const reservationTokens = Math.max(
    pricing.fixedFallbackTokens,
    maximumUsageWalletTokens,
  );

  const result: AIReservationQuoteResult = {
    feature: input.feature,
    requestedMode: 'PROVIDER_USAGE',
    appliedMode: 'PROVIDER_USAGE',
    reservationTokens,
    fixedFallbackTokens: pricing.fixedFallbackTokens,
    maximumUsageWalletTokens,
    maxInputTokens,
    maxOutputTokens,
    provider,
    model,
    billingCurrency: pricing.billingCurrency,
    providerCostMicros: pricing.providerCostMicros,
    adjustedCostMicros: pricing.adjustedCostMicros,
    rateCardVersion: pricing.rateCardVersion,
    walletPolicyVersion: pricing.walletPolicyVersion,
  };

  assertSafeResult(result);
  return result;
}

function buildFixedResult(
  feature: BusinessTokenFeature,
  fixedCost: number,
  maxInputTokens: number,
  maxOutputTokens: number,
): AIReservationQuoteResult {
  return {
    feature,
    requestedMode: 'FIXED_FALLBACK',
    appliedMode: 'FIXED_FALLBACK',
    reservationTokens: fixedCost,
    fixedFallbackTokens: fixedCost,
    maxInputTokens,
    maxOutputTokens,
  };
}

function validateQuoteInput(input: AIReservationQuoteInput): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AIReservationQuoteError('quote input must be an object');
  }

  if (typeof input.feature !== 'string' || !isBusinessTokenFeature(input.feature)) {
    throw new AIReservationQuoteError('feature must be a valid business token feature');
  }

  if (input.requestedMode !== 'FIXED_FALLBACK' && input.requestedMode !== 'PROVIDER_USAGE') {
    throw new AIReservationQuoteError('requestedMode must be FIXED_FALLBACK or PROVIDER_USAGE');
  }

  validateChatLimits(input.chatLimits);
}

function requireTrimmed(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AIReservationQuoteError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function validateChatLimits(chatLimits: ChatLimitsConfig): void {
  if (chatLimits === null || typeof chatLimits !== 'object' || Array.isArray(chatLimits)) {
    throw new AIReservationQuoteError('chatLimits must be an object');
  }

  const record = chatLimits as unknown as Record<string, unknown>;

  if (!isSafePositiveInteger(record.maxInputTokens)) {
    throw new AIReservationQuoteError('chatLimits maxInputTokens must be a safe positive integer');
  }
  if (!isSafePositiveInteger(record.maxOutputTokens)) {
    throw new AIReservationQuoteError('chatLimits maxOutputTokens must be a safe positive integer');
  }
  if (!isSafePositiveInteger(record.maxCurrentMessageTokens)) {
    throw new AIReservationQuoteError(
      'chatLimits maxCurrentMessageTokens must be a safe positive integer',
    );
  }
  if (!isSafePositiveInteger(record.maxMessageCharacters)) {
    throw new AIReservationQuoteError(
      'chatLimits maxMessageCharacters must be a safe positive integer',
    );
  }
  if (!isSafeNonNegativeInteger(record.maxRecentMessages)) {
    throw new AIReservationQuoteError(
      'chatLimits maxRecentMessages must be a safe non-negative integer',
    );
  }
  if (!isSafeNonNegativeInteger(record.historyTokenBudget)) {
    throw new AIReservationQuoteError(
      'chatLimits historyTokenBudget must be a safe non-negative integer',
    );
  }
  if (!isSafeNonNegativeInteger(record.summaryTokenBudget)) {
    throw new AIReservationQuoteError(
      'chatLimits summaryTokenBudget must be a safe non-negative integer',
    );
  }
  if (!isSafeNonNegativeInteger(record.inputHeadroomTokens)) {
    throw new AIReservationQuoteError(
      'chatLimits inputHeadroomTokens must be a safe non-negative integer',
    );
  }

  if (chatLimits.maxCurrentMessageTokens > chatLimits.maxInputTokens) {
    throw new AIReservationQuoteError(
      'chatLimits maxCurrentMessageTokens must not exceed maxInputTokens',
    );
  }

  const contextSum =
    chatLimits.maxCurrentMessageTokens +
    chatLimits.historyTokenBudget +
    chatLimits.summaryTokenBudget;

  if (contextSum > chatLimits.maxInputTokens) {
    throw new AIReservationQuoteError(
      'chatLimits context budgets must not exceed maxInputTokens',
    );
  }

  const expectedHeadroom =
    chatLimits.maxInputTokens -
    chatLimits.maxCurrentMessageTokens -
    chatLimits.historyTokenBudget -
    chatLimits.summaryTokenBudget;

  if (chatLimits.inputHeadroomTokens !== expectedHeadroom) {
    throw new AIReservationQuoteError('chatLimits inputHeadroomTokens is inconsistent');
  }
}

function assertSafeResult(result: AIReservationQuoteResult): void {
  requireSafeNonNegative(result.reservationTokens, 'reservationTokens');
  requireSafeNonNegative(result.fixedFallbackTokens, 'fixedFallbackTokens');
  if (result.maximumUsageWalletTokens !== undefined) {
    requireSafeNonNegative(result.maximumUsageWalletTokens, 'maximumUsageWalletTokens');
  }
  requireSafeNonNegative(result.maxInputTokens, 'maxInputTokens');
  requireSafeNonNegative(result.maxOutputTokens, 'maxOutputTokens');
  if (result.providerCostMicros !== undefined) {
    requireSafeNonNegative(result.providerCostMicros, 'providerCostMicros');
  }
  if (result.adjustedCostMicros !== undefined) {
    requireSafeNonNegative(result.adjustedCostMicros, 'adjustedCostMicros');
  }
}

function requireSafeNonNegative(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AIReservationQuoteError(`${name} must be a safe non-negative integer`);
  }
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
