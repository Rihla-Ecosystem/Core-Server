import type { Prisma } from '@prisma/client';
import type { AIBillingOperationStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  AIBillingOperationError,
  createAIBillingOperation,
  getAIBillingOperationByOperationId as getDurableOperationByOperationId,
  markAIBillingOperationReleased,
  markAIBillingOperationSettled,
  recordAIBillingOperationExecutionSuccess,
  recordAIBillingOperationFailure,
  recordAIBillingOperationPricing,
} from './ai-billing-operation.service.js';
import {
  releaseBusinessTokenReservation,
  reserveBusinessTokensForAmount,
  settleBusinessTokenReservationForAmount,
} from './token-reservation.service.js';
import { parseAIExecutionOutcome } from '../utils/ai-execution-contract.js';
import { aggregateProviderCalls } from '../utils/provider-pricing/aggregate.js';
import { computeWalletCharge } from '../utils/wallet-conversion.js';
import { calculateDynamicAIReservationQuote } from '../utils/dynamic-ai-reservation-quote.js';
import { deriveAffordableAIExecutionBudget } from '../utils/affordable-ai-execution-budget.js';
import { summarizeProviderAttemptExposure } from '../utils/provider-attempt-exposure.js';
import { normalizeProviderAttempts } from '../utils/ai-usage.js';
import type { AIExecutionOutcome } from '../types/ai-execution.js';
import type { AIUsagePricingResult } from '../types/ai-pricing.js';
import type {
  CreateAIBillingOperationResult,
  MarkAIBillingOperationReleasedResult,
  MarkAIBillingOperationSettledResult,
  RecordAIBillingOperationExecutionSuccessResult,
  RecordAIBillingOperationFailureResult,
  RecordAIBillingOperationPricingResult,
} from '../types/ai-billing-operation.js';
import type {
  ReserveBusinessTokensResult,
  SettleBusinessTokenReservationResult,
} from './token-reservation.service.js';
import type {
  UsageBasedBillingDependencies,
  UsageBasedBillingExposure,
  UsageBasedBillingExecutionContext,
  UsageBasedBillingInput,
  UsageBasedBillingReasonCode,
  UsageBasedBillingResult,
  UsageBasedBillingSettledBilling,
  UsageBasedBillingStage,
} from '../types/usage-based-ai-billing.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultProviderCallsOf(data: unknown): unknown {
  if (!isRecord(data)) return undefined;
  return data.providerCalls;
}

function defaultProviderAttemptsOf(data: unknown): unknown {
  if (!isRecord(data)) return undefined;
  return data.providerAttempts;
}

function isExplicitCacheHit(data: unknown, providerCalls: unknown): boolean {
  return (
    isRecord(data) &&
    data.cached === true &&
    Array.isArray(providerCalls) &&
    providerCalls.length === 0
  );
}

function trimOperationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function recovery<T>(
  operationId: string,
  stage: UsageBasedBillingStage,
  reasonCode: UsageBasedBillingReasonCode,
  options: {
    reservationId?: string;
    operationStatus?: AIBillingOperationStatus;
  } = {},
): UsageBasedBillingResult<T> {
  return {
    outcome: 'RECOVERY_REQUIRED',
    operationId,
    ...(options.reservationId === undefined ? {} : { reservationId: options.reservationId }),
    ...(options.operationStatus === undefined
      ? {}
      : { operationStatus: options.operationStatus }),
    stage,
    reasonCode,
    recoveryRequired: true,
  };
}

function reservationDenied<T>(
  reason: Extract<UsageBasedBillingResult<T>, { outcome: 'RESERVATION_DENIED' }>['reason'],
  httpStatus: number,
): UsageBasedBillingResult<T> {
  return {
    outcome: 'RESERVATION_DENIED',
    reason,
    httpStatus,
    recoveryRequired: false,
  };
}

function released<T>(
  operationId: string,
  reservationId: string,
  failureCode: string,
  adminExempt: boolean,
): UsageBasedBillingResult<T> {
  return {
    outcome: 'RELEASED',
    operationId,
    reservationId,
    failureCode,
    adminExempt,
    recoveryRequired: false,
  };
}

function toSettledBilling(
  settlement: SettleBusinessTokenReservationResult,
  walletPolicyVersion: string,
  rateCardVersion: string,
  billing: {
    pricedCostNanoUsd?: bigint;
    markedUpNanoUsd?: bigint;
    provider?: string;
    model?: string;
  },
): UsageBasedBillingSettledBilling {
  return {
    reservationId: settlement.reservationId,
    reservedTokens: settlement.tokens,
    actualTokens: settlement.actualTokens,
    releasedTokens: settlement.releasedTokens,
    consumedTokens: settlement.actualTokens,
    requestedMode: 'USAGE_BASED',
    ...(billing.provider === undefined ? {} : { provider: billing.provider }),
    ...(billing.model === undefined ? {} : { model: billing.model }),
    rateCardVersion,
    walletPolicyVersion,
    ...(billing.pricedCostNanoUsd === undefined
      ? {}
      : { pricedCostNanoUsd: billing.pricedCostNanoUsd.toString() }),
    ...(billing.markedUpNanoUsd === undefined
      ? {}
      : { markedUpNanoUsd: billing.markedUpNanoUsd.toString() }),
    consumeTransactionId: settlement.consumeTransactionId,
  };
}

function toPricingEvidence<T>(
  input: UsageBasedBillingInput<T>,
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

function buildReservationMetadata<T>(
  input: UsageBasedBillingInput<T>,
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
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.model === undefined ? {} : { model: input.model }),
      rateCardVersion: input.rateCard.version,
      walletPolicyVersion: input.walletPolicy.version,
      ...(input.pricingSource === undefined ? {} : { pricingSource: input.pricingSource }),
    },
  };
}

const SAFE_USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cachedInputTokens',
  'cachedOutputTokens',
  'reasoningTokens',
  'imageInputTokens',
  'imageOutputTokens',
  'audioInputTokens',
  'audioOutputTokens',
  'audioSeconds',
  'audioInputSeconds',
  'audioOutputSeconds',
  'transcriptionSeconds',
  'inputCharacters',
  'outputCharacters',
  'generatedImageCount',
] as const;

/**
 * Whitelist safe billing-only fields from ShadowPricedCall[] for durable
 * evidence, preserving raw token/modality usage for UNPRICED calls from the
 * original providerCall payload when present.
 *
 * Never serializes prompts, responses, media, or secrets.
 * Converts bigint costNanoUsd to string for JSON storage.
 */
function serializePricingCallEvidence(
  calls: Array<Record<string, unknown>>,
  rawProviderCalls?: unknown,
): Prisma.InputJsonValue[] {
  const rawArray = Array.isArray(rawProviderCalls) ? rawProviderCalls : [];
  const realCalls = rawArray.filter(
    (c) => c !== null && typeof c === 'object' && (c as Record<string, unknown>).providerCallMade !== false,
  ) as Array<Record<string, unknown>>;

  const callMap = new Map<string, Record<string, unknown>>();
  for (const rawCall of realCalls) {
    if (typeof rawCall.providerCallId === 'string' && rawCall.providerCallId.trim().length > 0) {
      callMap.set(rawCall.providerCallId, rawCall);
    }
  }

  return calls.map((call, index) => {
    const callId = typeof call.providerCallId === 'string' ? call.providerCallId : undefined;
    const rawMatch = (callId ? callMap.get(callId) : undefined) ?? realCalls[index];

    const base: Record<string, Prisma.InputJsonValue> = {
      kind: String(call.kind ?? 'UNPRICED'),
      ...(call.providerCallId !== undefined ? { providerCallId: String(call.providerCallId) } : {}),
      ...(call.provider !== undefined ? { provider: String(call.provider) } : {}),
      ...(call.operation !== undefined ? { operation: String(call.operation) } : {}),
      ...(call.requestedModel !== undefined ? { requestedModel: String(call.requestedModel) } : {}),
      ...(call.actualModel !== undefined ? { actualModel: String(call.actualModel) } : {}),
      ...(call.pricedAt !== undefined ? { pricedAt: String(call.pricedAt) } : {}),
    };

    if (call.kind === 'PRICED') {
      base.reason = String(call.reason);
      base.costNanoUsd = String(call.costNanoUsd);
      if (call.rateCard !== undefined) base.rateCard = call.rateCard as unknown as Prisma.InputJsonObject;
      if (call.usageApplied !== undefined) base.usageApplied = call.usageApplied as unknown as Prisma.InputJsonObject;
    } else {
      base.reason = String(call.reason);
      if (rawMatch) {
        for (const field of SAFE_USAGE_FIELDS) {
          const val = rawMatch[field];
          if (typeof val === 'number' && Number.isFinite(val)) {
            base[field] = val;
          }
        }
      }
    }
    return base as Prisma.InputJsonObject;
  });
}

function mapReservationDenied<T>(err: unknown): UsageBasedBillingResult<T> | null {
  if (err instanceof AppError) {
    if (err.statusCode === 402) {
      return reservationDenied<T>('INSUFFICIENT_BALANCE', 402);
    }
    if (err.statusCode === 403) {
      return reservationDenied<T>('WALLET_NOT_ACTIVE', 403);
    }
    if (err.statusCode === 400) {
      const message = err.message.toLowerCase();
      if (message.includes('feature')) return reservationDenied<T>('INVALID_FEATURE', 400);
      if (message.includes('source')) return reservationDenied<T>('INVALID_SOURCE', 400);
      if (message.includes('idempotency')) return reservationDenied<T>('INVALID_IDEMPOTENCY', 400);
      return reservationDenied<T>('UNKNOWN', 400);
    }
    return reservationDenied<T>('UNKNOWN', err.statusCode);
  }
  return null;
}

async function resolveOperationByOperationId(input: {
  operationId: string;
}): Promise<Awaited<ReturnType<typeof getDurableOperationByOperationId>> | null> {
  try {
    return await getDurableOperationByOperationId(input);
  } catch (err) {
    if (err instanceof AIBillingOperationError && err.code === 'OPERATION_NOT_FOUND') {
      return null;
    }
    throw err;
  }
}

interface ProviderExecutionMetadata {
  schemaVersion: 1;
  executionSource: 'PROVIDER' | 'CACHE' | 'NONE';
  providerCalls: Prisma.InputJsonValue[];
  providerAttempts: Prisma.InputJsonValue[];
}

async function updateReservationMetadata(input: {
  reservationId: string;
  providerExecution?: ProviderExecutionMetadata;
  unresolvedCostExposure?: Record<string, Prisma.InputJsonValue>;
  providerAttemptExposure?: unknown;
}): Promise<void> {
  const reservation = await prisma.tokenReservation.findUnique({
    where: { id: input.reservationId },
    select: { metadata: true },
  });
  const existing = isRecord(reservation?.metadata) ? (reservation!.metadata as Record<string, unknown>) : {};

  const updatedMetadata: Record<string, unknown> = {
    ...existing,
  };

  if (input.providerExecution !== undefined) {
    updatedMetadata.providerExecution = input.providerExecution as unknown as Prisma.InputJsonObject;
  }
  if (input.unresolvedCostExposure !== undefined) {
    updatedMetadata.unresolvedCostExposure = input.unresolvedCostExposure as unknown as Prisma.InputJsonObject;
  }
  if (input.providerAttemptExposure !== undefined) {
    updatedMetadata.providerAttemptExposure = input.providerAttemptExposure;
  }

  await prisma.tokenReservation.update({
    where: { id: input.reservationId },
    data: {
      metadata: updatedMetadata as Prisma.InputJsonValue,
    },
  });
}

async function recordReservationExposure(
  exposure: UsageBasedBillingExposure,
): Promise<void> {
  const exposureMeta: Record<string, Prisma.InputJsonValue> = {};
  if (exposure.pricedCallCount !== undefined) exposureMeta.pricedCallCount = exposure.pricedCallCount;
  if (exposure.unpricedCallCount !== undefined) exposureMeta.unpricedCallCount = exposure.unpricedCallCount;
  if (exposure.pricedCostNanoUsd !== undefined) exposureMeta.pricedCostNanoUsd = exposure.pricedCostNanoUsd;
  if (exposure.markedUpNanoUsd !== undefined) exposureMeta.markedUpNanoUsd = exposure.markedUpNanoUsd;
  if (exposure.walletTokens !== undefined) exposureMeta.walletTokens = exposure.walletTokens;

  await updateReservationMetadata({
    reservationId: exposure.reservationId,
    ...(exposure.pricedCallCount === undefined ? {} : { unresolvedCostExposure: exposureMeta }),
    ...(exposure.providerAttemptExposure === undefined ? {} : { providerAttemptExposure: exposure.providerAttemptExposure }),
  });
}

export function createDefaultUsageBasedBillingDependencies(): UsageBasedBillingDependencies {
  return {
    reserveForAmount: reserveBusinessTokensForAmount,
    getAIBillingOperationByOperationId: resolveOperationByOperationId,
    createAIBillingOperation,
    recordAIBillingOperationExecutionSuccess,
    recordAIBillingOperationPricing,
    recordAIBillingOperationFailure,
    markAIBillingOperationSettled,
    markAIBillingOperationReleased,
    parseAIExecutionOutcome,
    aggregateProviderCalls,
    computeWalletCharge,
    settleForAmount: settleBusinessTokenReservationForAmount,
    releaseReservation: releaseBusinessTokenReservation,
    recordUnresolvedExposure: recordReservationExposure,
  };
}

function verifyCreateSnapshot(input: {
  reservation: ReserveBusinessTokensResult;
  createResult: CreateAIBillingOperationResult;
}): boolean {
  const { reservation, createResult } = input;
  if (reservation.reservationId !== createResult.reservationId) return false;
  if (reservation.tokens !== createResult.reservedTokens) return false;
  if (createResult.status !== 'RESERVED') return false;
  if (createResult.idempotentReplay !== false) return false;
  return true;
}

export async function runUsageBasedAIBilling<T>(
  input: UsageBasedBillingInput<T>,
  dependencies: UsageBasedBillingDependencies = createDefaultUsageBasedBillingDependencies(),
): Promise<UsageBasedBillingResult<T>> {
  const operationId = trimOperationId(input.operationId);
  if (operationId === undefined) {
    return recovery<T>('', 'PREFLIGHT', 'INVALID_OPERATION_ID');
  }

  const userId = input.userId.trim();
  if (!userId) {
    return recovery<T>(operationId, 'PREFLIGHT', 'INVALID_USER_ID');
  }

  const requestedIdentity = (() => {
    const hasProvider = input.provider !== undefined;
    const hasModel = input.model !== undefined;
    if (hasProvider !== hasModel) {
      return { ok: false as const };
    }
    if (hasProvider && hasModel) {
      const provider = input.provider as string;
      const model = input.model as string;
      if (provider.trim().length === 0 || model.trim().length === 0) {
        return { ok: false as const };
      }
      return { ok: true as const, provider: provider.trim(), model: model.trim() };
    }
    return { ok: true as const };
  })();
  if (!requestedIdentity.ok) {
    return recovery<T>(operationId, 'PREFLIGHT', 'INVALID_REQUESTED_IDENTITY');
  }

  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) {
    return recovery<T>(operationId, 'PREFLIGHT', 'INVALID_IDEMPOTENCY_KEY');
  }

  const providerCallsOf = input.providerCallsOf ?? defaultProviderCallsOf;
  const providerAttemptsOf = input.providerAttemptsOf ?? defaultProviderAttemptsOf;
  const executeContext: UsageBasedBillingExecutionContext = {
    operationId,
    reservationId: '',
    executionBudget: input.executionBudget,
  };

  // Admin-exempt users execute normally but never reserve or consume tokens.
  if (input.adminExempt) {
    return runAdminExemptFlow<T>(input, dependencies, operationId, providerCallsOf);
  }

  let existing;
  try {
    existing = await dependencies.getAIBillingOperationByOperationId({ operationId });
  } catch {
    return recovery<T>(operationId, 'PREFLIGHT', 'OPERATION_LOOKUP_FAILED');
  }
  if (existing) {
    return recovery<T>(operationId, 'PREFLIGHT', 'OPERATION_REPLAY_REQUIRES_RECOVERY', {
      reservationId: existing.reservationId,
      operationStatus: existing.status,
    });
  }

  let reservationTokens: number;
  try {
    if (input.pricingSource !== 'DATABASE_PRIMARY') {
      return recovery<T>(operationId, 'QUOTE', 'QUOTE_FAILED');
    }
    const wallet = await prisma.tokenWallet.findUnique({ where: { userId }, select: { tokenBalance: true } });
    if (!wallet) return reservationDenied<T>('WALLET_NOT_FOUND', 402);
    const affordable = deriveAffordableAIExecutionBudget({
      feature: input.feature,
      budget: input.executionBudget,
      estimatedInputTokens: input.estimatedInputTokens,
      optionalHistoryInputTokens: input.optionalHistoryInputTokens,
      rateCard: input.rateCard,
      walletPolicy: input.walletPolicy,
      availableBalance: wallet.tokenBalance,
    });
    if (!affordable) return reservationDenied<T>('INSUFFICIENT_BALANCE', 402);
    reservationTokens = affordable.reservationTokens;
    executeContext.executionBudget = affordable.budget;
  } catch {
    return recovery<T>(operationId, 'QUOTE', 'QUOTE_FAILED');
  }

  let reservation: ReserveBusinessTokensResult;
  try {
    reservation = await dependencies.reserveForAmount({
      userId,
      feature: input.feature,
      source: input.source,
      idempotencyKey,
      tokens: reservationTokens,
      metadata: buildReservationMetadata(input, reservationTokens),
    });
  } catch (err) {
    const denied = mapReservationDenied<T>(err);
    if (denied) return denied;
    return recovery<T>(operationId, 'RESERVATION', 'RESERVATION_FAILED');
  }

  const reservationId = reservation.reservationId;
  executeContext.reservationId = reservationId;

  let createResult: CreateAIBillingOperationResult;
  try {
    createResult = await dependencies.createAIBillingOperation({
      operationId,
      reservationId,
      ...(requestedIdentity.ok && requestedIdentity.provider !== undefined
        ? {
            requestedProvider: requestedIdentity.provider,
            requestedModel: requestedIdentity.model,
          }
        : {}),
    });
  } catch (err) {
    return recovery<T>(operationId, 'OPERATION_CREATION', 'OPERATION_CREATE_FAILED', {
      reservationId,
    });
  }

  if (createResult.idempotentReplay) {
    return recovery<T>(operationId, 'OPERATION_CREATION', 'OPERATION_CREATE_REPLAY', {
      reservationId,
      operationStatus: createResult.status,
    });
  }

  if (!verifyCreateSnapshot({ reservation, createResult })) {
    return recovery<T>(operationId, 'OPERATION_CREATION', 'OPERATION_SNAPSHOT_MISMATCH', {
      reservationId,
    });
  }

  let raw: unknown;
  try {
    raw = await input.execute(executeContext);
  } catch (err) {
    return await persistIndeterminate<T>(
      dependencies,
      operationId,
      reservationId,
      'EXECUTOR_THROWN_DISPATCH_UNKNOWN',
      'AI execution dispatch outcome is unknown',
      'EXECUTOR_THROWN_DISPATCH_UNKNOWN',
    );
  }

  let outcome: AIExecutionOutcome<T>;
  try {
    outcome = dependencies.parseAIExecutionOutcome<T>(raw);
  } catch {
    return await persistIndeterminate<T>(
      dependencies,
      operationId,
      reservationId,
      'EXECUTION_OUTCOME_INVALID',
      'AI execution outcome is invalid',
      'EXECUTION_OUTCOME_INVALID',
    );
  }

  if (outcome.kind === 'NON_BILLABLE_FAILURE') {
    return runNonBillableFlow<T>(
      dependencies,
      operationId,
      reservationId,
      outcome,
    );
  }

  if (outcome.kind === 'INDETERMINATE_FAILURE') {
    return await persistIndeterminate<T>(
      dependencies,
      operationId,
      reservationId,
      outcome.code,
      outcome.message,
      'INDETERMINATE_EXECUTION',
      outcome.retryable,
      outcome.execution,
      raw,
    );
  }

  let executionEvidence: RecordAIBillingOperationExecutionSuccessResult;
  try {
    executionEvidence = await dependencies.recordAIBillingOperationExecutionSuccess({
      operationId,
      execution: outcome.execution,
      usage: outcome.usage,
    });
  } catch {
    return recovery<T>(operationId, 'EXECUTION_EVIDENCE', 'EXECUTION_EVIDENCE_FAILED', {
      reservationId,
    });
  }

  const attemptExposure = summarizeProviderAttemptExposure(providerAttemptsOf(outcome.data));
  if (attemptExposure !== undefined) {
    try {
      await dependencies.recordUnresolvedExposure({ reservationId, providerAttemptExposure: attemptExposure });
      console.info('[usage-billing] provider_attempt_exposure', {
        operationId, feature: input.feature, fundingPolicy: 'USER_FUNDED', ...attemptExposure,
      });
    } catch {
      return recovery<T>(operationId, 'EXECUTION_EVIDENCE', 'EXECUTION_EVIDENCE_FAILED', {
        reservationId, operationStatus: 'EXECUTION_SUCCEEDED',
      });
    }
  }

  if (
    outcome.usage.inputTokens > input.chatLimits.maxInputTokens ||
    outcome.usage.outputTokens > executeContext.executionBudget.maxOutputTokens
  ) {
    return recovery<T>(operationId, 'USAGE_VALIDATION', 'USAGE_LIMITS_EXCEEDED', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  const providerCalls = providerCallsOf(outcome.data);

  // Absent or non-array providerCalls are NOT authoritative: unknown cost must
  // never be treated as zero. An empty array is zero cost only when paired with
  // the AI service's explicit cache marker.
  if (providerCalls === undefined || providerCalls === null || !Array.isArray(providerCalls)) {
    return recovery<T>(operationId, 'PRICING', 'UNPRICED_PROVIDER_CALLS', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  if (isExplicitCacheHit(outcome.data, providerCalls)) {
    return runCacheHitSettlement<T>(
      dependencies,
      input,
      operationId,
      reservationId,
      outcome,
    );
  }

  if (providerCalls.length === 0) {
    return recovery<T>(operationId, 'PRICING', 'UNPRICED_PROVIDER_CALLS', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  let pricing;
  try {
    pricing = dependencies.aggregateProviderCalls({
      providerCalls,
      card: input.rateCard,
    });
  } catch {
    return recovery<T>(operationId, 'PRICING', 'PRICING_FAILED', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  const walletConversionConfig = {
    walletTokenValueNanoUsd: input.walletPolicy.walletTokenValueNanoUsd,
    markupBasisPoints: input.walletPolicy.markupBasisPoints,
    minimumWalletTokens: input.walletPolicy.minimumWalletTokens,
  };

  let charge;
  try {
    charge = dependencies.computeWalletCharge(pricing, walletConversionConfig);
  } catch {
    return recovery<T>(operationId, 'PRICING', 'PRICING_FAILED', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  const rawAttempts = providerAttemptsOf(outcome.data);
  const normalizedAttempts = normalizeProviderAttempts(rawAttempts) ?? [];
  const callsEvidence = serializePricingCallEvidence(pricing.calls as unknown as Array<Record<string, unknown>>, providerCalls);

  if (pricing.summaryStatus === 'UNPRICED') {
    try {
      await updateReservationMetadata({
        reservationId,
        providerExecution: {
          schemaVersion: 1,
          executionSource: 'PROVIDER',
          providerCalls: callsEvidence,
          providerAttempts: normalizedAttempts as unknown as Prisma.InputJsonValue[],
        },
        unresolvedCostExposure: {
          pricedCallCount: 0,
          unpricedCallCount: pricing.totals.unpricedCallCount,
          pricedCostNanoUsd: '0',
          markedUpNanoUsd: '0',
          walletTokens: '0',
          rateCardVersion: input.rateCard.version,
          providerCallEvidence: callsEvidence,
        },
      });
    } catch (evidenceErr) {
      console.error('[usage-billing] unpriced_evidence_failed', {
        operationId, reservationId,
        error: evidenceErr instanceof Error ? evidenceErr.message : String(evidenceErr),
      });
    }
    // SUCCESS + UNPRICED: never auto-deduct, never treat as free. Recovery.
    return recovery<T>(operationId, 'PRICING', 'UNPRICED_PROVIDER_CALLS', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  // Phase 4B: PARTIALLY_PRICED fail-closed. Unknown provider cost must never
  // be treated as zero. Persist durable per-call billing evidence, then route
  // to recovery. Reservation remains PENDING; no wallet deduction or release.
  if (pricing.summaryStatus === 'PARTIALLY_PRICED') {
    try {
      await updateReservationMetadata({
        reservationId,
        providerExecution: {
          schemaVersion: 1,
          executionSource: 'PROVIDER',
          providerCalls: callsEvidence,
          providerAttempts: normalizedAttempts as unknown as Prisma.InputJsonValue[],
        },
        unresolvedCostExposure: {
          pricedCallCount: pricing.totals.pricedCallCount,
          unpricedCallCount: pricing.totals.unpricedCallCount,
          pricedCostNanoUsd: pricing.totals.pricedCostNanoUsd.toString(),
          markedUpNanoUsd: charge.markedUpNanoUsd.toString(),
          walletTokens: charge.tokens.toString(),
          rateCardVersion: input.rateCard.version,
          providerCallEvidence: callsEvidence,
        },
      });
    } catch (evidenceErr) {
      // Evidence persistence failure must NOT fall back to partial settlement.
      // Route to recovery anyway — the reservation remains held.
      console.error('[usage-billing] partial_pricing_evidence_failed', {
        operationId, reservationId,
        error: evidenceErr instanceof Error ? evidenceErr.message : String(evidenceErr),
      });
    }
    return recovery<T>(operationId, 'PRICING', 'UNPRICED_PROVIDER_CALLS', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  const actualWalletTokens = Number(charge.tokens);
  if (
    !Number.isSafeInteger(actualWalletTokens) ||
    actualWalletTokens < 0 ||
    actualWalletTokens > createResult.reservedTokens
  ) {
    return recovery<T>(operationId, 'PRICING', 'PRICING_LIMITS_EXCEEDED', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  let pricingEvidence: RecordAIBillingOperationPricingResult;
  try {
    pricingEvidence = await dependencies.recordAIBillingOperationPricing({
      operationId,
      pricing: toPricingEvidence(input, actualWalletTokens, {
        provider: outcome.execution.provider,
        model: outcome.execution.model,
      }),
    });
  } catch {
    return recovery<T>(operationId, 'PRICING_EVIDENCE', 'PRICING_EVIDENCE_FAILED', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  // Phase 5B.1: Best-effort canonical providerExecution write for FULLY_PRICED.
  // Observability errors must NOT block settlement or cause recovery.
  try {
    await updateReservationMetadata({
      reservationId,
      providerExecution: {
        schemaVersion: 1,
        executionSource: 'PROVIDER',
        providerCalls: callsEvidence,
        providerAttempts: normalizedAttempts as unknown as Prisma.InputJsonValue[],
      },
    });
  } catch (evidenceErr) {
    console.error('[usage-billing] fully_priced_evidence_failed', {
      operationId, reservationId,
      error: evidenceErr instanceof Error ? evidenceErr.message : String(evidenceErr),
    });
  }

  let settlement: SettleBusinessTokenReservationResult;
  try {
    settlement = await dependencies.settleForAmount({
      reservationId,
      actualTokens: actualWalletTokens,
    });
  } catch {
    return recovery<T>(operationId, 'SETTLEMENT', 'SETTLEMENT_FAILED', {
      reservationId,
      operationStatus: 'PRICED',
    });
  }

  let settledEvidence: MarkAIBillingOperationSettledResult;
  try {
    settledEvidence = await dependencies.markAIBillingOperationSettled({
      operationId,
      settlement,
    });
  } catch {
    return recovery<T>(operationId, 'SETTLED_EVIDENCE', 'SETTLED_EVIDENCE_FAILED', {
      reservationId,
      operationStatus: 'PRICED',
    });
  }

  // Phase 4B: PARTIALLY_PRICED is now fail-closed above and never reaches
  // settlement. Only FULLY_PRICED operations reach this point.

  return {
    outcome: 'SETTLED',
    operationId,
    reservationId,
    data: outcome.data,
    actualWalletTokens,
    adminExempt: false,
    billing: toSettledBilling(
      settlement,
      input.walletPolicy.version,
      input.rateCard.version,
      {
        pricedCostNanoUsd: pricing.totals.pricedCostNanoUsd,
        markedUpNanoUsd: charge.markedUpNanoUsd,
        provider: outcome.execution.provider,
        model: outcome.execution.model,
      },
    ),
    recoveryRequired: false,
  };
}

async function runCacheHitSettlement<T>(
  dependencies: UsageBasedBillingDependencies,
  input: UsageBasedBillingInput<T>,
  operationId: string,
  reservationId: string,
  outcome: Extract<AIExecutionOutcome<T>, { kind: 'SUCCESS' }>,
): Promise<UsageBasedBillingResult<T>> {
  try {
    await updateReservationMetadata({
      reservationId,
      providerExecution: {
        schemaVersion: 1,
        executionSource: 'CACHE',
        providerCalls: [],
        providerAttempts: [],
      },
    });
  } catch (evidenceErr) {
    console.error('[usage-billing] cache_hit_evidence_failed', { operationId, reservationId });
  }

  let pricingEvidence: RecordAIBillingOperationPricingResult;
  try {
    pricingEvidence = await dependencies.recordAIBillingOperationPricing({
      operationId,
      pricing: toPricingEvidence(input, 0, {
        provider: outcome.execution.provider,
        model: outcome.execution.model,
      }),
    });
  } catch {
    return recovery<T>(operationId, 'PRICING_EVIDENCE', 'PRICING_EVIDENCE_FAILED', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  let settlement: SettleBusinessTokenReservationResult;
  try {
    settlement = await dependencies.settleForAmount({ reservationId, actualTokens: 0 });
  } catch {
    return recovery<T>(operationId, 'SETTLEMENT', 'SETTLEMENT_FAILED', {
      reservationId,
      operationStatus: 'PRICED',
    });
  }

  let settledEvidence: MarkAIBillingOperationSettledResult;
  try {
    settledEvidence = await dependencies.markAIBillingOperationSettled({
      operationId,
      settlement,
    });
  } catch {
    return recovery<T>(operationId, 'SETTLED_EVIDENCE', 'SETTLED_EVIDENCE_FAILED', {
      reservationId,
      operationStatus: 'PRICED',
    });
  }

  return {
    outcome: 'SETTLED',
    operationId,
    reservationId,
    data: outcome.data,
    actualWalletTokens: 0,
    adminExempt: false,
    billing: toSettledBilling(
      settlement,
      input.walletPolicy.version,
      input.rateCard.version,
      {
        pricedCostNanoUsd: 0n,
        markedUpNanoUsd: 0n,
        provider: outcome.execution.provider,
        model: outcome.execution.model,
      },
    ),
    recoveryRequired: false,
  };
}

async function runAdminExemptFlow<T>(
  input: UsageBasedBillingInput<T>,
  dependencies: UsageBasedBillingDependencies,
  operationId: string,
  providerCallsOf: (data: T) => unknown,
): Promise<UsageBasedBillingResult<T>> {
  const executeContext: UsageBasedBillingExecutionContext = {
    operationId,
    reservationId: '',
    executionBudget: input.executionBudget,
  };

  let raw: unknown;
  try {
    raw = await input.execute(executeContext);
  } catch (err) {
    console.error('[usage-billing] admin_exempt_executor_thrown', {
      operationId,
      feature: input.feature,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      outcome: 'RECOVERY_REQUIRED',
      operationId,
      stage: 'EXECUTION',
      reasonCode: 'EXECUTOR_THROWN_DISPATCH_UNKNOWN',
      recoveryRequired: true,
    };
  }

  let outcome: AIExecutionOutcome<T>;
  try {
    outcome = dependencies.parseAIExecutionOutcome<T>(raw);
  } catch {
    return {
      outcome: 'RECOVERY_REQUIRED',
      operationId,
      stage: 'EXECUTION',
      reasonCode: 'EXECUTION_OUTCOME_INVALID',
      recoveryRequired: true,
    };
  }

  if (outcome.kind === 'NON_BILLABLE_FAILURE') {
    return released<T>(operationId, '', outcome.code, true);
  }

  if (outcome.kind === 'INDETERMINATE_FAILURE') {
    return {
      outcome: 'RECOVERY_REQUIRED',
      operationId,
      stage: 'EXECUTION',
      reasonCode: 'INDETERMINATE_EXECUTION',
      recoveryRequired: true,
    };
  }

  // Price for observability only; no reservation, no consumption transaction.
  let pricing;
  try {
    pricing = dependencies.aggregateProviderCalls({
      providerCalls: providerCallsOf(outcome.data),
      card: input.rateCard,
    });
  } catch {
    pricing = undefined;
  }

  if (pricing !== undefined) {
    console.info('[usage-billing] admin_exempt_pricing_observability', {
      operationId,
      feature: input.feature,
      summaryStatus: pricing.summaryStatus,
      noProviderCalls: pricing.noProviderCalls,
      callCount: pricing.totals.callCount,
      pricedCallCount: pricing.totals.pricedCallCount,
      unpricedCallCount: pricing.totals.unpricedCallCount,
      pricedCostNanoUsd: pricing.totals.pricedCostNanoUsd.toString(),
      rateCardVersion: input.rateCard.version,
      walletPolicyVersion: input.walletPolicy.version,
    });
  }

  return {
    outcome: 'ADMIN_EXEMPT',
    data: outcome.data,
    actualWalletTokens: 0,
    adminExempt: true,
    recoveryRequired: false,
  };
}

async function runNonBillableFlow<T>(
  dependencies: UsageBasedBillingDependencies,
  operationId: string,
  reservationId: string,
  outcome: Extract<AIExecutionOutcome<T>, { kind: 'NON_BILLABLE_FAILURE' }>,
): Promise<UsageBasedBillingResult<T>> {
  if (outcome.providerRequestSent === false && reservationId) {
    try {
      await updateReservationMetadata({
        reservationId,
        providerExecution: {
          schemaVersion: 1,
          executionSource: 'NONE',
          providerCalls: [],
          providerAttempts: [],
        },
      });
    } catch (evidenceErr) {
      console.error('[usage-billing] non_billable_evidence_failed', { operationId, reservationId });
    }
  }

  let failureEvidence: RecordAIBillingOperationFailureResult;
  try {
    failureEvidence = await dependencies.recordAIBillingOperationFailure({
      operationId,
      failure: {
        kind: 'NON_BILLABLE_FAILURE',
        code: outcome.code,
        message: outcome.message,
        providerRequestSent: false,
        retryable: outcome.retryable,
      },
    });
  } catch {
    return recovery<T>(operationId, 'FAILURE_EVIDENCE', 'FAILURE_EVIDENCE_FAILED', {
      reservationId,
    });
  }

  let release;
  try {
    release = await dependencies.releaseReservation({ reservationId });
  } catch {
    return recovery<T>(operationId, 'RELEASE', 'RELEASE_FAILED', {
      reservationId,
      operationStatus: 'NON_BILLABLE_CONFIRMED',
    });
  }

  let releasedEvidence: MarkAIBillingOperationReleasedResult;
  try {
    releasedEvidence = await dependencies.markAIBillingOperationReleased({
      operationId,
      release,
    });
  } catch {
    return recovery<T>(operationId, 'RELEASED_EVIDENCE', 'RELEASED_EVIDENCE_FAILED', {
      reservationId,
      operationStatus: 'NON_BILLABLE_CONFIRMED',
    });
  }

  return released<T>(operationId, reservationId, outcome.code, false);
}

async function persistIndeterminate<T>(
  dependencies: UsageBasedBillingDependencies,
  operationId: string,
  reservationId: string,
  code: string,
  message: string,
  reasonCode: UsageBasedBillingReasonCode,
  retryable?: boolean,
  execution?: Partial<{ provider: string; model: string; providerRequestId?: string }>,
  rawPayload?: unknown,
): Promise<UsageBasedBillingResult<T>> {
  if (reservationId) {
    try {
      const rawAttempts = isRecord(rawPayload)
        ? (rawPayload.providerAttempts ?? (rawPayload as { data?: { providerAttempts?: unknown } }).data?.providerAttempts)
        : undefined;
      const rawCalls = isRecord(rawPayload)
        ? (rawPayload.providerCalls ?? (rawPayload as { data?: { providerCalls?: unknown } }).data?.providerCalls)
        : undefined;

      const normalizedAttempts = normalizeProviderAttempts(rawAttempts) ?? [];
      const callsEvidence = serializePricingCallEvidence([], rawCalls);
      const attemptExposure = summarizeProviderAttemptExposure(rawAttempts);

      await updateReservationMetadata({
        reservationId,
        providerExecution: {
          schemaVersion: 1,
          executionSource: 'PROVIDER',
          providerCalls: callsEvidence,
          providerAttempts: normalizedAttempts as unknown as Prisma.InputJsonValue[],
        },
        ...(attemptExposure === undefined ? {} : { providerAttemptExposure: attemptExposure }),
      });
    } catch (evidenceErr) {
      console.error('[usage-billing] indeterminate_evidence_failed', {
        operationId, reservationId, error: evidenceErr instanceof Error ? evidenceErr.message : String(evidenceErr),
      });
    }
  }

  let failureEvidence: RecordAIBillingOperationFailureResult;
  try {
    failureEvidence = await dependencies.recordAIBillingOperationFailure({
      operationId,
      failure: {
        kind: 'INDETERMINATE_FAILURE',
        code,
        message,
        providerRequestSent: true,
        retryable: retryable ?? false,
        ...(execution === undefined ? {} : { execution }),
      },
    });
  } catch {
    return recovery<T>(operationId, 'FAILURE_EVIDENCE', 'FAILURE_EVIDENCE_FAILED', {
      reservationId,
    });
  }

  return recovery<T>(operationId, 'EXECUTION', reasonCode, {
    reservationId,
    operationStatus: 'INDETERMINATE',
  });
}
