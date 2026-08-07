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

function reservationCap<T>(input: UsageBasedBillingInput<T>): number {
  return input.walletPolicy.maxReservationTokensByFeature[input.feature];
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

async function recordReservationExposure(
  exposure: UsageBasedBillingExposure,
): Promise<void> {
  await prisma.tokenReservation.update({
    where: { id: exposure.reservationId },
    data: {
      metadata: {
        unresolvedCostExposure: {
          pricedCallCount: exposure.pricedCallCount,
          unpricedCallCount: exposure.unpricedCallCount,
          pricedCostNanoUsd: exposure.pricedCostNanoUsd,
          markedUpNanoUsd: exposure.markedUpNanoUsd,
          walletTokens: exposure.walletTokens,
        },
      },
    },
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
  const executeContext = {
    operationId,
    reservationId: '',
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

  const reservationTokens = reservationCap(input);

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

  if (
    outcome.usage.inputTokens > input.chatLimits.maxInputTokens ||
    outcome.usage.outputTokens > input.chatLimits.maxOutputTokens
  ) {
    return recovery<T>(operationId, 'USAGE_VALIDATION', 'USAGE_LIMITS_EXCEEDED', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  const providerCalls = providerCallsOf(outcome.data);

  // Absent or non-array providerCalls are NOT authoritative: unknown cost must
  // never be treated as zero. Only an explicit empty array is a cache hit.
  if (providerCalls === undefined || providerCalls === null || !Array.isArray(providerCalls)) {
    return recovery<T>(operationId, 'PRICING', 'UNPRICED_PROVIDER_CALLS', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  if (providerCalls.length === 0) {
    return runCacheHitSettlement<T>(
      dependencies,
      input,
      operationId,
      reservationId,
      outcome,
    );
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

  if (pricing.summaryStatus === 'UNPRICED') {
    // SUCCESS + UNPRICED: never auto-deduct, never treat as free. Recovery.
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

  // PARTIALLY_PRICED: only confirmed priced calls are charged; unresolved cost
  // exposure is recorded for recovery observability.
  if (pricing.summaryStatus === 'PARTIALLY_PRICED') {
    try {
      await dependencies.recordUnresolvedExposure({
        reservationId,
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
  const executeContext = { operationId, reservationId: '' };

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
): Promise<UsageBasedBillingResult<T>> {
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
