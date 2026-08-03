import type { AIProviderUsage } from '../types/ai.js';
import type { AIExecutionOutcome } from '../types/ai-execution.js';
import type { AIUsagePricingResult } from '../types/ai-pricing.js';
import type { AIReservationQuoteResult } from '../types/ai-reservation-quote.js';
import type {
  AIBillingOrchestrationResult,
  AIBillingOrchestratorDependencies,
  AIBillingOrchestratorInput,
  AIBillingOrchestratorReasonCode,
  AIBillingOrchestratorRecoveryResult,
  AIBillingOrchestratorReleasedResult,
  AIBillingOrchestratorResult,
  AIBillingOrchestratorStage,
  AIBillingReservationMetadata,
} from '../types/ai-billing-orchestrator.js';
import type {
  AIBillingOperationEvidenceResult,
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
import { calculateAIReservationQuote } from '../utils/ai-reservation-quote.js';
import { calculateAIUsagePrice } from '../utils/ai-usage-pricing.js';
import { parseAIExecutionOutcome } from '../utils/ai-execution-contract.js';

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
    provider: input.provider,
    model: input.model,
  };
}

function validateRequestedIdentity(
  provider: unknown,
  model: unknown,
): { ok: true; provider?: string; model?: string } | { ok: false } {
  const providerProvided = provider !== undefined;
  const modelProvided = model !== undefined;
  if (!providerProvided && !modelProvided) {
    return { ok: true };
  }
  if (typeof provider !== 'string' || typeof model !== 'string') {
    return { ok: false };
  }
  const trimmedProvider = provider.trim();
  const trimmedModel = model.trim();
  if (trimmedProvider.length === 0 || trimmedModel.length === 0) {
    return { ok: false };
  }
  return { ok: true, provider: trimmedProvider, model: trimmedModel };
}

function verifyCreateSnapshot(input: {
  operationId: string;
  reservation: ReserveBusinessTokensResult;
  quote: AIReservationQuoteResult;
  createResult: CreateAIBillingOperationResult;
}): boolean {
  const { operationId, reservation, quote, createResult } = input;
  if (reservation.reservationId !== createResult.reservationId) return false;
  if (operationId !== createResult.operationId) return false;
  if (reservation.tokens !== quote.reservationTokens) return false;
  if (createResult.reservedTokens !== reservation.tokens) return false;
  if (createResult.reservationPricingVersion !== reservation.pricingVersion) return false;
  if (createResult.status !== 'RESERVED') return false;
  if (createResult.idempotentReplay !== false) return false;
  return true;
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

type UsageValidationResult = { ok: true } | { ok: false; reasonCode: AIBillingOrchestratorReasonCode };

function validateUsageLimits(usage: AIProviderUsage, quote: AIReservationQuoteResult): UsageValidationResult {
  if (usage.inputTokens > quote.maxInputTokens) {
    return { ok: false, reasonCode: 'USAGE_LIMITS_EXCEEDED' };
  }
  if (usage.outputTokens > quote.maxOutputTokens) {
    return { ok: false, reasonCode: 'USAGE_LIMITS_EXCEEDED' };
  }
  return { ok: true };
}

function trimOperationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function recovery(
  operationId: string,
  stage: AIBillingOrchestratorStage,
  reasonCode: AIBillingOrchestratorReasonCode,
  options: {
    reservationId?: string;
    operationStatus?: AIBillingOrchestratorRecoveryResult['operationStatus'];
  } = {},
): AIBillingOrchestratorRecoveryResult {
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

function released(
  operationId: string,
  reservationId: string,
  failureCode: string,
): AIBillingOrchestratorReleasedResult {
  return {
    outcome: 'RELEASED',
    operationId,
    reservationId,
    failureCode,
    recoveryRequired: false,
  };
}

function settledResult<T>(
  operationId: string,
  reservationId: string,
  data: T,
  actualWalletTokens: number,
  settlement: SettleBusinessTokenReservationResult,
  quote: AIReservationQuoteResult,
  input: AIBillingOrchestratorInput<T>,
  pricing: AIUsagePricingResult,
  reservation: ReserveBusinessTokensResult,
): AIBillingOrchestratorResult<T> {
  const billingProvider = pricing.provider ?? quote.provider;
  const billingModel = pricing.model ?? quote.model;
  const billingCurrency = pricing.billingCurrency ?? quote.billingCurrency;
  const rateCardVersion = pricing.rateCardVersion ?? quote.rateCardVersion;
  const walletPolicyVersion = pricing.walletPolicyVersion ?? quote.walletPolicyVersion;

  return {
    outcome: 'SETTLED',
    operationId,
    reservationId,
    data,
    actualWalletTokens,
    settlement: {
      consumeTransactionId: settlement.consumeTransactionId,
      reservedTokens: settlement.tokens,
      actualTokens: settlement.actualTokens,
      releasedTokens: settlement.releasedTokens,
      settledAt: settlement.settledAt,
    },
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
    recoveryRequired: false,
  };
}

async function resolveOperationByOperationId(input: {
  operationId: string;
}): Promise<AIBillingOperationEvidenceResult | null> {
  try {
    return await getDurableOperationByOperationId(input);
  } catch (err) {
    if (err instanceof AIBillingOperationError && err.code === 'OPERATION_NOT_FOUND') {
      return null;
    }
    throw err;
  }
}

export function createDefaultAIBillingOrchestratorDependencies(): AIBillingOrchestratorDependencies {
  return {
    calculateQuote: calculateAIReservationQuote,
    reserveForAmount: reserveBusinessTokensForAmount,
    getAIBillingOperationByOperationId: resolveOperationByOperationId,
    createAIBillingOperation,
    recordAIBillingOperationExecutionSuccess,
    recordAIBillingOperationPricing,
    recordAIBillingOperationFailure,
    markAIBillingOperationSettled,
    markAIBillingOperationReleased,
    parseAIExecutionOutcome,
    calculateActualPrice: calculateAIUsagePrice,
    settleForAmount: settleBusinessTokenReservationForAmount,
    releaseReservation: releaseBusinessTokenReservation,
  };
}

export async function runAIBillingOrchestration<T>(
  input: AIBillingOrchestratorInput<T>,
  dependencies: AIBillingOrchestratorDependencies = createDefaultAIBillingOrchestratorDependencies(),
): Promise<AIBillingOrchestrationResult<T>> {
  const operationId = trimOperationId(input.operationId);
  if (operationId === undefined) {
    return recovery('', 'PREFLIGHT', 'INVALID_OPERATION_ID');
  }

  const identity = validateRequestedIdentity(input.provider, input.model);
  if (!identity.ok) {
    return recovery(operationId, 'PREFLIGHT', 'INVALID_REQUESTED_IDENTITY');
  }

  const snapshot = createPricingSnapshot({
    provider: identity.provider,
    model: identity.model,
    chatLimits: input.chatLimits,
    rateCard: input.rateCard,
    walletPolicy: input.walletPolicy,
  });

  let existing: AIBillingOperationEvidenceResult | null;
  try {
    existing = await dependencies.getAIBillingOperationByOperationId({ operationId });
  } catch (err) {
    return recovery(operationId, 'PREFLIGHT', 'OPERATION_LOOKUP_FAILED');
  }

  if (existing) {
    return recovery(operationId, 'PREFLIGHT', 'OPERATION_REPLAY_REQUIRES_RECOVERY', {
      reservationId: existing.reservationId,
      operationStatus: existing.status,
    });
  }

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
    return recovery(operationId, 'QUOTE', 'QUOTE_FAILED');
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
    return recovery(operationId, 'RESERVATION', 'RESERVATION_FAILED');
  }

  const reservationId = reservation.reservationId;

  let createResult: CreateAIBillingOperationResult;
  try {
    createResult = await dependencies.createAIBillingOperation({
      operationId,
      reservationId,
      ...(snapshot.provider === undefined ? {} : { requestedProvider: snapshot.provider }),
      ...(snapshot.model === undefined ? {} : { requestedModel: snapshot.model }),
    });
  } catch (err) {
    return recovery(operationId, 'OPERATION_CREATION', 'OPERATION_CREATE_FAILED', {
      reservationId,
    });
  }

  if (createResult.idempotentReplay) {
    return recovery(operationId, 'OPERATION_CREATION', 'OPERATION_CREATE_REPLAY', {
      reservationId,
      operationStatus: createResult.status,
    });
  }

  if (
    !verifyCreateSnapshot({
      operationId,
      reservation,
      quote,
      createResult,
    })
  ) {
    return recovery(operationId, 'OPERATION_CREATION', 'OPERATION_SNAPSHOT_MISMATCH', {
      reservationId,
    });
  }

  let raw: unknown;
  try {
    raw = await input.execute({ operationId, reservationId });
  } catch (err) {
    return await persistIndeterminate(
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
  } catch (err) {
    return await persistIndeterminate(
      dependencies,
      operationId,
      reservationId,
      'EXECUTION_OUTCOME_INVALID',
      'AI execution outcome is invalid',
      'EXECUTION_OUTCOME_INVALID',
    );
  }

  if (outcome.kind === 'NON_BILLABLE_FAILURE') {
    return await runNonBillableFlow(dependencies, operationId, reservationId, outcome);
  }

  if (outcome.kind === 'INDETERMINATE_FAILURE') {
    return await persistIndeterminate(
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
  } catch (err) {
    return recovery(operationId, 'EXECUTION_EVIDENCE', 'EXECUTION_EVIDENCE_FAILED', {
      reservationId,
    });
  }

  const validation = validateUsageLimits(outcome.usage, quote);
  if (!validation.ok) {
    return recovery(operationId, 'USAGE_VALIDATION', validation.reasonCode, {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  let pricing: AIUsagePricingResult;
  try {
    pricing = dependencies.calculateActualPrice({
      feature: input.feature,
      requestedMode: input.requestedMode,
      usage: outcome.usage,
      rateCard: snapshot.rateCard,
      walletPolicy: snapshot.walletPolicy,
    });
  } catch (err) {
    return recovery(operationId, 'PRICING', 'PRICING_FAILED', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  const actualWalletTokens = pricing.walletTokens;

  if (
    !Number.isSafeInteger(actualWalletTokens) ||
    actualWalletTokens < 0 ||
    actualWalletTokens > createResult.reservedTokens
  ) {
    return recovery(operationId, 'PRICING', 'PRICING_LIMITS_EXCEEDED', {
      reservationId,
      operationStatus: 'EXECUTION_SUCCEEDED',
    });
  }

  let pricingEvidence: RecordAIBillingOperationPricingResult;
  try {
    pricingEvidence = await dependencies.recordAIBillingOperationPricing({
      operationId,
      pricing,
    });
  } catch (err) {
    return recovery(operationId, 'PRICING_EVIDENCE', 'PRICING_EVIDENCE_FAILED', {
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
  } catch (err) {
    return recovery(operationId, 'SETTLEMENT', 'SETTLEMENT_FAILED', {
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
  } catch (err) {
    return recovery(operationId, 'SETTLED_EVIDENCE', 'SETTLED_EVIDENCE_FAILED', {
      reservationId,
      operationStatus: 'PRICED',
    });
  }

  return settledResult<T>(
    operationId,
    reservationId,
    outcome.data,
    actualWalletTokens,
    settlement,
    quote,
    input,
    pricing,
    reservation,
  );
}

async function runNonBillableFlow<T>(
  dependencies: AIBillingOrchestratorDependencies,
  operationId: string,
  reservationId: string,
  outcome: Extract<AIExecutionOutcome<T>, { kind: 'NON_BILLABLE_FAILURE' }>,
): Promise<AIBillingOrchestrationResult<T>> {
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
  } catch (err) {
    return recovery(operationId, 'FAILURE_EVIDENCE', 'FAILURE_EVIDENCE_FAILED', {
      reservationId,
    });
  }

  let release;
  try {
    release = await dependencies.releaseReservation({ reservationId });
  } catch (err) {
    return recovery(operationId, 'RELEASE', 'RELEASE_FAILED', {
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
  } catch (err) {
    return recovery(operationId, 'RELEASED_EVIDENCE', 'RELEASED_EVIDENCE_FAILED', {
      reservationId,
      operationStatus: 'NON_BILLABLE_CONFIRMED',
    });
  }

  return released(operationId, reservationId, outcome.code);
}

async function persistIndeterminate<T>(
  dependencies: AIBillingOrchestratorDependencies,
  operationId: string,
  reservationId: string,
  code: string,
  message: string,
  reasonCode: AIBillingOrchestratorReasonCode,
  retryable?: boolean,
  execution?: Partial<{ provider: string; model: string; providerRequestId?: string }>,
): Promise<AIBillingOrchestrationResult<T>> {
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
  } catch (err) {
    return recovery(operationId, 'FAILURE_EVIDENCE', 'FAILURE_EVIDENCE_FAILED', {
      reservationId,
    });
  }

  return recovery(operationId, 'EXECUTION', reasonCode, {
    reservationId,
    operationStatus: 'INDETERMINATE',
  });
}
