import type {
  AIBillingMetadataStatus,
  AIBillingRecoveryAction,
  AIBillingRecoveryErrorCode,
  AIBillingRecoveryErrorOptions,
  AIBillingRecoveryQueueInput,
  AIBillingRecoveryQueueItem,
  AIBillingRecoveryQueueResult,
  AIBillingRecoveryReasonCode,
  AIBillingRecoveryRecommendation,
  AIBillingRecoveryRepricingRecommendation,
  AIBillingRepricingItemizedCall,
  AIBillingRepricingStatus,
  InspectAIBillingRecoveryInput,
  InspectAIBillingRecoveryResult,
  MetadataIssue,
  ReconcileWalletReservationsInput,
  ReconcileWalletReservationsResult,
  RecoverAIBillingReservationInput,
  RecoverAIBillingReservationResult,
  WalletPolicySnapshot,
} from '../types/ai-billing-recovery.js';
import { aiBillingRecoveryErrorStatus } from '../types/ai-billing-recovery.js';
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
import { aggregateProviderCalls } from '../utils/provider-pricing/aggregate.js';
import { normalizePersistedProviderCallsForPricing } from '../utils/provider-pricing/persisted-call.js';
import { computeWalletCharge } from '../utils/wallet-conversion.js';
import {
  loadRateCardByVersion,
  type ProviderRateCardLoaderDependencies,
  createDefaultProviderRateCardLoaderDependencies,
} from './provider-rate-card-loader.service.js';
import { ProviderRateCardLoadError } from '../types/provider-rate-card-load.js';
import { createPrismaProviderRateCardRepository } from '../repositories/provider-rate-card.repository.js';

// ---------------------------------------------------------------------------
// Error Class & Helpers
// ---------------------------------------------------------------------------

export class AIBillingRecoveryError extends Error {
  readonly code: AIBillingRecoveryErrorCode;
  readonly statusCode: number;
  readonly reservationId?: string;
  readonly recoveryRequired: boolean;

  constructor(
    code: AIBillingRecoveryErrorCode,
    message: string,
    options: AIBillingRecoveryErrorOptions = {},
  ) {
    super(message);
    this.name = 'AIBillingRecoveryError';
    this.code = code;
    this.statusCode = options.statusCode ?? aiBillingRecoveryErrorStatus(code);
    this.reservationId = options.reservationId;
    this.recoveryRequired = options.recoveryRequired ?? true;
  }
}

function recoveryError(
  code: AIBillingRecoveryErrorCode,
  message: string,
  options: AIBillingRecoveryErrorOptions = {},
): AIBillingRecoveryError {
  return new AIBillingRecoveryError(code, message, options);
}

// ---------------------------------------------------------------------------
// Pure Validation & Metadata Parsing
// ---------------------------------------------------------------------------

const AI_USAGE_PRICING_MODES = new Set<string>([
  'FIXED_FALLBACK',
  'PROVIDER_USAGE',
]);

function isSafeNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    Number.isSafeInteger(value)
  ) || typeof value === 'bigint';
}

function isValidPricingMode(value: unknown): value is AIUsagePricingMode {
  return typeof value === 'string' && AI_USAGE_PRICING_MODES.has(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The `reservationAmountFromMetadata` field provides a contract-normalized token
 * amount that callers MUST validate against `TokenReservation.tokens` before
 * any financial recovery action. For legacy metadata this equals `quotedTokens`;
 * for current usage-based metadata this equals `reservationTokens`.
 */
export type ParsedAIBillingMetadata =
  | {
      status: 'VALID';
      metadataContract: 'LEGACY';
      /** Normalized reservation amount from metadata — validate against reservation.tokens. */
      reservationAmountFromMetadata: number;
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
      metadataIssues: MetadataIssue[];
      observed: Record<string, unknown>;
    }
  | {
      status: 'VALID';
      metadataContract: 'USAGE_BASED';
      /** Normalized reservation amount from metadata — validate against reservation.tokens. */
      reservationAmountFromMetadata: number;
      summary: {
        reservationTokens: number;
        maxInputTokens: number;
        maxOutputTokens: number;
        rateCardVersion: string;
        walletPolicyVersion: string;
        provider?: string;
        model?: string;
      };
      metadataIssues: MetadataIssue[];
      observed: Record<string, unknown>;
    }
  | {
      status: 'MISSING';
      metadataIssues: MetadataIssue[];
      observed?: Record<string, unknown>;
    }
  | {
      status: 'INVALID';
      metadataIssues: MetadataIssue[];
      observed?: Record<string, unknown>;
    };

export interface AIBillingRecoveryDependencies {
  repository: AIBillingRecoveryRepository;
  settleForAmount: (
    input: SettleBusinessTokenReservationForAmountInput,
  ) => Promise<SettleBusinessTokenReservationResult>;
  releaseReservation: (
    input: ReleaseBusinessTokenReservationInput,
  ) => Promise<ReleaseBusinessTokenReservationResult>;
  /** Rate-card loader dependency injected for testability; defaults to Prisma-backed loader. */
  rateCardLoader: ProviderRateCardLoaderDependencies;
}

export function createDefaultAIBillingRecoveryDependencies(): AIBillingRecoveryDependencies {
  return {
    repository: createPrismaAIBillingRecoveryRepository(),
    settleForAmount: settleBusinessTokenReservationForAmount,
    releaseReservation: releaseBusinessTokenReservation,
    rateCardLoader: createDefaultProviderRateCardLoaderDependencies(
      createPrismaProviderRateCardRepository(),
    ),
  };
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
    // A thrown repository read is an infrastructure failure, not a domain conflict.
    statusCode: 500,
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

function assertRecoveryQueuePage(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw recoveryError('INVALID_INPUT', 'page must be a positive integer');
  }
  return value;
}

function assertRecoveryQueueLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw recoveryError('INVALID_INPUT', 'limit must be an integer between 1 and 100');
  }
  return value;
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

  if (action.type === 'MANUAL_RELEASE') {
    const reason = assertRecoveryReason(action.reason);
    const evidenceReference = assertOptionalEvidenceReference(action.evidenceReference);
    if (
      action.confirmation !== undefined &&
      action.confirmation !== 'ADMIN_CONFIRMED_NON_BILLABLE'
    ) {
      throw recoveryError(
        'INVALID_INPUT',
        'Manual release requires ADMIN_CONFIRMED_NON_BILLABLE confirmation when confirmation is provided',
      );
    }
    if (action.actualTokens !== undefined) {
      throw recoveryError(
        'INVALID_INPUT',
        'Manual release must not include a confirmed actual token amount',
      );
    }
    return {
      type: 'MANUAL_RELEASE',
      confirmation: 'ADMIN_CONFIRMED_NON_BILLABLE',
      reason,
      ...(evidenceReference === undefined ? {} : { evidenceReference }),
    };
  }

  if (action.type === 'MANUAL_SETTLE') {
    const reason = assertRecoveryReason(action.reason);
    const evidenceReference = assertOptionalEvidenceReference(action.evidenceReference);
    if (
      action.confirmation !== undefined &&
      action.confirmation !== 'ADMIN_CONFIRMED_ACTUAL_TOKENS'
    ) {
      throw recoveryError(
        'INVALID_INPUT',
        'Manual settle requires ADMIN_CONFIRMED_ACTUAL_TOKENS confirmation when confirmation is provided',
      );
    }
    const actualTokens = assertConfirmedActualTokens(action.actualTokens);
    return {
      type: 'MANUAL_SETTLE',
      confirmation: 'ADMIN_CONFIRMED_ACTUAL_TOKENS',
      actualTokens,
      reason,
      ...(evidenceReference === undefined ? {} : { evidenceReference }),
    };
  }

  if (action.type === 'REVIEW') {
    const reason = assertRecoveryReason(action.reason);
    const evidenceReference = assertOptionalEvidenceReference(action.evidenceReference);
    if (action.confirmation !== undefined) {
      throw recoveryError('INVALID_INPUT', 'Review must not include a confirmation');
    }
    if (action.actualTokens !== undefined) {
      throw recoveryError(
        'INVALID_INPUT',
        'Review must not include a confirmed actual token amount',
      );
    }
    return {
      type: 'REVIEW',
      reason,
      ...(evidenceReference === undefined ? {} : { evidenceReference }),
    };
  }

  if (action.type === 'APPROVE_SYSTEM_RECOMMENDATION') {
    const reason = assertRecoveryReason(action.reason);
    const evidenceReference = assertOptionalEvidenceReference(action.evidenceReference);
    if (action.confirmation !== 'APPROVE_SYSTEM_RECOMMENDATION') {
      throw recoveryError(
        'INVALID_INPUT',
        'System recommendation approval requires APPROVE_SYSTEM_RECOMMENDATION confirmation',
      );
    }
    if (action.actualTokens !== undefined) {
      throw recoveryError(
        'INVALID_INPUT',
        'System recommendation approval must not include actualTokens — the server computes the amount',
      );
    }
    return {
      type: 'APPROVE_SYSTEM_RECOMMENDATION',
      confirmation: 'APPROVE_SYSTEM_RECOMMENDATION',
      reason,
      ...(evidenceReference === undefined ? {} : { evidenceReference }),
    };
  }

  throw recoveryError('INVALID_INPUT', 'action type is not a recognized recovery action');
}




// ---------------------------------------------------------------------------
// Metadata parser: supports two contracts
//
//  A. CURRENT (USAGE_BASED) — written by usage-based-ai-billing.service.ts
//     Required fields: schemaVersion=1, requestedMode='USAGE_BASED',
//                      reservationTokens, maxInputTokens, maxOutputTokens,
//                      rateCardVersion, walletPolicyVersion
//
//  B. LEGACY — written by the dormant legacy orchestrator path
//     Required fields: schemaVersion=1, requestedMode, quoteAppliedMode,
//                      quotedTokens, fixedFallbackTokens,
//                      maxInputTokens, maxOutputTokens
//
// Metadata is INVALID only when it does not fully satisfy either contract.
// ---------------------------------------------------------------------------

function parseUsageBasedMetadata(
  section: Record<string, unknown>,
): ParsedAIBillingMetadata {
  const issues: MetadataIssue[] = [];
  const observed: Record<string, unknown> = {};

  // schemaVersion — required, must be 1
  if (section.schemaVersion !== undefined) {
    observed.schemaVersion = section.schemaVersion;
    if (section.schemaVersion !== 1) {
      issues.push({ field: 'aiBilling.schemaVersion', code: 'SCHEMA_VERSION_INVALID', message: 'schemaVersion must equal 1' });
    }
  } else {
    issues.push({ field: 'aiBilling.schemaVersion', code: 'SCHEMA_VERSION_MISSING', message: 'schemaVersion is missing' });
  }

  // requestedMode — must be 'USAGE_BASED' (already known, just record)
  observed.requestedMode = section.requestedMode;

  // reservationTokens — required non-negative integer
  if (section.reservationTokens !== undefined) {
    observed.reservationTokens = section.reservationTokens;
    if (!isSafeNonNegativeInteger(section.reservationTokens)) {
      issues.push({ field: 'aiBilling.reservationTokens', code: 'RESERVATION_TOKENS_INVALID', message: 'reservationTokens must be a non-negative integer' });
    }
  } else {
    issues.push({ field: 'aiBilling.reservationTokens', code: 'RESERVATION_TOKENS_MISSING', message: 'reservationTokens is missing' });
  }

  // maxInputTokens — required non-negative integer
  if (section.maxInputTokens !== undefined) {
    observed.maxInputTokens = section.maxInputTokens;
    if (!isSafeNonNegativeInteger(section.maxInputTokens)) {
      issues.push({ field: 'aiBilling.maxInputTokens', code: 'MAX_INPUT_TOKENS_INVALID', message: 'maxInputTokens must be a non-negative integer' });
    }
  } else {
    issues.push({ field: 'aiBilling.maxInputTokens', code: 'MAX_INPUT_TOKENS_MISSING', message: 'maxInputTokens is missing' });
  }

  // maxOutputTokens — required non-negative integer
  if (section.maxOutputTokens !== undefined) {
    observed.maxOutputTokens = section.maxOutputTokens;
    if (!isSafeNonNegativeInteger(section.maxOutputTokens)) {
      issues.push({ field: 'aiBilling.maxOutputTokens', code: 'MAX_OUTPUT_TOKENS_INVALID', message: 'maxOutputTokens must be a non-negative integer' });
    }
  } else {
    issues.push({ field: 'aiBilling.maxOutputTokens', code: 'MAX_OUTPUT_TOKENS_MISSING', message: 'maxOutputTokens is missing' });
  }

  // rateCardVersion — required non-empty string
  if (section.rateCardVersion !== undefined) {
    observed.rateCardVersion = section.rateCardVersion;
    if (!isNonEmptyString(section.rateCardVersion)) {
      issues.push({ field: 'aiBilling.rateCardVersion', code: 'RATE_CARD_VERSION_INVALID', message: 'rateCardVersion must be a non-empty string' });
    }
  } else {
    issues.push({ field: 'aiBilling.rateCardVersion', code: 'RATE_CARD_VERSION_MISSING', message: 'rateCardVersion is missing' });
  }

  // walletPolicyVersion — required non-empty string
  if (section.walletPolicyVersion !== undefined) {
    observed.walletPolicyVersion = section.walletPolicyVersion;
    if (!isNonEmptyString(section.walletPolicyVersion)) {
      issues.push({ field: 'aiBilling.walletPolicyVersion', code: 'WALLET_POLICY_VERSION_INVALID', message: 'walletPolicyVersion must be a non-empty string' });
    }
  } else {
    issues.push({ field: 'aiBilling.walletPolicyVersion', code: 'WALLET_POLICY_VERSION_MISSING', message: 'walletPolicyVersion is missing' });
  }

  // Optional common fields
  if (section.provider !== undefined) {
    observed.provider = section.provider;
    if (!isNonEmptyString(section.provider)) {
      issues.push({ field: 'aiBilling.provider', code: 'PROVIDER_INVALID', message: 'provider must be a non-empty string' });
    }
  }
  if (section.model !== undefined) {
    observed.model = section.model;
    if (!isNonEmptyString(section.model)) {
      issues.push({ field: 'aiBilling.model', code: 'MODEL_INVALID', message: 'model must be a non-empty string' });
    }
  }
  if (section.pricingSource !== undefined) {
    observed.pricingSource = section.pricingSource;
  }
  if (section.feature !== undefined) {
    observed.feature = section.feature;
  }

  if (issues.length > 0) {
    return { status: 'INVALID', metadataIssues: issues, observed };
  }

  return {
    status: 'VALID',
    metadataContract: 'USAGE_BASED',
    reservationAmountFromMetadata: section.reservationTokens as number,
    metadataIssues: [],
    observed,
    summary: {
      reservationTokens: section.reservationTokens as number,
      maxInputTokens: section.maxInputTokens as number,
      maxOutputTokens: section.maxOutputTokens as number,
      rateCardVersion: section.rateCardVersion as string,
      walletPolicyVersion: section.walletPolicyVersion as string,
      ...(section.provider === undefined ? {} : { provider: section.provider as string }),
      ...(section.model === undefined ? {} : { model: section.model as string }),
    },
  };
}

function parseLegacyMetadata(
  section: Record<string, unknown>,
): ParsedAIBillingMetadata {
  const issues: MetadataIssue[] = [];
  const observed: Record<string, unknown> = {};

  // schemaVersion — required, must be 1
  if (section.schemaVersion !== undefined) {
    observed.schemaVersion = section.schemaVersion;
    if (section.schemaVersion !== 1) {
      issues.push({ field: 'aiBilling.schemaVersion', code: 'SCHEMA_VERSION_INVALID', message: 'schemaVersion must equal 1' });
    }
  } else {
    issues.push({ field: 'aiBilling.schemaVersion', code: 'SCHEMA_VERSION_MISSING', message: 'schemaVersion is missing' });
  }

  // quotedTokens — required non-negative integer
  if (section.quotedTokens !== undefined) {
    observed.quotedTokens = section.quotedTokens;
    if (!isSafeNonNegativeInteger(section.quotedTokens)) {
      issues.push({ field: 'aiBilling.quotedTokens', code: 'QUOTED_TOKENS_INVALID', message: 'quotedTokens must be a non-negative integer' });
    }
  } else {
    issues.push({ field: 'aiBilling.quotedTokens', code: 'QUOTED_TOKENS_MISSING', message: 'quotedTokens is missing' });
  }

  // fixedFallbackTokens — required non-negative integer
  if (section.fixedFallbackTokens !== undefined) {
    observed.fixedFallbackTokens = section.fixedFallbackTokens;
    if (!isSafeNonNegativeInteger(section.fixedFallbackTokens)) {
      issues.push({ field: 'aiBilling.fixedFallbackTokens', code: 'FIXED_FALLBACK_TOKENS_INVALID', message: 'fixedFallbackTokens must be a non-negative integer' });
    }
  } else {
    issues.push({ field: 'aiBilling.fixedFallbackTokens', code: 'FIXED_FALLBACK_TOKENS_MISSING', message: 'fixedFallbackTokens is missing' });
  }

  // maxInputTokens — required non-negative integer
  if (section.maxInputTokens !== undefined) {
    observed.maxInputTokens = section.maxInputTokens;
    if (!isSafeNonNegativeInteger(section.maxInputTokens)) {
      issues.push({ field: 'aiBilling.maxInputTokens', code: 'MAX_INPUT_TOKENS_INVALID', message: 'maxInputTokens must be a non-negative integer' });
    }
  } else {
    issues.push({ field: 'aiBilling.maxInputTokens', code: 'MAX_INPUT_TOKENS_MISSING', message: 'maxInputTokens is missing' });
  }

  // maxOutputTokens — required non-negative integer
  if (section.maxOutputTokens !== undefined) {
    observed.maxOutputTokens = section.maxOutputTokens;
    if (!isSafeNonNegativeInteger(section.maxOutputTokens)) {
      issues.push({ field: 'aiBilling.maxOutputTokens', code: 'MAX_OUTPUT_TOKENS_INVALID', message: 'maxOutputTokens must be a non-negative integer' });
    }
  } else {
    issues.push({ field: 'aiBilling.maxOutputTokens', code: 'MAX_OUTPUT_TOKENS_MISSING', message: 'maxOutputTokens is missing' });
  }

  // requestedMode — required, must be a valid legacy pricing mode
  if (section.requestedMode !== undefined) {
    observed.requestedMode = section.requestedMode;
    if (typeof section.requestedMode !== 'string' ||
        !['FIXED_FALLBACK', 'PROVIDER_USAGE'].includes(section.requestedMode)) {
      issues.push({ field: 'aiBilling.requestedMode', code: 'REQUESTED_MODE_INVALID', message: 'requestedMode is invalid' });
    }
  } else {
    issues.push({ field: 'aiBilling.requestedMode', code: 'REQUESTED_MODE_MISSING', message: 'requestedMode is missing' });
  }

  // quoteAppliedMode — required, must be a valid legacy pricing mode
  if (section.quoteAppliedMode !== undefined) {
    observed.quoteAppliedMode = section.quoteAppliedMode;
    if (typeof section.quoteAppliedMode !== 'string' ||
        !['FIXED_FALLBACK', 'PROVIDER_USAGE'].includes(section.quoteAppliedMode)) {
      issues.push({ field: 'aiBilling.quoteAppliedMode', code: 'QUOTE_APPLIED_MODE_INVALID', message: 'quoteAppliedMode is invalid' });
    }
  } else {
    issues.push({ field: 'aiBilling.quoteAppliedMode', code: 'QUOTE_APPLIED_MODE_MISSING', message: 'quoteAppliedMode is missing' });
  }

  // Optional common fields
  if (section.maximumUsageWalletTokens !== undefined) {
    observed.maximumUsageWalletTokens = section.maximumUsageWalletTokens;
    if (!isSafeNonNegativeInteger(section.maximumUsageWalletTokens)) {
      issues.push({ field: 'aiBilling.maximumUsageWalletTokens', code: 'MAXIMUM_USAGE_WALLET_TOKENS_INVALID', message: 'maximumUsageWalletTokens must be a non-negative integer' });
    }
  }
  if (section.provider !== undefined) {
    observed.provider = section.provider;
    if (!isNonEmptyString(section.provider)) {
      issues.push({ field: 'aiBilling.provider', code: 'PROVIDER_INVALID', message: 'provider must be a non-empty string' });
    }
  }
  if (section.model !== undefined) {
    observed.model = section.model;
    if (!isNonEmptyString(section.model)) {
      issues.push({ field: 'aiBilling.model', code: 'MODEL_INVALID', message: 'model must be a non-empty string' });
    }
  }
  if (section.billingCurrency !== undefined) {
    observed.billingCurrency = section.billingCurrency;
    if (!isNonEmptyString(section.billingCurrency)) {
      issues.push({ field: 'aiBilling.billingCurrency', code: 'BILLING_CURRENCY_INVALID', message: 'billingCurrency must be a non-empty string' });
    }
  }
  if (section.rateCardVersion !== undefined) {
    observed.rateCardVersion = section.rateCardVersion;
    if (!isNonEmptyString(section.rateCardVersion)) {
      issues.push({ field: 'aiBilling.rateCardVersion', code: 'RATE_CARD_VERSION_INVALID', message: 'rateCardVersion must be a non-empty string' });
    }
  }
  if (section.walletPolicyVersion !== undefined) {
    observed.walletPolicyVersion = section.walletPolicyVersion;
    if (!isNonEmptyString(section.walletPolicyVersion)) {
      issues.push({ field: 'aiBilling.walletPolicyVersion', code: 'WALLET_POLICY_VERSION_INVALID', message: 'walletPolicyVersion must be a non-empty string' });
    }
  }

  if (issues.length > 0) {
    return { status: 'INVALID', metadataIssues: issues, observed };
  }

  return {
    status: 'VALID',
    metadataContract: 'LEGACY',
    reservationAmountFromMetadata: section.quotedTokens as number,
    metadataIssues: [],
    observed,
    summary: {
      quotedTokens: section.quotedTokens as number,
      requestedMode: section.requestedMode as AIUsagePricingMode,
      quoteAppliedMode: section.quoteAppliedMode as AIUsagePricingMode,
      ...(section.maximumUsageWalletTokens === undefined ? {} : { maximumUsageWalletTokens: section.maximumUsageWalletTokens as number }),
      ...(section.provider === undefined ? {} : { provider: section.provider as string }),
      ...(section.model === undefined ? {} : { model: section.model as string }),
      ...(section.billingCurrency === undefined ? {} : { billingCurrency: section.billingCurrency as string }),
      ...(section.rateCardVersion === undefined ? {} : { rateCardVersion: section.rateCardVersion as string }),
      ...(section.walletPolicyVersion === undefined ? {} : { walletPolicyVersion: section.walletPolicyVersion as string }),
    },
  };
}

export function parseAIBillingMetadata(metadata: unknown): ParsedAIBillingMetadata {
  if (metadata === null || metadata === undefined) {
    return {
      status: 'MISSING',
      metadataIssues: [{ field: 'metadata', code: 'METADATA_MISSING', message: 'Metadata is missing' }],
    };
  }
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {
      status: 'INVALID',
      metadataIssues: [{ field: 'metadata', code: 'METADATA_NOT_OBJECT', message: 'Metadata must be an object' }],
    };
  }
  const root = metadata as Record<string, unknown>;
  const aiBilling = root.aiBilling;
  if (aiBilling === null || aiBilling === undefined) {
    return {
      status: 'MISSING',
      metadataIssues: [{ field: 'aiBilling', code: 'AI_BILLING_MISSING', message: 'aiBilling section is missing' }],
    };
  }
  if (typeof aiBilling !== 'object' || Array.isArray(aiBilling)) {
    return {
      status: 'INVALID',
      metadataIssues: [{ field: 'aiBilling', code: 'AI_BILLING_NOT_OBJECT', message: 'aiBilling must be an object' }],
    };
  }
  const section = aiBilling as Record<string, unknown>;

  // Route to the appropriate contract parser based on requestedMode.
  // USAGE_BASED is the current live contract; anything else is legacy.
  if (section.requestedMode === 'USAGE_BASED') {
    return parseUsageBasedMetadata(section);
  }
  return parseLegacyMetadata(section);
}

// ---------------------------------------------------------------------------
// Repricing Recommendation Engine
//
// 6-Gate fail-closed logic (all gates must pass for AUTHORITATIVE_REPRICE_AVAILABLE):
//  Gate 1: reservation.status === 'PENDING'
//  Gate 2: providerCalls array is non-empty
//  Gate 3: Every call has provider, model, operation fields
//  Gate 4: rateCardVersion non-empty, loads successfully, aggregateProviderCalls => FULLY_PRICED
//  Gate 5: Wallet policy params available from runtime env
//  Gate 6: 0 <= calculatedTokens <= reservation.tokens
//
// If ANY gate fails: repricingStatus = PARTIAL_EVIDENCE, recommendedActualWalletTokens = null.
// NO GUESSED NUMBERS ARE EVER OUTPUT.
// ---------------------------------------------------------------------------

export async function calculateAIBillingRecoveryRecommendation(
  reservation: AIBillingRecoveryReservationRow,
  dependencies: AIBillingRecoveryDependencies,
): Promise<AIBillingRecoveryRepricingRecommendation> {
  const noCallsResult = (status: AIBillingRepricingStatus, note: string): AIBillingRecoveryRepricingRecommendation => ({
    repricingStatus: status,
    recommendedActualWalletTokens: null,
    recommendedReturnedTokens: null,
    recommendedAction: 'KEEP_UNDER_REVIEW',
    pricingDate: (reservation.expiresAt ?? new Date()).toISOString().slice(0, 10),
    rateCardVersion: null,
    walletPolicyVersion: null,
    walletPolicySnapshot: null,
    totalProviderCostNanoUsd: null,
    totalPricedCalls: 0,
    totalUnpricedCalls: 0,
    itemizedCalls: [],
    discrepancyNote: note,
  });

  // Gate 1: only PENDING reservations are eligible for repricing
  if (reservation.status !== 'PENDING') {
    return noCallsResult('ALREADY_PRICED', 'Reservation is not in PENDING status; no repricing required.');
  }

  // Read the AIBillingOperation for rate card + wallet policy version context
  let operation: Awaited<ReturnType<AIBillingRecoveryDependencies['repository']['findAIBillingOperationByReservationId']>>;
  try {
    operation = await dependencies.repository.findAIBillingOperationByReservationId(reservation.id);
  } catch (_) {
    return noCallsResult('PARTIAL_EVIDENCE', 'Could not read AIBillingOperation for this reservation.');
  }

  // Check for indeterminate execution state
  if (operation?.failureKind === 'INDETERMINATE') {
    return noCallsResult('INDETERMINATE_EXECUTION',
      'Provider execution outcome is unknown (INDETERMINATE). Cannot safely compute a settlement amount.');
  }

  // Determine pricing date from operation timestamps (executedAt > createdAt fallback)
  const pricingDateRaw = operation?.executedAt ?? operation?.createdAt ?? reservation.expiresAt;
  const pricingDate = pricingDateRaw.toISOString().slice(0, 10);

  // Read providerCalls from reservation metadata
  const meta = reservation.metadata;
  if (meta === null || meta === undefined || typeof meta !== 'object' || Array.isArray(meta)) {
    return noCallsResult('PARTIAL_EVIDENCE', 'Reservation metadata is missing or malformed.');
  }
  const root = meta as Record<string, unknown>;
  const providerExecution = root.providerExecution;
  const execSection = (providerExecution !== null && providerExecution !== undefined &&
      typeof providerExecution === 'object' && !Array.isArray(providerExecution))
    ? (providerExecution as Record<string, unknown>)
    : undefined;

  const providerCalls = execSection?.providerCalls;

  // Gate 2: providerCalls non-empty check
  const hasProviderCalls = Array.isArray(providerCalls) && providerCalls.length > 0;
  if (!hasProviderCalls) {
    // Check if independent execution evidence explicitly proves a non-billable operation
    const isProvenNonBillable =
      operation?.status === 'NON_BILLABLE_CONFIRMED' ||
      operation?.reviewReasonCode === 'NO_PROVIDER_CALLS' ||
      operation?.failureKind === 'NON_BILLABLE' ||
      operation?.providerRequestSent === false;

    if (isProvenNonBillable) {
      return {
        repricingStatus: 'NON_BILLABLE_CONFIRMED',
        recommendedActualWalletTokens: 0,
        recommendedReturnedTokens: reservation.tokens,
        recommendedAction: 'RELEASE_RESERVATION',
        pricingDate,
        rateCardVersion: operation?.rateCardVersion ?? null,
        walletPolicyVersion: operation?.walletPolicyVersion ?? null,
        walletPolicySnapshot: null,
        totalProviderCostNanoUsd: '0',
        totalPricedCalls: 0,
        totalUnpricedCalls: 0,
        itemizedCalls: [],
        discrepancyNote: 'Independent execution state explicitly proves a non-billable operation (request not sent or confirmed non-billable). Full release recommended.',
      };
    }

    // Absence of recorded providerCalls when not explicitly proven non-billable MUST return PARTIAL_EVIDENCE with null recommendation
    return noCallsResult(
      'PARTIAL_EVIDENCE',
      'providerExecution.providerCalls is missing or empty and execution state does not explicitly prove a non-billable operation. Authoritative settlement cannot be calculated without provider calls.',
    );
  }

  // Gate 3: every call must have required identity fields
  for (const call of providerCalls as unknown[]) {
    if (typeof call !== 'object' || call === null) {
      return noCallsResult('PARTIAL_EVIDENCE', 'One or more providerCalls entries are malformed.');
    }
    const c = call as Record<string, unknown>;
    const hasProvider = typeof c.provider === 'string' && c.provider.trim().length > 0;
    const hasModel = (typeof c.actualModel === 'string' && c.actualModel.trim().length > 0) ||
                     (typeof c.model === 'string' && c.model.trim().length > 0);
    const hasOperation = typeof c.operation === 'string' && c.operation.trim().length > 0;
    if (!hasProvider || !hasModel || !hasOperation) {
      return noCallsResult('PARTIAL_EVIDENCE',
        'One or more providerCalls entries are missing required identity fields (provider, model, operation).');
    }
  }

  // Gate 4: load rate card by version and run aggregateProviderCalls
  const rateCardVersion = operation?.rateCardVersion ?? null;
  if (!rateCardVersion || rateCardVersion.trim().length === 0) {
    return noCallsResult('PARTIAL_EVIDENCE',
      'No rateCardVersion recorded on the billing operation. Cannot load historical rate card for repricing.');
  }

  let rateCardResult: Awaited<ReturnType<typeof loadRateCardByVersion>>;
  try {
    rateCardResult = await loadRateCardByVersion(dependencies.rateCardLoader, rateCardVersion);
  } catch (err) {
    const errNote = err instanceof ProviderRateCardLoadError
      ? `Rate card version '${rateCardVersion}' could not be loaded: ${err.code}.`
      : `Rate card version '${rateCardVersion}' was not found in persistent snapshot store.`;
    return noCallsResult('PARTIAL_EVIDENCE', errNote);
  }

  // Persisted calls carry applied usage nested under `usageApplied`; project it
  // to the canonical flat pricing shape so authoritative repricing reads the
  // same evidence the live billing engine used. Identity fields pass through.
  const normalizedProviderCalls = normalizePersistedProviderCallsForPricing(providerCalls);

  const pricingResult = aggregateProviderCalls({
    providerCalls: normalizedProviderCalls as unknown[],
    pricingDate,
    card: rateCardResult.card,
  });

  // Build itemized call list regardless of FULLY_PRICED status (for transparency)
  const itemizedCalls: AIBillingRepricingItemizedCall[] = pricingResult.calls.map((priced) => ({
    providerCallId: typeof priced.providerCallId === 'string' ? priced.providerCallId : undefined,
    provider: priced.provider ?? '',
    model: priced.actualModel ?? priced.requestedModel ?? (priced.kind === 'PRICED' ? priced.rateCard.model : ''),
    operation: priced.operation ?? '',
    kind: priced.kind as 'PRICED' | 'UNPRICED',
    costNanoUsd: priced.kind === 'PRICED' ? String(priced.costNanoUsd) : '0',
    reason: priced.kind === 'UNPRICED' ? priced.reason : 'PRICED',
  }));

  if (pricingResult.summaryStatus !== 'FULLY_PRICED') {
    const unpricedNote = `${pricingResult.totals.unpricedCallCount} of ${pricingResult.totals.callCount} provider call(s) could not be priced under rate card ${rateCardVersion}. ` +
      'Authoritative repricing requires all calls to be fully priced.';
    return {
      repricingStatus: 'PARTIAL_EVIDENCE',
      recommendedActualWalletTokens: null,
      recommendedReturnedTokens: null,
      recommendedAction: 'KEEP_UNDER_REVIEW',
      pricingDate,
      rateCardVersion,
      walletPolicyVersion: operation?.walletPolicyVersion ?? null,
      walletPolicySnapshot: null,
      totalProviderCostNanoUsd: String(pricingResult.totals.pricedCostNanoUsd),
      totalPricedCalls: pricingResult.totals.pricedCallCount,
      totalUnpricedCalls: pricingResult.totals.unpricedCallCount,
      itemizedCalls,
      discrepancyNote: unpricedNote,
    };
  }

  // Gate 5: Read STORED walletPolicySnapshot from reservation metadata
  const aiBillingSection = root.aiBilling && typeof root.aiBilling === 'object' && !Array.isArray(root.aiBilling)
    ? (root.aiBilling as Record<string, unknown>)
    : undefined;
  const storedPolicy = aiBillingSection?.walletPolicySnapshot;

  let walletPolicySnapshot: WalletPolicySnapshot | null = null;
  if (storedPolicy !== null && storedPolicy !== undefined && typeof storedPolicy === 'object' && !Array.isArray(storedPolicy)) {
    const p = storedPolicy as Record<string, unknown>;
    if (
      isSafeNonNegativeInteger(p.walletTokenValueNanoUsd) &&
      (p.walletTokenValueNanoUsd as number) > 0 &&
      isSafeNonNegativeInteger(p.markupBasisPoints) &&
      isSafeNonNegativeInteger(p.minimumWalletTokens)
    ) {
      walletPolicySnapshot = {
        walletTokenValueNanoUsd: p.walletTokenValueNanoUsd as number,
        markupBasisPoints: p.markupBasisPoints as number,
        minimumWalletTokens: p.minimumWalletTokens as number,
        sourceNote: 'PERSISTED_SNAPSHOT',
      };
    }
  }

  if (!walletPolicySnapshot) {
    return {
      repricingStatus: 'PARTIAL_EVIDENCE',
      recommendedActualWalletTokens: null,
      recommendedReturnedTokens: null,
      recommendedAction: 'KEEP_UNDER_REVIEW',
      pricingDate,
      rateCardVersion,
      walletPolicyVersion: operation?.walletPolicyVersion ?? null,
      walletPolicySnapshot: null,
      totalProviderCostNanoUsd: String(pricingResult.totals.pricedCostNanoUsd),
      totalPricedCalls: pricingResult.totals.pricedCallCount,
      totalUnpricedCalls: 0,
      itemizedCalls,
      discrepancyNote: 'Reservation metadata is missing stored walletPolicySnapshot. Authoritative historical recovery requires a stored wallet policy snapshot.',
    };
  }

  const walletCharge = computeWalletCharge(pricingResult, walletPolicySnapshot);
  const calculatedTokens = Number(walletCharge.tokens);

  // Gate 6: overflow guard — calculated amount must not exceed reserved tokens
  if (calculatedTokens > reservation.tokens) {
    return {
      repricingStatus: 'PARTIAL_EVIDENCE',
      recommendedActualWalletTokens: null,
      recommendedReturnedTokens: null,
      recommendedAction: 'KEEP_UNDER_REVIEW',
      pricingDate,
      rateCardVersion,
      walletPolicyVersion: operation?.walletPolicyVersion ?? null,
      walletPolicySnapshot,
      totalProviderCostNanoUsd: String(pricingResult.totals.pricedCostNanoUsd),
      totalPricedCalls: pricingResult.totals.pricedCallCount,
      totalUnpricedCalls: 0,
      itemizedCalls,
      discrepancyNote: `Calculated token charge (${calculatedTokens}) exceeds reserved tokens (${reservation.tokens}). Manual review required.`,
    };
  }

  // All 6 gates passed: AUTHORITATIVE_REPRICE_AVAILABLE
  const returnedTokens = reservation.tokens - calculatedTokens;
  return {
    repricingStatus: 'AUTHORITATIVE_REPRICE_AVAILABLE',
    recommendedActualWalletTokens: calculatedTokens,
    recommendedReturnedTokens: returnedTokens,
    recommendedAction: 'APPROVE_SETTLEMENT',
    pricingDate,
    rateCardVersion,
    walletPolicyVersion: operation?.walletPolicyVersion ?? null,
    walletPolicySnapshot,
    totalProviderCostNanoUsd: String(pricingResult.totals.pricedCostNanoUsd),
    totalPricedCalls: pricingResult.totals.pricedCallCount,
    totalUnpricedCalls: 0,
    itemizedCalls,
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
  const metadataIssues = [...parsed.metadataIssues];

  if (parsed.status === 'VALID' && parsed.reservationAmountFromMetadata !== reservation.tokens) {
    metadataIssues.push({
      field: parsed.metadataContract === 'USAGE_BASED' ? 'aiBilling.reservationTokens' : 'aiBilling.quotedTokens',
      code: 'RESERVATION_MISMATCH',
      message: 'Metadata reservation amount does not match reservation.tokens',
    });
  }

  let metadataStatus: AIBillingMetadataStatus;
  if (parsed.status === 'MISSING') {
    metadataStatus = 'MISSING';
  } else if (metadataIssues.length > 0) {
    metadataStatus = 'INVALID';
  } else {
    metadataStatus = 'VALID';
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

  let review: InspectAIBillingRecoveryResult['review'] | undefined;
  if (reservation.status === 'PENDING') {
    try {
      const reviewAudit = await dependencies.repository.findLatestRecoveryReviewAuditLog(reservationId);
      if (reviewAudit) {
        const meta = (reviewAudit.metadata as Record<string, unknown>) ?? {};
        review = {
          reviewedBy: reviewAudit.actorId ?? undefined,
          reviewedAt: reviewAudit.createdAt.toISOString(),
          reason: (meta.reason as string) ?? '',
          ...(meta.evidenceReference ? { evidenceReference: meta.evidenceReference as string } : {}),
          status: 'UNDER_REVIEW',
        };
      }
    } catch (_) {}
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
    metadataIssues,
    observed: parsed.observed,
    ...(parsed.status === 'VALID' && metadataStatus === 'VALID'
      ? parsed.metadataContract === 'LEGACY'
        ? {
            quotedTokens: parsed.summary.quotedTokens,
            requestedMode: parsed.summary.requestedMode,
            quoteAppliedMode: parsed.summary.quoteAppliedMode,
            ...(parsed.summary.maximumUsageWalletTokens === undefined
              ? {}
              : { maximumUsageWalletTokens: parsed.summary.maximumUsageWalletTokens }),
            ...(parsed.summary.provider === undefined ? {} : { provider: parsed.summary.provider }),
            ...(parsed.summary.model === undefined ? {} : { model: parsed.summary.model }),
            ...(parsed.summary.billingCurrency === undefined
              ? {}
              : { billingCurrency: parsed.summary.billingCurrency }),
            ...(parsed.summary.rateCardVersion === undefined
              ? {}
              : { rateCardVersion: parsed.summary.rateCardVersion }),
            ...(parsed.summary.walletPolicyVersion === undefined
              ? {}
              : { walletPolicyVersion: parsed.summary.walletPolicyVersion }),
          }
        : {
            ...(parsed.summary.provider === undefined ? {} : { provider: parsed.summary.provider }),
            ...(parsed.summary.model === undefined ? {} : { model: parsed.summary.model }),
            ...(parsed.summary.rateCardVersion === undefined
              ? {}
              : { rateCardVersion: parsed.summary.rateCardVersion }),
            ...(parsed.summary.walletPolicyVersion === undefined
              ? {}
              : { walletPolicyVersion: parsed.summary.walletPolicyVersion }),
          }
      : {}),
    ...(consumeTransactionId === undefined ? {} : { consumeTransactionId }),
    ...(consumedTokens === undefined ? {} : { consumedTokens }),
    ...(releasedTokens === undefined ? {} : { releasedTokens }),
    recommendation,
    automaticFinancialActionAllowed: false,
    recoveryRequired,
    reasonCode,
    integrityConflict,
    inspectedAt,
    ...(review === undefined ? {} : { review }),
    repricingRecommendation: await calculateAIBillingRecoveryRecommendation(reservation, dependencies),
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
  const isAmountMatch = parsed.status === 'VALID' && parsed.reservationAmountFromMetadata === reservation.tokens;
  const metadataStatus: AIBillingMetadataStatus =
    parsed.status === 'MISSING'
      ? 'MISSING'
      : parsed.status === 'INVALID' || !isAmountMatch
        ? 'INVALID'
        : 'VALID';

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

    case 'MANUAL_RELEASE': {
      await assertReservationWalletOwnership(reservation, dependencies);
      if (reservation.status === 'RELEASED') {
        if (reservation.releasedAt !== null && reservation.settledAt === null) {
          return {
            reservationId,
            outcome: 'ALREADY_RELEASED',
            status: 'RELEASED',
            financialMutationPerformed: false,
            recoveryRequired: false,
            idempotentReplay: true,
            reason: action.reason,
            ...(action.evidenceReference === undefined
              ? {}
              : { evidenceReference: action.evidenceReference }),
          };
        }
      }

      if (reservation.status !== 'PENDING') {
        throw recoveryError(
          'INTEGRITY_CONFLICT',
          'Only PENDING reservations can be manually released',
          { reservationId, recoveryRequired: true },
        );
      }

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
      if (consumes.length > 0) {
        throw recoveryError(
          'INTEGRITY_CONFLICT',
          'Reservation has associated consume transactions and cannot be manually released',
          { reservationId, recoveryRequired: true },
        );
      }

      try {
        await dependencies.repository.recordAuditLog({
          actorId: input.actorId,
          action: 'AI_BILLING_RECOVERY_MANUAL_RELEASE_ATTEMPT',
          targetUserId: reservation.userId,
          metadata: {
            reservationId,
            action: 'MANUAL_RELEASE',
            actorId: input.actorId,
            reason: action.reason,
            evidenceReference: action.evidenceReference,
            status: 'ATTEMPT',
          },
        });
      } catch (err) {
        if (err instanceof AIBillingRecoveryError) throw err;
        throw recoveryError(
          'INTEGRITY_CONFLICT',
          'Manual release attempt audit logging failed',
          { reservationId, recoveryRequired: true },
        );
      }

      let released: ReleaseBusinessTokenReservationResult;
      try {
        released = await dependencies.releaseReservation({
          reservationId,
          reason: action.reason,
        });
      } catch (err) {
        const errorType = err instanceof AIBillingRecoveryError ? err.name : err instanceof AppError ? 'AppError' : 'Error';
        const errorCode = err instanceof AIBillingRecoveryError ? err.code : 'RELEASE_FAILED';
        const statusCode = err instanceof AppError ? err.statusCode : undefined;
        try {
          await dependencies.repository.recordAuditLog({
            actorId: input.actorId,
            action: 'AI_BILLING_RECOVERY_MANUAL_RELEASE_FAILED',
            targetUserId: reservation.userId,
            metadata: {
              reservationId,
              action: 'MANUAL_RELEASE',
              errorType,
              errorCode,
              ...(statusCode !== undefined ? { statusCode } : {}),
              reason: action.reason,
              evidenceReference: action.evidenceReference,
              status: 'FAILED',
            },
          });
        } catch (_) {}

        if (err instanceof AppError) {
          if (err.statusCode === 404) {
            throw recoveryError(
              'RESERVATION_NOT_FOUND',
              'AI billing reservation not found during manual release',
              { reservationId, recoveryRequired: true },
            );
          }
          if (err.statusCode === 409) {
            throw recoveryError('INTEGRITY_CONFLICT', 'AI billing reservation cannot be manually released', {
              reservationId,
              recoveryRequired: true,
            });
          }
        }
        throw recoveryError('RELEASE_FAILED', 'AI billing reservation manual release failed', {
          reservationId,
          recoveryRequired: true,
        });
      }

      const idempotentReplay = released.idempotentReplay;
      try {
        await dependencies.repository.recordAuditLog({
          actorId: input.actorId,
          action: 'AI_BILLING_RECOVERY_MANUAL_RELEASE',
          targetUserId: reservation.userId,
          metadata: {
            reservationId,
            action: 'MANUAL_RELEASE',
            reason: action.reason,
            evidenceReference: action.evidenceReference,
            status: 'RELEASED',
          },
        });
      } catch (_) {}

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

    case 'MANUAL_SETTLE': {
      await assertReservationWalletOwnership(reservation, dependencies);
      if (reservation.status === 'COMPLETED') {
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
        if (consumes.length === 1 && consumes[0].tokens === action.actualTokens) {
          return {
            reservationId,
            outcome: 'ALREADY_SETTLED',
            status: 'COMPLETED',
            financialMutationPerformed: false,
            recoveryRequired: false,
            actualTokens: action.actualTokens,
            releasedTokens: reservation.tokens - action.actualTokens,
            consumeTransactionId: consumes[0].id,
            idempotentReplay: true,
            reason: action.reason,
            ...(action.evidenceReference === undefined
              ? {}
              : { evidenceReference: action.evidenceReference }),
          };
        }
        throw recoveryError(
          'INTEGRITY_CONFLICT',
          'Token reservation integrity conflict',
          { reservationId, recoveryRequired: true },
        );
      }

      if (reservation.status !== 'PENDING') {
        throw recoveryError(
          'INTEGRITY_CONFLICT',
          'Only PENDING reservations can be manually settled',
          { reservationId, recoveryRequired: true },
        );
      }

      if (action.actualTokens > reservation.tokens) {
        throw recoveryError(
          'INVALID_INPUT',
          'Confirmed actual tokens must not exceed the reserved amount',
          { reservationId },
        );
      }

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
      if (consumes.length > 0) {
        throw recoveryError(
          'INTEGRITY_CONFLICT',
          'Reservation has associated consume transactions and cannot be manually settled',
          { reservationId, recoveryRequired: true },
        );
      }

      try {
        await dependencies.repository.recordAuditLog({
          actorId: input.actorId,
          action: 'AI_BILLING_RECOVERY_MANUAL_SETTLE_ATTEMPT',
          targetUserId: reservation.userId,
          metadata: {
            reservationId,
            action: 'MANUAL_SETTLE',
            actorId: input.actorId,
            actualTokens: action.actualTokens,
            reason: action.reason,
            evidenceReference: action.evidenceReference,
            status: 'ATTEMPT',
          },
        });
      } catch (err) {
        if (err instanceof AIBillingRecoveryError) throw err;
        throw recoveryError(
          'INTEGRITY_CONFLICT',
          'Manual settle attempt audit logging failed',
          { reservationId, recoveryRequired: true },
        );
      }

      let settlement: SettleBusinessTokenReservationResult;
      try {
        settlement = await dependencies.settleForAmount({
          reservationId,
          actualTokens: action.actualTokens,
        });
      } catch (err) {
        const errorType = err instanceof AIBillingRecoveryError ? err.name : err instanceof AppError ? 'AppError' : 'Error';
        const errorCode = err instanceof AIBillingRecoveryError ? err.code : 'SETTLEMENT_FAILED';
        const statusCode = err instanceof AppError ? err.statusCode : undefined;
        try {
          await dependencies.repository.recordAuditLog({
            actorId: input.actorId,
            action: 'AI_BILLING_RECOVERY_MANUAL_SETTLE_FAILED',
            targetUserId: reservation.userId,
            metadata: {
              reservationId,
              action: 'MANUAL_SETTLE',
              actualTokens: action.actualTokens,
              errorType,
              errorCode,
              ...(statusCode !== undefined ? { statusCode } : {}),
              reason: action.reason,
              evidenceReference: action.evidenceReference,
              status: 'FAILED',
            },
          });
        } catch (_) {}

        if (err instanceof AppError) {
          if (err.statusCode === 404) {
            throw recoveryError(
              'RESERVATION_NOT_FOUND',
              'AI billing reservation not found during manual settlement',
              { reservationId, recoveryRequired: true },
            );
          }
          if (err.statusCode === 409) {
            throw recoveryError('INTEGRITY_CONFLICT', 'AI billing reservation cannot be manually settled', {
              reservationId,
              recoveryRequired: true,
            });
          }
        }
        throw recoveryError('SETTLEMENT_FAILED', 'AI billing reservation manual settlement failed', {
          reservationId,
          recoveryRequired: true,
        });
      }

      const idempotentReplay = settlement.idempotentReplay;
      try {
        let repricingRec: AIBillingRecoveryRepricingRecommendation | undefined;
        try {
          repricingRec = await calculateAIBillingRecoveryRecommendation(reservation, dependencies);
        } catch (_) {}

        await dependencies.repository.recordAuditLog({
          actorId: input.actorId,
          action: 'AI_BILLING_RECOVERY_MANUAL_SETTLE',
          targetUserId: reservation.userId,
          metadata: {
            reservationId,
            action: 'MANUAL_SETTLE',
            recoveryResolutionType: 'MANUAL_OVERRIDE',
            systemRecommendedTokens: repricingRec?.recommendedActualWalletTokens ?? null,
            adminApprovedTokens: action.actualTokens,
            override: true,
            repricingStatus: repricingRec?.repricingStatus ?? 'UNKNOWN',
            actualTokens: action.actualTokens,
            reason: action.reason,
            evidenceReference: action.evidenceReference,
            status: 'COMPLETED',
          },
        });
      } catch (_) {}

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

    case 'REVIEW': {
      await assertReservationWalletOwnership(reservation, dependencies);
      if (reservation.status !== 'PENDING') {
        throw recoveryError(
          'INTEGRITY_CONFLICT',
          'Only PENDING reservations can be marked under review',
          { reservationId, recoveryRequired: true },
        );
      }

      try {
        await dependencies.repository.recordAuditLog({
          actorId: input.actorId,
          action: 'AI_BILLING_RECOVERY_REVIEW',
          targetUserId: reservation.userId,
          metadata: {
            reservationId,
            action: 'REVIEW',
            reason: action.reason,
            evidenceReference: action.evidenceReference,
            status: 'UNDER_REVIEW',
          },
        });
      } catch (err) {
        if (err instanceof AIBillingRecoveryError) throw err;
        throw recoveryError(
          'INTEGRITY_CONFLICT',
          'AI billing recovery audit log persistence failed',
          { reservationId, recoveryRequired: true },
        );
      }

      return {
        reservationId,
        outcome: 'REVIEW_REQUIRED',
        status: reservation.status,
        financialMutationPerformed: false,
        recoveryRequired: true,
        reason: action.reason,
        ...(action.evidenceReference === undefined
          ? {}
          : { evidenceReference: action.evidenceReference }),
      };
    }

    case 'APPROVE_SYSTEM_RECOMMENDATION': {
      await assertReservationWalletOwnership(reservation, dependencies);
      if (reservation.status !== 'PENDING') {
        throw recoveryError(
          'INTEGRITY_CONFLICT',
          'Only PENDING reservations can be processed via system recommendation approval',
          { reservationId, recoveryRequired: true },
        );
      }

      // Re-run the repricing engine fresh at approval time.
      // The client sends NO actualTokens — the server computes the authoritative action & amount.
      let repricingRecommendation: AIBillingRecoveryRepricingRecommendation;
      try {
        repricingRecommendation = await calculateAIBillingRecoveryRecommendation(reservation, dependencies);
      } catch (err) {
        throw recoveryError('REPRICING_FAILED', 'Failed to compute system repricing recommendation', {
          reservationId,
          recoveryRequired: true,
          // A thrown repricing computation is an unexpected internal failure, not a domain rejection.
          statusCode: 500,
        });
      }

      const recStatus = repricingRecommendation.repricingStatus;

      if (recStatus !== 'AUTHORITATIVE_REPRICE_AVAILABLE' && recStatus !== 'NON_BILLABLE_CONFIRMED') {
        throw recoveryError(
          'REPRICING_FAILED',
          `System recommendation approval requires AUTHORITATIVE_REPRICE_AVAILABLE or NON_BILLABLE_CONFIRMED status, got: ${recStatus}. ${repricingRecommendation.discrepancyNote ?? ''}`,
          { reservationId, recoveryRequired: true },
        );
      }

      // ---------------------------------------------------------------------
      // Branch A: NON_BILLABLE_CONFIRMED => Canonical Release Path
      // ---------------------------------------------------------------------
      if (recStatus === 'NON_BILLABLE_CONFIRMED') {
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
        if (consumes.length > 0) {
          throw recoveryError(
            'INTEGRITY_CONFLICT',
            'Reservation has associated consume transactions and cannot be released via system recommendation',
            { reservationId, recoveryRequired: true },
          );
        }

        try {
          await dependencies.repository.recordAuditLog({
            actorId: input.actorId,
            action: 'AI_BILLING_RECOVERY_SYSTEM_APPROVAL_ATTEMPT',
            targetUserId: reservation.userId,
            metadata: {
              reservationId,
              action: 'APPROVE_SYSTEM_RECOMMENDATION',
              actorId: input.actorId,
              recommendedAction: 'RELEASE_RESERVATION',
              systemRecommendedTokens: 0,
              overrideFlag: false,
              reason: action.reason,
              evidenceReference: action.evidenceReference,
              repricingStatus: recStatus,
              status: 'ATTEMPT',
            },
          });
        } catch (err) {
          if (err instanceof AIBillingRecoveryError) throw err;
          throw recoveryError(
            'INTEGRITY_CONFLICT',
            'System recommendation approval audit logging failed',
            { reservationId, recoveryRequired: true },
          );
        }

        let released: ReleaseBusinessTokenReservationResult;
        try {
          released = await dependencies.releaseReservation({
            reservationId,
            reason: action.reason,
          });
        } catch (err) {
          const errorType = err instanceof AppError ? 'AppError' : 'Error';
          const statusCode = err instanceof AppError ? err.statusCode : undefined;
          try {
            await dependencies.repository.recordAuditLog({
              actorId: input.actorId,
              action: 'AI_BILLING_RECOVERY_SYSTEM_APPROVAL_FAILED',
              targetUserId: reservation.userId,
              metadata: {
                reservationId,
                action: 'APPROVE_SYSTEM_RECOMMENDATION',
                recommendedAction: 'RELEASE_RESERVATION',
                errorType,
                ...(statusCode !== undefined ? { statusCode } : {}),
                reason: action.reason,
                status: 'FAILED',
              },
            });
          } catch (_) {}

          if (err instanceof AppError) {
            if (err.statusCode === 404) {
              throw recoveryError(
                'RESERVATION_NOT_FOUND',
                'AI billing reservation not found during system recommendation release',
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
          throw recoveryError('RELEASE_FAILED', 'System recommendation release failed', {
            reservationId,
            recoveryRequired: true,
          });
        }

        const idempotentReplay = released.idempotentReplay;
        try {
          await dependencies.repository.recordAuditLog({
            actorId: input.actorId,
            action: 'AI_BILLING_RECOVERY_SYSTEM_APPROVAL',
            targetUserId: reservation.userId,
            metadata: {
              reservationId,
              action: 'APPROVE_SYSTEM_RECOMMENDATION',
              recoveryResolutionType: 'SYSTEM_RECOMMENDATION_APPROVED',
              recommendedAction: 'RELEASE_RESERVATION',
              systemRecommendedTokens: 0,
              adminApprovedTokens: 0,
              overrideFlag: false,
              reason: action.reason,
              evidenceReference: action.evidenceReference,
              repricingStatus: recStatus,
              status: 'RELEASED',
            },
          });
        } catch (_) {}

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

      // ---------------------------------------------------------------------
      // Branch B: AUTHORITATIVE_REPRICE_AVAILABLE => Canonical Settlement Path
      // ---------------------------------------------------------------------
      const systemRecommendedTokens = repricingRecommendation.recommendedActualWalletTokens!;

      // Verify no prior consume transactions exist
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
      if (consumes.length > 0) {
        throw recoveryError(
          'INTEGRITY_CONFLICT',
          'Reservation has associated consume transactions and cannot be settled via system recommendation',
          { reservationId, recoveryRequired: true },
        );
      }

      try {
        await dependencies.repository.recordAuditLog({
          actorId: input.actorId,
          action: 'AI_BILLING_RECOVERY_SYSTEM_APPROVAL_ATTEMPT',
          targetUserId: reservation.userId,
          metadata: {
            reservationId,
            action: 'APPROVE_SYSTEM_RECOMMENDATION',
            actorId: input.actorId,
            systemRecommendedTokens,
            overrideFlag: false,
            reason: action.reason,
            evidenceReference: action.evidenceReference,
            repricingStatus: repricingRecommendation.repricingStatus,
            rateCardVersion: repricingRecommendation.rateCardVersion,
            totalProviderCostNanoUsd: repricingRecommendation.totalProviderCostNanoUsd,
            status: 'ATTEMPT',
          },
        });
      } catch (err) {
        if (err instanceof AIBillingRecoveryError) throw err;
        throw recoveryError(
          'INTEGRITY_CONFLICT',
          'System recommendation approval audit logging failed',
          { reservationId, recoveryRequired: true },
        );
      }

      let settlement: SettleBusinessTokenReservationResult;
      try {
        settlement = await dependencies.settleForAmount({
          reservationId,
          actualTokens: systemRecommendedTokens,
        });
      } catch (err) {
        const errorType = err instanceof AppError ? 'AppError' : 'Error';
        const statusCode = err instanceof AppError ? err.statusCode : undefined;
        try {
          await dependencies.repository.recordAuditLog({
            actorId: input.actorId,
            action: 'AI_BILLING_RECOVERY_SYSTEM_APPROVAL_FAILED',
            targetUserId: reservation.userId,
            metadata: {
              reservationId,
              action: 'APPROVE_SYSTEM_RECOMMENDATION',
              systemRecommendedTokens,
              errorType,
              ...(statusCode !== undefined ? { statusCode } : {}),
              reason: action.reason,
              status: 'FAILED',
            },
          });
        } catch (_) {}

        if (err instanceof AppError) {
          if (err.statusCode === 404) {
            throw recoveryError(
              'RESERVATION_NOT_FOUND',
              'AI billing reservation not found during system recommendation settlement',
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
        throw recoveryError('SETTLEMENT_FAILED', 'System recommendation settlement failed', {
          reservationId,
          recoveryRequired: true,
        });
      }

      const idempotentReplay = settlement.idempotentReplay;
      try {
        await dependencies.repository.recordAuditLog({
          actorId: input.actorId,
          action: 'AI_BILLING_RECOVERY_SYSTEM_APPROVAL',
          targetUserId: reservation.userId,
          metadata: {
            reservationId,
            action: 'APPROVE_SYSTEM_RECOMMENDATION',
            systemRecommendedTokens,
            adminApprovedTokens: systemRecommendedTokens,
            overrideFlag: false,
            reason: action.reason,
            evidenceReference: action.evidenceReference,
            repricingStatus: repricingRecommendation.repricingStatus,
            rateCardVersion: repricingRecommendation.rateCardVersion,
            totalProviderCostNanoUsd: repricingRecommendation.totalProviderCostNanoUsd,
            status: 'SETTLED',
          },
        });
      } catch (_) {}

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
        systemApproval: {
          systemRecommendedTokens,
          overrideFlag: false,
        },
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
    throw recoveryError('RECONCILIATION_FAILED', 'Wallet not found for reservation reconciliation', {
      statusCode: 404,
    });
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
      { statusCode: 409 },
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

export async function listAIBillingRecoveryQueue(
  input: AIBillingRecoveryQueueInput,
  dependencies: AIBillingRecoveryDependencies = createDefaultAIBillingRecoveryDependencies(),
): Promise<AIBillingRecoveryQueueResult> {
  const page = assertRecoveryQueuePage(input.page);
  const limit = assertRecoveryQueueLimit(input.limit);
  const inspectedAt = new Date();

  let pageResult;
  try {
    pageResult = await dependencies.repository.listReservationsForRecovery({
      status: input.status,
      feature: input.feature,
      page,
      limit,
    });
  } catch (err) {
    wrapRepositoryRead(
      'INTEGRITY_CONFLICT',
      'AI billing recovery queue data could not be read reliably',
      undefined,
      err,
    );
  }

  const items: AIBillingRecoveryQueueItem[] = pageResult.items.map((reservation) => {
    const parsed = parseAIBillingMetadata(reservation.metadata);
    const metadataStatus: AIBillingMetadataStatus =
      parsed.status === 'MISSING'
        ? 'MISSING'
        : parsed.status === 'INVALID'
          ? 'INVALID'
          : parsed.reservationAmountFromMetadata === reservation.tokens
            ? 'VALID'
            : 'INVALID';

    let reasonCode: AIBillingRecoveryReasonCode;
    if (reservation.status === 'PENDING') {
      reasonCode =
        metadataStatus === 'MISSING'
          ? 'METADATA_MISSING'
          : metadataStatus === 'INVALID'
            ? 'METADATA_INVALID'
            : 'PENDING_REVIEW';
    } else {
      reasonCode = 'RESOLVED';
    }

    const metadataSummary = parsed.status === 'VALID' ? parsed.summary : undefined;

    return {
      reservationId: reservation.id,
      referenceId: reservation.referenceId,
      walletId: reservation.walletId,
      userId: reservation.userId,
      feature: reservation.feature,
      source: reservation.source,
      reservationStatus: reservation.status,
      reservedTokens: reservation.tokens,
      pricingVersion: reservation.pricingVersion,
      expiresAt: reservation.expiresAt.toISOString(),
      isExpired: reservation.expiresAt.getTime() <= inspectedAt.getTime(),
      metadataStatus,
      reasonCode,
      ...(parsed.status === 'VALID' && metadataStatus === 'VALID'
        ? parsed.metadataContract === 'LEGACY'
          ? {
              requestedMode: parsed.summary.requestedMode,
              quoteAppliedMode: parsed.summary.quoteAppliedMode,
              ...(parsed.summary.provider === undefined ? {} : { provider: parsed.summary.provider }),
              ...(parsed.summary.model === undefined ? {} : { model: parsed.summary.model }),
              ...(parsed.summary.billingCurrency === undefined
                ? {}
                : { billingCurrency: parsed.summary.billingCurrency }),
              ...(parsed.summary.rateCardVersion === undefined
                ? {}
                : { rateCardVersion: parsed.summary.rateCardVersion }),
              ...(parsed.summary.walletPolicyVersion === undefined
                ? {}
                : { walletPolicyVersion: parsed.summary.walletPolicyVersion }),
            }
          : {
              ...(parsed.summary.provider === undefined ? {} : { provider: parsed.summary.provider }),
              ...(parsed.summary.model === undefined ? {} : { model: parsed.summary.model }),
              ...(parsed.summary.rateCardVersion === undefined
                ? {}
                : { rateCardVersion: parsed.summary.rateCardVersion }),
              ...(parsed.summary.walletPolicyVersion === undefined
                ? {}
                : { walletPolicyVersion: parsed.summary.walletPolicyVersion }),
            }
        : {}),
    };
  });

  return {
    items,
    pagination: {
      page,
      limit,
      total: pageResult.total,
      totalPages: pageResult.total > 0 ? Math.ceil(pageResult.total / limit) : 0,
    },
    aggregate: {
      count: pageResult.aggregate.count,
      totalTokens: pageResult.aggregate.totalTokens,
    },
  };
}
