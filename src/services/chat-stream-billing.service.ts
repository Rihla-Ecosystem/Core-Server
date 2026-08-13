import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  AIBillingOperationError,
  createAIBillingOperation,
  getAIBillingOperationByOperationId,
  markAIBillingOperationSettled,
  recordAIBillingOperationExecutionSuccess,
  recordAIBillingOperationFailure,
  recordAIBillingOperationPricing,
} from './ai-billing-operation.service.js';
import {
  reserveBusinessTokensForAmount,
  settleBusinessTokenReservationForAmount,
} from './token-reservation.service.js';
import { parseAIExecutionOutcome } from '../utils/ai-execution-contract.js';
import { aggregateProviderCalls } from '../utils/provider-pricing/aggregate.js';
import { computeWalletCharge } from '../utils/wallet-conversion.js';
import { buildSuccessOutcome } from '../utils/usage-billing.js';
import type { AIExecutionOutcome } from '../types/ai-execution.js';
import type { AIUsagePricingResult } from '../types/ai-pricing.js';
import type { ChatLimitsConfig } from '../config/chat-limits.js';
import type { WalletPolicyConfig } from '../config/wallet-policy.js';
import type { UsageBasedAIFeature } from '../config/ai-runtime-routing.js';
import type { BusinessConsumptionSource } from './business-token-consumption.service.js';
import type { ProviderRateCard } from '../types/provider-pricing.js';
import type { AIExecutionBudget } from '../config/ai-execution-budget.js';
import { deriveAffordableAIExecutionBudget } from '../utils/affordable-ai-execution-budget.js';
import { summarizeProviderAttemptExposure } from '../utils/provider-attempt-exposure.js';

/**
 * Phase 2G-A streaming chat usage-based billing lifecycle.
 *
 * Streaming cannot settle synchronously inside a coordinator execute closure,
 * so the reservation + operation are created BEFORE the upstream stream is
 * dispatched, and settlement happens AFTER the stream body is fully consumed.
 * All durable primitives (TokenReservation / AIBillingOperation / recovery)
 * are reused; no parallel durable architecture is introduced.
 *
 * Invariants:
 *  - Reserve before dispatch; never dispatch before a reservation exists.
 *  - Settle exactly once from the final stream usage (never per-chunk).
 *  - A client disconnect or mid-stream error NEVER silently releases an
 *    ambiguous operation: the reservation is left pending and the operation is
 *    recorded as INDETERMINATE for recovery.
 */

export interface ChatStreamBillingContext {
  mode: 'USAGE_BASED' | 'ADMIN_EXEMPT';
  operationId: string;
  reservationId: string;
  reservedTokens: number;
  /** The exact bounded request sent to AI Service after affordability reduction. */
  executionBudget: AIExecutionBudget;
  /** The resolved authoritative rate card used for this streaming operation. */
  rateCard: ProviderRateCard;
  pricingSource?: 'STATIC' | 'DATABASE_SHADOW' | 'DATABASE_PRIMARY';
}

export interface BeginChatStreamUsageBasedBillingInput {
  userId: string;
  feature: UsageBasedAIFeature;
  source: BusinessConsumptionSource;
  idempotencyKey: string;
  operationId: string;
  adminExempt: boolean;
  chatLimits: ChatLimitsConfig;
  executionBudget: AIExecutionBudget;
  estimatedInputTokens: number;
  optionalHistoryInputTokens?: number;
  rateCard: ProviderRateCard;
  walletPolicy: WalletPolicyConfig;
  pricingSource?: 'STATIC' | 'DATABASE_SHADOW' | 'DATABASE_PRIMARY';
}

function buildReservationMetadata(
  input: Omit<BeginChatStreamUsageBasedBillingInput, 'userId' | 'source' | 'idempotencyKey' | 'adminExempt'>,
  reservationTokens: number,
): Prisma.InputJsonValue {
  return {
    aiBilling: {
      schemaVersion: 1,
      requestedMode: 'USAGE_BASED',
      feature: input.feature,
      reservationTokens,
      maxInputTokens: input.chatLimits.maxInputTokens,
      maxOutputTokens: input.chatLimits.maxOutputTokens,
      rateCardVersion: input.rateCard.version,
      walletPolicyVersion: input.walletPolicy.version,
      ...(input.pricingSource === undefined ? {} : { pricingSource: input.pricingSource }),
    },
  };
}

async function findOperationOrNull(operationId: string) {
  try {
    return await getAIBillingOperationByOperationId({ operationId });
  } catch (err) {
    if (err instanceof AIBillingOperationError && err.code === 'OPERATION_NOT_FOUND') {
      return null;
    }
    throw err;
  }
}

/**
 * Reserve a streaming operation and create its durable AIBillingOperation.
 * Throws the same AppError contracts as the non-streaming coordinator:
 * 409 replay, 402 insufficient balance, 403 wallet not active.
 */
export async function beginChatStreamUsageBasedBilling(
  input: BeginChatStreamUsageBasedBillingInput,
): Promise<ChatStreamBillingContext> {
  if (input.adminExempt) {
    return {
      mode: 'ADMIN_EXEMPT',
      operationId: '',
      reservationId: '',
      reservedTokens: 0,
      executionBudget: input.executionBudget,
      rateCard: input.rateCard,
      pricingSource: input.pricingSource,
    };
  }

  const existing = await findOperationOrNull(input.operationId);
  if (existing) {
    throw new AppError(409, 'Chat request already processed');
  }

  if (input.pricingSource !== 'DATABASE_PRIMARY') {
    throw new AppError(503, 'Active database rate card is required for AI billing');
  }
  let reservationTokens: number;
  let executionBudget: AIExecutionBudget;
  try {
    const wallet = await prisma.tokenWallet.findUnique({
      where: { userId: input.userId },
      select: { tokenBalance: true },
    });
    if (!wallet) throw new AppError(402, 'Insufficient token balance');
    const affordable = deriveAffordableAIExecutionBudget({
      feature: input.feature,
      budget: input.executionBudget,
      estimatedInputTokens: input.estimatedInputTokens,
      optionalHistoryInputTokens: input.optionalHistoryInputTokens,
      rateCard: input.rateCard,
      walletPolicy: input.walletPolicy,
      availableBalance: wallet.tokenBalance,
    });
    if (!affordable) throw new AppError(402, 'Insufficient token balance');
    reservationTokens = affordable.reservationTokens;
    executionBudget = affordable.budget;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(503, 'Active database rate card cannot price this AI request');
  }

  let reservation;
  try {
    reservation = await reserveBusinessTokensForAmount({
      userId: input.userId,
      feature: input.feature,
      source: input.source,
      idempotencyKey: input.idempotencyKey,
      tokens: reservationTokens,
      metadata: buildReservationMetadata(input, reservationTokens),
    });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.statusCode === 402) {
        throw new AppError(402, 'Insufficient token balance');
      }
      if (err.statusCode === 403) {
        throw new AppError(403, 'Token wallet is not active');
      }
    }
    throw err;
  }

  const reservationId = reservation.reservationId;

  let createResult;
  try {
    createResult = await createAIBillingOperation({
      operationId: input.operationId,
      reservationId,
    });
  } catch (err) {
    if (err instanceof AIBillingOperationError && err.code === 'IDEMPOTENCY_CONFLICT') {
      throw new AppError(409, 'Chat request already processed');
    }
    throw err;
  }

  if (createResult.idempotentReplay) {
    throw new AppError(409, 'Chat request already processed');
  }

  return {
    mode: 'USAGE_BASED',
    operationId: input.operationId,
    reservationId,
    reservedTokens: reservationTokens,
    executionBudget,
    rateCard: input.rateCard,
    pricingSource: input.pricingSource,
  };
}

export interface SettleChatStreamUsageBasedBillingInput {
  operationId: string;
  reservationId: string;
  userId: string;
  feature: UsageBasedAIFeature;
  reservedTokens: number;
  executionBudget: AIExecutionBudget;
  usage?: unknown;
  providerCalls?: unknown;
  providerAttempts?: unknown;
  chatLimits: ChatLimitsConfig;
  rateCard: ProviderRateCard;
  walletPolicy: WalletPolicyConfig;
  pricingSource?: 'STATIC' | 'DATABASE_SHADOW' | 'DATABASE_PRIMARY';
}

export type ChatStreamSettleOutcome = 'SETTLED' | 'RECOVERY_REQUIRED' | 'SKIPPED';

async function recordStreamExposure(input: {
  reservationId: string;
  pricedCallCount?: number;
  unpricedCallCount?: number;
  pricedCostNanoUsd?: string;
  markedUpNanoUsd?: string;
  walletTokens?: string;
  providerAttemptExposure?: unknown;
}): Promise<void> {
  const reservation = await prisma.tokenReservation.findUnique({
    where: { id: input.reservationId }, select: { metadata: true },
  });
  const existing = reservation?.metadata !== null && typeof reservation?.metadata === 'object' && !Array.isArray(reservation.metadata)
    ? reservation.metadata : {};
  await prisma.tokenReservation.update({
    where: { id: input.reservationId },
    data: {
      metadata: {
        ...existing,
        ...(input.pricedCallCount === undefined ? {} : { unresolvedCostExposure: {
          pricedCallCount: input.pricedCallCount, unpricedCallCount: input.unpricedCallCount,
          pricedCostNanoUsd: input.pricedCostNanoUsd, markedUpNanoUsd: input.markedUpNanoUsd, walletTokens: input.walletTokens,
        } }),
        ...(input.providerAttemptExposure === undefined ? {} : { providerAttemptExposure: input.providerAttemptExposure }),
      },
    },
  });
}

function toPricingEvidence(
  input: SettleChatStreamUsageBasedBillingInput,
  walletTokens: number,
  execution: { provider: string; model: string },
): AIUsagePricingResult {
  return {
    feature: input.feature,
    requestedMode: 'PROVIDER_USAGE',
    appliedMode: 'PROVIDER_USAGE',
    walletTokens,
    fixedFallbackTokens: 0,
    provider: execution.provider,
    model: execution.model,
    rateCardVersion: input.rateCard.version,
    walletPolicyVersion: input.walletPolicy.version,
    ...(input.pricingSource === undefined ? {} : { pricingSource: input.pricingSource }),
  };
}

/**
 * Settle a completed stream from its final usage + providerCalls evidence.
 * Returns SETTLED on success, RECOVERY_REQUIRED when the stream cannot be
 * priced safely, and SKIPPED when the operation was already settled or is no
 * longer reservable. Never auto-releases and never treats unknown cost as zero.
 */
export async function settleChatStreamUsageBasedBilling(
  input: SettleChatStreamUsageBasedBillingInput,
): Promise<ChatStreamSettleOutcome> {
  const existing = await findOperationOrNull(input.operationId);
  if (existing && existing.status === 'SETTLED') {
    return 'SKIPPED';
  }

  const raw: unknown = buildSuccessOutcome(
    {
      providerCalls: input.providerCalls,
      providerAttempts: input.providerAttempts,
    },
    input.usage,
  );

  let outcome: AIExecutionOutcome<unknown>;
  try {
    outcome = parseAIExecutionOutcome<unknown>(raw);
  } catch {
    return recoveryRequired(input, 'EXECUTION_OUTCOME_INVALID');
  }

  if (outcome.kind !== 'SUCCESS') {
    return recoveryRequired(
      input,
      outcome.kind === 'INDETERMINATE_FAILURE' ? 'INDETERMINATE_EXECUTION' : 'NON_BILLABLE_FAILURE',
    );
  }

  try {
    await recordAIBillingOperationExecutionSuccess({
      operationId: input.operationId,
      execution: outcome.execution,
      usage: outcome.usage,
    });
  } catch {
    return recoveryRequired(input, 'EXECUTION_EVIDENCE_FAILED');
  }

  const attemptExposure = summarizeProviderAttemptExposure(input.providerAttempts);
  if (attemptExposure !== undefined) {
    try {
      await recordStreamExposure({ reservationId: input.reservationId, providerAttemptExposure: attemptExposure });
      console.info('[chat-stream-billing] provider_attempt_exposure', {
        operationId: input.operationId, feature: input.feature, fundingPolicy: 'USER_FUNDED', ...attemptExposure,
      });
    } catch {
      return recoveryRequired(input, 'EXECUTION_EVIDENCE_FAILED');
    }
  }

  if (
    outcome.usage.inputTokens > input.chatLimits.maxInputTokens ||
    outcome.usage.outputTokens > input.executionBudget.maxOutputTokens
  ) {
    return recoveryRequired(input, 'USAGE_LIMITS_EXCEEDED');
  }

  const providerCalls = (outcome.data as { providerCalls?: unknown }).providerCalls;
  if (providerCalls === undefined || providerCalls === null || !Array.isArray(providerCalls)) {
    return recoveryRequired(input, 'UNPRICED_PROVIDER_CALLS');
  }

  if (providerCalls.length === 0) {
    return settleStreamZero(input, outcome);
  }

  let pricing;
  try {
    pricing = aggregateProviderCalls({ providerCalls, card: input.rateCard });
  } catch {
    return recoveryRequired(input, 'PRICING_FAILED');
  }

  if (pricing.summaryStatus === 'UNPRICED') {
    return recoveryRequired(input, 'UNPRICED_PROVIDER_CALLS');
  }

  let charge;
  try {
    charge = computeWalletCharge(pricing, {
      walletTokenValueNanoUsd: input.walletPolicy.walletTokenValueNanoUsd,
      markupBasisPoints: input.walletPolicy.markupBasisPoints,
      minimumWalletTokens: input.walletPolicy.minimumWalletTokens,
    });
  } catch {
    return recoveryRequired(input, 'PRICING_FAILED');
  }

  const actualWalletTokens = Number(charge.tokens);
  if (
    !Number.isSafeInteger(actualWalletTokens) ||
    actualWalletTokens < 0 ||
    actualWalletTokens > input.reservedTokens
  ) {
    return recoveryRequired(input, 'PRICING_LIMITS_EXCEEDED');
  }

  try {
    await recordAIBillingOperationPricing({
      operationId: input.operationId,
      pricing: toPricingEvidence(input, actualWalletTokens, {
        provider: outcome.execution.provider,
        model: outcome.execution.model,
      }),
    });
  } catch {
    return recoveryRequired(input, 'PRICING_EVIDENCE_FAILED');
  }

  let settlement;
  try {
    settlement = await settleBusinessTokenReservationForAmount({
      reservationId: input.reservationId,
      actualTokens: actualWalletTokens,
    });
  } catch {
    return recoveryRequired(input, 'SETTLEMENT_FAILED');
  }

  try {
    await markAIBillingOperationSettled({
      operationId: input.operationId,
      settlement,
    });
  } catch {
    return recoveryRequired(input, 'SETTLED_EVIDENCE_FAILED');
  }

  if (pricing.summaryStatus === 'PARTIALLY_PRICED') {
    try {
      await recordStreamExposure({
        reservationId: input.reservationId,
        pricedCallCount: pricing.totals.pricedCallCount,
        unpricedCallCount: pricing.totals.unpricedCallCount,
        pricedCostNanoUsd: pricing.totals.pricedCostNanoUsd.toString(),
        markedUpNanoUsd: charge.markedUpNanoUsd.toString(),
        walletTokens: charge.tokens.toString(),
      });
    } catch {
      // Exposure recording must never fail the already-settled operation.
    }
  }

  return 'SETTLED';
}

async function settleStreamZero(
  input: SettleChatStreamUsageBasedBillingInput,
  outcome: Extract<AIExecutionOutcome<unknown>, { kind: 'SUCCESS' }>,
): Promise<ChatStreamSettleOutcome> {
  try {
    await recordAIBillingOperationPricing({
      operationId: input.operationId,
      pricing: toPricingEvidence(input, 0, {
        provider: outcome.execution.provider,
        model: outcome.execution.model,
      }),
    });
    const settlement = await settleBusinessTokenReservationForAmount({
      reservationId: input.reservationId,
      actualTokens: 0,
    });
    await markAIBillingOperationSettled({ operationId: input.operationId, settlement });
    return 'SETTLED';
  } catch {
    return recoveryRequired(input, 'SETTLEMENT_FAILED');
  }
}

/**
 * Fail a stream that ended without a trustworthy completed body. Records an
 * INDETERMINATE failure when the operation is still in RESERVED; otherwise the
 * operation is left pending for recovery. Never auto-releases.
 */
export async function failChatStreamUsageBasedBilling(input: {
  operationId: string;
  reservationId: string;
}): Promise<void> {
  try {
    const existing = await findOperationOrNull(input.operationId);
    if (!existing) return;
    if (existing.status === 'SETTLED' || existing.status === 'RELEASED') return;
    await recordAIBillingOperationFailure({
      operationId: input.operationId,
      failure: {
        kind: 'INDETERMINATE_FAILURE',
        code: 'STREAM_INTERRUPTED',
        message: 'Chat stream ended without a trusted completed body',
        providerRequestSent: true,
        retryable: false,
      },
    });
  } catch (err) {
    if (err instanceof AIBillingOperationError && err.code === 'INVALID_TRANSITION') {
      console.error('[usage-billing] stream_interrupted_recovery_required', {
        operationId: input.operationId,
        reservationId: input.reservationId,
      });
      return;
    }
    console.error('[usage-billing] stream_failure_evidence_failed', {
      operationId: input.operationId,
      reservationId: input.reservationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function recoveryRequired(
  input: SettleChatStreamUsageBasedBillingInput,
  reasonCode: string,
): ChatStreamSettleOutcome {
  console.error('[usage-billing] stream_settle_recovery_required', {
    operationId: input.operationId,
    reservationId: input.reservationId,
    userId: input.userId,
    reasonCode,
  });
  return 'RECOVERY_REQUIRED';
}
