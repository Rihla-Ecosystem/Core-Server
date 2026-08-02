import type { AIProviderUsage } from '../types/ai.js';
import type { AIUsagePricingResult } from '../types/ai-pricing.js';
import type { AIReservationQuoteResult } from '../types/ai-reservation-quote.js';
import type {
  AIBillingOrchestratorDependencies,
  AIBillingOrchestratorErrorOptions,
  AIBillingOrchestratorInput,
  AIBillingOrchestratorResult,
  AIBillingOrchestratorStage,
  AIBillingReservationMetadata,
} from '../types/ai-billing-orchestrator.js';
import type {
  ReserveBusinessTokensResult,
  SettleBusinessTokenReservationResult,
} from './token-reservation.service.js';
import {
  releaseBusinessTokenReservation,
  reserveBusinessTokensForAmount,
  settleBusinessTokenReservationForAmount,
} from './token-reservation.service.js';
import { calculateAIReservationQuote } from '../utils/ai-reservation-quote.js';
import { calculateAIUsagePrice } from '../utils/ai-usage-pricing.js';
import { normalizeAIProviderUsage } from '../utils/ai-usage.js';

export class AIBillingOrchestratorError extends Error {
  readonly stage: AIBillingOrchestratorStage;
  readonly reservationId?: string;
  readonly recoveryRequired: boolean;
  readonly reservationReleased: boolean;

  constructor(
    stage: AIBillingOrchestratorStage,
    message: string,
    options: AIBillingOrchestratorErrorOptions = {},
  ) {
    super(message);
    this.name = 'AIBillingOrchestratorError';
    this.stage = stage;
    this.reservationId = options.reservationId;
    this.recoveryRequired = options.recoveryRequired ?? false;
    this.reservationReleased = options.reservationReleased ?? false;
  }
}

export function createDefaultAIBillingOrchestratorDependencies(): AIBillingOrchestratorDependencies {
  return {
    calculateQuote: calculateAIReservationQuote,
    reserveForAmount: reserveBusinessTokensForAmount,
    normalizeUsage: normalizeAIProviderUsage,
    calculateActualPrice: calculateAIUsagePrice,
    settleForAmount: settleBusinessTokenReservationForAmount,
    releaseReservation: releaseBusinessTokenReservation,
  };
}

interface AIBillingPricingSnapshot {
  chatLimits: Readonly<AIBillingOrchestratorInput<unknown>['chatLimits']>;
  rateCard: Readonly<AIBillingOrchestratorInput<unknown>['rateCard']>;
  walletPolicy: Readonly<AIBillingOrchestratorInput<unknown>['walletPolicy']>;
  provider: string | undefined;
  model: string | undefined;
}

function createPricingSnapshot(input: {
  provider?: string;
  model?: string;
  chatLimits: AIBillingOrchestratorInput<unknown>['chatLimits'];
  rateCard: AIBillingOrchestratorInput<unknown>['rateCard'];
  walletPolicy: AIBillingOrchestratorInput<unknown>['walletPolicy'];
}): AIBillingPricingSnapshot {
  return {
    chatLimits: Object.freeze({ ...input.chatLimits }),
    rateCard: Object.freeze(input.rateCard.map((entry) => Object.freeze({ ...entry }))),
    walletPolicy: Object.freeze({ ...input.walletPolicy }),
    provider: typeof input.provider === 'string' ? input.provider.trim() : undefined,
    model: typeof input.model === 'string' ? input.model.trim() : undefined,
  };
}

function buildReservationMetadata(
  snapshot: AIBillingPricingSnapshot,
  quote: AIReservationQuoteResult,
): AIBillingReservationMetadata {
  return {
    aiBilling: {
      schemaVersion: 1,
      requestedMode: quote.requestedMode,
      quoteAppliedMode: quote.appliedMode,
      quotedTokens: quote.reservationTokens,
      fixedFallbackTokens: quote.fixedFallbackTokens,
      maxInputTokens: quote.maxInputTokens,
      maxOutputTokens: quote.maxOutputTokens,
      ...(quote.maximumUsageWalletTokens === undefined
        ? {}
        : { maximumUsageWalletTokens: quote.maximumUsageWalletTokens }),
      ...(snapshot.provider === undefined ? {} : { provider: snapshot.provider }),
      ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
      ...(quote.billingCurrency === undefined
        ? {}
        : { billingCurrency: quote.billingCurrency }),
      ...(quote.rateCardVersion === undefined
        ? {}
        : { rateCardVersion: quote.rateCardVersion }),
      ...(quote.walletPolicyVersion === undefined
        ? {}
        : { walletPolicyVersion: quote.walletPolicyVersion }),
    },
  };
}

function assertUsageMatchesSnapshot(
  usage: AIProviderUsage,
  snapshot: AIBillingPricingSnapshot,
  quote: AIReservationQuoteResult,
  reservationId: string,
): void {
  const provider = usage.provider.trim();
  const model = usage.model.trim();

  if (snapshot.provider !== undefined && provider !== snapshot.provider) {
    throw orchestratorError('USAGE_VALIDATION', 'Provider does not match the quoted provider', {
      reservationId,
      recoveryRequired: true,
    });
  }

  if (snapshot.model !== undefined && model !== snapshot.model) {
    throw orchestratorError('USAGE_VALIDATION', 'Model does not match the quoted model', {
      reservationId,
      recoveryRequired: true,
    });
  }

  if (usage.inputTokens > quote.maxInputTokens) {
    throw orchestratorError(
      'USAGE_VALIDATION',
      'Input usage exceeds the quoted maximum input tokens',
      { reservationId, recoveryRequired: true },
    );
  }

  if (usage.outputTokens > quote.maxOutputTokens) {
    throw orchestratorError(
      'USAGE_VALIDATION',
      'Output usage exceeds the quoted maximum output tokens',
      { reservationId, recoveryRequired: true },
    );
  }
}

function orchestratorError(
  stage: AIBillingOrchestratorStage,
  message: string,
  options: AIBillingOrchestratorErrorOptions = {},
): AIBillingOrchestratorError {
  return new AIBillingOrchestratorError(stage, message, options);
}

export async function runAIBillingOrchestration<T>(
  input: AIBillingOrchestratorInput<T>,
  dependencies: AIBillingOrchestratorDependencies = createDefaultAIBillingOrchestratorDependencies(),
): Promise<AIBillingOrchestratorResult<T>> {
  const snapshot = createPricingSnapshot(input);

  let quote: AIReservationQuoteResult;
  try {
    quote = dependencies.calculateQuote({
      feature: input.feature,
      requestedMode: input.requestedMode,
      provider: snapshot.provider,
      model: snapshot.model,
      chatLimits: snapshot.chatLimits,
      rateCard: snapshot.rateCard,
      walletPolicy: snapshot.walletPolicy,
    });
  } catch (err) {
    throw orchestratorError('QUOTE', 'AI billing quote calculation failed');
  }

  const metadata = buildReservationMetadata(snapshot, quote);

  let reservation: ReserveBusinessTokensResult;
  try {
    reservation = await dependencies.reserveForAmount({
      userId: input.userId,
      feature: input.feature,
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      tokens: quote.reservationTokens,
      metadata,
    });
  } catch (err) {
    throw orchestratorError('RESERVATION', 'AI billing reservation failed');
  }

  if (reservation.idempotentReplay) {
    throw orchestratorError(
      'RESERVATION_REPLAY',
      'AI billing reservation replay requires manual recovery',
      { reservationId: reservation.reservationId, recoveryRequired: true },
    );
  }

  let outcome: Awaited<ReturnType<AIBillingOrchestratorInput<T>['execute']>>;
  try {
    outcome = await input.execute();
  } catch (err) {
    throw orchestratorError('EXECUTION', 'AI execution failed before a known outcome', {
      reservationId: reservation.reservationId,
      recoveryRequired: true,
    });
  }

  if (outcome.kind === 'FAILURE') {
    if (outcome.disposition === 'NON_BILLABLE') {
      try {
        await dependencies.releaseReservation({ reservationId: reservation.reservationId });
      } catch (err) {
        throw orchestratorError(
          'RELEASE',
          'AI billing release failed after a non-billable execution',
          { reservationId: reservation.reservationId, recoveryRequired: true },
        );
      }
      throw orchestratorError('EXECUTION', 'AI execution was not billable', {
        reservationId: reservation.reservationId,
        recoveryRequired: false,
        reservationReleased: true,
      });
    }
    throw orchestratorError('EXECUTION', 'AI execution outcome is indeterminate', {
      reservationId: reservation.reservationId,
      recoveryRequired: true,
    });
  }

  const rawUsage = outcome.usage;

  let normalized: AIProviderUsage | undefined;
  try {
    normalized = dependencies.normalizeUsage(rawUsage);
  } catch (err) {
    throw orchestratorError('USAGE_VALIDATION', 'AI billing usage normalization failed', {
      reservationId: reservation.reservationId,
      recoveryRequired: true,
    });
  }

  if (input.requestedMode === 'PROVIDER_USAGE' && normalized !== undefined) {
    assertUsageMatchesSnapshot(normalized, snapshot, quote, reservation.reservationId);
  }

  const usageForPricing = normalized !== undefined ? normalized : rawUsage;

  let pricing: AIUsagePricingResult;
  try {
    pricing = dependencies.calculateActualPrice({
      feature: input.feature,
      requestedMode: input.requestedMode,
      usage: usageForPricing as AIProviderUsage | undefined,
      rateCard: snapshot.rateCard,
      walletPolicy: snapshot.walletPolicy,
    });
  } catch (err) {
    throw orchestratorError('PRICING', 'AI billing actual pricing failed', {
      reservationId: reservation.reservationId,
      recoveryRequired: true,
    });
  }

  const actualTokens = pricing.walletTokens;

  if (
    !Number.isSafeInteger(actualTokens) ||
    actualTokens < 0 ||
    actualTokens > quote.reservationTokens ||
    actualTokens > reservation.tokens
  ) {
    throw orchestratorError('PRICING', 'Actual price exceeds the reserved amount', {
      reservationId: reservation.reservationId,
      recoveryRequired: true,
    });
  }

  let settlement: SettleBusinessTokenReservationResult;
  try {
    settlement = await dependencies.settleForAmount({
      reservationId: reservation.reservationId,
      actualTokens,
    });
  } catch (err) {
    throw orchestratorError('SETTLEMENT', 'AI billing settlement failed', {
      reservationId: reservation.reservationId,
      recoveryRequired: true,
    });
  }

  const billingProvider = pricing.provider ?? quote.provider;
  const billingModel = pricing.model ?? quote.model;
  const billingCurrency = pricing.billingCurrency ?? quote.billingCurrency;
  const rateCardVersion = pricing.rateCardVersion ?? quote.rateCardVersion;
  const walletPolicyVersion = pricing.walletPolicyVersion ?? quote.walletPolicyVersion;

  return {
    data: outcome.data,
    quote: { ...quote },
    billing: {
      reservationId: settlement.reservationId,
      reservedTokens: reservation.tokens,
      actualTokens: settlement.actualTokens,
      releasedTokens: settlement.releasedTokens,
      requestedMode: input.requestedMode,
      appliedMode: pricing.appliedMode,
      ...(pricing.fallbackReason === undefined ? {} : { fallbackReason: pricing.fallbackReason }),
      ...(billingProvider === undefined ? {} : { provider: billingProvider }),
      ...(billingModel === undefined ? {} : { model: billingModel }),
      ...(billingCurrency === undefined ? {} : { billingCurrency }),
      ...(rateCardVersion === undefined ? {} : { rateCardVersion }),
      ...(walletPolicyVersion === undefined ? {} : { walletPolicyVersion }),
      consumeTransactionId: settlement.consumeTransactionId,
    },
  };
}
