import type {
  PricingIdentityCandidate,
  PricingIdentitySource,
} from '../../types/provider-pricing.js';

/**
 * Phase 2B model-identity resolution.
 *
 * Pure, defensive, stateless. Provider/model identity is derived ONLY from the
 * reported strings — there is no closed provider list, no substring / fuzzy /
 * wildcard matching, and no provider-from-model inference. Rate-card existence
 * and alias/effective-date resolution belong to Phase 2C; this module only
 * canonicalizes identity and applies the authoritative-`actualModel` rule.
 */

export interface CanonicalModel {
  /** Trimmed display identity, original case preserved. */
  display: string;
  /** Trimmed + lowercased lookup key. */
  lookup: string;
}

/**
 * Canonicalize a provider string: trim + lowercase. Non-string or empty
 * (after trim) input returns `undefined`.
 */
export function canonicalizeProvider(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Canonicalize a model string: trimmed display identity (case preserved) and
 * a trimmed + lowercased lookup key. Non-string or empty (after trim) input
 * returns `undefined`.
 */
export function canonicalizeModel(value: unknown): CanonicalModel | undefined {
  if (typeof value !== 'string') return undefined;
  const display = value.trim();
  if (display.length === 0) return undefined;
  return { display, lookup: display.toLowerCase() };
}

/**
 * Select the pricing identity for one provider call per the authoritative
 * `actualModel` rule:
 *
 *  - `actualModel` present ⇒ selected, source `ACTUAL_MODEL`.
 *    `requestedModel` is NEVER inspected in this case (a present-but-
 *    unresolvable `actualModel` stays `ACTUAL_MODEL`; the unresolvability
 *    decision is a Phase 2C rate-card matter, never a fallback trigger).
 *  - `actualModel` absent + `requestedModel` present ⇒ selected, source
 *    `REQUESTED_MODEL_FALLBACK`.
 *  - neither present ⇒ `MISSING_MODEL` with `reason: 'MODEL_MISSING'`.
 *
 * Whitespace-only / non-string model values are treated as absent.
 * The input object is never mutated.
 */
export function selectPricingIdentity(input: {
  provider?: unknown;
  requestedModel?: unknown;
  actualModel?: unknown;
}): PricingIdentityCandidate {
  const provider = canonicalizeProvider(input.provider);

  const actual = canonicalizeModel(input.actualModel);
  if (actual) {
    return {
      kind: 'SELECTED',
      provider,
      providerLookupKey: provider,
      model: actual.display,
      modelLookupKey: actual.lookup,
      source: 'ACTUAL_MODEL',
    };
  }

  const requested = canonicalizeModel(input.requestedModel);
  if (requested) {
    return {
      kind: 'SELECTED',
      provider,
      providerLookupKey: provider,
      model: requested.display,
      modelLookupKey: requested.lookup,
      source: 'REQUESTED_MODEL_FALLBACK',
    };
  }

  return {
    kind: 'MISSING_MODEL',
    provider,
    providerLookupKey: provider,
    reason: 'MODEL_MISSING',
  };
}

export type { PricingIdentitySource };
