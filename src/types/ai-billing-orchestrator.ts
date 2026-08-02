import type { AIProviderUsage } from './ai.js';
import type {
  AIProviderTokenRate,
  AIUsagePricingFallbackReason,
  AIUsagePricingInput,
  AIUsagePricingMode,
  AIUsagePricingResult,
  AIWalletPricingPolicy,
} from './ai-pricing.js';
import type {
  AIReservationQuoteInput,
  AIReservationQuoteResult,
} from './ai-reservation-quote.js';
import type { ChatLimitsConfig } from '../config/chat-limits.js';
import type { BusinessTokenFeature } from '../config/business-token-features.js';
import type { BusinessConsumptionSource } from '../services/business-token-consumption.service.js';
import type {
  ReleaseBusinessTokenReservationInput,
  ReleaseBusinessTokenReservationResult,
  ReserveBusinessTokensForAmountInput,
  ReserveBusinessTokensResult,
  SettleBusinessTokenReservationForAmountInput,
  SettleBusinessTokenReservationResult,
} from '../services/token-reservation.service.js';

export type AIBillingOrchestratorStage =
  | 'QUOTE'
  | 'RESERVATION'
  | 'RESERVATION_REPLAY'
  | 'EXECUTION'
  | 'RELEASE'
  | 'USAGE_VALIDATION'
  | 'PRICING'
  | 'SETTLEMENT';

export interface AIBillingOrchestratorInput<T> {
  userId: string;
  feature: BusinessTokenFeature;
  source: BusinessConsumptionSource;
  idempotencyKey: string;

  requestedMode: AIUsagePricingMode;

  provider?: string;
  model?: string;

  chatLimits: ChatLimitsConfig;
  rateCard: readonly AIProviderTokenRate[];
  walletPolicy: AIWalletPricingPolicy;

  execute: () => Promise<AIBillingExecutionOutcome<T>>;
}

export type AIBillingExecutionOutcome<T> =
  | {
      kind: 'SUCCESS';
      data: T;
      usage?: unknown;
    }
  | {
      kind: 'FAILURE';
      disposition: 'NON_BILLABLE' | 'INDETERMINATE';
      errorCode?: string;
      message?: string;
    };

export type AIBillingReservationMetadata = {
  aiBilling: {
    schemaVersion: 1;
    requestedMode: AIUsagePricingMode;
    quoteAppliedMode: AIUsagePricingMode;
    quotedTokens: number;
    fixedFallbackTokens: number;
    maximumUsageWalletTokens?: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    provider?: string;
    model?: string;
    billingCurrency?: string;
    rateCardVersion?: string;
    walletPolicyVersion?: string;
  };
};

export interface AIBillingOrchestratorDependencies {
  calculateQuote: (input: AIReservationQuoteInput) => AIReservationQuoteResult;
  reserveForAmount: (
    input: ReserveBusinessTokensForAmountInput,
  ) => Promise<ReserveBusinessTokensResult>;
  normalizeUsage: (raw: unknown) => AIProviderUsage | undefined;
  calculateActualPrice: (input: AIUsagePricingInput) => AIUsagePricingResult;
  settleForAmount: (
    input: SettleBusinessTokenReservationForAmountInput,
  ) => Promise<SettleBusinessTokenReservationResult>;
  releaseReservation: (
    input: ReleaseBusinessTokenReservationInput,
  ) => Promise<ReleaseBusinessTokenReservationResult>;
}

export interface AIBillingOrchestratorResult<T> {
  data: T;

  quote: AIReservationQuoteResult;

  billing: {
    reservationId: string;
    reservedTokens: number;
    actualTokens: number;
    releasedTokens: number;

    requestedMode: AIUsagePricingMode;
    appliedMode: AIUsagePricingMode;

    fallbackReason?: AIUsagePricingFallbackReason;

    provider?: string;
    model?: string;
    billingCurrency?: string;

    rateCardVersion?: string;
    walletPolicyVersion?: string;

    consumeTransactionId: string;
  };
}

export interface AIBillingOrchestratorErrorOptions {
  reservationId?: string;
  recoveryRequired?: boolean;
  reservationReleased?: boolean;
}
