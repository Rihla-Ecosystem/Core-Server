import type {
  AIBillingMetadataStatus,
  AIBillingRecoveryAction,
  AIBillingRecoveryErrorCode,
  AIBillingRecoveryErrorOptions,
  AIBillingRecoveryReasonCode,
  AIBillingRecoveryRecommendation,
  InspectAIBillingRecoveryInput,
  InspectAIBillingRecoveryResult,
  ReconcileWalletReservationsInput,
  ReconcileWalletReservationsResult,
  RecoverAIBillingReservationInput,
  RecoverAIBillingReservationResult,
} from '../types/ai-billing-recovery.js';
import type { AIUsagePricingMode } from '../types/ai-pricing.js';
import type {
  AIBillingRecoveryRepository,
  AIBillingRecoveryReservationRow,
  AIBillingRecoveryWalletRow,
} from '../repositories/ai-billing-recovery.repository.js';
import { createPrismaAIBillingRecoveryRepository } from '../repositories/ai-billing-recovery.repository.js';
import type {
  ReleaseBusinessTokenReservationInput,
  ReleaseBusinessTokenReservationResult,
  SettleBusinessTokenReservationForAmountInput,
  SettleBusinessTokenReservationResult,
} from './token-reservation.service.js';
import {
  releaseBusinessTokenReservation,
  settleBusinessTokenReservationForAmount,
} from './token-reservation.service.js';
import { AppError } from '../middleware/errorHandler.js';

const AI_USAGE_PRICING_MODES = new Set<string>(['PROVIDER_USAGE', 'FIXED_FALLBACK']);

export class AIBillingRecoveryError extends Error {
  readonly code: AIBillingRecoveryErrorCode;
  readonly recoveryRequired: boolean;
  readonly reservationId?: string;

  constructor(
    code: AIBillingRecoveryErrorCode,
    message: string,
    options: AIBillingRecoveryErrorOptions = {},
  ) {
    super(message);
    this.name = 'AIBillingRecoveryError';
    this.code = code;
    this.recoveryRequired = options.recoveryRequired ?? false;
    this.reservationId = options.reservationId;
  }
}

export interface AIBillingRecoveryDependencies {
  repository: AIBillingRecoveryRepository;
  settleForAmount: (
    input: SettleBusinessTokenReservationForAmountInput,
  ) => Promise<SettleBusinessTokenReservationResult>;
  releaseReservation: (
    input: ReleaseBusinessTokenReservationInput,
  ) => Promise<ReleaseBusinessTokenReservationResult>;
}

export function createDefaultAIBillingRecoveryDependencies(): AIBillingRecoveryDependencies {
  return {
    repository: createPrismaAIBillingRecoveryRepository(),
    settleForAmount: settleBusinessTokenReservationForAmount,
    releaseReservation: releaseBusinessTokenReservation,
  };
}

function recoveryError(
  code: AIBillingRecoveryErrorCode,
  message: string,
  options: AIBillingRecoveryErrorOptions = {},
): AIBillingRecoveryError {
  return new AIBillingRecoveryError(code, message, options);
}

function wrapRepositoryRead(
  code: AIBillingRecoveryErrorCode,
  message: string,
  reservationId: string | undefined,
  err: unknown,
): never {
  if (err instanceof AIBillingRecoveryError) {
    throw err;
  }
  throw recoveryError(code, message, {
    reservationId,
    recoveryRequired: true,
  });
}

async function assertReservationWalletOwnership(
  reservation: AIBillingRecoveryReservationRow,
  dependencies: AIBillingRecoveryDependencies,
): Promise<AIBillingRecoveryWalletRow> {
  let wallet;
  try {
    wallet = await dependencies.repository.findWalletById(reservation.walletId);
  } catch (err) {
    wrapRepositoryRead(
      'INTEGRITY_CONFLICT',
      'AI billing reservation data could not be read reliably',
      reservation.id,
      err,
    );
  }

  if (!wallet) {
    throw recoveryError(
      'INTEGRITY_CONFLICT',
      'AI billing reservation references a missing wallet',
      { reservationId: reservation.id, recoveryRequired: true },
    );
  }

  if (wallet.userId !== reservation.userId) {
    throw recoveryError(
      'INTEGRITY_CONFLICT',
      'AI billing reservation wallet ownership mismatch',
      { reservationId: reservation.id, recoveryRequired: true },
    );
  }

  return wallet;
}

function assertRecoveryReservationId(reservationId: unknown): string {
  if (typeof reservationId !== 'string') {
    throw recoveryError('INVALID_INPUT', 'reservationId must not be empty');
  }
  const trimmed = reservationId.trim();
  if (!trimmed) {
    throw recoveryError('INVALID_INPUT', 'reservationId must not be empty');
  }
  return trimmed;
}

function assertRecoveryWalletId(walletId: unknown): string {
  if (typeof walletId !== 'string') {
    throw recoveryError('INVALID_INPUT', 'walletId must not be empty');
  }
  const trimmed = walletId.trim();
  if (!trimmed) {
    throw recoveryError('INVALID_INPUT', 'walletId must not be empty');
  }
  return trimmed;
}

function assertRecoveryReason(reason: unknown): string {
  if (typeof reason !== 'string') {
    throw recoveryError('INVALID_INPUT', 'reason must be a non-empty string');
  }
  const trimmed = reason.trim();
  if (!trimmed) {
    throw recoveryError('INVALID_INPUT', 'reason must be a non-empty string');
  }
  return trimmed;
}

function assertOptionalEvidenceReference(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw recoveryError('INVALID_INPUT', 'evidenceReference must be a non-empty string when provided');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw recoveryError('INVALID_INPUT', 'evidenceReference must be a non-empty string when provided');
  }
  return trimmed;
}

function assertConfirmedActualTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw recoveryError(
      'INVALID_INPUT',
      'Confirmed actual tokens must be a safe non-negative integer',
    );
  }
  return value;
}

function assertRecoveryAction(value: unknown): AIBillingRecoveryAction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw recoveryError('INVALID_INPUT', 'action must be a valid recovery action');
  }
  const action = value as Record<string, unknown>;

  if (action.type === 'SETTLE') {
    const reason = assertRecoveryReason(action.reason);
    const evidenceReference = assertOptionalEvidenceReference(action.evidenceReference);
    if (action.confirmation !== 'ACTUAL_TOKENS_CONFIRMED') {
      throw recoveryError(
        'INVALID_INPUT',
        'Settlement requires ACTUAL_TOKENS_CONFIRMED confirmation',
      );
    }
    const actualTokens = assertConfirmedActualTokens(action.actualTokens);
    return {
      type: 'SETTLE',
      confirmation: 'ACTUAL_TOKENS_CONFIRMED',
      actualTokens,
      reason,
      ...(evidenceReference === undefined ? {} : { evidenceReference }),
    };
  }

  if (action.type === 'RELEASE') {
    const reason = assertRecoveryReason(action.reason);
    const evidenceReference = assertOptionalEvidenceReference(action.evidenceReference);
    if (action.confirmation !== 'CONFIRMED_NON_BILLABLE') {
      throw recoveryError(
        'INVALID_INPUT',
        'Release requires CONFIRMED_NON_BILLABLE confirmation',
      );
    }
    if (action.actualTokens !== undefined) {
      throw recoveryError(
        'INVALID_INPUT',
        'Release must not include a confirmed actual token amount',
      );
    }
    return {
      type: 'RELEASE',
      confirmation: 'CONFIRMED_NON_BILLABLE',
      reason,
      ...(evidenceReference === undefined ? {} : { evidenceReference }),
    };
  }

  if (action.type === 'REVIEW') {
    const reason = assertRecoveryReason(action.reason);
    if (action.confirmation !== undefined) {
      throw recoveryError('INVALID_INPUT', 'Review must not include a confirmation');
    }
    if (action.actualTokens !== undefined) {
      throw recoveryError(
        'INVALID_INPUT',
        'Review must not include a confirmed actual token amount',
      );
    }
    if (action.evidenceReference !== undefined) {
      throw recoveryError('INVALID_INPUT', 'Review must not include an evidence reference');
    }
    return { type: 'REVIEW', reason };
  }

  throw recoveryError('INVALID_INPUT', 'action type is not a recognized recovery action');
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidPricingMode(value: unknown): value is AIUsagePricingMode {
  return typeof value === 'string' && AI_USAGE_PRICING_MODES.has(value);
}

type ParsedAIBillingMetadata =
  | {
      status: 'VALID';
      summary: {
        quotedTokens: number;
        requestedMode: AIUsagePricingMode;
        quoteAppliedMode: AIUsagePricingMode;
        maximumUsageWalletTokens?: number;
        provider?: string;
        model?: string;
        billingCurrency?: string;
        rateCardVersion?: string;
        walletPolicyVersion?: string;
      };
    }
  | { status: 'MISSING' }
  | { status: 'INVALID' };

function parseAIBillingMetadata(metadata: unknown): ParsedAIBillingMetadata {
  if (metadata === null || metadata === undefined) {
    return { status: 'MISSING' };
  }
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { status: 'INVALID' };
  }
  const root = metadata as Record<string, unknown>;
  const aiBilling = root.aiBilling;
  if (aiBilling === null || aiBilling === undefined) {
    return { status: 'MISSING' };
  }
  if (typeof aiBilling !== 'object' || Array.isArray(aiBilling)) {
    return { status: 'INVALID' };
  }
  const section = aiBilling as Record<string, unknown>;

  if (section.schemaVersion !== 1) {
    return { status: 'INVALID' };
  }
  if (!isSafeNonNegativeInteger(section.quotedTokens)) {
    return { status: 'INVALID' };
  }
  if (!isSafeNonNegativeInteger(section.fixedFallbackTokens)) {
    return { status: 'INVALID' };
  }
  if (!isSafeNonNegativeInteger(section.maxInputTokens)) {
    return { status: 'INVALID' };
  }
  if (!isSafeNonNegativeInteger(section.maxOutputTokens)) {
    return { status: 'INVALID' };
  }
  if (!isValidPricingMode(section.requestedMode)) {
    return { status: 'INVALID' };
  }
  if (!isValidPricingMode(section.quoteAppliedMode)) {
    return { status: 'INVALID' };
  }
  if (section.maximumUsageWalletTokens !== undefined && !isSafeNonNegativeInteger(section.maximumUsageWalletTokens)) {
    return { status: 'INVALID' };
  }
  if (section.provider !== undefined && !isNonEmptyString(section.provider)) {
    return { status: 'INVALID' };
  }
  if (section.model !== undefined && !isNonEmptyString(section.model)) {
    return { status: 'INVALID' };
  }
  if (section.billingCurrency !== undefined && !isNonEmptyString(section.billingCurrency)) {
    return { status: 'INVALID' };
  }
  if (section.rateCardVersion !== undefined && !isNonEmptyString(section.rateCardVersion)) {
    return { status: 'INVALID' };
  }
  if (section.walletPolicyVersion !== undefined && !isNonEmptyString(section.walletPolicyVersion)) {
    return { status: 'INVALID' };
  }

  return {
    status: 'VALID',
    summary: {
      quotedTokens: section.quotedTokens,
      requestedMode: section.requestedMode,
      quoteAppliedMode: section.quoteAppliedMode,
      ...(section.maximumUsageWalletTokens === undefined
        ? {}
        : { maximumUsageWalletTokens: section.maximumUsageWalletTokens }),
      ...(section.provider === undefined ? {} : { provider: section.provider }),
      ...(section.model === undefined ? {} : { model: section.model }),
      ...(section.billingCurrency === undefined ? {} : { billingCurrency: section.billingCurrency }),
      ...(section.rateCardVersion === undefined ? {} : { rateCardVersion: section.rateCardVersion }),
      ...(section.walletPolicyVersion === undefined
        ? {}
        : { walletPolicyVersion: section.walletPolicyVersion }),
    },
  };
}

export async function inspectAIBillingRecovery(
  input: InspectAIBillingRecoveryInput,
  dependencies: AIBillingRecoveryDependencies = createDefaultAIBillingRecoveryDependencies(),
): Promise<InspectAIBillingRecoveryResult> {
  const reservationId = assertRecoveryReservationId(input.reservationId);
  const inspectedAt = new Date();

  let reservation;
  try {
    reservation = await dependencies.repository.findReservationById(reservationId);
  } catch (err) {
    wrapRepositoryRead(
      'INTEGRITY_CONFLICT',
      'AI billing reservation data could not be read reliably',
      reservationId,
      err,
    );
  }

  if (!reservation) {
    throw recoveryError('RESERVATION_NOT_FOUND', 'AI billing reservation not found', {
      reservationId,
    });
  }

  await assertReservationWalletOwnership(reservation, dependencies);

  let consumes;
  try {
    consumes = await dependencies.repository.findConsumeForReservation(reservation);
  } catch (err) {
    wrapRepositoryRead(
      'INTEGRITY_CONFLICT',
      'AI billing reservation data could not be read reliably',
      reservationId,
      err,
    );
  }

  const parsed = parseAIBillingMetadata(reservation.metadata);
  let metadataStatus: AIBillingMetadataStatus;
  if (parsed.status === 'MISSING') {
    metadataStatus = 'MISSING';
  } else if (parsed.status === 'INVALID') {
    metadataStatus = 'INVALID';
  } else {
    metadataStatus = parsed.summary.quotedTokens === reservation.tokens ? 'VALID' : 'INVALID';
  }
  const metadataSummary =
    parsed.status === 'VALID' && metadataStatus === 'VALID' ? parsed.summary : undefined;

  let recommendation: AIBillingRecoveryRecommendation;
  let recoveryRequired: boolean;
  let integrityConflict = false;
  let consumeTransactionId: string | undefined;
  let consumedTokens: number | undefined;
  let releasedTokens: number | undefined;

  if (reservation.status === 'COMPLETED') {
    const consume = consumes[0];
    const validCompleted =
      reservation.settledAt !== null &&
      reservation.releasedAt === null &&
      consumes.length === 1 &&
      consume !== undefined &&
      isSafeNonNegativeInteger(consume.tokens) &&
      consume.tokens <= reservation.tokens;

    if (validCompleted) {
      recommendation = 'NO_ACTION';
      recoveryRequired = false;
      consumeTransactionId = consume.id;
      consumedTokens = consume.tokens;
      releasedTokens = reservation.tokens - consume.tokens;
    } else {
      recommendation = 'REVIEW';
      recoveryRequired = true;
      integrityConflict = true;
    }
  } else if (reservation.status === 'RELEASED') {
    const validReleased =
      reservation.releasedAt !== null &&
      reservation.settledAt === null &&
      consumes.length === 0;

    if (validReleased) {
      recommendation = 'NO_ACTION';
      recoveryRequired = false;
    } else {
      recommendation = 'REVIEW';
      recoveryRequired = true;
      integrityConflict = true;
    }
  } else {
    if (consumes.length > 0) {
      integrityConflict = true;
    }
    recommendation = 'REVIEW';
    recoveryRequired = true;
  }

  let reasonCode: AIBillingRecoveryReasonCode;
  if (integrityConflict) {
    reasonCode = 'INTEGRITY_CONFLICT';
  } else if (reservation.status === 'PENDING') {
    reasonCode =
      metadataStatus === 'MISSING'
        ? 'METADATA_MISSING'
        : metadataStatus === 'INVALID'
          ? 'METADATA_INVALID'
          : 'PENDING_REVIEW';
  } else {
    reasonCode = 'RESOLVED';
  }

  return {
    reservationId,
    referenceId: reservation.referenceId,
    walletId: reservation.walletId,
    userId: reservation.userId,
    feature: reservation.feature,
    source: reservation.source,
    reservationStatus: reservation.status,
    reservedTokens: reservation.tokens,
    pricingVersion: reservation.pricingVersion,
    expiresAt: reservation.expiresAt,
    isExpired: reservation.expiresAt.getTime() <= inspectedAt.getTime(),
    metadataStatus,
    ...(metadataSummary === undefined
      ? {}
      : {
          quotedTokens: metadataSummary.quotedTokens,
          requestedMode: metadataSummary.requestedMode,
          quoteAppliedMode: metadataSummary.quoteAppliedMode,
          ...(metadataSummary.maximumUsageWalletTokens === undefined
            ? {}
            : { maximumUsageWalletTokens: metadataSummary.maximumUsageWalletTokens }),
          ...(metadataSummary.provider === undefined ? {} : { provider: metadataSummary.provider }),
          ...(metadataSummary.model === undefined ? {} : { model: metadataSummary.model }),
          ...(metadataSummary.billingCurrency === undefined
            ? {}
            : { billingCurrency: metadataSummary.billingCurrency }),
          ...(metadataSummary.rateCardVersion === undefined
            ? {}
            : { rateCardVersion: metadataSummary.rateCardVersion }),
          ...(metadataSummary.walletPolicyVersion === undefined
            ? {}
            : { walletPolicyVersion: metadataSummary.walletPolicyVersion }),
        }),
    ...(consumeTransactionId === undefined ? {} : { consumeTransactionId }),
    ...(consumedTokens === undefined ? {} : { consumedTokens }),
    ...(releasedTokens === undefined ? {} : { releasedTokens }),
    recommendation,
    automaticFinancialActionAllowed: false,
    recoveryRequired,
    reasonCode,
    integrityConflict,
    inspectedAt,
  };
}

export async function recoverAIBillingReservation(
  input: RecoverAIBillingReservationInput,
  dependencies: AIBillingRecoveryDependencies = createDefaultAIBillingRecoveryDependencies(),
): Promise<RecoverAIBillingReservationResult> {
  const reservationId = assertRecoveryReservationId(input.reservationId);
  const action = assertRecoveryAction(input.action);

  let reservation;
  try {
    reservation = await dependencies.repository.findReservationById(reservationId);
  } catch (err) {
    wrapRepositoryRead(
      'INTEGRITY_CONFLICT',
      'AI billing reservation data could not be read reliably',
      reservationId,
      err,
    );
  }

  if (!reservation) {
    throw recoveryError('RESERVATION_NOT_FOUND', 'AI billing reservation not found', {
      reservationId,
    });
  }

  const parsed = parseAIBillingMetadata(reservation.metadata);
  const metadataStatus: AIBillingMetadataStatus =
    parsed.status === 'MISSING'
      ? 'MISSING'
      : parsed.status === 'INVALID'
        ? 'INVALID'
        : parsed.summary.quotedTokens === reservation.tokens
          ? 'VALID'
          : 'INVALID';

  switch (action.type) {
    case 'SETTLE': {
      await assertReservationWalletOwnership(reservation, dependencies);
      if (metadataStatus !== 'VALID') {
        throw recoveryError(
          'METADATA_INVALID',
          'AI billing reservation metadata is missing or invalid',
          { reservationId },
        );
      }
      if (action.actualTokens > reservation.tokens) {
        throw recoveryError(
          'INVALID_INPUT',
          'Confirmed actual tokens must not exceed the reserved amount',
          { reservationId },
        );
      }

      let settlement: SettleBusinessTokenReservationResult;
      try {
        settlement = await dependencies.settleForAmount({
          reservationId,
          actualTokens: action.actualTokens,
        });
      } catch (err) {
        if (err instanceof AppError) {
          if (err.statusCode === 404) {
            throw recoveryError(
              'RESERVATION_NOT_FOUND',
              'AI billing reservation not found during settlement',
              { reservationId, recoveryRequired: true },
            );
          }
          if (err.statusCode === 409) {
            throw recoveryError('INTEGRITY_CONFLICT', 'AI billing reservation cannot be settled', {
              reservationId,
              recoveryRequired: true,
            });
          }
        }
        throw recoveryError('SETTLEMENT_FAILED', 'AI billing reservation settlement failed', {
          reservationId,
          recoveryRequired: true,
        });
      }

      const idempotentReplay = settlement.idempotentReplay;
      return {
        reservationId,
        outcome: idempotentReplay ? 'ALREADY_SETTLED' : 'SETTLED',
        status: settlement.status,
        financialMutationPerformed: !idempotentReplay,
        recoveryRequired: false,
        actualTokens: settlement.actualTokens,
        releasedTokens: settlement.releasedTokens,
        consumeTransactionId: settlement.consumeTransactionId,
        idempotentReplay,
        reason: action.reason,
        ...(action.evidenceReference === undefined
          ? {}
          : { evidenceReference: action.evidenceReference }),
      };
    }

    case 'RELEASE': {
      await assertReservationWalletOwnership(reservation, dependencies);
      if (metadataStatus !== 'VALID') {
        throw recoveryError(
          'METADATA_INVALID',
          'AI billing reservation metadata is missing or invalid',
          { reservationId },
        );
      }

      let released: ReleaseBusinessTokenReservationResult;
      try {
        released = await dependencies.releaseReservation({
          reservationId,
          reason: action.reason,
        });
      } catch (err) {
        if (err instanceof AppError) {
          if (err.statusCode === 404) {
            throw recoveryError(
              'RESERVATION_NOT_FOUND',
              'AI billing reservation not found during release',
              { reservationId, recoveryRequired: true },
            );
          }
          if (err.statusCode === 409) {
            throw recoveryError('INTEGRITY_CONFLICT', 'AI billing reservation cannot be released', {
              reservationId,
              recoveryRequired: true,
            });
          }
        }
        throw recoveryError('RELEASE_FAILED', 'AI billing reservation release failed', {
          reservationId,
          recoveryRequired: true,
        });
      }

      const idempotentReplay = released.idempotentReplay;
      return {
        reservationId,
        outcome: idempotentReplay ? 'ALREADY_RELEASED' : 'RELEASED',
        status: released.status,
        financialMutationPerformed: !idempotentReplay,
        recoveryRequired: false,
        idempotentReplay,
        reason: action.reason,
        ...(action.evidenceReference === undefined
          ? {}
          : { evidenceReference: action.evidenceReference }),
      };
    }

    case 'REVIEW': {
      return {
        reservationId,
        outcome: 'REVIEW_REQUIRED',
        status: reservation.status,
        financialMutationPerformed: false,
        recoveryRequired: true,
        reason: action.reason,
      };
    }
  }
}

export async function reconcileWalletReservations(
  input: ReconcileWalletReservationsInput,
  dependencies: AIBillingRecoveryDependencies = createDefaultAIBillingRecoveryDependencies(),
): Promise<ReconcileWalletReservationsResult> {
  const walletId = assertRecoveryWalletId(input.walletId);

  let snapshot;
  try {
    snapshot = await dependencies.repository.readReconciliationSnapshot(walletId);
  } catch (err) {
    wrapRepositoryRead(
      'RECONCILIATION_FAILED',
      'Wallet reservation reconciliation data could not be read reliably',
      undefined,
      err,
    );
  }

  if (!snapshot.wallet) {
    throw recoveryError('RECONCILIATION_FAILED', 'Wallet not found for reservation reconciliation');
  }

  const actualReservedBalance = snapshot.wallet.reservedBalance;
  const expectedPendingReservedTokens = snapshot.pending.totalTokens;
  const pendingReservationCount = snapshot.pending.count;

  if (
    !isSafeNonNegativeInteger(actualReservedBalance) ||
    !isSafeNonNegativeInteger(expectedPendingReservedTokens) ||
    !isSafeNonNegativeInteger(pendingReservationCount)
  ) {
    throw recoveryError(
      'RECONCILIATION_FAILED',
      'Wallet reservation reconciliation encountered invalid balances',
    );
  }

  const difference = actualReservedBalance - expectedPendingReservedTokens;
  const matched = difference === 0;

  return {
    walletId,
    userId: snapshot.wallet.userId,
    status: matched ? 'MATCH' : 'MISMATCH',
    actualReservedBalance,
    expectedPendingReservedTokens,
    difference,
    pendingReservationCount,
    walletStatus: snapshot.wallet.status,
    recoveryRequired: !matched,
    inspectedAt: new Date(),
  };
}
