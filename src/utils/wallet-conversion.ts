import type { ShadowPricingResult } from '../types/provider-pricing.js';
import type { WalletPolicyConfig } from '../config/wallet-policy.js';

/**
 * Phase 2G-A pure Wallet conversion arithmetic.
 *
 * Conversion policy (locked):
 *  - Price providerCalls[] once (via `aggregateProviderCalls` upstream); the
 *    sum of `pricedCostNanoUsd` is the provider cost in nano-USD.
 *  - Apply the Wallet markup ONCE, expressed in basis points: the customer cost
 *    is `pricedCostNanoUsd * markupBasisPoints / 10000`. The default
 *    `10000` = 1.00x (no extra markup).
 *  - Convert to Wallet Tokens ONCE using only `walletTokenValueNanoUsd`
 *    (nano-USD per token). Round-half-up ONCE over the combined multiplication.
 *  - Never float, never per-call rounding, never charge `totalTokens` directly,
 *    never treat unknown cost as zero.
 *  - Minimum charge applies ONLY when FULLY_PRICED AND provider cost > 0 AND the
 *    rounded result would be 0 tokens.
 */

export const WALLET_MARKUP_BASIS_POINTS_UNIT = 10_000n;

export interface WalletChargeComputation {
  /** Wallet Tokens to charge for this billing operation. */
  tokens: bigint;
  /** Sum of priced provider-call costs in nano-USD (pre-markup). */
  pricedCostNanoUsd: bigint;
  /** `pricedCostNanoUsd * markupBasisPoints` (bps-scaled, pre-division). */
  markedUpNanoUsd: bigint;
  markupBasisPoints: number;
  walletTokenValueNanoUsd: number;
  minimumWalletTokens: number;
  /** True only when every real provider call priced. */
  fullyPriced: boolean;
  /** True when the providerCalls payload was empty / absent. */
  noProviderCalls: boolean;
  /** True when `pricedCostNanoUsd > 0`. */
  providerCostPositive: boolean;
  /** True when the rounded token amount was 0 but the minimum clamp applied. */
  roundedZeroClampedToMinimum: boolean;
}

export interface WalletConversionConfig {
  walletTokenValueNanoUsd: number;
  markupBasisPoints: number;
  minimumWalletTokens: number;
}

/** Round half up on non-negative bigints. */
export function roundHalfUpBigInt(numerator: bigint, denominator: bigint): bigint {
  if (numerator <= 0n) return 0n;
  return (numerator + denominator / 2n) / denominator;
}

export function computeWalletCharge(
  pricing: ShadowPricingResult,
  config: WalletConversionConfig,
): WalletChargeComputation {
  const { walletTokenValueNanoUsd, markupBasisPoints, minimumWalletTokens } = config;

  const pricedCostNanoUsd = pricing.totals.pricedCostNanoUsd;
  const fullyPriced = pricing.summaryStatus === 'FULLY_PRICED';
  const noProviderCalls = pricing.noProviderCalls === true;
  const providerCostPositive = pricedCostNanoUsd > 0n;

  if (noProviderCalls) {
    return {
      tokens: 0n,
      pricedCostNanoUsd,
      markedUpNanoUsd: 0n,
      markupBasisPoints,
      walletTokenValueNanoUsd,
      minimumWalletTokens,
      fullyPriced: false,
      noProviderCalls: true,
      providerCostPositive,
      roundedZeroClampedToMinimum: false,
    };
  }

  // Apply markup once, convert once, round-half-up once.
  const markedUpNanoUsd = pricedCostNanoUsd * BigInt(markupBasisPoints);
  const denominator =
    BigInt(walletTokenValueNanoUsd) * WALLET_MARKUP_BASIS_POINTS_UNIT;
  let tokens = roundHalfUpBigInt(markedUpNanoUsd, denominator);

  let roundedZeroClampedToMinimum = false;
  if (tokens === 0n && fullyPriced && providerCostPositive) {
    tokens = BigInt(minimumWalletTokens);
    roundedZeroClampedToMinimum = true;
  }

  return {
    tokens,
    pricedCostNanoUsd,
    markedUpNanoUsd,
    markupBasisPoints,
    walletTokenValueNanoUsd,
    minimumWalletTokens,
    fullyPriced,
    noProviderCalls: false,
    providerCostPositive,
    roundedZeroClampedToMinimum,
  };
}
