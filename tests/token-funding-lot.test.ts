import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fundingLotsReconcile, isPurchaseLotRefundEligible } from '../src/services/token-funding-lot.service.js';

test('strict FIFO settlement preserves the original lot of unused reserved points', () => {
  // Signup 400 + purchase A 1000; reserve 500 => signup 400, A 100.
  // Settle 300 => signup consumed 300, signup restores 100, purchase A restores all 1000.
  const lots = [
    { originalTokens: 400, availableTokens: 100, reservedTokens: 0, consumedTokens: 300 },
    { originalTokens: 1000, availableTokens: 1000, reservedTokens: 0, consumedTokens: 0 },
  ];
  assert.equal(fundingLotsReconcile({ walletAvailable: 1100, walletReserved: 0, lots }), true);
  assert.equal(isPurchaseLotRefundEligible({ ...lots[1], refundedAt: null }), true);
});

test('one consumed or reserved purchase point makes a purchase ineligible for refund', () => {
  assert.equal(isPurchaseLotRefundEligible({ originalTokens: 1000, availableTokens: 999, reservedTokens: 0, consumedTokens: 1, refundedAt: null }), false);
  assert.equal(isPurchaseLotRefundEligible({ originalTokens: 1000, availableTokens: 900, reservedTokens: 100, consumedTokens: 0, refundedAt: null }), false);
});

test('reconciliation rejects a wallet or lot imbalance', () => {
  assert.equal(fundingLotsReconcile({ walletAvailable: 99, walletReserved: 0, lots: [{ originalTokens: 100, availableTokens: 100, reservedTokens: 0, consumedTokens: 0 }] }), false);
});

test('refund-held and refunded points remain non-spendable while preserving lot reconciliation', () => {
  const held = [{ originalTokens: 1000, availableTokens: 0, reservedTokens: 0, refundHeldTokens: 1000, consumedTokens: 0, refundedTokens: 0 }];
  assert.equal(fundingLotsReconcile({ walletAvailable: 0, walletReserved: 0, lots: held }), true);
  const refunded = [{ ...held[0], refundHeldTokens: 0, refundedTokens: 1000 }];
  assert.equal(fundingLotsReconcile({ walletAvailable: 0, walletReserved: 0, lots: refunded }), true);
});
