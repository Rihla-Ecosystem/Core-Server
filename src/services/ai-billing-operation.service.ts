import type {
  AIBillingOperationRow,
  AIBillingOperationRepository,
  AIBillingOperationReservationRow,
  AIBillingOperationWalletRow,
} from '../repositories/ai-billing-operation.repository.js';
import { createPrismaAIBillingOperationRepository } from '../repositories/ai-billing-operation.repository.js';
import type {
  AIBillingOperationErrorCode,
  AIBillingOperationErrorOptions,
  AIBillingOperationEvidenceResult,
  CreateAIBillingOperationInput,
  CreateAIBillingOperationResult,
  MarkAIBillingOperationForReviewInput,
  MarkAIBillingOperationForReviewResult,
  MarkAIBillingOperationReleasedInput,
  MarkAIBillingOperationReleasedResult,
  MarkAIBillingOperationSettledInput,
  MarkAIBillingOperationSettledResult,
  ReadAIBillingOperationByOperationIdInput,
  ReadAIBillingOperationByReservationIdInput,
  RecordAIBillingOperationExecutionSuccessInput,
  RecordAIBillingOperationExecutionSuccessResult,
  RecordAIBillingOperationFailureInput,
  RecordAIBillingOperationFailureResult,
  RecordAIBillingOperationPricingInput,
  RecordAIBillingOperationPricingResult,
} from '../types/ai-billing-operation.js';
import type {
  AIBillingOperationFailureKind,
  AIBillingOperationStatus,
  TokenReservationStatus,
  TokenTransactionSource,
} from '@prisma/client';
import type { AIExecutionIdentity } from '../types/ai-execution.js';
import type { AIProviderUsage } from '../types/ai.js';
import type {
  AIUsagePricingFallbackReason,
  AIUsagePricingMode,
  AIUsagePricingResult,
} from '../types/ai-pricing.js';
import { normalizeAIProviderUsage } from '../utils/ai-usage.js';

const REVIEWABLE_OPERATION_STATUSES: AIBillingOperationStatus[] = [
  'RESERVED',
  'EXECUTION_SUCCEEDED',
  'PRICED',
  'NON_BILLABLE_CONFIRMED',
  'INDETERMINATE',
];

const AI_USAGE_PRICING_MODES = new Set<string>(['PROVIDER_USAGE', 'FIXED_FALLBACK']);
const AI_BILLING_FALLBACK_REASONS = new Set<string>([
  'USAGE_MISSING',
  'USAGE_INVALID',
  'RATE_CARD_NOT_FOUND',
]);
const TOKEN_TRANSACTION_SOURCES = new Set<string>([
  'CHAT',
  'IMAGE',
  'FILE_UPLOAD',
  'OCR',
  'VOICE',
  'ITINERARY',
  'PURCHASE',
  'ADMIN',
]);
const REVIEW_REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_REVIEW_REASON_CODE_LENGTH = 64;

export class AIBillingOperationError extends Error {
  readonly code: AIBillingOperationErrorCode;
  readonly recoveryRequired: boolean;
  readonly operationId?: string;
  readonly reservationId?: string;

  constructor(
    code: AIBillingOperationErrorCode,
    message: string,
    options: AIBillingOperationErrorOptions = {},
  ) {
    super(message);
    this.name = 'AIBillingOperationError';
    this.code = code;
    this.recoveryRequired = options.recoveryRequired ?? false;
    this.operationId = options.operationId;
    this.reservationId = options.reservationId;
  }
}

export interface AIBillingOperationDependencies {
  repository: AIBillingOperationRepository;
}

export function createDefaultAIBillingOperationDependencies(): AIBillingOperationDependencies {
  return {
    repository: createPrismaAIBillingOperationRepository(),
  };
}

function opError(
  code: AIBillingOperationErrorCode,
  message: string,
  options: AIBillingOperationErrorOptions = {},
): AIBillingOperationError {
  return new AIBillingOperationError(code, message, options);
}

function wrapRepositoryRead(
  message: string,
  operationId: string,
  reservationId: string,
  err: unknown,
): never {
  if (err instanceof AIBillingOperationError) {
    throw err;
  }
  throw opError('INTEGRITY_CONFLICT', message, {
    operationId,
    reservationId,
    recoveryRequired: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidPricingMode(value: unknown): value is AIUsagePricingMode {
  return typeof value === 'string' && AI_USAGE_PRICING_MODES.has(value);
}

function isValidFallbackReason(value: unknown): value is AIUsagePricingFallbackReason {
  return typeof value === 'string' && AI_BILLING_FALLBACK_REASONS.has(value);
}

function isValidTokenTransactionSource(value: unknown): value is TokenTransactionSource {
  return typeof value === 'string' && TOKEN_TRANSACTION_SOURCES.has(value);
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

function assertOperationId(operationId: unknown): string {
  if (typeof operationId !== 'string') {
    throw opError('INVALID_INPUT', 'operationId must not be empty');
  }
  const trimmed = operationId.trim();
  if (!trimmed) {
    throw opError('INVALID_INPUT', 'operationId must not be empty');
  }
  return trimmed;
}

function assertReservationId(reservationId: unknown): string {
  if (typeof reservationId !== 'string') {
    throw opError('INVALID_INPUT', 'reservationId must not be empty');
  }
  const trimmed = reservationId.trim();
  if (!trimmed) {
    throw opError('INVALID_INPUT', 'reservationId must not be empty');
  }
  return trimmed;
}

function parseRequestedIdentity(
  requestedProvider: unknown,
  requestedModel: unknown,
): { provider?: string; model?: string } {
  let provider: string | undefined;
  if (requestedProvider !== undefined) {
    const trimmed = trimNonEmptyString(requestedProvider);
    if (trimmed === undefined) {
      throw opError('INVALID_INPUT', 'requestedProvider must be a non-empty string when present');
    }
    provider = trimmed;
  }
  let model: string | undefined;
  if (requestedModel !== undefined) {
    const trimmed = trimNonEmptyString(requestedModel);
    if (trimmed === undefined) {
      throw opError('INVALID_INPUT', 'requestedModel must be a non-empty string when present');
    }
    model = trimmed;
  }
  if ((provider === undefined) !== (model === undefined)) {
    throw opError(
      'INVALID_INPUT',
      'requestedProvider and requestedModel must be provided together',
    );
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  };
}

function assertReviewReasonCode(reasonCode: unknown): string {
  if (typeof reasonCode !== 'string') {
    throw opError('INVALID_INPUT', 'reasonCode must be a non-empty string');
  }
  const trimmed = reasonCode.trim();
  if (!trimmed) {
    throw opError('INVALID_INPUT', 'reasonCode must be a non-empty string');
  }
  if (trimmed.length > MAX_REVIEW_REASON_CODE_LENGTH) {
    throw opError('INVALID_INPUT', 'reasonCode must not exceed 64 characters');
  }
  if (!REVIEW_REASON_CODE_PATTERN.test(trimmed)) {
    throw opError(
      'INVALID_INPUT',
      'reasonCode must contain only uppercase ASCII letters, digits, and underscores',
    );
  }
  return trimmed;
}

function assertValidDate(value: unknown, message: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw opError('INVALID_INPUT', message);
  }
  return value;
}

function parseExecutionEvidence(
  execution: unknown,
): { provider: string; model: string; providerRequestId?: string } {
  if (!isRecord(execution)) {
    throw opError('INVALID_INPUT', 'AI billing execution evidence must be an object');
  }
  const provider = trimNonEmptyString(execution.provider);
  if (provider === undefined) {
    throw opError('INVALID_INPUT', 'AI billing execution provider is missing or empty');
  }
  const model = trimNonEmptyString(execution.model);
  if (model === undefined) {
    throw opError('INVALID_INPUT', 'AI billing execution model is missing or empty');
  }
  let providerRequestId: string | undefined;
  if (execution.providerRequestId !== undefined) {
    const trimmed = trimNonEmptyString(execution.providerRequestId);
    if (trimmed === undefined) {
      throw opError(
        'INVALID_INPUT',
        'AI billing providerRequestId must be a non-empty string when present',
      );
    }
    providerRequestId = trimmed;
  }
  return {
    provider,
    model,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  };
}

function parseUsageEvidence(usage: unknown): AIProviderUsage {
  const normalized = normalizeAIProviderUsage(usage);
  if (normalized === undefined) {
    throw opError('INVALID_INPUT', 'AI billing usage evidence is missing or invalid');
  }
  return normalized;
}

interface ParsedAIPricingEvidence {
  appliedMode: AIUsagePricingMode;
  fallbackReason?: AIUsagePricingFallbackReason;
  walletTokens: number;
  billingCurrency?: string;
  rateCardVersion?: string;
  walletPolicyVersion?: string;
  provider?: string;
  model?: string;
}

function parsePricingEvidence(pricing: unknown): ParsedAIPricingEvidence {
  if (!isRecord(pricing)) {
    throw opError('INVALID_INPUT', 'AI billing pricing evidence must be an object');
  }
  const appliedMode = pricing.appliedMode;
  if (!isValidPricingMode(appliedMode)) {
    throw opError('INVALID_INPUT', 'AI billing pricing appliedMode is invalid');
  }
  const walletTokens = pricing.walletTokens;
  if (!isSafeNonNegativeInteger(walletTokens)) {
    throw opError('INVALID_INPUT', 'AI billing actual wallet tokens are invalid');
  }
  let fallbackReason: AIUsagePricingFallbackReason | undefined;
  if (pricing.fallbackReason !== undefined) {
    if (!isValidFallbackReason(pricing.fallbackReason)) {
      throw opError('INVALID_INPUT', 'AI billing pricing fallbackReason is invalid');
    }
    fallbackReason = pricing.fallbackReason;
  }
  let billingCurrency: string | undefined;
  if (pricing.billingCurrency !== undefined) {
    const trimmed = trimNonEmptyString(pricing.billingCurrency);
    if (trimmed === undefined) {
      throw opError(
        'INVALID_INPUT',
        'AI billing pricing billingCurrency must be a non-empty string when present',
      );
    }
    billingCurrency = trimmed;
  }
  let rateCardVersion: string | undefined;
  if (pricing.rateCardVersion !== undefined) {
    const trimmed = trimNonEmptyString(pricing.rateCardVersion);
    if (trimmed === undefined) {
      throw opError(
        'INVALID_INPUT',
        'AI billing pricing rateCardVersion must be a non-empty string when present',
      );
    }
    rateCardVersion = trimmed;
  }
  let walletPolicyVersion: string | undefined;
  if (pricing.walletPolicyVersion !== undefined) {
    const trimmed = trimNonEmptyString(pricing.walletPolicyVersion);
    if (trimmed === undefined) {
      throw opError(
        'INVALID_INPUT',
        'AI billing pricing walletPolicyVersion must be a non-empty string when present',
      );
    }
    walletPolicyVersion = trimmed;
  }
  let provider: string | undefined;
  if (pricing.provider !== undefined) {
    const trimmed = trimNonEmptyString(pricing.provider);
    if (trimmed === undefined) {
      throw opError(
        'INVALID_INPUT',
        'AI billing pricing provider must be a non-empty string when present',
      );
    }
    provider = trimmed;
  }
  let model: string | undefined;
  if (pricing.model !== undefined) {
    const trimmed = trimNonEmptyString(pricing.model);
    if (trimmed === undefined) {
      throw opError(
        'INVALID_INPUT',
        'AI billing pricing model must be a non-empty string when present',
      );
    }
    model = trimmed;
  }
  return {
    appliedMode,
    walletTokens,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
    ...(billingCurrency === undefined ? {} : { billingCurrency }),
    ...(rateCardVersion === undefined ? {} : { rateCardVersion }),
    ...(walletPolicyVersion === undefined ? {} : { walletPolicyVersion }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  };
}

function parsePartialExecutionIdentity(raw: unknown): Partial<AIExecutionIdentity> {
  if (!isRecord(raw)) {
    throw opError('INVALID_INPUT', 'AI billing execution identity must be an object when present');
  }
  const identity: Partial<AIExecutionIdentity> = {};
  if (raw.provider !== undefined) {
    const provider = trimNonEmptyString(raw.provider);
    if (provider === undefined) {
      throw opError(
        'INVALID_INPUT',
        'AI billing execution identity provider must be a non-empty string when present',
      );
    }
    identity.provider = provider;
  }
  if (raw.model !== undefined) {
    const model = trimNonEmptyString(raw.model);
    if (model === undefined) {
      throw opError(
        'INVALID_INPUT',
        'AI billing execution identity model must be a non-empty string when present',
      );
    }
    identity.model = model;
  }
  if (raw.providerRequestId !== undefined) {
    const providerRequestId = trimNonEmptyString(raw.providerRequestId);
    if (providerRequestId === undefined) {
      throw opError(
        'INVALID_INPUT',
        'AI billing providerRequestId must be a non-empty string when present',
      );
    }
    identity.providerRequestId = providerRequestId;
  }
  return identity;
}

interface ParsedAIFailureEvidence {
  kind: AIBillingOperationFailureKind;
  code: string;
  retryable: boolean;
  providerRequestSent: boolean;
  execution?: Partial<AIExecutionIdentity>;
}

function parseFailureEvidence(failure: unknown): ParsedAIFailureEvidence {
  if (!isRecord(failure)) {
    throw opError('INVALID_INPUT', 'AI billing failure evidence must be an object');
  }
  if (failure.kind === 'NON_BILLABLE_FAILURE') {
    if (failure.providerRequestSent !== false) {
      throw opError(
        'INVALID_INPUT',
        'AI billing non-billable failure must confirm the provider request was not sent',
      );
    }
    if (failure.execution !== undefined) {
      throw opError(
        'INVALID_INPUT',
        'AI billing non-billable failure must not contain an execution identity',
      );
    }
    const code = trimNonEmptyString(failure.code);
    if (code === undefined) {
      throw opError('INVALID_INPUT', 'AI billing failure code is missing or empty');
    }
    if (typeof failure.retryable !== 'boolean') {
      throw opError('INVALID_INPUT', 'AI billing failure retryable must be a boolean');
    }
    return {
      kind: 'NON_BILLABLE',
      code,
      retryable: failure.retryable,
      providerRequestSent: false,
    };
  }
  if (failure.kind === 'INDETERMINATE_FAILURE') {
    if (failure.providerRequestSent !== true) {
      throw opError(
        'INVALID_INPUT',
        'AI billing indeterminate failure must confirm the provider request was sent',
      );
    }
    const code = trimNonEmptyString(failure.code);
    if (code === undefined) {
      throw opError('INVALID_INPUT', 'AI billing failure code is missing or empty');
    }
    if (typeof failure.retryable !== 'boolean') {
      throw opError('INVALID_INPUT', 'AI billing failure retryable must be a boolean');
    }
    let execution: Partial<AIExecutionIdentity> | undefined;
    if (failure.execution !== undefined) {
      execution = parsePartialExecutionIdentity(failure.execution);
    }
    return {
      kind: 'INDETERMINATE',
      code,
      retryable: failure.retryable,
      providerRequestSent: true,
      ...(execution === undefined ? {} : { execution }),
    };
  }
  throw opError('INVALID_INPUT', 'AI billing failure kind is not recognized');
}

interface ParsedSettlementResult {
  reservationId: string;
  walletId: string;
  userId: string;
  feature: string;
  source: TokenTransactionSource;
  tokens: number;
  actualTokens: number;
  status: TokenReservationStatus;
  settledAt: Date;
  consumeTransactionId: string;
}

function parseSettlementResult(
  raw: unknown,
  expectedReservationId: string,
): ParsedSettlementResult {
  if (!isRecord(raw)) {
    throw opError('INVALID_INPUT', 'AI billing settlement evidence must be an object');
  }
  if (raw.reservationId !== expectedReservationId) {
    throw opError('INVALID_INPUT', 'AI billing settlement reservation does not match the operation');
  }
  if (raw.status !== 'COMPLETED') {
    throw opError(
      'INVALID_INPUT',
      'AI billing settlement must confirm a completed reservation',
    );
  }
  if (!isSafeNonNegativeInteger(raw.tokens)) {
    throw opError('INVALID_INPUT', 'AI billing settlement reserved tokens are invalid');
  }
  if (!isSafeNonNegativeInteger(raw.actualTokens)) {
    throw opError('INVALID_INPUT', 'AI billing settlement actual tokens are invalid');
  }
  if (raw.actualTokens > raw.tokens) {
    throw opError(
      'INVALID_INPUT',
      'AI billing settlement actual tokens must not exceed the reserved amount',
    );
  }
  if (!isNonEmptyString(raw.consumeTransactionId)) {
    throw opError('INVALID_INPUT', 'AI billing settlement consume transaction is missing');
  }
  const settledAt = assertValidDate(raw.settledAt, 'AI billing settlement settledAt is invalid');
  if (!isNonEmptyString(raw.walletId) || !isNonEmptyString(raw.userId)) {
    throw opError('INVALID_INPUT', 'AI billing settlement ownership is incomplete');
  }
  if (!isNonEmptyString(raw.feature)) {
    throw opError('INVALID_INPUT', 'AI billing settlement feature is missing');
  }
  if (!isValidTokenTransactionSource(raw.source)) {
    throw opError('INVALID_INPUT', 'AI billing settlement source is invalid');
  }
  return {
    reservationId: raw.reservationId,
    walletId: raw.walletId,
    userId: raw.userId,
    feature: raw.feature,
    source: raw.source,
    tokens: raw.tokens,
    actualTokens: raw.actualTokens,
    status: 'COMPLETED',
    settledAt,
    consumeTransactionId: raw.consumeTransactionId,
  };
}

interface ParsedReleaseResult {
  reservationId: string;
  walletId: string;
  userId: string;
  feature: string;
  source: TokenTransactionSource;
  tokens: number;
  status: TokenReservationStatus;
  releasedAt: Date;
}

function parseReleaseResult(
  raw: unknown,
  expectedReservationId: string,
): ParsedReleaseResult {
  if (!isRecord(raw)) {
    throw opError('INVALID_INPUT', 'AI billing release evidence must be an object');
  }
  if (raw.reservationId !== expectedReservationId) {
    throw opError('INVALID_INPUT', 'AI billing release reservation does not match the operation');
  }
  if (raw.status !== 'RELEASED') {
    throw opError('INVALID_INPUT', 'AI billing release must confirm a released reservation');
  }
  if (!isSafeNonNegativeInteger(raw.tokens)) {
    throw opError('INVALID_INPUT', 'AI billing release reserved tokens are invalid');
  }
  const releasedAt = assertValidDate(raw.releasedAt, 'AI billing release releasedAt is invalid');
  if (!isNonEmptyString(raw.walletId) || !isNonEmptyString(raw.userId)) {
    throw opError('INVALID_INPUT', 'AI billing release ownership is incomplete');
  }
  if (!isNonEmptyString(raw.feature)) {
    throw opError('INVALID_INPUT', 'AI billing release feature is missing');
  }
  if (!isValidTokenTransactionSource(raw.source)) {
    throw opError('INVALID_INPUT', 'AI billing release source is invalid');
  }
  return {
    reservationId: raw.reservationId,
    walletId: raw.walletId,
    userId: raw.userId,
    feature: raw.feature,
    source: raw.source,
    tokens: raw.tokens,
    status: 'RELEASED',
    releasedAt,
  };
}

function matchesCreateIdentity(
  row: AIBillingOperationRow,
  operationId: string,
  reservation: AIBillingOperationReservationRow,
  requestedProvider: string | null,
  requestedModel: string | null,
): boolean {
  return (
    row.operationId === operationId &&
    row.reservationId === reservation.id &&
    row.walletId === reservation.walletId &&
    row.userId === reservation.userId &&
    row.feature === reservation.feature &&
    row.source === reservation.source &&
    row.reservedTokens === reservation.tokens &&
    row.reservationPricingVersion === reservation.pricingVersion &&
    row.requestedProvider === requestedProvider &&
    row.requestedModel === requestedModel
  );
}

async function findOperationByOperationId(
  deps: AIBillingOperationDependencies,
  operationId: string,
  reservationId: string,
): Promise<AIBillingOperationRow | null> {
  try {
    return await deps.repository.findOperationByOperationId(operationId);
  } catch (err) {
    wrapRepositoryRead(
      'AI billing operation data could not be read reliably',
      operationId,
      reservationId,
      err,
    );
  }
}

async function findOperationByReservationId(
  deps: AIBillingOperationDependencies,
  operationId: string,
  reservationId: string,
): Promise<AIBillingOperationRow | null> {
  try {
    return await deps.repository.findOperationByReservationId(reservationId);
  } catch (err) {
    wrapRepositoryRead(
      'AI billing operation data could not be read reliably',
      operationId,
      reservationId,
      err,
    );
  }
}

function toCreateResult(
  row: AIBillingOperationRow,
  idempotentReplay: boolean,
): CreateAIBillingOperationResult {
  return {
    operationId: row.operationId,
    reservationId: row.reservationId,
    walletId: row.walletId,
    userId: row.userId,
    feature: row.feature,
    source: row.source,
    status: row.status,
    reservedTokens: row.reservedTokens,
    reservationPricingVersion: row.reservationPricingVersion,
    ...(row.requestedProvider === null ? {} : { requestedProvider: row.requestedProvider }),
    ...(row.requestedModel === null ? {} : { requestedModel: row.requestedModel }),
    idempotentReplay,
    createdAt: row.createdAt,
  };
}

async function resolveCreateConflict(
  deps: AIBillingOperationDependencies,
  operationId: string,
  reservation: AIBillingOperationReservationRow,
  requestedProvider: string | null,
  requestedModel: string | null,
): Promise<CreateAIBillingOperationResult> {
  const byOperationId = await findOperationByOperationId(
    deps,
    operationId,
    reservation.id,
  );
  if (byOperationId) {
    if (matchesCreateIdentity(byOperationId, operationId, reservation, requestedProvider, requestedModel)) {
      return toCreateResult(byOperationId, true);
    }
    throw opError(
      'IDEMPOTENCY_CONFLICT',
      'AI billing operation already exists for this reservation',
      { operationId, reservationId: reservation.id },
    );
  }
  const byReservationId = await findOperationByReservationId(
    deps,
    operationId,
    reservation.id,
  );
  if (byReservationId) {
    if (matchesCreateIdentity(byReservationId, operationId, reservation, requestedProvider, requestedModel)) {
      return toCreateResult(byReservationId, true);
    }
    throw opError(
      'IDEMPOTENCY_CONFLICT',
      'AI billing operation already exists for this reservation',
      { operationId, reservationId: reservation.id },
    );
  }
  throw opError('STORAGE_FAILED', 'AI billing operation could not be stored reliably', {
    operationId,
    reservationId: reservation.id,
    recoveryRequired: true,
  });
}

async function safeTransition(
  deps: AIBillingOperationDependencies,
  operationId: string,
  reservationId: string,
  allowedFrom: AIBillingOperationStatus[],
  target: AIBillingOperationStatus,
  set: Record<string, unknown>,
): Promise<boolean> {
  try {
    return await deps.repository.transitionOperation({
      operationId,
      allowedFrom,
      target,
      set,
    });
  } catch (err) {
    throw opError('STORAGE_FAILED', 'AI billing operation could not be stored reliably', {
      operationId,
      reservationId,
      recoveryRequired: true,
    });
  }
}

function buildSuccessSet(
  execution: { provider: string; model: string; providerRequestId?: string },
  usage: AIProviderUsage,
  executedAt: Date,
): Record<string, unknown> {
  return {
    actualProvider: execution.provider,
    actualModel: execution.model,
    providerRequestId: execution.providerRequestId ?? null,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cached: usage.cached ?? null,
    audioSeconds: usage.audioSeconds ?? null,
    executedAt,
  };
}

function successEvidenceMatches(
  row: AIBillingOperationRow,
  set: Record<string, unknown>,
): boolean {
  return (
    row.actualProvider === set.actualProvider &&
    row.actualModel === set.actualModel &&
    row.providerRequestId === set.providerRequestId &&
    row.inputTokens === set.inputTokens &&
    row.outputTokens === set.outputTokens &&
    row.totalTokens === set.totalTokens &&
    row.cached === set.cached &&
    row.audioSeconds === set.audioSeconds
  );
}

function buildPricingSet(
  pricing: ParsedAIPricingEvidence,
  pricedAt: Date,
): Record<string, unknown> {
  return {
    pricingMode: pricing.appliedMode,
    pricingFallbackReason: pricing.fallbackReason ?? null,
    actualWalletTokens: pricing.walletTokens,
    billingCurrency: pricing.billingCurrency ?? null,
    rateCardVersion: pricing.rateCardVersion ?? null,
    walletPolicyVersion: pricing.walletPolicyVersion ?? null,
    pricedAt,
  };
}

function pricingEvidenceMatches(
  row: AIBillingOperationRow,
  pricing: ParsedAIPricingEvidence,
): boolean {
  return (
    row.pricingMode === pricing.appliedMode &&
    row.pricingFallbackReason === (pricing.fallbackReason ?? null) &&
    row.actualWalletTokens === pricing.walletTokens &&
    row.billingCurrency === (pricing.billingCurrency ?? null) &&
    row.rateCardVersion === (pricing.rateCardVersion ?? null) &&
    row.walletPolicyVersion === (pricing.walletPolicyVersion ?? null)
  );
}

function buildFailureSet(
  failure: ParsedAIFailureEvidence,
  failedAt: Date,
): Record<string, unknown> {
  return {
    failureKind: failure.kind,
    failureCode: failure.code,
    retryable: failure.retryable,
    providerRequestSent: failure.providerRequestSent,
    actualProvider: failure.execution?.provider ?? null,
    actualModel: failure.execution?.model ?? null,
    providerRequestId: failure.execution?.providerRequestId ?? null,
    failedAt,
  };
}

function failureEvidenceMatches(
  row: AIBillingOperationRow,
  set: Record<string, unknown>,
): boolean {
  return (
    row.failureKind === set.failureKind &&
    row.failureCode === set.failureCode &&
    row.retryable === set.retryable &&
    row.providerRequestSent === set.providerRequestSent &&
    row.actualProvider === set.actualProvider &&
    row.actualModel === set.actualModel &&
    row.providerRequestId === set.providerRequestId
  );
}

function settlementEvidenceMatches(
  row: AIBillingOperationRow,
  settlement: ParsedSettlementResult,
): boolean {
  return (
    row.settledAt !== null &&
    row.settledAt.getTime() === settlement.settledAt.getTime() &&
    row.reservationId === settlement.reservationId &&
    row.userId === settlement.userId &&
    row.walletId === settlement.walletId &&
    row.feature === settlement.feature &&
    row.source === settlement.source &&
    row.reservedTokens === settlement.tokens &&
    row.actualWalletTokens === settlement.actualTokens &&
    row.consumeTransactionId === settlement.consumeTransactionId
  );
}

function releaseEvidenceMatches(
  row: AIBillingOperationRow,
  release: ParsedReleaseResult,
): boolean {
  return (
    row.releasedAt !== null &&
    row.releasedAt.getTime() === release.releasedAt.getTime() &&
    row.reservationId === release.reservationId &&
    row.userId === release.userId &&
    row.walletId === release.walletId &&
    row.feature === release.feature &&
    row.source === release.source &&
    row.reservedTokens === release.tokens
  );
}

function toEvidenceResult(row: AIBillingOperationRow): AIBillingOperationEvidenceResult {
  return {
    operationId: row.operationId,
    reservationId: row.reservationId,
    walletId: row.walletId,
    userId: row.userId,
    feature: row.feature,
    source: row.source,
    status: row.status,
    reservedTokens: row.reservedTokens,
    reservationPricingVersion: row.reservationPricingVersion,
    ...(row.requestedProvider === null ? {} : { requestedProvider: row.requestedProvider }),
    ...(row.requestedModel === null ? {} : { requestedModel: row.requestedModel }),
    ...(row.actualProvider === null ? {} : { actualProvider: row.actualProvider }),
    ...(row.actualModel === null ? {} : { actualModel: row.actualModel }),
    ...(row.providerRequestId === null ? {} : { providerRequestId: row.providerRequestId }),
    ...(row.providerRequestSent === null ? {} : { providerRequestSent: row.providerRequestSent }),
    ...(row.inputTokens === null ? {} : { inputTokens: row.inputTokens }),
    ...(row.outputTokens === null ? {} : { outputTokens: row.outputTokens }),
    ...(row.totalTokens === null ? {} : { totalTokens: row.totalTokens }),
    ...(row.cached === null ? {} : { cached: row.cached }),
    ...(row.audioSeconds === null ? {} : { audioSeconds: row.audioSeconds }),
    ...(row.pricingMode === null || !AI_USAGE_PRICING_MODES.has(row.pricingMode)
      ? {}
      : { pricingMode: row.pricingMode as AIUsagePricingMode }),
    ...(row.pricingFallbackReason === null ||
    !AI_BILLING_FALLBACK_REASONS.has(row.pricingFallbackReason)
      ? {}
      : { pricingFallbackReason: row.pricingFallbackReason as AIUsagePricingFallbackReason }),
    ...(row.actualWalletTokens === null ? {} : { actualWalletTokens: row.actualWalletTokens }),
    ...(row.billingCurrency === null ? {} : { billingCurrency: row.billingCurrency }),
    ...(row.rateCardVersion === null ? {} : { rateCardVersion: row.rateCardVersion }),
    ...(row.walletPolicyVersion === null
      ? {}
      : { walletPolicyVersion: row.walletPolicyVersion }),
    ...(row.failureKind === null ? {} : { failureKind: row.failureKind }),
    ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
    ...(row.retryable === null ? {} : { retryable: row.retryable }),
    ...(row.reviewReasonCode === null ? {} : { reviewReasonCode: row.reviewReasonCode }),
    ...(row.consumeTransactionId === null
      ? {}
      : { consumeTransactionId: row.consumeTransactionId }),
    ...(row.executedAt === null ? {} : { executedAt: row.executedAt }),
    ...(row.pricedAt === null ? {} : { pricedAt: row.pricedAt }),
    ...(row.failedAt === null ? {} : { failedAt: row.failedAt }),
    ...(row.reviewedAt === null ? {} : { reviewedAt: row.reviewedAt }),
    ...(row.settledAt === null ? {} : { settledAt: row.settledAt }),
    ...(row.releasedAt === null ? {} : { releasedAt: row.releasedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createAIBillingOperation(
  input: CreateAIBillingOperationInput,
  dependencies: AIBillingOperationDependencies = createDefaultAIBillingOperationDependencies(),
): Promise<CreateAIBillingOperationResult> {
  const operationId = assertOperationId(input.operationId);
  const reservationId = assertReservationId(input.reservationId);
  const requested = parseRequestedIdentity(input.requestedProvider, input.requestedModel);
  const requestedProvider = requested.provider ?? null;
  const requestedModel = requested.model ?? null;

  let reservation;
  try {
    reservation = await dependencies.repository.findReservationById(reservationId);
  } catch (err) {
    wrapRepositoryRead(
      'AI billing reservation data could not be read reliably',
      operationId,
      reservationId,
      err,
    );
  }
  if (!reservation) {
    throw opError('RESERVATION_NOT_FOUND', 'AI billing reservation not found', {
      operationId,
      reservationId,
    });
  }
  if (reservation.status !== 'PENDING') {
    throw opError('RESERVATION_NOT_PENDING', 'AI billing reservation is not pending', {
      operationId,
      reservationId,
    });
  }

  let wallet: AIBillingOperationWalletRow | null;
  try {
    wallet = await dependencies.repository.findWalletById(reservation.walletId);
  } catch (err) {
    wrapRepositoryRead(
      'AI billing wallet data could not be read reliably',
      operationId,
      reservationId,
      err,
    );
  }
  if (!wallet) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing wallet could not be verified for this reservation',
      { operationId, reservationId, recoveryRequired: true },
    );
  }
  if (wallet.id !== reservation.walletId || wallet.userId !== reservation.userId) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing wallet ownership could not be verified for this reservation',
      { operationId, reservationId, recoveryRequired: true },
    );
  }

  const existingByOperationId = await findOperationByOperationId(
    dependencies,
    operationId,
    reservationId,
  );
  if (existingByOperationId) {
    if (
      matchesCreateIdentity(
        existingByOperationId,
        operationId,
        reservation,
        requestedProvider,
        requestedModel,
      )
    ) {
      return toCreateResult(existingByOperationId, true);
    }
    throw opError(
      'IDEMPOTENCY_CONFLICT',
      'AI billing operation already exists for this reservation',
      { operationId, reservationId },
    );
  }

  const existingByReservationId = await findOperationByReservationId(
    dependencies,
    operationId,
    reservationId,
  );
  if (existingByReservationId) {
    if (
      matchesCreateIdentity(
        existingByReservationId,
        operationId,
        reservation,
        requestedProvider,
        requestedModel,
      )
    ) {
      return toCreateResult(existingByReservationId, true);
    }
    throw opError(
      'IDEMPOTENCY_CONFLICT',
      'AI billing operation already exists for this reservation',
      { operationId, reservationId },
    );
  }

  let operation;
  try {
    operation = await dependencies.repository.createOperation({
      operationId,
      reservationId,
      walletId: reservation.walletId,
      userId: reservation.userId,
      feature: reservation.feature,
      source: reservation.source,
      reservedTokens: reservation.tokens,
      reservationPricingVersion: reservation.pricingVersion,
      requestedProvider,
      requestedModel,
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return resolveCreateConflict(
        dependencies,
        operationId,
        reservation,
        requestedProvider,
        requestedModel,
      );
    }
    throw opError('STORAGE_FAILED', 'AI billing operation could not be stored reliably', {
      operationId,
      reservationId,
      recoveryRequired: true,
    });
  }

  return toCreateResult(operation, false);
}

export async function recordAIBillingOperationExecutionSuccess(
  input: RecordAIBillingOperationExecutionSuccessInput,
  dependencies: AIBillingOperationDependencies = createDefaultAIBillingOperationDependencies(),
): Promise<RecordAIBillingOperationExecutionSuccessResult> {
  const operationId = assertOperationId(input.operationId);
  const execution = parseExecutionEvidence(input.execution);
  const usage = parseUsageEvidence(input.usage);

  if (execution.provider !== usage.provider || execution.model !== usage.model) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing execution identity does not match usage evidence',
      { operationId },
    );
  }

  const operation = await findOperationByOperationId(
    dependencies,
    operationId,
    operationId,
  );
  if (!operation) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { operationId });
  }

  if (operation.requestedProvider !== null && execution.provider !== operation.requestedProvider) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing actual provider does not match the requested provider',
      { operationId, reservationId: operation.reservationId },
    );
  }
  if (operation.requestedModel !== null && execution.model !== operation.requestedModel) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing actual model does not match the requested model',
      { operationId, reservationId: operation.reservationId },
    );
  }

  if (operation.status === 'EXECUTION_SUCCEEDED') {
    const set = buildSuccessSet(execution, usage, operation.executedAt ?? new Date());
    if (successEvidenceMatches(operation, set)) {
      return {
        operationId,
        reservationId: operation.reservationId,
        status: operation.status,
        executedAt: set.executedAt as Date,
        idempotentReplay: true,
      };
    }
    throw opError(
      'IDEMPOTENCY_CONFLICT',
      'AI billing operation already recorded conflicting execution evidence',
      { operationId, reservationId: operation.reservationId },
    );
  }

  if (operation.status !== 'RESERVED') {
    throw opError(
      'INVALID_TRANSITION',
      'AI billing operation cannot record execution from its current state',
      { operationId, reservationId: operation.reservationId },
    );
  }

  const executedAt = new Date();
  const set = buildSuccessSet(execution, usage, executedAt);
  const ok = await safeTransition(
    dependencies,
    operationId,
    operation.reservationId,
    ['RESERVED'],
    'EXECUTION_SUCCEEDED',
    set,
  );
  if (ok) {
    return {
      operationId,
      reservationId: operation.reservationId,
      status: 'EXECUTION_SUCCEEDED',
      executedAt,
      idempotentReplay: false,
    };
  }

  const fresh = await findOperationByOperationId(
    dependencies,
    operationId,
    operation.reservationId,
  );
  if (!fresh) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { operationId });
  }
  if (fresh.status === 'EXECUTION_SUCCEEDED') {
    if (successEvidenceMatches(fresh, set)) {
      return {
        operationId,
        reservationId: fresh.reservationId,
        status: fresh.status,
        executedAt: fresh.executedAt ?? executedAt,
        idempotentReplay: true,
      };
    }
    throw opError(
      'IDEMPOTENCY_CONFLICT',
      'AI billing operation already recorded conflicting execution evidence',
      { operationId, reservationId: fresh.reservationId },
    );
  }
  throw opError(
    'INVALID_TRANSITION',
    'AI billing operation cannot record execution from its current state',
    { operationId, reservationId: fresh.reservationId },
  );
}

export async function recordAIBillingOperationPricing(
  input: RecordAIBillingOperationPricingInput,
  dependencies: AIBillingOperationDependencies = createDefaultAIBillingOperationDependencies(),
): Promise<RecordAIBillingOperationPricingResult> {
  const operationId = assertOperationId(input.operationId);
  const pricing = parsePricingEvidence(input.pricing);

  const operation = await findOperationByOperationId(
    dependencies,
    operationId,
    operationId,
  );
  if (!operation) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { operationId });
  }

  if (pricing.walletTokens > operation.reservedTokens) {
    throw opError(
      'INVALID_INPUT',
      'Actual wallet tokens must not exceed the reserved amount',
      { operationId, reservationId: operation.reservationId },
    );
  }

  if (
    pricing.provider !== undefined &&
    operation.actualProvider !== null &&
    pricing.provider !== operation.actualProvider
  ) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing pricing provider does not match execution evidence',
      { operationId, reservationId: operation.reservationId },
    );
  }
  if (
    pricing.model !== undefined &&
    operation.actualModel !== null &&
    pricing.model !== operation.actualModel
  ) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing pricing model does not match execution evidence',
      { operationId, reservationId: operation.reservationId },
    );
  }

  if (operation.status === 'PRICED') {
    if (pricingEvidenceMatches(operation, pricing)) {
      return {
        operationId,
        reservationId: operation.reservationId,
        status: operation.status,
        pricedAt: operation.pricedAt ?? new Date(),
        actualWalletTokens: operation.actualWalletTokens ?? pricing.walletTokens,
        idempotentReplay: true,
      };
    }
    throw opError(
      'IDEMPOTENCY_CONFLICT',
      'AI billing operation already recorded conflicting pricing evidence',
      { operationId, reservationId: operation.reservationId },
    );
  }

  if (operation.status !== 'EXECUTION_SUCCEEDED') {
    throw opError(
      'INVALID_TRANSITION',
      'AI billing operation cannot record pricing from its current state',
      { operationId, reservationId: operation.reservationId },
    );
  }

  let reservation: AIBillingOperationReservationRow | null;
  try {
    reservation = await dependencies.repository.findReservationById(operation.reservationId);
  } catch (err) {
    wrapRepositoryRead(
      'AI billing reservation data could not be read reliably',
      operationId,
      operation.reservationId,
      err,
    );
  }
  if (!reservation) {
    throw opError('RESERVATION_NOT_FOUND', 'AI billing reservation not found', {
      operationId,
      reservationId: operation.reservationId,
    });
  }
  if (reservation.status !== 'PENDING') {
    throw opError(
      'INVALID_TRANSITION',
      'AI billing operation cannot record pricing from its current state',
      { operationId, reservationId: operation.reservationId },
    );
  }

  const pricedAt = new Date();
  const set = buildPricingSet(pricing, pricedAt);
  const ok = await safeTransition(
    dependencies,
    operationId,
    operation.reservationId,
    ['EXECUTION_SUCCEEDED'],
    'PRICED',
    set,
  );
  if (ok) {
    return {
      operationId,
      reservationId: operation.reservationId,
      status: 'PRICED',
      pricedAt,
      actualWalletTokens: pricing.walletTokens,
      idempotentReplay: false,
    };
  }

  const fresh = await findOperationByOperationId(
    dependencies,
    operationId,
    operation.reservationId,
  );
  if (!fresh) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { operationId });
  }
  if (fresh.status === 'PRICED') {
    if (pricingEvidenceMatches(fresh, pricing)) {
      return {
        operationId,
        reservationId: fresh.reservationId,
        status: fresh.status,
        pricedAt: fresh.pricedAt ?? pricedAt,
        actualWalletTokens: fresh.actualWalletTokens ?? pricing.walletTokens,
        idempotentReplay: true,
      };
    }
    throw opError(
      'IDEMPOTENCY_CONFLICT',
      'AI billing operation already recorded conflicting pricing evidence',
      { operationId, reservationId: fresh.reservationId },
    );
  }
  throw opError(
    'INVALID_TRANSITION',
    'AI billing operation cannot record pricing from its current state',
    { operationId, reservationId: fresh.reservationId },
  );
}

export async function recordAIBillingOperationFailure(
  input: RecordAIBillingOperationFailureInput,
  dependencies: AIBillingOperationDependencies = createDefaultAIBillingOperationDependencies(),
): Promise<RecordAIBillingOperationFailureResult> {
  const operationId = assertOperationId(input.operationId);
  const failure = parseFailureEvidence(input.failure);

  const operation = await findOperationByOperationId(
    dependencies,
    operationId,
    operationId,
  );
  if (!operation) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { operationId });
  }

  const target: AIBillingOperationStatus =
    failure.kind === 'NON_BILLABLE' ? 'NON_BILLABLE_CONFIRMED' : 'INDETERMINATE';
  const failedAt = new Date();
  const set = buildFailureSet(failure, failedAt);

  if (operation.status === target) {
    if (failureEvidenceMatches(operation, set)) {
      return {
        operationId,
        reservationId: operation.reservationId,
        status: operation.status,
        failureKind: failure.kind,
        providerRequestSent: failure.providerRequestSent,
        failedAt: operation.failedAt ?? failedAt,
        idempotentReplay: true,
      };
    }
    throw opError(
      'IDEMPOTENCY_CONFLICT',
      'AI billing operation already recorded conflicting failure evidence',
      { operationId, reservationId: operation.reservationId },
    );
  }

  if (operation.status !== 'RESERVED') {
    throw opError(
      'INVALID_TRANSITION',
      'AI billing operation cannot record a failure from its current state',
      { operationId, reservationId: operation.reservationId },
    );
  }

  const ok = await safeTransition(
    dependencies,
    operationId,
    operation.reservationId,
    ['RESERVED'],
    target,
    set,
  );
  if (ok) {
    return {
      operationId,
      reservationId: operation.reservationId,
      status: target,
      failureKind: failure.kind,
      providerRequestSent: failure.providerRequestSent,
      failedAt,
      idempotentReplay: false,
    };
  }

  const fresh = await findOperationByOperationId(
    dependencies,
    operationId,
    operation.reservationId,
  );
  if (!fresh) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { operationId });
  }
  if (fresh.status === target) {
    if (failureEvidenceMatches(fresh, set)) {
      return {
        operationId,
        reservationId: fresh.reservationId,
        status: fresh.status,
        failureKind: failure.kind,
        providerRequestSent: failure.providerRequestSent,
        failedAt: fresh.failedAt ?? failedAt,
        idempotentReplay: true,
      };
    }
    throw opError(
      'IDEMPOTENCY_CONFLICT',
      'AI billing operation already recorded conflicting failure evidence',
      { operationId, reservationId: fresh.reservationId },
    );
  }
  throw opError(
    'INVALID_TRANSITION',
    'AI billing operation cannot record a failure from its current state',
    { operationId, reservationId: fresh.reservationId },
  );
}

export async function markAIBillingOperationForReview(
  input: MarkAIBillingOperationForReviewInput,
  dependencies: AIBillingOperationDependencies = createDefaultAIBillingOperationDependencies(),
): Promise<MarkAIBillingOperationForReviewResult> {
  const operationId = assertOperationId(input.operationId);
  const reasonCode = assertReviewReasonCode(input.reasonCode);

  const operation = await findOperationByOperationId(
    dependencies,
    operationId,
    operationId,
  );
  if (!operation) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { operationId });
  }

  if (operation.status === 'REVIEW_REQUIRED') {
    if (operation.reviewReasonCode === reasonCode) {
      return {
        operationId,
        reservationId: operation.reservationId,
        status: operation.status,
        reviewedAt: operation.reviewedAt ?? new Date(),
        reviewRequired: true,
        idempotentReplay: true,
      };
    }
    throw opError(
      'IDEMPOTENCY_CONFLICT',
      'AI billing operation is already under review with different evidence',
      { operationId, reservationId: operation.reservationId },
    );
  }

  if (operation.status === 'SETTLED' || operation.status === 'RELEASED') {
    throw opError(
      'INVALID_TRANSITION',
      'AI billing operation cannot be sent for review once settled or released',
      { operationId, reservationId: operation.reservationId },
    );
  }

  const reviewedAt = new Date();
  const ok = await safeTransition(
    dependencies,
    operationId,
    operation.reservationId,
    REVIEWABLE_OPERATION_STATUSES,
    'REVIEW_REQUIRED',
    { reviewReasonCode: reasonCode, reviewedAt },
  );
  if (ok) {
    return {
      operationId,
      reservationId: operation.reservationId,
      status: 'REVIEW_REQUIRED',
      reviewedAt,
      reviewRequired: true,
      idempotentReplay: false,
    };
  }

  const fresh = await findOperationByOperationId(
    dependencies,
    operationId,
    operation.reservationId,
  );
  if (!fresh) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { operationId });
  }
  if (fresh.status === 'REVIEW_REQUIRED' && fresh.reviewReasonCode === reasonCode) {
    return {
      operationId,
      reservationId: fresh.reservationId,
      status: fresh.status,
      reviewedAt: fresh.reviewedAt ?? reviewedAt,
      reviewRequired: true,
      idempotentReplay: true,
    };
  }
  throw opError(
    'INVALID_TRANSITION',
    'AI billing operation cannot be sent for review from its current state',
    { operationId, reservationId: fresh.reservationId },
  );
}

export async function markAIBillingOperationSettled(
  input: MarkAIBillingOperationSettledInput,
  dependencies: AIBillingOperationDependencies = createDefaultAIBillingOperationDependencies(),
): Promise<MarkAIBillingOperationSettledResult> {
  const operationId = assertOperationId(input.operationId);

  const operation = await findOperationByOperationId(
    dependencies,
    operationId,
    operationId,
  );
  if (!operation) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { operationId });
  }

  const settlement = parseSettlementResult(input.settlement, operation.reservationId);

  if (operation.status === 'SETTLED') {
    if (settlementEvidenceMatches(operation, settlement)) {
      return {
        operationId,
        reservationId: operation.reservationId,
        status: operation.status,
        settledAt: operation.settledAt ?? settlement.settledAt,
        actualWalletTokens: operation.actualWalletTokens ?? settlement.actualTokens,
        consumeTransactionId: operation.consumeTransactionId ?? settlement.consumeTransactionId,
        idempotentReplay: true,
      };
    }
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing operation already recorded conflicting settlement evidence',
      { operationId, reservationId: operation.reservationId },
    );
  }

  if (operation.status !== 'PRICED') {
    throw opError(
      'INVALID_TRANSITION',
      'AI billing operation cannot be marked settled from its current state',
      { operationId, reservationId: operation.reservationId },
    );
  }

  if (settlement.tokens !== operation.reservedTokens) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing settlement reserved tokens do not match the operation snapshot',
      { operationId, reservationId: operation.reservationId },
    );
  }
  if (settlement.actualTokens !== operation.actualWalletTokens) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing settlement amount does not match priced evidence',
      { operationId, reservationId: operation.reservationId },
    );
  }
  if (
    operation.userId !== settlement.userId ||
    operation.walletId !== settlement.walletId
  ) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing settlement ownership does not match operation evidence',
      { operationId, reservationId: operation.reservationId },
    );
  }
  if (operation.feature !== settlement.feature || operation.source !== settlement.source) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing settlement feature does not match operation evidence',
      { operationId, reservationId: operation.reservationId },
    );
  }

  const ok = await safeTransition(
    dependencies,
    operationId,
    operation.reservationId,
    ['PRICED'],
    'SETTLED',
    {
      consumeTransactionId: settlement.consumeTransactionId,
      settledAt: settlement.settledAt,
    },
  );
  if (ok) {
    return {
      operationId,
      reservationId: operation.reservationId,
      status: 'SETTLED',
      settledAt: settlement.settledAt,
      actualWalletTokens: operation.actualWalletTokens as number,
      consumeTransactionId: settlement.consumeTransactionId,
      idempotentReplay: false,
    };
  }

  const fresh = await findOperationByOperationId(
    dependencies,
    operationId,
    operation.reservationId,
  );
  if (!fresh) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { operationId });
  }
  if (fresh.status === 'SETTLED') {
    if (settlementEvidenceMatches(fresh, settlement)) {
      return {
        operationId,
        reservationId: fresh.reservationId,
        status: fresh.status,
        settledAt: fresh.settledAt ?? settlement.settledAt,
        actualWalletTokens: fresh.actualWalletTokens ?? settlement.actualTokens,
        consumeTransactionId: fresh.consumeTransactionId ?? settlement.consumeTransactionId,
        idempotentReplay: true,
      };
    }
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing operation already recorded conflicting settlement evidence',
      { operationId, reservationId: fresh.reservationId },
    );
  }
  throw opError(
    'INVALID_TRANSITION',
    'AI billing operation cannot be marked settled from its current state',
    { operationId, reservationId: fresh.reservationId },
  );
}

export async function markAIBillingOperationReleased(
  input: MarkAIBillingOperationReleasedInput,
  dependencies: AIBillingOperationDependencies = createDefaultAIBillingOperationDependencies(),
): Promise<MarkAIBillingOperationReleasedResult> {
  const operationId = assertOperationId(input.operationId);

  const operation = await findOperationByOperationId(
    dependencies,
    operationId,
    operationId,
  );
  if (!operation) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { operationId });
  }

  const release = parseReleaseResult(input.release, operation.reservationId);

  if (operation.status === 'RELEASED') {
    if (releaseEvidenceMatches(operation, release)) {
      return {
        operationId,
        reservationId: operation.reservationId,
        status: operation.status,
        releasedAt: operation.releasedAt ?? release.releasedAt,
        idempotentReplay: true,
      };
    }
    throw opError(
      'IDEMPOTENCY_CONFLICT',
      'AI billing operation already recorded conflicting release evidence',
      { operationId, reservationId: operation.reservationId },
    );
  }

  if (operation.status !== 'NON_BILLABLE_CONFIRMED') {
    throw opError(
      'INVALID_TRANSITION',
      'AI billing operation cannot be marked released from its current state',
      { operationId, reservationId: operation.reservationId },
    );
  }

  if (release.tokens !== operation.reservedTokens) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing release reserved tokens do not match the operation snapshot',
      { operationId, reservationId: operation.reservationId },
    );
  }
  if (
    operation.userId !== release.userId ||
    operation.walletId !== release.walletId
  ) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing release ownership does not match operation evidence',
      { operationId, reservationId: operation.reservationId },
    );
  }
  if (operation.feature !== release.feature || operation.source !== release.source) {
    throw opError(
      'INTEGRITY_CONFLICT',
      'AI billing release feature does not match operation evidence',
      { operationId, reservationId: operation.reservationId },
    );
  }

  const ok = await safeTransition(
    dependencies,
    operationId,
    operation.reservationId,
    ['NON_BILLABLE_CONFIRMED'],
    'RELEASED',
    { releasedAt: release.releasedAt },
  );
  if (ok) {
    return {
      operationId,
      reservationId: operation.reservationId,
      status: 'RELEASED',
      releasedAt: release.releasedAt,
      idempotentReplay: false,
    };
  }

  const fresh = await findOperationByOperationId(
    dependencies,
    operationId,
    operation.reservationId,
  );
  if (!fresh) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { operationId });
  }
  if (fresh.status === 'RELEASED') {
    if (releaseEvidenceMatches(fresh, release)) {
      return {
        operationId,
        reservationId: fresh.reservationId,
        status: fresh.status,
        releasedAt: fresh.releasedAt ?? release.releasedAt,
        idempotentReplay: true,
      };
    }
    throw opError(
      'IDEMPOTENCY_CONFLICT',
      'AI billing operation already recorded conflicting release evidence',
      { operationId, reservationId: fresh.reservationId },
    );
  }
  throw opError(
    'INVALID_TRANSITION',
    'AI billing operation cannot be marked released from its current state',
    { operationId, reservationId: fresh.reservationId },
  );
}

export async function getAIBillingOperationByOperationId(
  input: ReadAIBillingOperationByOperationIdInput,
  dependencies: AIBillingOperationDependencies = createDefaultAIBillingOperationDependencies(),
): Promise<AIBillingOperationEvidenceResult> {
  const operationId = assertOperationId(input.operationId);
  const operation = await findOperationByOperationId(dependencies, operationId, operationId);
  if (!operation) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { operationId });
  }
  return toEvidenceResult(operation);
}

export async function getAIBillingOperationByReservationId(
  input: ReadAIBillingOperationByReservationIdInput,
  dependencies: AIBillingOperationDependencies = createDefaultAIBillingOperationDependencies(),
): Promise<AIBillingOperationEvidenceResult> {
  const reservationId = assertReservationId(input.reservationId);
  const operation = await findOperationByReservationId(
    dependencies,
    reservationId,
    reservationId,
  );
  if (!operation) {
    throw opError('OPERATION_NOT_FOUND', 'AI billing operation not found', { reservationId });
  }
  return toEvidenceResult(operation);
}
