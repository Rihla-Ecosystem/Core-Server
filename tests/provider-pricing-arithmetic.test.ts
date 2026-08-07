import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ceilDiv,
  MICROS_PER_MILLION,
  NANO_PER_MICRO,
  NANO_PER_USD,
  nanoUsdToMicroUsdCeil,
  nanoUsdToUsdString,
  perUnitCostNanoUsd,
  tokenComponentCostNanoUsd,
} from '../src/utils/provider-pricing/arithmetic.js';

// Compile-time money-safety guards: every authoritative money helper returns
// bigint — never number. These type assertions are checked by the explicit
// `tsc` over the test files.
const _ceilDivIsBigInt: bigint = ceilDiv(1n, 2n);
const _tokenCostIsBigInt: bigint = tokenComponentCostNanoUsd(1n, 1n);
const _perUnitCostIsBigInt: bigint = perUnitCostNanoUsd(1n, 1n);
const _microUsdIsBigInt: bigint = nanoUsdToMicroUsdCeil(1n);
// @ts-expect-error nanoUsdToMicroUsdCeil must return bigint, not number
const _microUsdIsNotNumber: number = nanoUsdToMicroUsdCeil(1n);
// @ts-expect-error tokenComponentCostNanoUsd must return bigint, not number
const _tokenCostIsNotNumber: number = tokenComponentCostNanoUsd(1n, 1n);
// @ts-expect-error perUnitCostNanoUsd must return bigint, not number
const _perUnitCostIsNotNumber: number = perUnitCostNanoUsd(1n, 1n);
// @ts-expect-error ceilDiv must return bigint, not number
const _ceilDivIsNotNumber: number = ceilDiv(1n, 2n);

test('1. ceilDiv rounds exact division without error', () => {
  assert.equal(ceilDiv(1_500_000n * 1_000_000n, MICROS_PER_MILLION), 1_500_000n);
});

test('2. ceilDiv rounds up on any fractional remainder', () => {
  assert.equal(ceilDiv(1n, 2n), 1n);
  assert.equal(ceilDiv(2n, 3n), 1n);
  assert.equal(ceilDiv(3n, 2n), 2n);
});

test('3. ceilDiv exact zero and multi-step', () => {
  assert.equal(ceilDiv(0n, 5n), 0n);
  assert.equal(ceilDiv(9n, 3n), 3n);
  assert.equal(ceilDiv(10n, 3n), 4n);
});

test('4. ceilDiv rejects negative numerator', () => {
  assert.throws(() => ceilDiv(-1n, 2n), RangeError);
});

test('5. ceilDiv rejects non-positive denominator', () => {
  assert.throws(() => ceilDiv(1n, 0n), RangeError);
  assert.throws(() => ceilDiv(1n, -2n), RangeError);
});

test('6. tokenComponentCostNanoUsd exact for gemini-3.6-flash input', () => {
  // 1500 tokens x 1_500_000 µUSD/1M = 2_250_000 nUSD
  const cost = tokenComponentCostNanoUsd(1500n, 1_500_000n);
  assert.equal(cost, 2_250_000n);
});

test('7. tokenComponentCostNanoUsd exact for gemini-3.6-flash output', () => {
  // 200 tokens x 7_500_000 µUSD/1M = 1_500_000 nUSD
  const cost = tokenComponentCostNanoUsd(200n, 7_500_000n);
  assert.equal(cost, 1_500_000n);
});

test('8. tokenComponentCostNanoUsd exact for cached input', () => {
  // 500 tokens x 150_000 µUSD/1M = 75_000 nUSD
  const cost = tokenComponentCostNanoUsd(500n, 150_000n);
  assert.equal(cost, 75_000n);
});

test('9. §8.4 worked example sums to 3_825_000 nUSD exactly', () => {
  const input = tokenComponentCostNanoUsd(1500n, 1_500_000n); // 2_250_000
  const output = tokenComponentCostNanoUsd(200n, 7_500_000n); // 1_500_000
  const cached = tokenComponentCostNanoUsd(500n, 150_000n); // 75_000
  assert.equal(input + output + cached, 3_825_000n);
});

test('10. 1-token gemini-2.5-flash-lite call = 100 nUSD (small-call exactness)', () => {
  const cost = tokenComponentCostNanoUsd(1n, 100_000n);
  assert.equal(cost, 100n);
});

test('11. fractional per-unit seconds are never floored at zero', () => {
  // $0.039/image style whole-unit: 2 images
  assert.equal(perUnitCostNanoUsd(2n, 39_000n), 78_000n * NANO_PER_MICRO);
});

test('12. perUnitCostNanoUsd exact zero', () => {
  assert.equal(perUnitCostNanoUsd(0n, 39_000n), 0n);
});

test('13. nanoUsdToMicroUsdCeil rounds up to whole micro and returns bigint', () => {
  const a = nanoUsdToMicroUsdCeil(3_825_000n);
  const b = nanoUsdToMicroUsdCeil(3_825_001n);
  assert.equal(a, 3825n);
  assert.equal(b, 3826n);
  assert.equal(typeof a, 'bigint');
  assert.equal(typeof b, 'bigint');
});

test('14. nanoUsdToMicroUsdCeil exact micro boundaries (bigint)', () => {
  assert.equal(nanoUsdToMicroUsdCeil(0n), 0n);
  assert.equal(nanoUsdToMicroUsdCeil(1_000n), 1n);
  assert.equal(nanoUsdToMicroUsdCeil(999n), 1n);
});

test('15. nanoUsdToMicroUsdCeil rejects negative input', () => {
  assert.throws(() => nanoUsdToMicroUsdCeil(-1n), RangeError);
});

test('15b. nanoUsdToMicroUsdCeil converts very large nUSD exactly without Number overflow', () => {
  // Far beyond Number.MAX_SAFE_INTEGER micro-USD; must stay exact BigInt.
  const huge = NANO_PER_USD * BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const micros = nanoUsdToMicroUsdCeil(huge);
  // ceilDiv(huge nUSD, 1000) = 1_000_000 * MAX_SAFE + 1 micro
  assert.equal(micros, 1_000_000n * BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  assert.equal(typeof micros, 'bigint');
  assert.ok(micros > BigInt(Number.MAX_SAFE_INTEGER));
});

test('15c. nanoUsdToUsdString still exact for huge totals (no Number in the money path)', () => {
  const huge = 123_456n * NANO_PER_USD + 999_999n;
  assert.equal(nanoUsdToUsdString(huge), '123456.000999999');
});

test('16. nanoUsdToUsdString 9-decimal exact', () => {
  assert.equal(nanoUsdToUsdString(3_825_000n), '0.003825000');
});

test('17. nanoUsdToUsdString whole dollars', () => {
  assert.equal(nanoUsdToUsdString(NANO_PER_USD), '1.000000000');
  assert.equal(nanoUsdToUsdString(0n), '0.000000000');
});

test('18. nanoUsdToUsdString big safe-total', () => {
  const big = 123n * NANO_PER_USD + 456_789n;
  assert.equal(nanoUsdToUsdString(big), '123.000456789');
});

test('19. nanoUsdToUsdString rejects negative', () => {
  assert.throws(() => nanoUsdToUsdString(-1n), RangeError);
});

test('20. constants match the fixed money scale', () => {
  assert.equal(NANO_PER_USD, 1_000_000_000n);
  assert.equal(NANO_PER_MICRO, 1_000n);
  assert.equal(MICROS_PER_MILLION, 1_000_000n);
});
