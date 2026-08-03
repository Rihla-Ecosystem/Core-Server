import type { AIProviderUsage } from './ai.js';
import type { BusinessTokenFeature } from '../config/business-token-features.js';

export type AIUsagePricingMode = 'FIXED_FALLBACK' | 'PROVIDER_USAGE';

export type AIUsagePricingFallbackReason =
  | 'USAGE_MISSING'
  | 'USAGE_INVALID'
  | 'RATE_CARD_NOT_FOUND';

export interface AIProviderTokenRate {
  provider: string;
  model: string;
  billingCurrency: string;

  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;

  version: string;
}

export interface AIWalletPricingPolicy {
  billingCurrency: string;

  walletTokenValueMicros: number;
  minimumWalletTokens: number;
  markupBasisPoints: number;

  version: string;
}

export interface AIUsagePricingInput {
  feature: BusinessTokenFeature;
  requestedMode: AIUsagePricingMode;
  usage?: AIProviderUsage;
  rateCard: readonly AIProviderTokenRate[];
  walletPolicy: AIWalletPricingPolicy;
}

export interface AIUsagePricingResult {
  feature: BusinessTokenFeature;

  requestedMode: AIUsagePricingMode;
  appliedMode: AIUsagePricingMode;

  walletTokens: number;
  fixedFallbackTokens: number;

  fallbackReason?: AIUsagePricingFallbackReason;

  provider?: string;
  model?: string;
  billingCurrency?: string;

  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cached?: boolean;
  audioSeconds?: number;

  providerCostMicros?: number;
  adjustedCostMicros?: number;

  rateCardVersion?: string;
  walletPolicyVersion?: string;
}
