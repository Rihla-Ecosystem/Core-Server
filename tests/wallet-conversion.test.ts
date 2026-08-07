import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWalletCharge,
  roundHalfUpBigInt,
  WALLET_MARKUP_BASIS_POINTS_UNIT,
} from '../src/utils/wallet-conversion.js';
import { aggregateProviderCalls } from '../src/utils/provider-pricing/aggregate.js';
import type { ShadowPricingResult } from '../src/types/provider-pricing.js';

/**
 * Build a `ShadowPricingResult` fixture directly. Only the fields read by
 * `computeWalletCharge` matter: `totals.pricedCostNanoUsd`, `summaryStatus`,
 * `noProviderCalls`.
 */
function pricingResult(overrides: {
  pricedCostNanoUsd: bigint;
  summaryStatus: ShadowPricingResult['summaryStatus'];
  noProviderCalls?: boolean;
}): ShadowPricingResult {
  return {
    pricedAt: '2026-08-07T00:00:00.000Z',
    noProviderCalls: overrides.noProviderCalls ?? false,
    calls: [],
    totals: {
      callCount: 0,
      pricedCallCount: 0,
      unpricedCallCount: 0,
      unpricedReasons: {} as ShadowPricingResult['totals']['unpricedReasons'],
      pricedCostNanoUsd: overrides.pricedCostNanoUsd,
    },
    summaryStatus: overrides.summaryStatus,
  };
}

const DEFAULT_TOKEN_VALUE = 100_000; // nano-USD per token (locked default)
const DEFAULT_MARKUP = 10_000; // 1.00x
const DEFAULT_MIN = 1;

function cfg(overrides?: Partial<{
  walletTokenValueNanoUsd: number;
  markupBasisPoints: number;
  minimumWalletTokens: number;
}>): {
  walletTokenValueNanoUsd: number;
  markupBasisPoints: number;
  minimumWalletTokens: number;
} {
  return {
    walletTokenValueNanoUsd: DEFAULT_TOKEN_VALUE,
    markupBasisPoints: DEFAULT_MARKUP,
    minimumWalletTokens: DEFAULT_MIN,
    ...overrides,
  };
}

describe('roundHalfUpBigInt', () => {
  test('1. Rounds 0.5 up', () => {
    assert.equal(roundHalfUpBigInt(5n, 10n), 1n);
  });

  test('2. Rounds below half down', () => {
    assert.equal(roundHalfUpBigInt(4n, 10n), 0n);
  });

  test('3. Rounds above half up', () => {
    assert.equal(roundHalfUpBigInt(7n, 10n), 1n);
  });

  test('4. Non-positive numerator yields zero', () => {
    assert.equal(roundHalfUpBigInt(0n, 10n), 0n);
    assert.equal(roundHalfUpBigInt(-5n, 10n), 0n);
  });
});

describe('computeWalletCharge - denomination + conversion', () => {
  test('5. Exactly one token value maps to exactly one token', () => {
    const result = computeWalletCharge(
      pricingResult({ pricedCostNanoUsd: 100_000n, summaryStatus: 'FULLY_PRICED' }),
      cfg(),
    );
    assert.equal(result.tokens, 1n);
    assert.equal(result.pricedCostNanoUsd, 100_000n);
    assert.equal(result.markedUpNanoUsd, 100_000n * BigInt(DEFAULT_MARKUP));
    assert.equal(result.markupBasisPoints, DEFAULT_MARKUP);
    assert.equal(result.walletTokenValueNanoUsd, DEFAULT_TOKEN_VALUE);
    assert.equal(result.fullyPriced, true);
    assert.equal(result.noProviderCalls, false);
    assert.equal(result.providerCostPositive, true);
    assert.equal(result.roundedZeroClampedToMinimum, false);
  });

  test('6. Half (0.5) rounds up', () => {
    const result = computeWalletCharge(
      pricingResult({ pricedCostNanoUsd: 150_000n, summaryStatus: 'FULLY_PRICED' }),
      cfg(),
    );
    assert.equal(result.tokens, 2n);
  });

  test('7. Below half rounds down', () => {
    const result = computeWalletCharge(
      pricingResult({ pricedCostNanoUsd: 140_000n, summaryStatus: 'FULLY_PRICED' }),
      cfg(),
    );
    assert.equal(result.tokens, 1n);
  });

  test('8. Aggregates before rounding: 60k + 60k = 120k -> 1 token, not 2', () => {
    const result = computeWalletCharge(
      pricingResult({ pricedCostNanoUsd: 120_000n, summaryStatus: 'FULLY_PRICED' }),
      cfg(),
    );
    assert.equal(result.tokens, 1n);
  });

  test('9. Multi-call sum 150k -> 2 tokens (single combined conversion)', () => {
    const result = computeWalletCharge(
      pricingResult({ pricedCostNanoUsd: 150_000n, summaryStatus: 'FULLY_PRICED' }),
      cfg(),
    );
    assert.equal(result.tokens, 2n);
  });

  test('10. Markup applied once: 2.00x doubles the token amount', () => {
    const result = computeWalletCharge(
      pricingResult({ pricedCostNanoUsd: 100_000n, summaryStatus: 'FULLY_PRICED' }),
      cfg({ markupBasisPoints: 20_000 }),
    );
    assert.equal(result.markedUpNanoUsd, 100_000n * 20_000n);
    assert.equal(result.tokens, 2n);
  });

  test('11. Token denomination is read from config, never hardcoded', () => {
    const result = computeWalletCharge(
      pricingResult({ pricedCostNanoUsd: 250_000n, summaryStatus: 'FULLY_PRICED' }),
      cfg({ walletTokenValueNanoUsd: 250_000 }),
    );
    assert.equal(result.tokens, 1n);
  });

  test('12. BigInt arithmetic beyond Number.MAX_SAFE_INTEGER stays exact', () => {
    const bigCost = 9_007_199_254_740_993n; // > Number.MAX_SAFE_INTEGER
    const result = computeWalletCharge(
      pricingResult({ pricedCostNanoUsd: bigCost, summaryStatus: 'FULLY_PRICED' }),
      cfg(),
    );
    const numerator = bigCost * BigInt(DEFAULT_MARKUP);
    const denominator =
      BigInt(DEFAULT_TOKEN_VALUE) * WALLET_MARKUP_BASIS_POINTS_UNIT;
    assert.equal(result.tokens, roundHalfUpBigInt(numerator, denominator));
    assert.equal(result.tokens, 90_071_992_547n);
  });
});

describe('computeWalletCharge - minimum charge clamp', () => {
  test('13. Rounded zero on a positive fully-priced cost clamps to the minimum', () => {
    const result = computeWalletCharge(
      pricingResult({ pricedCostNanoUsd: 40_000n, summaryStatus: 'FULLY_PRICED' }),
      cfg(),
    );
    assert.equal(result.tokens, 1n);
    assert.equal(result.roundedZeroClampedToMinimum, true);
  });

  test('14. Custom minimum is used', () => {
    const result = computeWalletCharge(
      pricingResult({ pricedCostNanoUsd: 40_000n, summaryStatus: 'FULLY_PRICED' }),
      cfg({ minimumWalletTokens: 3 }),
    );
    assert.equal(result.tokens, 3n);
    assert.equal(result.roundedZeroClampedToMinimum, true);
  });

  test('15. No clamp when the cost is zero, even if fully priced', () => {
    const result = computeWalletCharge(
      pricingResult({ pricedCostNanoUsd: 0n, summaryStatus: 'FULLY_PRICED' }),
      cfg(),
    );
    assert.equal(result.tokens, 0n);
    assert.equal(result.providerCostPositive, false);
    assert.equal(result.roundedZeroClampedToMinimum, false);
  });

  test('16. No clamp on a PARTIALLY_PRICED positive cost that rounds to zero', () => {
    const result = computeWalletCharge(
      pricingResult({ pricedCostNanoUsd: 40_000n, summaryStatus: 'PARTIALLY_PRICED' }),
      cfg(),
    );
    assert.equal(result.tokens, 0n);
    assert.equal(result.roundedZeroClampedToMinimum, false);
  });

  test('17. No clamp on UNPRICED (zero cost)', () => {
    const result = computeWalletCharge(
      pricingResult({ pricedCostNanoUsd: 0n, summaryStatus: 'UNPRICED' }),
      cfg(),
    );
    assert.equal(result.tokens, 0n);
    assert.equal(result.roundedZeroClampedToMinimum, false);
  });
});

describe('computeWalletCharge - no provider calls', () => {
  test('18. Empty payload charges zero, never clamps', () => {
    const result = computeWalletCharge(
      pricingResult({
        pricedCostNanoUsd: 0n,
        summaryStatus: 'UNPRICED',
        noProviderCalls: true,
      }),
      cfg(),
    );
    assert.equal(result.tokens, 0n);
    assert.equal(result.noProviderCalls, true);
    assert.equal(result.fullyPriced, false);
    assert.equal(result.roundedZeroClampedToMinimum, false);
  });
});

describe('computeWalletCharge - real aggregate integration', () => {
  test('19. gemini-3.5-flash-lite 100 in / 50 out prices to 155000 nUSD and 2 tokens', () => {
    const pricing = aggregateProviderCalls({
      providerCalls: [
        {
          provider: 'google',
          providerCallMade: true,
          actualModel: 'gemini-3.5-flash-lite',
          inputTokens: 100,
          outputTokens: 50,
        },
      ],
    });
    assert.equal(pricing.summaryStatus, 'FULLY_PRICED');
    assert.equal(pricing.noProviderCalls, false);
    assert.equal(pricing.totals.pricedCostNanoUsd, 155_000n);

    const result = computeWalletCharge(pricing, cfg());
    assert.equal(result.tokens, 2n);
  });

  test('20. Two calls aggregate into one conversion (no per-call rounding)', () => {
    const pricing = aggregateProviderCalls({
      providerCalls: [
        {
          provider: 'google',
          providerCallMade: true,
          actualModel: 'gemini-3.5-flash-lite',
          inputTokens: 50,
          outputTokens: 0,
        },
        {
          provider: 'google',
          providerCallMade: true,
          actualModel: 'gemini-3.5-flash-lite',
          inputTokens: 50,
          outputTokens: 0,
        },
      ],
    });
    // 2 x (50 * 300 nUSD) = 30000 nUSD total -> 0.3 token -> rounds to 0,
    // then the fully-priced minimum clamp raises it to 1.
    assert.equal(pricing.totals.pricedCostNanoUsd, 30_000n);
    const result = computeWalletCharge(pricing, cfg());
    assert.equal(result.tokens, 1n);
    assert.equal(result.roundedZeroClampedToMinimum, true);
  });
});
