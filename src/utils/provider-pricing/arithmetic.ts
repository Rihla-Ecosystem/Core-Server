/**
 * Phase 2C BigInt nano-USD arithmetic for the shadow-pricing engine.
 *
 * All internal money is integer nano-USD (`1 USD = 1_000_000_000 nUSD`),
 * BigInt-only. Micro-USD / USD strings are produced ONLY at an explicit
 * display/reporting boundary. There is no floating-point money anywhere.
 *
 * Rate-card rates are stored as integer micro-USD; token rates are per
 * 1,000,000 tokens. Components and calls are summed in exact nUSD before any
 * output-boundary conversion (no per-component micro-USD rounding).
 */

export const NANO_PER_USD = 1_000_000_000n;
export const NANO_PER_MICRO = 1_000n;
export const MICROS_PER_MILLION = 1_000_000n;

/**
 * Ceiling division for non-negative BigInt `a` and positive BigInt `b`.
 * Matches the existing convention in `src/utils/ai-usage-pricing.ts`.
 */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (a < 0n) {
    throw new RangeError('ceilDiv numerator must be non-negative');
  }
  if (b <= 0n) {
    throw new RangeError('ceilDiv denominator must be positive');
  }
  return (a + b - 1n) / b;
}

/** Type guard: a finite, non-negative JS safe integer (usable as a token count). */
export function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Type guard: a finite non-negative number (usable as a seconds count). */
export function isSafeNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Cost of a token component in nUSD.
 *
 * `rateMicrosPerMillion` is the micro-USD-per-1M-tokens rate from the card.
 * The conversion is exact integer arithmetic; ceilDiv only guarantees an
 * integer result for any validated (non-negative) rate.
 */
export function tokenComponentCostNanoUsd(
  tokenCount: bigint,
  rateMicrosPerMillion: bigint,
): bigint {
  return ceilDiv(tokenCount * rateMicrosPerMillion * NANO_PER_MICRO, MICROS_PER_MILLION);
}

/**
 * Cost of a whole-unit component in nUSD.
 *
 * `unitCount` is a non-negative integer count (e.g. generated images) and
 * `perUnitMicros` the whole-unit micro-USD price. Exact, never floored.
 */
export function perUnitCostNanoUsd(
  unitCount: bigint,
  perUnitMicros: bigint,
): bigint {
  return unitCount * perUnitMicros * NANO_PER_MICRO;
}

/**
 * Output boundary: round a non-negative nUSD total up to a whole micro-USD,
 * returned as BigInt. Micro-USD stays BigInt — the authoritative money path
 * never converts to a JS Number.
 */
export function nanoUsdToMicroUsdCeil(totalNanoUsd: bigint): bigint {
  if (totalNanoUsd < 0n) {
    throw new RangeError('totalNanoUsd must be non-negative');
  }
  return ceilDiv(totalNanoUsd, NANO_PER_MICRO);
}

/**
 * Output boundary: exact 9-decimal USD string derived directly from the
 * BigInt nUSD value (e.g. `3_825_000n` → `"0.003825000"`).
 */
export function nanoUsdToUsdString(totalNanoUsd: bigint): string {
  if (totalNanoUsd < 0n) {
    throw new RangeError('totalNanoUsd must be non-negative');
  }
  const whole = totalNanoUsd / NANO_PER_USD;
  const frac = totalNanoUsd % NANO_PER_USD;
  const fracStr = frac.toString().padStart(9, '0');
  return `${whole.toString()}.${fracStr}`;
}