/**
 * Phase 2F-D pure deterministic shadow pricing comparison.
 *
 * Compares static (authoritative) and database (shadow) pricing results.
 * Never mutates either input. Uses bigint-safe comparisons.
 */

import type {
  ShadowPricingResult,
  ShadowPricedCall,
  PricedShadowCall,
  UnpricedShadowCall,
  UnpricedReason,
  RequestSummaryStatus,
  PricedVia,
  RateCardTier,
  RateCardBillingUnit,
  RateCardEntry,
  ProviderRateCard,
} from '../../types/provider-pricing.js';
import { tokenComponentCostNanoUsd, perUnitCostNanoUsd } from './arithmetic.js';

/** Find a rate-card entry matching provider, model, tier, billingUnit. */
function findEntry(card: ProviderRateCard, provider: string, model: string, tier: RateCardTier | undefined, billingUnit: RateCardBillingUnit): RateCardEntry | undefined {
  return card.entries.find(
    (e) => e.provider === provider && e.model === model && e.tier === tier && e.billingUnit === billingUnit,
  );
}

/** Compute component costs for a priced call using its usageApplied and the matched entry. */
function computeComponentCosts(call: PricedShadowCall, entry: RateCardEntry | undefined): {
  input: bigint | null;
  output: bigint | null;
  cachedInput: bigint | null;
  cachedOutput: bigint | null;
  audioInput: bigint | null;
  audioOutput: bigint | null;
  perUnit: bigint | null;
} {
  const usage = call.usageApplied ?? {};
  const res = {
    input: null as bigint | null,
    output: null as bigint | null,
    cachedInput: null as bigint | null,
    cachedOutput: null as bigint | null,
    audioInput: null as bigint | null,
    audioOutput: null as bigint | null,
    perUnit: null as bigint | null,
  };
  if (!entry) return res;

  // Token billing
  if (entry.billingUnit === 'TOKEN' && entry.tokenRates) {
    const rates = entry.tokenRates;
    if (usage.inputTokens !== undefined && rates.inputMicrosPerMillion !== undefined) {
      res.input = tokenComponentCostNanoUsd(BigInt(usage.inputTokens), BigInt(rates.inputMicrosPerMillion));
    }
    if (usage.outputTokens !== undefined && rates.outputMicrosPerMillion !== undefined) {
      res.output = tokenComponentCostNanoUsd(BigInt(usage.outputTokens), BigInt(rates.outputMicrosPerMillion));
    }
    if (usage.cachedInputTokens !== undefined && rates.cachedInputMicrosPerMillion !== undefined) {
      res.cachedInput = tokenComponentCostNanoUsd(BigInt(usage.cachedInputTokens), BigInt(rates.cachedInputMicrosPerMillion));
    }
    if (usage.cachedOutputTokens !== undefined && rates.cachedOutputMicrosPerMillion !== undefined) {
      res.cachedOutput = tokenComponentCostNanoUsd(BigInt(usage.cachedOutputTokens), BigInt(rates.cachedOutputMicrosPerMillion));
    }
    if (entry.modalityRates?.audioInputMicrosPerMillion !== undefined && usage.audioInputTokens !== undefined) {
      res.audioInput = tokenComponentCostNanoUsd(BigInt(usage.audioInputTokens), BigInt(entry.modalityRates.audioInputMicrosPerMillion));
    }
    if (entry.tts?.audioOutputMicrosPerMillion !== undefined && usage.audioOutputTokens !== undefined) {
      res.audioOutput = tokenComponentCostNanoUsd(BigInt(usage.audioOutputTokens), BigInt(entry.tts.audioOutputMicrosPerMillion));
    }
  } else if (entry.perUnitMicros !== undefined) {
    // Non-token per-unit (IMAGE, CHARACTER, SECOND, MINUTE)
    if (usage.generatedImageCount !== undefined) {
      res.perUnit = perUnitCostNanoUsd(BigInt(usage.generatedImageCount), BigInt(entry.perUnitMicros));
    } else if (usage.inputCharacters !== undefined || usage.outputCharacters !== undefined) {
      const totalChars = (usage.inputCharacters ?? 0) + (usage.outputCharacters ?? 0);
      res.perUnit = perUnitCostNanoUsd(BigInt(totalChars), BigInt(entry.perUnitMicros));
    } else if (usage.audioOutputSeconds !== undefined) {
      res.perUnit = perUnitCostNanoUsd(BigInt(usage.audioOutputSeconds), BigInt(entry.perUnitMicros));
    }
  }
  return res;
}

/** How the database rate card was selected for comparison. */
export type ShadowSelectionMode = 'ACTIVE_DATE' | 'EXPLICIT_VERSION';

/** Comparison outcome statuses. */
export type ShadowComparisonStatus =
  | 'MATCH'
  | 'MISMATCH'
  | 'DB_RATE_CARD_NOT_FOUND'
  | 'DB_RATE_CARD_ACTIVE_CONFLICT'
  | 'DB_RATE_CARD_VERSION_NOT_FOUND'
  | 'DB_RATE_CARD_INVALID'
  | 'DB_RATE_CARD_ERROR'
  | 'DB_RATE_CARD_TIMEOUT'
  | 'DB_PRICING_ERROR';

/** Aggregate-level comparison fields. */
export interface ShadowAggregateComparison {
  staticSummaryStatus: RequestSummaryStatus;
  dbSummaryStatus: RequestSummaryStatus | null;
  staticTotalCostNanoUsd: bigint;
  dbTotalCostNanoUsd: bigint | null;
  deltaNanoUsd: bigint | null;
  staticCallCount: number;
  dbCallCount: number | null;
  staticPricedCallCount: number;
  dbPricedCallCount: number | null;
  staticUnpricedCallCount: number;
  dbUnpricedCallCount: number | null;
  staticUnpricedReasons: Record<UnpricedReason, number>;
  dbUnpricedReasons: Record<UnpricedReason, number> | null;
  staticRateCardVersion: string;
  dbRateCardVersion: string | null;
}

/** Per-call comparison result. */
export interface ShadowCallComparison {
  provider: string;
  providerCallId: string;
  requestedModel?: string;
  actualModel?: string;
  resolvedModel: string | null;
  tier: RateCardTier | null;
  billingUnit: RateCardBillingUnit | null;
  staticStatus: 'PRICED' | 'UNPRICED';
  dbStatus: 'PRICED' | 'UNPRICED' | null;
  staticCostNanoUsd: bigint;
  dbCostNanoUsd: bigint | null;
  deltaNanoUsd: bigint | null;
  staticInputCostNanoUsd: bigint | null;
  dbInputCostNanoUsd: bigint | null;
  staticOutputCostNanoUsd: bigint | null;
  dbOutputCostNanoUsd: bigint | null;
  staticCachedInputCostNanoUsd: bigint | null;
  dbCachedInputCostNanoUsd: bigint | null;
  staticCachedOutputCostNanoUsd: bigint | null;
  dbCachedOutputCostNanoUsd: bigint | null;
  staticAudioInputCostNanoUsd: bigint | null;
  dbAudioInputCostNanoUsd: bigint | null;
  staticAudioOutputCostNanoUsd: bigint | null;
  dbAudioOutputCostNanoUsd: bigint | null;
  staticPerUnitCostNanoUsd: bigint | null;
  dbPerUnitCostNanoUsd: bigint | null;
  staticUnpricedReason: UnpricedReason | null;
  dbUnpricedReason: UnpricedReason | null;
  matchedEntryIdentity: string | null;
}

/** Full comparison result. */
export interface ShadowComparisonResult {
  status: ShadowComparisonStatus;
  selectionMode: ShadowSelectionMode;
  pricingDate: string;
  aggregate: ShadowAggregateComparison;
  calls: ShadowCallComparison[];
  mismatchFields: string[];
  mismatchCategories: string[];
  loaderErrorCode: string | null;
  providerCallCount: number;
  durationMs: number;
  featureEnabled: boolean;
}

/** Type guard for PRICED calls. */
function isPricedCall(call: ShadowPricedCall): call is PricedShadowCall {
  return call.kind === 'PRICED';
}

/** Type guard for UNPRICED calls. */
function isUnpricedCall(call: ShadowPricedCall): call is UnpricedShadowCall {
  return call.kind === 'UNPRICED';
}

/** Create a stable entry identity key for ordering. */
function entryIdentity(call: PricedShadowCall): string {
  return `${call.provider}|${call.rateCard.model}|${call.rateCard.tier}|${call.rateCard.billingUnit}`;
}

/** Compare two unpriced reason records. */
function compareUnpricedReasons(
  staticReasons: Record<UnpricedReason, number>,
  dbReasons: Record<UnpricedReason, number> | null,
): { equal: boolean; mismatches: string[] } {
  if (!dbReasons) return { equal: false, mismatches: ['db_unpriced_reasons_missing'] };
  const allReasons: UnpricedReason[] = [
    'PROVIDER_NOT_IN_RATECARD',
    'MODEL_MISSING',
    'ACTUAL_MODEL_NOT_IN_RATECARD',
    'REQUESTED_MODEL_NOT_IN_RATECARD',
    'USAGE_MISSING',
    'USAGE_INVALID',
    'RATE_NOT_ACTIVE',
    'UNIT_UNPRICED',
    'MODALITY_INVALID',
    'OVERFLOW',
  ];
  const mismatches: string[] = [];
  for (const r of allReasons) {
    if ((staticReasons[r] ?? 0) !== (dbReasons[r] ?? 0)) {
      mismatches.push(`unpriced_reason_${r}`);
    }
  }
  return { equal: mismatches.length === 0, mismatches };
}

/** Normalize calls for deterministic ordering comparison. */
function normalizeCallsForComparison(calls: PricedShadowCall[]): PricedShadowCall[] {
  return [...calls].sort((a, b) => {
    const ia = entryIdentity(a);
    const ib = entryIdentity(b);
    if (ia < ib) return -1;
    if (ia > ib) return 1;
    return a.providerCallId.localeCompare(b.providerCallId);
  });
}

/** Main comparison function. Pure and deterministic. */
export function compareShadowPricingResults(
  staticResult: ShadowPricingResult,
  dbResult: ShadowPricingResult | null,
  dbError: { code: string; status: ShadowComparisonStatus } | null,
  selectionMode: ShadowSelectionMode,
  pricingDate: string,
  staticRateCardVersion: string,
  dbRateCardVersion: string | null,
  durationMs: number,
  featureEnabled: boolean,
  staticCard: import('../../types/provider-pricing.js').ProviderRateCard,
  dbCard: import('../../types/provider-pricing.js').ProviderRateCard | null,
): ShadowComparisonResult {
  const aggregate: ShadowAggregateComparison = {
    staticSummaryStatus: staticResult.summaryStatus,
    dbSummaryStatus: dbResult?.summaryStatus ?? null,
    staticTotalCostNanoUsd: staticResult.totals.pricedCostNanoUsd,
    dbTotalCostNanoUsd: dbResult?.totals.pricedCostNanoUsd ?? null,
    deltaNanoUsd: dbResult
      ? dbResult.totals.pricedCostNanoUsd - staticResult.totals.pricedCostNanoUsd
      : null,
    staticCallCount: staticResult.totals.callCount,
    dbCallCount: dbResult?.totals.callCount ?? null,
    staticPricedCallCount: staticResult.totals.pricedCallCount,
    dbPricedCallCount: dbResult?.totals.pricedCallCount ?? null,
    staticUnpricedCallCount: staticResult.totals.unpricedCallCount,
    dbUnpricedCallCount: dbResult?.totals.unpricedCallCount ?? null,
    staticUnpricedReasons: { ...staticResult.totals.unpricedReasons },
    dbUnpricedReasons: dbResult ? { ...dbResult.totals.unpricedReasons } : null,
    staticRateCardVersion,
    dbRateCardVersion,
  };

  const calls: ShadowCallComparison[] = [];
  const mismatchFields: string[] = [];
  const mismatchCategories: string[] = [];

  if (!featureEnabled) {
    return {
      status: 'MATCH',
      selectionMode,
      pricingDate,
      aggregate,
      calls: [],
      mismatchFields: [],
      mismatchCategories: [],
      loaderErrorCode: null,
      providerCallCount: staticResult.totals.callCount,
      durationMs,
      featureEnabled: false,
    };
  }

  if (dbError) {
    return {
      status: dbError.status,
      selectionMode,
      pricingDate,
      aggregate,
      calls: [],
      mismatchFields: [`loader_error_${dbError.code}`],
      mismatchCategories: ['DB_LOADER_ERROR'],
      loaderErrorCode: dbError.code,
      providerCallCount: staticResult.totals.callCount,
      durationMs,
      featureEnabled: true,
    };
  }

  if (!dbResult) {
    return {
      status: 'DB_RATE_CARD_NOT_FOUND',
      selectionMode,
      pricingDate,
      aggregate,
      calls: [],
      mismatchFields: ['db_result_missing'],
      mismatchCategories: ['DB_RESULT_MISSING'],
      loaderErrorCode: 'RATE_CARD_NOT_FOUND',
      providerCallCount: staticResult.totals.callCount,
      durationMs,
      featureEnabled: true,
    };
  }

  // Compare aggregate fields
  if (staticResult.summaryStatus !== dbResult.summaryStatus) {
    mismatchFields.push('summaryStatus');
    mismatchCategories.push('AGGREGATE_STATUS');
  }
  if (staticResult.totals.pricedCostNanoUsd !== dbResult.totals.pricedCostNanoUsd) {
    mismatchFields.push('pricedCostNanoUsd');
    mismatchCategories.push('TOTAL_COST');
  }
  if (staticResult.totals.callCount !== dbResult.totals.callCount) {
    mismatchFields.push('callCount');
    mismatchCategories.push('CALL_COUNT');
  }
  if (staticResult.totals.pricedCallCount !== dbResult.totals.pricedCallCount) {
    mismatchFields.push('pricedCallCount');
    mismatchCategories.push('PRICED_CALL_COUNT');
  }
  if (staticResult.totals.unpricedCallCount !== dbResult.totals.unpricedCallCount) {
    mismatchFields.push('unpricedCallCount');
    mismatchCategories.push('UNPRICED_CALL_COUNT');
  }

  const reasonCompare = compareUnpricedReasons(
    staticResult.totals.unpricedReasons,
    dbResult.totals.unpricedReasons,
  );
  if (!reasonCompare.equal) {
    mismatchFields.push(...reasonCompare.mismatches);
    mismatchCategories.push('UNPRICED_REASONS');
  }

  // Compare per-call - order by entry identity for deterministic comparison
  const staticPricedCalls = staticResult.calls.filter(isPricedCall);
  const dbPricedCalls = dbResult.calls.filter(isPricedCall);

  const staticCalls = normalizeCallsForComparison(staticPricedCalls);
  const dbCalls = normalizeCallsForComparison(dbPricedCalls);

  // Also need to compare UNPRICED calls
  const staticUnpriced = staticResult.calls.filter(isUnpricedCall);
  const dbUnpriced = dbResult.calls.filter(isUnpricedCall);

  // Build a map of db priced calls by providerCallId (unique per call)
  const dbPricedMap = new Map<string, PricedShadowCall>();
  for (const c of dbCalls) {
    dbPricedMap.set(c.providerCallId, c);
  }

  // Compare each static priced call - match by providerCallId
  for (const sc of staticCalls) {
    const dc = dbPricedMap.get(sc.providerCallId);

    const comparison: ShadowCallComparison = {
      provider: sc.provider,
      providerCallId: sc.providerCallId,
      requestedModel: sc.requestedModel,
      actualModel: sc.actualModel,
      resolvedModel: sc.rateCard.model,
      tier: sc.rateCard.tier,
      billingUnit: sc.rateCard.billingUnit,
      staticStatus: 'PRICED',
      dbStatus: dc ? 'PRICED' : 'UNPRICED',
      staticCostNanoUsd: sc.costNanoUsd,
      dbCostNanoUsd: dc?.costNanoUsd ?? null,
      deltaNanoUsd: dc ? dc.costNanoUsd - sc.costNanoUsd : null,
      staticInputCostNanoUsd: null,
      dbInputCostNanoUsd: null,
      staticOutputCostNanoUsd: null,
      dbOutputCostNanoUsd: null,
      staticCachedInputCostNanoUsd: null,
      dbCachedInputCostNanoUsd: null,
      staticCachedOutputCostNanoUsd: null,
      dbCachedOutputCostNanoUsd: null,
      staticAudioInputCostNanoUsd: null,
      dbAudioInputCostNanoUsd: null,
      staticAudioOutputCostNanoUsd: null,
      dbAudioOutputCostNanoUsd: null,
      staticPerUnitCostNanoUsd: null,
      dbPerUnitCostNanoUsd: null,
      staticUnpricedReason: null,
      dbUnpricedReason: dc ? null : 'MODEL_MISSING',
      matchedEntryIdentity: dc ? entryIdentity(dc) : null,
    };

    if (!dc) {
      mismatchFields.push(`call_${sc.providerCallId}_missing_in_db`);
      mismatchCategories.push('CALL_MISSING_IN_DB');
    } else {
      // Resolve entries in both cards for component-level comparison
      const staticEntry = findEntry(staticCard, sc.provider, sc.rateCard.model, sc.rateCard.tier, sc.rateCard.billingUnit);
      const dbEntry = dbCard ? findEntry(dbCard, dc.provider, dc.rateCard.model, dc.rateCard.tier, dc.rateCard.billingUnit) : undefined;

      const staticComponents = computeComponentCosts(sc, staticEntry);
      const dbComponents = dc ? computeComponentCosts(dc, dbEntry) : {
        input: null, output: null, cachedInput: null, cachedOutput: null,
        audioInput: null, audioOutput: null, perUnit: null
      };

      // Fill component fields
      comparison.staticInputCostNanoUsd = staticComponents.input;
      comparison.dbInputCostNanoUsd = dbComponents.input;
      comparison.staticOutputCostNanoUsd = staticComponents.output;
      comparison.dbOutputCostNanoUsd = dbComponents.output;
      comparison.staticCachedInputCostNanoUsd = staticComponents.cachedInput;
      comparison.dbCachedInputCostNanoUsd = dbComponents.cachedInput;
      comparison.staticCachedOutputCostNanoUsd = staticComponents.cachedOutput;
      comparison.dbCachedOutputCostNanoUsd = dbComponents.cachedOutput;
      comparison.staticAudioInputCostNanoUsd = staticComponents.audioInput;
      comparison.dbAudioInputCostNanoUsd = dbComponents.audioInput;
      comparison.staticAudioOutputCostNanoUsd = staticComponents.audioOutput;
      comparison.dbAudioOutputCostNanoUsd = dbComponents.audioOutput;
      comparison.staticPerUnitCostNanoUsd = staticComponents.perUnit;
      comparison.dbPerUnitCostNanoUsd = dbComponents.perUnit;

      // Compare each component
      const componentFields = [
        { static: staticComponents.input, db: dbComponents.input, field: 'inputCostNanoUsd', cat: 'INPUT_COST' },
        { static: staticComponents.output, db: dbComponents.output, field: 'outputCostNanoUsd', cat: 'OUTPUT_COST' },
        { static: staticComponents.cachedInput, db: dbComponents.cachedInput, field: 'cachedInputCostNanoUsd', cat: 'CACHED_INPUT_COST' },
        { static: staticComponents.cachedOutput, db: dbComponents.cachedOutput, field: 'cachedOutputCostNanoUsd', cat: 'CACHED_OUTPUT_COST' },
        { static: staticComponents.audioInput, db: dbComponents.audioInput, field: 'audioInputCostNanoUsd', cat: 'AUDIO_INPUT_COST' },
        { static: staticComponents.audioOutput, db: dbComponents.audioOutput, field: 'audioOutputCostNanoUsd', cat: 'AUDIO_OUTPUT_COST' },
        { static: staticComponents.perUnit, db: dbComponents.perUnit, field: 'perUnitCostNanoUsd', cat: 'PER_UNIT_COST' },
      ];

      for (const comp of componentFields) {
        if (comp.static !== comp.db) {
          mismatchFields.push(`call_${sc.providerCallId}_${comp.field}`);
          mismatchCategories.push(comp.cat);
        }
      }

      if (sc.costNanoUsd !== dc.costNanoUsd) {
        mismatchFields.push(`call_${sc.providerCallId}_cost`);
        mismatchCategories.push('PER_CALL_COST');
      }
      if (sc.reason !== dc.reason) {
        mismatchFields.push(`call_${sc.providerCallId}_priced_via`);
        mismatchCategories.push('PRICED_VIA');
      }
      if (sc.rateCard.version !== dc.rateCard.version) {
        mismatchFields.push(`call_${sc.providerCallId}_version`);
        mismatchCategories.push('RATE_CARD_VERSION');
      }
      if (sc.rateCard.model !== dc.rateCard.model) {
        mismatchFields.push(`call_${sc.providerCallId}_model`);
        mismatchCategories.push('MODEL');
      }
      if (sc.rateCard.tier !== dc.rateCard.tier) {
        mismatchFields.push(`call_${sc.providerCallId}_tier`);
        mismatchCategories.push('TIER');
      }
      if (sc.rateCard.billingUnit !== dc.rateCard.billingUnit) {
        mismatchFields.push(`call_${sc.providerCallId}_billing_unit`);
        mismatchCategories.push('BILLING_UNIT');
      }
    }

    calls.push(comparison);
    dbPricedMap.delete(sc.providerCallId);
  }

  // Check for extra calls in DB that weren't in static
  for (const [providerCallId, dc] of dbPricedMap) {
    const comparison: ShadowCallComparison = {
      provider: dc.provider,
      providerCallId: dc.providerCallId,
      requestedModel: dc.requestedModel,
      actualModel: dc.actualModel,
      resolvedModel: dc.rateCard.model,
      tier: dc.rateCard.tier,
      billingUnit: dc.rateCard.billingUnit,
      staticStatus: 'UNPRICED',
      dbStatus: 'PRICED',
      staticCostNanoUsd: 0n,
      dbCostNanoUsd: dc.costNanoUsd,
      deltaNanoUsd: dc.costNanoUsd,
      staticInputCostNanoUsd: null,
      dbInputCostNanoUsd: null,
      staticOutputCostNanoUsd: null,
      dbOutputCostNanoUsd: null,
      staticCachedInputCostNanoUsd: null,
      dbCachedInputCostNanoUsd: null,
      staticCachedOutputCostNanoUsd: null,
      dbCachedOutputCostNanoUsd: null,
      staticAudioInputCostNanoUsd: null,
      dbAudioInputCostNanoUsd: null,
      staticAudioOutputCostNanoUsd: null,
      dbAudioOutputCostNanoUsd: null,
      staticPerUnitCostNanoUsd: null,
      dbPerUnitCostNanoUsd: null,
      staticUnpricedReason: 'MODEL_MISSING',
      dbUnpricedReason: null,
      matchedEntryIdentity: entryIdentity(dc),
    };
    calls.push(comparison);
    mismatchFields.push(`call_${dc.providerCallId}_extra_in_db`);
    mismatchCategories.push('EXTRA_CALL_IN_DB');
  }

  // Compare unpriced calls (match by providerCallId)
  const dbUnpricedMap = new Map<string, UnpricedShadowCall>();
  for (const c of dbUnpriced) {
    dbUnpricedMap.set(c.providerCallId, c);
  }

  for (const sc of staticUnpriced) {
    const dc = dbUnpricedMap.get(sc.providerCallId);
    const comparison: ShadowCallComparison = {
      provider: sc.provider,
      providerCallId: sc.providerCallId,
      requestedModel: sc.requestedModel,
      actualModel: sc.actualModel,
      resolvedModel: null,
      tier: null,
      billingUnit: null,
      staticStatus: 'UNPRICED',
      dbStatus: dc ? 'UNPRICED' : null,
      staticCostNanoUsd: 0n,
      dbCostNanoUsd: null,
      deltaNanoUsd: null,
      staticInputCostNanoUsd: null,
      dbInputCostNanoUsd: null,
      staticOutputCostNanoUsd: null,
      dbOutputCostNanoUsd: null,
      staticCachedInputCostNanoUsd: null,
      dbCachedInputCostNanoUsd: null,
      staticCachedOutputCostNanoUsd: null,
      dbCachedOutputCostNanoUsd: null,
      staticAudioInputCostNanoUsd: null,
      dbAudioInputCostNanoUsd: null,
      staticAudioOutputCostNanoUsd: null,
      dbAudioOutputCostNanoUsd: null,
      staticPerUnitCostNanoUsd: null,
      dbPerUnitCostNanoUsd: null,
      staticUnpricedReason: sc.reason,
      dbUnpricedReason: dc?.reason ?? null,
      matchedEntryIdentity: null,
    };

    if (!dc) {
      mismatchFields.push(`unpriced_call_${sc.providerCallId}_missing_in_db`);
      mismatchCategories.push('UNPRICED_CALL_MISSING_IN_DB');
    } else if (sc.reason !== dc.reason) {
      mismatchFields.push(`unpriced_call_${sc.providerCallId}_reason`);
      mismatchCategories.push('UNPRICED_REASON');
    }
    calls.push(comparison);
    dbUnpricedMap.delete(sc.providerCallId);
  }

  // Extra unpriced calls in DB
  for (const [, dc] of dbUnpricedMap) {
    const comparison: ShadowCallComparison = {
      provider: dc.provider,
      providerCallId: dc.providerCallId,
      requestedModel: dc.requestedModel,
      actualModel: dc.actualModel,
      resolvedModel: null,
      tier: null,
      billingUnit: null,
      staticStatus: 'UNPRICED',
      dbStatus: 'UNPRICED',
      staticCostNanoUsd: 0n,
      dbCostNanoUsd: null,
      deltaNanoUsd: null,
      staticInputCostNanoUsd: null,
      dbInputCostNanoUsd: null,
      staticOutputCostNanoUsd: null,
      dbOutputCostNanoUsd: null,
      staticCachedInputCostNanoUsd: null,
      dbCachedInputCostNanoUsd: null,
      staticCachedOutputCostNanoUsd: null,
      dbCachedOutputCostNanoUsd: null,
      staticAudioInputCostNanoUsd: null,
      dbAudioInputCostNanoUsd: null,
      staticAudioOutputCostNanoUsd: null,
      dbAudioOutputCostNanoUsd: null,
      staticPerUnitCostNanoUsd: null,
      dbPerUnitCostNanoUsd: null,
      staticUnpricedReason: null,
      dbUnpricedReason: dc.reason,
      matchedEntryIdentity: null,
    };
    calls.push(comparison);
    mismatchFields.push(`unpriced_call_${dc.providerCallId}_extra_in_db`);
    mismatchCategories.push('EXTRA_UNPRICED_CALL_IN_DB');
  }

  const uniqueCategories = [...new Set(mismatchCategories)];

  let status: ShadowComparisonStatus = 'MATCH';
  if (mismatchFields.length > 0) {
    status = 'MISMATCH';
  }

  return {
    status,
    selectionMode,
    pricingDate,
    aggregate,
    calls,
    mismatchFields,
    mismatchCategories: uniqueCategories,
    loaderErrorCode: null,
    providerCallCount: staticResult.totals.callCount,
    durationMs,
    featureEnabled: true,
  };
}