/**
 * Phase 2D-A/2F-D failure-isolated shadow-pricing service with database comparison.
 *
 * This is the thin wrapper that connects the pure Phase 2C engine to the outer
 * request path at the `recordAiUsage` choke point. It:
 *
 *  1. classifies whether the incoming `providerCalls` is authoritative
 *  2. calls the pure aggregate pricing function exactly once (static result)
 *  3. optionally loads a database rate card and computes a shadow comparison
 *  4. converts the result through the BigInt-safe reporting boundary
 *  5. appends one immutable observation to the bounded in-memory buffer
 *  6. emits one structured log event (shadow/estimate wording only)
 *  7. returns a useful, explicitly-typed outcome to tests
 *  8. never throws into the caller
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
 * Database Shadow Pricing (Phase 2F-D):
 *  - Static result is ALWAYS authoritative
 *  - Database pricing is comparison-only, never affects billing or responses
 *  - Feature flag defaults to disabled
 *  - All database failures are isolated and never escape the shadow path
 *  - Comparison results are logged/observed but never replace the static result
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
import { env } from '../config/env.js';
import { compareShadowPricingResults } from '../utils/provider-pricing/shadow-comparison.js';
import type { ShadowComparisonResult, ShadowComparisonStatus } from '../utils/provider-pricing/shadow-comparison.js';
import { ShadowPricingDependencies, loadShadowRateCard, loadPrimaryRateCard, ShadowRateCardLoadResult, createDefaultShadowPricingDependencies, createDefaultDatabaseShadowPricingDependencies } from './shadow-pricing-deps.js';

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
  /** Shadow pricing dependencies for database comparison (Phase 2F-D). */
  shadowDeps?: ShadowPricingDependencies;
  /** Optional operation ID for correlation. */
  operationId?: string;
}

export interface ShadowPricingRequestContext {
  source?: string;
  conversationId?: string | null;
  /** Diagnostic provider attempts for this request (observability only). */
  providerAttempts?: unknown;
  /** Injectable for tests / deterministic reporting. */
  pricingDate?: string;
  /** Optional operation ID for correlation (Phase 2F-D). */
  operationId?: string;
}

/** Explicit, test-friendly outcome of one authoritative call. */
export type ShadowPricingOutcome =
  | { kind: 'skipped'; reason: 'NOT_AUTHORITATIVE' | 'INVALID' }
  | { kind: 'noProviderCalls'; result: ShadowPricingResult }
  | { kind: 'priced'; result: ShadowPricingResult }
  | { kind: 'error'; errorName?: string; errorMessage?: string }
  | {
      kind: 'dbPricingError';
      errorCode: string;
      status: string;
      errorMessage: string;
    };

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

/** Map comparison status to a safe string for logging. */
function comparisonStatusToString(status: ShadowComparisonStatus): string {
  return status;
}

export class AiShadowPricingService {
  private readonly logger: ShadowPricingLogger;
  private readonly buffer: AiShadowPricingObservationService;
  private readonly card: ProviderRateCard;
  private readonly engine: (input: ShadowPricingInput) => ShadowPricingResult;
  private readonly now: () => string;
  private readonly shadowDeps: ShadowPricingDependencies;
  private readonly defaultOperationId: string;

  constructor(deps: ShadowPricingServiceOptions = {}) {
    this.engine = deps.engine ?? aggregateProviderCalls;
    this.buffer = deps.buffer ?? DEFAULT_OBSERVATION_BUFFER;
    this.logger = deps.logger ?? CONSOLE_LOGGER;
    this.card = deps.card ?? PROVIDER_RATE_CARD;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.shadowDeps = {
      ...createDefaultShadowPricingDependencies(),
      ...deps.shadowDeps,
      dbShadowEnabled: deps.shadowDeps?.dbShadowEnabled ?? env.PROVIDER_RATE_CARD_DB_SHADOW_ENABLED,
      pricingSource: deps.shadowDeps?.pricingSource ?? env.PROVIDER_RATE_CARD_PRICING_SOURCE,
    };
    this.defaultOperationId = deps.operationId ?? `shadow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
   * Price authoritative providerCalls once, optionally compare with database rate card,
   * report via the output boundary, append one observation, emit structured logs,
   * and never throw.
   *
   * The static result is ALWAYS returned as the authoritative outcome.
   * Database comparison is purely observational.
   */
  async record(providerCalls: unknown, ctx: ShadowPricingRequestContext = {}): Promise<ShadowPricingOutcome> {
    const classification = classifyProviderCalls(providerCalls);
    const source = ctx.source ?? 'chat';
    const conversationId = ctx.conversationId ?? undefined;
    const observedAt = this.now();
    const attempts = normalizeProviderAttempts(ctx.providerAttempts) ?? [];
    const attemptRiskStatus = computeAttemptRiskStatus(attempts);
    const operationId = ctx.operationId ?? this.defaultOperationId;
    const pricingDate = ctx.pricingDate ?? new Date().toISOString().slice(0, 10);
    const comparisonStartMs = this.shadowDeps.now?.() ?? Date.now();
    const configuredPricingSource = this.shadowDeps.pricingSource ?? 'STATIC';

    if (classification === 'skipped') {
      return {
        kind: 'skipped',
        reason: isArray(providerCalls) ? 'INVALID' : 'NOT_AUTHORITATIVE',
      };
    }

    // DATABASE_PRIMARY (Phase 2F-E): the database rate card is the authoritative
    // pricing source. Fail closed on any load failure — no silent static fallback.
    if (configuredPricingSource === 'DATABASE_PRIMARY') {
      return this.recordDatabasePrimary(providerCalls, classification, {
        source,
        conversationId,
        observedAt,
        attemptRiskStatus,
        attempts,
        operationId,
        pricingDate,
        startMs: comparisonStartMs,
      });
    }

    const input: ShadowPricingInput = {
      providerCalls: classification === 'noProviderCalls' ? [] : providerCalls,
      ...(ctx.pricingDate ? { pricingDate: ctx.pricingDate } : {}),
      card: this.card,
    };

    // DATABASE_SHADOW implies the 2F-D shadow flag; STATIC only when the flag is set.
    const shadowEnabled =
      this.shadowDeps.dbShadowEnabled || configuredPricingSource === 'DATABASE_SHADOW';

    try {
      // Step 1: Compute the static (authoritative) result
      const staticResult = this.engine(input);
      const staticReport = toReportableShadow(staticResult, this.card.version);

      // Step 2: Optionally compute database shadow comparison
      let comparisonResult: ShadowComparisonResult | null = null;
      let dbResult: ShadowPricingResult | null = null;
      let dbLoadError: ShadowRateCardLoadResult['error'] | null = null;
      let dbRateCardVersion: string | null = null;
      let loadResult: ShadowRateCardLoadResult | null = null;

      if (shadowEnabled && classification === 'authoritative') {
        const timeoutMs = env.PROVIDER_RATE_CARD_DB_SHADOW_TIMEOUT_MS;
        const shadowWork = (async () => {
          // Load database rate card by ACTIVE date
          const lr = await loadShadowRateCard(this.shadowDeps, 'ACTIVE_DATE', pricingDate);
          loadResult = lr;
          dbLoadError = lr.error;
          dbRateCardVersion = lr.snapshot?.version ?? null;

          if (lr.card && !lr.error) {
            // Compute database pricing result using the same normalized calls
            const dbInput: ShadowPricingInput = {
              providerCalls: input.providerCalls,
              pricingDate: input.pricingDate,
              tier: input.tier,
              card: lr.card,
            };
            dbResult = this.engine(dbInput);
          }
        })();

        // Race with timeout
        try {
          await Promise.race([
            shadowWork,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('DB_RATE_CARD_TIMEOUT')), timeoutMs),
            ),
          ]);
        } catch (e) {
          if (e instanceof Error && e.message === 'DB_RATE_CARD_TIMEOUT') {
            dbLoadError = { code: 'RATE_CARD_DATABASE_ERROR', status: 'DB_RATE_CARD_TIMEOUT' };
          } else {
            // Any unexpected error in shadow path is caught and logged but never thrown
            dbLoadError = { code: 'RATE_CARD_DATABASE_ERROR', status: 'DB_RATE_CARD_ERROR' };
          }
        }
      }

// Step 3: Compare results if we have both
        const durationMs = (this.shadowDeps.now?.() ?? Date.now()) - comparisonStartMs;
        if (shadowEnabled && classification === 'authoritative') {
          const dbCard = loadResult!.card ?? null;
comparisonResult = compareShadowPricingResults(
            staticResult,
            dbResult,
            dbLoadError,
            'ACTIVE_DATE',
            pricingDate,
            this.card.version,
            dbRateCardVersion,
            durationMs,
            true,
            this.card,
            dbCard,
          );

        // Emit structured comparison log
        if (comparisonResult) {
          this.safeLog('info', 'ai_shadow_pricing_comparison', {
            event: 'ai_shadow_pricing_comparison',
            operationId,
            source,
            conversationId,
            comparisonStatus: comparisonStatusToString(comparisonResult.status),
            selectionMode: comparisonResult.selectionMode,
            pricingDate: comparisonResult.pricingDate,
            staticRateCardVersion: comparisonResult.aggregate.staticRateCardVersion,
            databaseRateCardVersion: comparisonResult.aggregate.dbRateCardVersion,
            staticPricingStatus: comparisonResult.aggregate.staticSummaryStatus,
            databasePricingStatus: comparisonResult.aggregate.dbSummaryStatus,
            staticTotalCostNanoUsd: comparisonResult.aggregate.staticTotalCostNanoUsd.toString(),
            databaseTotalCostNanoUsd: comparisonResult.aggregate.dbTotalCostNanoUsd?.toString() ?? null,
            deltaNanoUsd: comparisonResult.aggregate.deltaNanoUsd?.toString() ?? null,
            mismatchFields: comparisonResult.mismatchFields,
            mismatchCategories: comparisonResult.mismatchCategories,
            loaderErrorCode: comparisonResult.loaderErrorCode,
            providerCallCount: comparisonResult.providerCallCount,
            durationMs: comparisonResult.durationMs,
            featureEnabled: comparisonResult.featureEnabled,
          });

          // Call optional callback
          if (this.shadowDeps.onComparison) {
            try {
              this.shadowDeps.onComparison({
                operationId,
                comparisonStatus: comparisonStatusToString(comparisonResult.status),
                selectionMode: comparisonResult.selectionMode,
                pricingDate: comparisonResult.pricingDate,
                staticRateCardVersion: comparisonResult.aggregate.staticRateCardVersion,
                databaseRateCardVersion: comparisonResult.aggregate.dbRateCardVersion,
                staticPricingStatus: comparisonResult.aggregate.staticSummaryStatus,
                databasePricingStatus: comparisonResult.aggregate.dbSummaryStatus,
                staticTotalCostNanoUsd: comparisonResult.aggregate.staticTotalCostNanoUsd.toString(),
                databaseTotalCostNanoUsd: comparisonResult.aggregate.dbTotalCostNanoUsd?.toString() ?? null,
                deltaNanoUsd: comparisonResult.aggregate.deltaNanoUsd?.toString() ?? null,
                mismatchFields: comparisonResult.mismatchFields,
                mismatchCategories: comparisonResult.mismatchCategories,
                loaderErrorCode: comparisonResult.loaderErrorCode,
                providerCallCount: comparisonResult.providerCallCount,
                durationMs: comparisonResult.durationMs,
                featureEnabled: comparisonResult.featureEnabled,
              });
            } catch {
              // Callback failure must never escape
            }
          }
        }
      }

      // Step 4: Record the standard observation (static result only)
      try {
        this.buffer.record(buildObservation(staticReport, source, conversationId, observedAt, attemptRiskStatus, attempts));
      } catch (_bufferError) {
        const safe = safeObservationError();
        this.safeLog('error', 'ai_shadow_pricing_error', {
          event: 'ai_shadow_pricing_error',
          source,
          errorName: safe.errorName,
          errorMessage: 'shadow pricing observation failed',
        });
      }

      // Step 5: Emit standard pricing log
      this.safeLog('info', 'ai_shadow_pricing', {
        event: 'ai_shadow_pricing',
        operationId,
        source,
        conversationId,
        configuredPricingSource,
        actualPricingSource: 'STATIC',
        pricingDate,
        rateCardVersion: staticReport.rateCardVersion,
        providerCallCount: staticReport.totals.callCount,
        pricingStatus: staticReport.summaryStatus,
        durationMs,
        loaderErrorCode: comparisonResult?.loaderErrorCode ?? null,
        rollbackToStatic: false,
        summaryStatus: staticReport.summaryStatus,
        noProviderCalls: staticReport.noProviderCalls,
        callCount: staticReport.totals.callCount,
        pricedCallCount: staticReport.totals.pricedCallCount,
        unpricedCallCount: staticReport.totals.unpricedCallCount,
        pricedCostNanoUsd: staticReport.totals.pricedCostNanoUsd,
        pricedCostMicroUsd: staticReport.totals.pricedCostMicroUsd,
        pricedCostUsd: staticReport.totals.pricedCostUsd,
        unpricedReasons: staticReport.totals.unpricedReasons,
      });

      return classification === 'noProviderCalls'
        ? { kind: 'noProviderCalls', result: staticResult }
        : { kind: 'priced', result: staticResult };
    } catch (engineError) {
      const safe = safeError(engineError);
      this.safeLog('error', 'ai_shadow_pricing_error', {
        event: 'ai_shadow_pricing_error',
        operationId,
        source,
        conversationId,
        configuredPricingSource,
        actualPricingSource: 'STATIC',
        pricingDate,
        rateCardVersion: null,
        providerCallCount: classification === 'authoritative' ? (normalizeProviderCalls(providerCalls) ?? []).length : 0,
        pricingStatus: 'ERROR',
        durationMs: (this.shadowDeps.now?.() ?? Date.now()) - comparisonStartMs,
        loaderErrorCode: null,
        rollbackToStatic: false,
        errorName: safe.errorName,
        errorMessage: safe.errorMessage,
      });
      return { kind: 'error', errorName: safe.errorName, errorMessage: safe.errorMessage };
    }
  }

  /**
   * DATABASE_PRIMARY pricing (Phase 2F-E): the database rate card is the
   * authoritative pricing source. Loads exactly one ACTIVE rate card for the
   * pricing date (once per operation), prices the normalized providerCalls with
   * it, and returns the database result as the outcome. Fails closed on any
   * load failure — no silent static fallback and never a fabricated zero cost.
   * Never mutates rate-card lifecycle or billing state.
   */
  private async recordDatabasePrimary(
    providerCalls: unknown,
    classification: 'noProviderCalls' | 'authoritative',
    ctx: {
      source: string;
      conversationId: string | undefined;
      observedAt: string;
      attemptRiskStatus: AttemptRiskStatus;
      attempts: ProviderAttempt[];
      operationId: string;
      pricingDate: string;
      startMs: number;
    },
  ): Promise<ShadowPricingOutcome> {
    const timeoutMs = env.PROVIDER_RATE_CARD_DB_SHADOW_TIMEOUT_MS;
    const providerCallCount =
      classification === 'authoritative' ? (normalizeProviderCalls(providerCalls) ?? []).length : 0;

    // Cache hit / zero provider calls: no DB card is loaded and no pricing occurs.
    if (classification === 'noProviderCalls') {
      const durationMs = (this.shadowDeps.now?.() ?? Date.now()) - ctx.startMs;
      const staticResult = this.engine({ providerCalls: [], pricingDate: ctx.pricingDate, card: this.card });
      const staticReport = toReportableShadow(staticResult, this.card.version);
      try {
        this.buffer.record(buildObservation(staticReport, ctx.source, ctx.conversationId, ctx.observedAt, ctx.attemptRiskStatus, ctx.attempts));
      } catch (_bufferError) {
        const safe = safeObservationError();
        this.safeLog('error', 'ai_shadow_pricing_error', {
          event: 'ai_shadow_pricing_error',
          operationId: ctx.operationId,
          source: ctx.source,
          errorName: safe.errorName,
          errorMessage: 'shadow pricing observation failed',
        });
      }
      this.safeLog('info', 'ai_shadow_pricing', {
        event: 'ai_shadow_pricing',
        operationId: ctx.operationId,
        source: ctx.source,
        conversationId: ctx.conversationId,
        configuredPricingSource: 'DATABASE_PRIMARY',
        actualPricingSource: 'STATIC',
        pricingDate: ctx.pricingDate,
        rateCardVersion: null,
        providerCallCount: 0,
        pricingStatus: staticReport.summaryStatus,
        durationMs,
        loaderErrorCode: null,
        rollbackToStatic: false,
        summaryStatus: staticReport.summaryStatus,
        noProviderCalls: true,
        callCount: 0,
        pricedCallCount: 0,
        unpricedCallCount: 0,
        pricedCostNanoUsd: staticReport.totals.pricedCostNanoUsd,
        pricedCostMicroUsd: staticReport.totals.pricedCostMicroUsd,
        pricedCostUsd: staticReport.totals.pricedCostUsd,
        unpricedReasons: staticReport.totals.unpricedReasons,
      });
      return { kind: 'noProviderCalls', result: staticResult };
    }

    // Authoritative: load exactly one ACTIVE database rate card and price with it.
    let loadResult: ShadowRateCardLoadResult | null = null;
    let dbLoadError: ShadowRateCardLoadResult['error'] | null = null;
    let dbResult: ShadowPricingResult | null = null;
    let dbRateCardVersion: string | null = null;

    const primaryWork = (async () => {
      const lr = await loadPrimaryRateCard(this.shadowDeps, ctx.pricingDate);
      loadResult = lr;
      dbLoadError = lr.error;
      dbRateCardVersion = lr.snapshot?.version ?? null;
      if (lr.card && !lr.error) {
        const dbInput: ShadowPricingInput = {
          providerCalls,
          pricingDate: ctx.pricingDate,
          card: lr.card,
        };
        dbResult = this.engine(dbInput);
      }
    })();

    try {
      await Promise.race([
        primaryWork,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('DB_RATE_CARD_TIMEOUT')), timeoutMs),
        ),
      ]);
    } catch (e) {
      if (e instanceof Error && e.message === 'DB_RATE_CARD_TIMEOUT') {
        dbLoadError = { code: 'RATE_CARD_DATABASE_ERROR', status: 'DB_RATE_CARD_TIMEOUT' };
      } else {
        // Any unexpected error (including engine failure) is a stable DB pricing error.
        dbLoadError = { code: 'RATE_CARD_DATABASE_ERROR', status: 'DB_RATE_CARD_ERROR' };
      }
    }

    const durationMs = (this.shadowDeps.now?.() ?? Date.now()) - ctx.startMs;

    // Fail closed: stable internal pricing error for any load/pricing failure.
    if (dbLoadError || !dbResult) {
      const status = dbLoadError ? dbLoadError.status : 'DB_RATE_CARD_ERROR';
      const code = dbLoadError ? dbLoadError.code : 'RATE_CARD_DATABASE_ERROR';
      this.safeLog('error', 'ai_shadow_pricing_primary_error', {
        event: 'ai_shadow_pricing_primary_error',
        operationId: ctx.operationId,
        source: ctx.source,
        conversationId: ctx.conversationId,
        configuredPricingSource: 'DATABASE_PRIMARY',
        actualPricingSource: 'DATABASE_PRIMARY',
        pricingDate: ctx.pricingDate,
        rateCardVersion: dbRateCardVersion,
        providerCallCount,
        pricingStatus: status,
        durationMs,
        loaderErrorCode: code,
        rollbackToStatic: false,
        errorMessage: 'database rate card pricing unavailable',
      });
      return {
        kind: 'dbPricingError',
        errorCode: code,
        status,
        errorMessage: 'database rate card pricing unavailable',
      };
    }

    const report = toReportableShadow(dbResult, dbRateCardVersion ?? this.card.version);

    try {
      this.buffer.record(buildObservation(report, ctx.source, ctx.conversationId, ctx.observedAt, ctx.attemptRiskStatus, ctx.attempts));
    } catch (_bufferError) {
      const safe = safeObservationError();
      this.safeLog('error', 'ai_shadow_pricing_error', {
        event: 'ai_shadow_pricing_error',
        operationId: ctx.operationId,
        source: ctx.source,
        errorName: safe.errorName,
        errorMessage: 'shadow pricing observation failed',
      });
    }

    this.safeLog('info', 'ai_shadow_pricing', {
      event: 'ai_shadow_pricing',
      operationId: ctx.operationId,
      source: ctx.source,
      conversationId: ctx.conversationId,
      configuredPricingSource: 'DATABASE_PRIMARY',
      actualPricingSource: 'DATABASE_PRIMARY',
      pricingDate: ctx.pricingDate,
      rateCardVersion: dbRateCardVersion,
      providerCallCount,
      pricingStatus: report.summaryStatus,
      durationMs,
      loaderErrorCode: null,
      rollbackToStatic: false,
      summaryStatus: report.summaryStatus,
      noProviderCalls: report.noProviderCalls,
      callCount: report.totals.callCount,
      pricedCallCount: report.totals.pricedCallCount,
      unpricedCallCount: report.totals.unpricedCallCount,
      pricedCostNanoUsd: report.totals.pricedCostNanoUsd,
      pricedCostMicroUsd: report.totals.pricedCostMicroUsd,
      pricedCostUsd: report.totals.pricedCostUsd,
      unpricedReasons: report.totals.unpricedReasons,
    });

    return { kind: 'priced', result: dbResult };
  }
}

/**
 * Process-shared default observation buffer for the singleton service.
 * Exported so tests can reset it deterministically.
 */
export const DEFAULT_OBSERVATION_BUFFER = new AiShadowPricingObservationService();

/** Application-wide default shadow-pricing service (the integration choke point). */
export const shadowPricingService = new AiShadowPricingService({
  shadowDeps: createDefaultDatabaseShadowPricingDependencies(),
});