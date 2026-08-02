import type { BusinessTokenFeature } from '../config/business-token-features.js';
import type { ChatLimitsConfig } from '../config/chat-limits.js';
import type {
  AIProviderTokenRate,
  AIUsagePricingFallbackReason,
  AIUsagePricingMode,
  AIWalletPricingPolicy,
} from './ai-pricing.js';

export interface AIReservationQuoteInput {
  feature: BusinessTokenFeature;
  requestedMode: AIUsagePricingMode;

  provider?: string;
  model?: string;

  chatLimits: ChatLimitsConfig;

  rateCard: readonly AIProviderTokenRate[];
  walletPolicy: AIWalletPricingPolicy;
}

export interface AIReservationQuoteResult {
  feature: BusinessTokenFeature;

  requestedMode: AIUsagePricingMode;
  appliedMode: AIUsagePricingMode;

  reservationTokens: number;
  fixedFallbackTokens: number;

  maximumUsageWalletTokens?: number;
  fallbackReason?: AIUsagePricingFallbackReason;

  maxInputTokens: number;
  maxOutputTokens: number;

  provider?: string;
  model?: string;
  billingCurrency?: string;

  providerCostMicros?: number;
  adjustedCostMicros?: number;

  rateCardVersion?: string;
  walletPolicyVersion?: string;
}
