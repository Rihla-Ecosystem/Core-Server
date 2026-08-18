import type { PricingCallInput } from './price-call.js';

/**
 * Phase 2C pure persisted-call normalization for repricing.
 *
 * Live usage-based billing persists `PRICED` provider-call evidence with the
 * applied usage nested under `usageApplied` (see `serializePricingCallEvidence`
 * in `usage-based-ai-billing.service.ts`), while the canonical pricing engine
 * (`aggregateProviderCalls` -> `priceProviderCall`) reads flat canonical usage
 * fields directly on the call object.
 *
 * This helper bridges only that persistence/repricing boundary. It NEVER
 * changes the canonical pricing engine, rate-card lookup, or wallet conversion;
 * it only projects already-recorded usage into the flat canonical shape the
 * engine already understands.
 *
 * Rules:
 *  1. Existing flat canonical fields are preserved verbatim.
 *  2. When a canonical flat field is absent, the equivalent value under
 *     `usageApplied` is copied onto the call (never invented).
 *  3. An explicit flat value always wins over `usageApplied` (no silent
 *     overwrite).
 *  4. All pricing-relevant modalities supported by the canonical
 *     `PricingCallInput` contract are covered.
 *  5. No fallback, no defaults, no rounding — absent usage stays absent.
 *  6. Invalid/missing usage flows through unchanged so the pricing engine
 *     continues to fail closed (`USAGE_MISSING` / `USAGE_INVALID`).
 *
 * The function is pure: it never mutates its input.
 */

/** Flat canonical usage fields the pricing engine reads (subset of PricingCallInput). */
const CANONICAL_FLAT_USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cachedOutputTokens',
  'imageInputTokens',
  'audioInputTokens',
  'generatedImageCount',
  'audioOutputSeconds',
  'inputCharacters',
  'outputCharacters',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize one persisted provider call into canonical flat pricing input.
 *
 * Identity fields (provider, providerCallId, requestedModel, actualModel,
 * operation) and already-flat usage fields pass through untouched. Usage values
 * recorded under `usageApplied` are copied onto the matching canonical flat
 * field ONLY when that flat field is absent. The original call object is never
 * mutated.
 */
export function normalizePersistedProviderCallForPricing(
  call: unknown,
): Record<string, unknown> {
  if (!isRecord(call)) {
    return call as Record<string, unknown>;
  }

  const usageApplied = isRecord(call['usageApplied']) ? call['usageApplied'] : undefined;

  const out: Record<string, unknown> = { ...call };

  if (usageApplied === undefined) {
    return out;
  }

  for (const field of CANONICAL_FLAT_USAGE_FIELDS) {
    if (out[field] !== undefined) {
      continue;
    }
    if (usageApplied[field] !== undefined) {
      out[field] = usageApplied[field];
    }
  }

  return out;
}

/**
 * Normalize an array of persisted provider calls for repricing (or pass
 * non-array / empty inputs through unchanged so callers keep their own
 * emptiness semantics).
 */
export function normalizePersistedProviderCallsForPricing(calls: unknown): unknown {
  if (!Array.isArray(calls)) {
    return calls;
  }
  return calls.map((call) => normalizePersistedProviderCallForPricing(call));
}

export type NormalizedPersistedProviderCallInput = Partial<PricingCallInput> & Record<string, unknown>;