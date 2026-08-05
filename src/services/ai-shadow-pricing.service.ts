/**
 * Phase 2D-A failure-isolated shadow-pricing service.
 *
 * This is the thin wrapper that connects the pure Phase 2C engine to the outer
 * request path at the `recordAiUsage` choke point. It:
 *
 *  1. classifies whether the incoming `providerCalls` is authoritative
 *  2. calls the pure aggregate pricing function exactly once
 *  3. converts the result through the BigInt-safe reporting boundary
 *  4. appends one immutable observation to the bounded in-memory buffer
 *  5. emits one structured log event (shadow/estimate wording only)
 *  6. returns a useful, explicitly-typed outcome to tests
 *  7. never throws into the caller
 *
 * Authoritative-input distinction (locked):
 *
 *  - `providerCalls` absent or not an array            → NOT authoritative;
 *    skipped entirely (no engine call, no observation, no log, no coverage).
 *  - `providerCalls` an explicit empty array            → authoritative
 *    zero-call (cache hit); produces a `noProviderCalls` observation that is
 *    not a pricing failure and never enters priced/unpriced denominators.
 *  - `providerCalls` an authoritative non-empty array   → every real call is
 *    priced exactly once; `providerCallMade=false` records are ignored by the
 *    engine.
 *
 * Legacy aggregate usage/model is never fed to the engine; there is no fallback.
 *
 * Safety: unexpected errors are caught, logged as a safe structured error event
 * with no secrets/raw payloads/stack, and returned as a failure outcome without
 * altering AiUsageLog writes, the AI request, or Wallet behavior.
 *
 * Dependencies are injected so tests can simulate engine / logger / buffer
 * failure without global monkey-patching.
 */

import type { ProviderRateCard } from '../types/provider-pricing.js';
import type { ShadowPricingInput, ShadowPricingResult } from '../types/provider-pricing.js';
import { PROVIDER_RATE_CARD } from '../config/provider-rate-card/index.js';
import { aggregateProviderCalls } from '../utils/provider-pricing/aggregate.js';
import { toReportableShadow } from '../utils/provider-pricing/reporting.js';
import type { ReportableShadow } from '../utils/provider-pricing/reporting.js';
import { normalizeProviderCalls } from '../utils/ai-usage.js';
import { normalizeProviderAttempts, computeAttemptRiskStatus } from '../utils/ai-usage.js';
import type { AttemptRiskStatus, ProviderAttempt } from '../types/ai.js';
import { AiShadowPricingObservationService } from './ai-shadow-pricing-observation.service.js';
import type { ShadowPricingObservation } from './ai-shadow-pricing-observation.service.js';

/** Thin structured logger seam (the repo uses `console.*`). */
export interface ShadowPricingLogger {
  info: (event: string, payload: Record<string, unknown>) => void;
  error: (event: string, payload: Record<string, unknown>) => void;
}

const CONSOLE_LOGGER: ShadowPricingLogger = {
  info(event, payload) {
    console.info('[shadow-pricing]', { event, ...payload });
  },
  error(event, payload) {
    console.error('[shadow-pricing]', { event, ...payload });
  },
};

export interface ShadowPricingServiceOptions {
  /** Aggregate engine; defaults to the Phase 2C pure function. */
  engine?: (input: ShadowPricingInput) => ShadowPricingResult;
  /** Buffer seam; defaults to a process-shared instance. */
  buffer?: AiShadowPricingObservationService;
  /** Logger seam; defaults to console-based structured logger. */
  logger?: ShadowPricingLogger;
  /** Rate card applied (for `rateCardVersion`); defaults to the materialized card. */
  card?: ProviderRateCard;
  /** Clock seam for `observedAt`; defaults to ISO-now. */
  now?: () => string;
}

export interface ShadowPricingRequestContext {
  source?: string;
  conversationId?: string | null;
  /** Diagnostic provider attempts for this request (observability only). */
  providerAttempts?: unknown;
  /** Injectable for tests / deterministic reporting. */
  pricingDate?: string;
}

/** Explicit, test-friendly outcome of one authoritative call. */
export type ShadowPricingOutcome =
  | { kind: 'skipped'; reason: 'NOT_AUTHORITATIVE' | 'INVALID' }
  | { kind: 'noProviderCalls'; result: ShadowPricingResult }
  | { kind: 'priced'; result: ShadowPricingResult }
  | { kind: 'error'; errorName?: string; errorMessage?: string };

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Distinguish a skipped (non-authoritative) payload from an empty array. */
function classifyProviderCalls(
  providerCalls: unknown,
): 'skipped' | 'noProviderCalls' | 'authoritative' {
  if (!isArray(providerCalls)) {
    return 'skipped';
  }
  if (providerCalls.length === 0) {
    return 'noProviderCalls';
  }
  // A non-empty array that fails normalization is invalid / not authoritative.
  if (normalizeProviderCalls(providerCalls) === undefined) {
    return 'skipped';
  }
  return 'authoritative';
}

/** Build a single immutable observation from a reportable result. */
function buildObservation(
  report: ReportableShadow,
  source: string,
  conversationId: string | undefined | null,
  observedAt: string,
  attemptRiskStatus: AttemptRiskStatus,
  attempts: ProviderAttempt[],
): ShadowPricingObservation {
  return {
    observedAt,
    source,
    conversationId: conversationId ?? undefined,
    report,
    attemptRiskStatus,
    attempts,
  };
}

/** Sanitize an unexpected error into a safe, generic structured message without exposing raw error text. */
function safeError(error: unknown): { errorName: string; errorMessage: string } {
  const name = error instanceof Error ? error.name : 'Error';
  const safeMessage = 'shadow pricing failed';
  return { errorName: name || 'Error', errorMessage: safeMessage };
}

/** Safe generic message for observation-buffer failures. */
function safeObservationError(): { errorName: string; errorMessage: string } {
  return { errorName: 'Error', errorMessage: 'shadow pricing observation failed' };
}

export class AiShadowPricingService {
  private readonly logger: ShadowPricingLogger;
  private readonly buffer: AiShadowPricingObservationService;
  private readonly card: ProviderRateCard;
  private readonly engine: (input: ShadowPricingInput) => ShadowPricingResult;
  private readonly now: () => string;

  constructor(deps: ShadowPricingServiceOptions = {}) {
    this.engine = deps.engine ?? aggregateProviderCalls;
    this.buffer = deps.buffer ?? DEFAULT_OBSERVATION_BUFFER;
    this.logger = deps.logger ?? CONSOLE_LOGGER;
    this.card = deps.card ?? PROVIDER_RATE_CARD;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /** Emit a structured log event; a logger failure is swallowed, never escaped. */
  private safeLog(
    method: 'info' | 'error',
    event: string,
    payload: Record<string, unknown>,
  ): void {
    try {
      this.logger[method](event, payload);
    } catch {
      // Logger failure must never escape the shadow path.
    }
  }

  /**
   * Price authoritative providerCalls once, report via the output boundary,
   * append one observation, emit one structured log, and never throw.
   */
  record(providerCalls: unknown, ctx: ShadowPricingRequestContext = {}): ShadowPricingOutcome {
    const classification = classifyProviderCalls(providerCalls);
    const source = ctx.source ?? 'chat';
    const conversationId = ctx.conversationId ?? undefined;
    const observedAt = this.now();
    const attempts = normalizeProviderAttempts(ctx.providerAttempts) ?? [];
    const attemptRiskStatus = computeAttemptRiskStatus(attempts);

    if (classification === 'skipped') {
      return {
        kind: 'skipped',
        reason: isArray(providerCalls) ? 'INVALID' : 'NOT_AUTHORITATIVE',
      };
    }

    const input: ShadowPricingInput = {
      providerCalls: classification === 'noProviderCalls' ? [] : providerCalls,
      ...(ctx.pricingDate ? { pricingDate: ctx.pricingDate } : {}),
      card: this.card,
    };

    try {
      const result = this.engine(input);
      const report = toReportableShadow(result, this.card.version);

      try {
        this.buffer.record(buildObservation(report, source, conversationId, observedAt, attemptRiskStatus, attempts));
      } catch (_bufferError) {
        // The buffer must never break the request path.
        const safe = safeObservationError();
        this.safeLog('error', 'ai_shadow_pricing_error', {
          event: 'ai_shadow_pricing_error',
          source,
          errorName: safe.errorName,
          errorMessage: `shadow pricing observation failed`,
        });
      }

      this.safeLog('info', 'ai_shadow_pricing', {
        event: 'ai_shadow_pricing',
        source,
        conversationId,
        summaryStatus: report.summaryStatus,
        noProviderCalls: report.noProviderCalls,
        callCount: report.totals.callCount,
        pricedCallCount: report.totals.pricedCallCount,
        unpricedCallCount: report.totals.unpricedCallCount,
        pricedCostNanoUsd: report.totals.pricedCostNanoUsd,
        pricedCostMicroUsd: report.totals.pricedCostMicroUsd,
        pricedCostUsd: report.totals.pricedCostUsd,
        rateCardVersion: report.rateCardVersion,
        unpricedReasons: report.totals.unpricedReasons,
      });

      return classification === 'noProviderCalls'
        ? { kind: 'noProviderCalls', result }
        : { kind: 'priced', result };
    } catch (engineError) {
      const safe = safeError(engineError);
      this.safeLog('error', 'ai_shadow_pricing_error', {
        event: 'ai_shadow_pricing_error',
        source,
        errorName: safe.errorName,
        errorMessage: safe.errorMessage,
      });
      return { kind: 'error', errorName: safe.errorName, errorMessage: safe.errorMessage };
    }
  }
}

/**
 * Process-shared default observation buffer for the singleton service.
 * Exported so tests can reset it deterministically.
 */
export const DEFAULT_OBSERVATION_BUFFER = new AiShadowPricingObservationService();

/** Application-wide default shadow-pricing service (the integration choke point). */
export const shadowPricingService = new AiShadowPricingService();