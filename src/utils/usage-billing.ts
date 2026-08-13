import type { AIExecutionOutcome } from '../types/ai-execution.js';
import type { UsageBasedBillingResult } from '../types/usage-based-ai-billing.js';
import { AppError } from '../middleware/errorHandler.js';
import { normalizeAIProviderUsage } from './ai-usage.js';

/**
 * Phase 2G-A route-facing usage-based billing helpers shared by the live
 * feature routes (chat, chat-stream, identify, voice, itinerary).
 *
 * These helpers only build AI execution outcomes and map coordinator results to
 * HTTP contracts. They never touch Prisma, never price, and never convert.
 */

/**
 * Derive the provider from a Gemini model name. The static rate card only
 * routes Gemini models, so every known model maps to `google`. Unknown models
 * return undefined so the caller can fall back to providerCalls evidence.
 */
export function deriveProviderFromModel(model: string | undefined | null): string | undefined {
  if (model === undefined || model === null) return undefined;
  const trimmed = model.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith('gemini')) return 'google';
  return undefined;
}

/**
 * Build a SUCCESS outcome from a feature result and the AI service usage
 * payload. Provider is derived from the model; when the model is unknown the
 * outcome cannot be formed and an INDETERMINATE_FAILURE is returned so the
 * coordinator never auto-releases and never treats the cost as zero.
 */
export function buildSuccessOutcome<T>(
  data: T,
  usage?: unknown,
): AIExecutionOutcome<T> {
  if (usage === null || usage === undefined || typeof usage !== 'object') {
    return {
      kind: 'INDETERMINATE_FAILURE',
      code: 'USAGE_EVIDENCE_MISSING',
      message: 'AI response is missing trusted usage evidence',
      providerRequestSent: true,
      retryable: false,
    };
  }

  const record = usage as Record<string, unknown>;
  const model = typeof record.model === 'string' ? record.model : undefined;
  const provider = deriveProviderFromModel(model);
  if (!provider) {
    return {
      kind: 'INDETERMINATE_FAILURE',
      code: 'USAGE_EVIDENCE_UNKNOWN_MODEL',
      message: 'AI response usage model is not recognized',
      providerRequestSent: true,
      retryable: false,
    };
  }

  const normalized = normalizeAIProviderUsage({ ...record, provider });
  if (!normalized) {
    return {
      kind: 'INDETERMINATE_FAILURE',
      code: 'USAGE_EVIDENCE_INVALID',
      message: 'AI response usage evidence is invalid',
      providerRequestSent: true,
      retryable: false,
    };
  }

  return {
    kind: 'SUCCESS',
    data,
    execution: {
      provider: normalized.provider,
      model: normalized.model,
    },
    usage: normalized,
  };
}

/**
 * Build the only accepted zero-provider-cost success outcome.  The Identify
 * service explicitly marks a stored-result response with `cached: true` and
 * `providerCalls: []`; it intentionally has no provider usage because no
 * provider request occurred.  The execution identity is an internal cache
 * marker used only for durable operation evidence, never for rate-card
 * pricing: the coordinator settles this outcome at zero before pricing calls.
 */
export function buildExplicitCacheHitOutcome<T>(data: T): AIExecutionOutcome<T> {
  return {
    kind: 'SUCCESS',
    data,
    execution: { provider: 'cache', model: 'identify-cache-hit' },
    usage: {
      provider: 'cache',
      model: 'identify-cache-hit',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  };
}

/**
 * An upstream AI-service failure is indeterminate from Core's perspective:
 * the service may have already dispatched a physical provider attempt. Never
 * invent a user charge, but retain the reservation for conservative recovery
 * instead of releasing it as a known zero-cost outcome.
 */
export function aiUnavailableOutcome(message: string): AIExecutionOutcome<never> {
  return {
    kind: 'INDETERMINATE_FAILURE',
    code: 'AI_SERVICE_UNAVAILABLE',
    message,
    providerRequestSent: true,
    retryable: true,
  };
}

export interface UsageBillingLabels {
  /** Human feature label used for recovery logging. */
  feature: string;
  /** HTTP 409 message for an idempotent replay. */
  replayMessage: string;
  /** HTTP 502 message when the AI service is unavailable. */
  aiUnavailableMessage: string;
}

/**
 * Map a coordinator result to the feature result data, throwing the same
 * AppError contracts the FIXED mode exposes (402 insufficient, 403 inactive,
 * 409 replay, 502 AI service unavailable).
 */
export function resolveUsageBasedBillingResult<T>(
  result: UsageBasedBillingResult<T>,
  labels: UsageBillingLabels,
): T {
  switch (result.outcome) {
    case 'SETTLED':
    case 'ADMIN_EXEMPT':
      return result.data;

    case 'RELEASED':
      throw new AppError(502, labels.aiUnavailableMessage);

    case 'RESERVATION_DENIED': {
      switch (result.reason) {
        case 'INSUFFICIENT_BALANCE':
        case 'WALLET_NOT_FOUND':
          throw new AppError(402, 'Insufficient token balance');
        case 'WALLET_NOT_ACTIVE':
          throw new AppError(403, 'Token wallet is not active');
        default:
          throw new AppError(result.httpStatus, 'Token consumption failed');
      }
    }

    case 'RECOVERY_REQUIRED': {
      if (
        result.reasonCode === 'OPERATION_REPLAY_REQUIRES_RECOVERY' ||
        result.reasonCode === 'OPERATION_CREATE_REPLAY'
      ) {
        throw new AppError(409, labels.replayMessage);
      }
      console.error('[usage-billing] recovery_required', {
        feature: labels.feature,
        operationId: result.operationId,
        reservationId: result.reservationId,
        operationStatus: result.operationStatus,
        stage: result.stage,
        reasonCode: result.reasonCode,
      });
      throw new AppError(500, 'AI request could not be completed. Please retry.');
    }
  }
}
