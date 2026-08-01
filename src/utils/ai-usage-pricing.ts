import type { AIProviderUsage } from '../types/ai.js';
import type {
  AIProviderTokenRate,
  AIUsagePricingFallbackReason,
  AIUsagePricingInput,
  AIUsagePricingMode,
  AIUsagePricingResult,
  AIWalletPricingPolicy,
} from '../types/ai-pricing.js';
import {
  getBusinessTokenCost,
  isBusinessTokenFeature,
} from '../config/business-token-features.js';

export class AIUsagePricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIUsagePricingError';
  }
}

/**
 * Pure pricing engine foundation. It calculates AI usage pricing results only
 * and never reserves, debits, settles, releases, refunds, or otherwise touches
 * any wallet balance.
 *
 * Basis-point meaning for walletPolicy.markupBasisPoints:
 * - 10000 = 1.00x
 * - 12000 = 1.20x
 *
 * The production markup is not assumed to be 12000; tests may use explicit
 * fake values.
 */
export function calculateAIUsagePrice(input: AIUsagePricingInput): AIUsagePricingResult {
  validateInput(input);

  const fixedCost = getBusinessTokenCost(input.feature);

  if (input.requestedMode === 'FIXED_FALLBACK') {
    return buildFixedFallbackResult(input.feature, 'FIXED_FALLBACK', fixedCost);
  }

  if (input.usage === undefined) {
    return buildFixedFallbackResult(input.feature, 'PROVIDER_USAGE', fixedCost, 'USAGE_MISSING');
  }

  const usage = validateUsage(input.usage);
  if (usage === undefined) {
    return buildFixedFallbackResult(input.feature, 'PROVIDER_USAGE', fixedCost, 'USAGE_INVALID');
  }

  const rate = findExactRate(input.rateCard, usage.provider, usage.model);
  if (rate === undefined) {
    return buildFixedFallbackResult(
      input.feature,
      'PROVIDER_USAGE',
      fixedCost,
      'RATE_CARD_NOT_FOUND',
    );
  }

  if (rate.billingCurrency.trim() !== input.walletPolicy.billingCurrency.trim()) {
    throw new AIUsagePricingError(
      `rate billing currency "${rate.billingCurrency}" does not match wallet policy ` +
        `billing currency "${input.walletPolicy.billingCurrency}"`,
    );
  }

  const providerCostMicros = computeProviderCostMicros(usage, rate);
  const adjustedCostMicros = applyMarkup(
    providerCostMicros,
    input.walletPolicy.markupBasisPoints,
  );

  const calculatedWalletTokens = ceilDiv(
    BigInt(adjustedCostMicros),
    BigInt(input.walletPolicy.walletTokenValueMicros),
  );
  const walletTokens = Math.max(
    requireSafeNumber(calculatedWalletTokens, 'walletTokens'),
    input.walletPolicy.minimumWalletTokens,
  );

  return {
    feature: input.feature,
    requestedMode: 'PROVIDER_USAGE',
    appliedMode: 'PROVIDER_USAGE',
    walletTokens,
    fixedFallbackTokens: fixedCost,
    provider: usage.provider,
    model: usage.model,
    billingCurrency: rate.billingCurrency,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cached === undefined ? {} : { cached: usage.cached }),
    ...(usage.audioSeconds === undefined ? {} : { audioSeconds: usage.audioSeconds }),
    providerCostMicros,
    adjustedCostMicros,
    rateCardVersion: rate.version,
    walletPolicyVersion: input.walletPolicy.version,
  };
}

function buildFixedFallbackResult(
  feature: AIUsagePricingInput['feature'],
  requestedMode: AIUsagePricingMode,
  fixedCost: number,
  fallbackReason?: AIUsagePricingFallbackReason,
): AIUsagePricingResult {
  return {
    feature,
    requestedMode,
    appliedMode: 'FIXED_FALLBACK',
    walletTokens: fixedCost,
    fixedFallbackTokens: fixedCost,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
  };
}

function validateInput(input: AIUsagePricingInput): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AIUsagePricingError('pricing input must be an object');
  }

  const feature = input.feature;
  if (typeof feature !== 'string' || !isBusinessTokenFeature(feature)) {
    throw new AIUsagePricingError('feature must be a valid business token feature');
  }

  if (input.requestedMode !== 'FIXED_FALLBACK' && input.requestedMode !== 'PROVIDER_USAGE') {
    throw new AIUsagePricingError('requestedMode must be FIXED_FALLBACK or PROVIDER_USAGE');
  }

  validateRateCard(input.rateCard);
  validateWalletPolicy(input.walletPolicy);
}

function validateRateCard(rateCard: readonly AIProviderTokenRate[]): void {
  if (!Array.isArray(rateCard)) {
    throw new AIUsagePricingError('rateCard must be an array');
  }

  const seen = new Set<string>();
  for (let index = 0; index < rateCard.length; index++) {
    const entry = rateCard[index];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AIUsagePricingError(`rateCard entry ${index} must be an object`);
    }
    if (typeof entry.provider !== 'string' || entry.provider.trim().length === 0) {
      throw new AIUsagePricingError(
        `rateCard entry ${index} provider must be a non-empty string`,
      );
    }
    if (typeof entry.model !== 'string' || entry.model.trim().length === 0) {
      throw new AIUsagePricingError(
        `rateCard entry ${index} model must be a non-empty string`,
      );
    }
    if (
      typeof entry.billingCurrency !== 'string' ||
      entry.billingCurrency.trim().length === 0
    ) {
      throw new AIUsagePricingError(
        `rateCard entry ${index} billingCurrency must be a non-empty string`,
      );
    }
    if (typeof entry.version !== 'string' || entry.version.trim().length === 0) {
      throw new AIUsagePricingError(
        `rateCard entry ${index} version must be a non-empty string`,
      );
    }
    if (!isSafeNonNegativeInteger(entry.inputMicrosPerMillionTokens)) {
      throw new AIUsagePricingError(
        `rateCard entry ${index} inputMicrosPerMillionTokens must be a safe non-negative integer`,
      );
    }
    if (!isSafeNonNegativeInteger(entry.outputMicrosPerMillionTokens)) {
      throw new AIUsagePricingError(
        `rateCard entry ${index} outputMicrosPerMillionTokens must be a safe non-negative integer`,
      );
    }

    const key = `${entry.provider.trim()}\u0000${entry.model.trim()}`;
    if (seen.has(key)) {
      throw new AIUsagePricingError(
        `duplicate rateCard entry for provider "${entry.provider.trim()}" and model "${entry.model.trim()}"`,
      );
    }
    seen.add(key);
  }
}

function validateWalletPolicy(policy: AIWalletPricingPolicy): void {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new AIUsagePricingError('walletPolicy must be an object');
  }
  if (typeof policy.billingCurrency !== 'string' || policy.billingCurrency.trim().length === 0) {
    throw new AIUsagePricingError('walletPolicy billingCurrency must be a non-empty string');
  }
  if (typeof policy.version !== 'string' || policy.version.trim().length === 0) {
    throw new AIUsagePricingError('walletPolicy version must be a non-empty string');
  }
  if (!isSafePositiveInteger(policy.walletTokenValueMicros)) {
    throw new AIUsagePricingError('walletPolicy walletTokenValueMicros must be a safe positive integer');
  }
  if (!isSafeNonNegativeInteger(policy.minimumWalletTokens)) {
    throw new AIUsagePricingError('walletPolicy minimumWalletTokens must be a safe non-negative integer');
  }
  if (!isSafePositiveInteger(policy.markupBasisPoints)) {
    throw new AIUsagePricingError('walletPolicy markupBasisPoints must be a safe positive integer');
  }
}

function validateUsage(usage: AIProviderUsage | undefined): AIProviderUsage | undefined {
  if (usage === undefined) return undefined;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return undefined;

  const record = usage as unknown as Record<string, unknown>;
  const provider = record.provider;
  const model = record.model;
  if (typeof provider !== 'string' || provider.trim().length === 0) return undefined;
  if (typeof model !== 'string' || model.trim().length === 0) return undefined;
  if (!isSafeNonNegativeInteger(record.inputTokens)) return undefined;
  if (!isSafeNonNegativeInteger(record.outputTokens)) return undefined;
  if (!isSafeNonNegativeInteger(record.totalTokens)) return undefined;

  let cached: boolean | undefined;
  if (Object.prototype.hasOwnProperty.call(record, 'cached')) {
    if (typeof record.cached !== 'boolean') return undefined;
    cached = record.cached;
  }

  let audioSeconds: number | undefined;
  if (Object.prototype.hasOwnProperty.call(record, 'audioSeconds')) {
    if (
      typeof record.audioSeconds !== 'number' ||
      !Number.isFinite(record.audioSeconds) ||
      record.audioSeconds < 0
    ) {
      return undefined;
    }
    audioSeconds = record.audioSeconds;
  }

  return {
    provider: provider.trim(),
    model: model.trim(),
    inputTokens: record.inputTokens as number,
    outputTokens: record.outputTokens as number,
    totalTokens: record.totalTokens as number,
    ...(cached === undefined ? {} : { cached }),
    ...(audioSeconds === undefined ? {} : { audioSeconds }),
  };
}

function findExactRate(
  rateCard: readonly AIProviderTokenRate[],
  provider: string,
  model: string,
): AIProviderTokenRate | undefined {
  return rateCard.find(
    (rate) => rate.provider.trim() === provider && rate.model.trim() === model,
  );
}

function computeProviderCostMicros(
  usage: AIProviderUsage,
  rate: AIProviderTokenRate,
): number {
  const numerator =
    BigInt(usage.inputTokens) * BigInt(rate.inputMicrosPerMillionTokens) +
    BigInt(usage.outputTokens) * BigInt(rate.outputMicrosPerMillionTokens);

  const providerCostMicros = ceilDiv(numerator, MICROS_PER_MILLION);
  return requireSafeNumber(providerCostMicros, 'providerCostMicros');
}

function applyMarkup(providerCostMicros: number, markupBasisPoints: number): number {
  const adjustedCostMicros = ceilDiv(
    BigInt(providerCostMicros) * BigInt(markupBasisPoints),
    BASIS_POINTS_PER_UNIT,
  );
  return requireSafeNumber(adjustedCostMicros, 'adjustedCostMicros');
}

const MICROS_PER_MILLION = 1_000_000n;
const BASIS_POINTS_PER_UNIT = 10_000n;

/**
 * Ceiling division for non-negative numerators and positive denominators.
 * Produces a non-negative BigInt.
 */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function requireSafeNumber(value: bigint, name: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AIUsagePricingError(`${name} must be a non-negative safe integer`);
  }
  return Number(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
