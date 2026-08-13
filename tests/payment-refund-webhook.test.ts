{
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('Safety check failed: DATABASE_URL is not set');
  if (!['/core_server_test', '/core_server_test_suite'].includes(new URL(dbUrl).pathname)) throw new Error('Safety check failed: DATABASE_URL is not an approved isolated test database');
}

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Gender, PaymentRefundStatus, PaymentStatus, TokenTransactionSource, TokenTransactionType } from '@prisma/client';
import { prisma } from '../src/config/prisma.js';
import { reconcileRefundWebhook } from '../src/services/payment-refund.service.js';
import { ensureUserRole } from './helpers/test-role-fixtures.js';

let roleId: number;
const ids: string[] = [];

async function fixture(status: PaymentRefundStatus, held: number, available: number, consumed = 0, reserved = 0) {
  const suffix = crypto.randomUUID();
  const user = await prisma.user.create({ data: { roleId, email: `refund_webhook_${suffix}@example.com`, passwordHash: 'hash', displayName: 'Refund Test', gender: Gender.MALE, nationality: 'Egyptian' } });
  const pkg = await prisma.tokenPackage.create({ data: { name: `Refund ${suffix}`, code: `refund-${suffix}`, price: '10.00', currency: 'EGP', tokens: 100 } });
  const payment = await prisma.payment.create({ data: { userId: user.id, tokenPackageId: pkg.id, amount: '10.00', currency: 'EGP', status: PaymentStatus.COMPLETED, packageNameSnapshot: pkg.name, tokensSnapshot: 100, priceSnapshot: '10.00', currencySnapshot: 'EGP', providerTransactionId: `original-${suffix}` } });
  const wallet = await prisma.tokenWallet.create({ data: { userId: user.id, tokenBalance: available } });
  const grant = await prisma.tokenTransaction.create({ data: { walletId: wallet.id, userId: user.id, type: TokenTransactionType.GRANT, tokens: 100, source: TokenTransactionSource.PURCHASE, paymentId: payment.id, referenceId: `grant-${suffix}` } });
  const lot = await prisma.tokenFundingLot.create({ data: { walletId: wallet.id, userId: user.id, source: TokenTransactionSource.PURCHASE, sourceTransactionId: grant.id, paymentId: payment.id, originalTokens: 100, availableTokens: available, reservedTokens: reserved, refundHeldTokens: held, consumedTokens: consumed } });
  const refund = await prisma.paymentRefund.create({ data: { paymentId: payment.id, fundingLotId: lot.id, tokenAmount: 100, amountCents: 1000, currency: 'EGP', provider: 'PAYMOB', originalProviderTransactionId: payment.providerTransactionId!, status } });
  ids.push(user.id);
  return { user, pkg, payment, wallet, lot, refund };
}

async function clean() {
  for (const userId of ids.splice(0)) {
    const payments = await prisma.payment.findMany({ where: { userId }, select: { id: true, tokenPackageId: true } });
    await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: payments.map(x => x.id) } } });
    await prisma.tokenReservationFundingAllocation.deleteMany({ where: { fundingLot: { userId } } });
    await prisma.tokenFundingLot.deleteMany({ where: { userId } });
    await prisma.tokenTransaction.deleteMany({ where: { userId } });
    await prisma.tokenWallet.deleteMany({ where: { userId } });
    await prisma.payment.deleteMany({ where: { userId } });
    await prisma.tokenPackage.deleteMany({ where: { id: { in: payments.map(x => x.tokenPackageId) } } });
    await prisma.user.delete({ where: { id: userId } });
  }
}

describe('Phase 8C.4 status-aware refund webhooks', () => {
  before(async () => { roleId = (await ensureUserRole()).id; });
  after(async () => { await clean(); await prisma.$disconnect(); });

  test('SUCCEEDED and REVIEW_REQUIRED external conflicts acknowledge duplicate webhooks without mutation', async () => {
    const success = await fixture(PaymentRefundStatus.SUCCEEDED, 100, 0);
    await prisma.payment.update({ where: { id: success.payment.id }, data: { status: PaymentStatus.REFUNDED } });
    await prisma.tokenFundingLot.update({ where: { id: success.lot.id }, data: { refundHeldTokens: 0, refundedTokens: 100, refundedAt: new Date() } });
    const review = await fixture(PaymentRefundStatus.REVIEW_REQUIRED, 0, 99, 1);
    await reconcileRefundWebhook({ paymentId: success.payment.id, transactionId: 'refund-success', amountCents: 1000, currency: 'EGP' });
    await reconcileRefundWebhook({ paymentId: review.payment.id, transactionId: 'refund-review', amountCents: 1000, currency: 'EGP' });
    assert.equal((await prisma.paymentRefund.findUniqueOrThrow({ where: { id: success.refund.id } })).status, PaymentRefundStatus.SUCCEEDED);
    assert.equal((await prisma.paymentRefund.findUniqueOrThrow({ where: { id: review.refund.id } })).status, PaymentRefundStatus.REVIEW_REQUIRED);
    assert.equal((await prisma.tokenWallet.findUniqueOrThrow({ where: { id: review.wallet.id } })).tokenBalance, 99);
    assert.equal(await prisma.tokenTransaction.count({ where: { paymentId: review.payment.id, type: TokenTransactionType.REFUND } }), 0);
  });

  test('FAILED late refund webhook escalates once to REVIEW_REQUIRED without wallet or ledger mutation', async () => {
    const row = await fixture(PaymentRefundStatus.FAILED, 0, 100);
    await reconcileRefundWebhook({ paymentId: row.payment.id, transactionId: 'late-refund', amountCents: 1000, currency: 'EGP' });
    await reconcileRefundWebhook({ paymentId: row.payment.id, transactionId: 'late-refund', amountCents: 1000, currency: 'EGP' });
    const refund = await prisma.paymentRefund.findUniqueOrThrow({ where: { id: row.refund.id } });
    assert.equal(refund.status, PaymentRefundStatus.REVIEW_REQUIRED);
    assert.equal(refund.failureReason, 'LATE_PROVIDER_REFUND_AFTER_LOCAL_FAILURE');
    assert.equal((await prisma.tokenWallet.findUniqueOrThrow({ where: { id: row.wallet.id } })).tokenBalance, 100);
    assert.equal(await prisma.tokenTransaction.count({ where: { paymentId: row.payment.id, type: TokenTransactionType.REFUND } }), 0);
  });

  test('PROVIDER_PENDING and INDETERMINATE webhook finalization each occur exactly once', async () => {
    for (const status of [PaymentRefundStatus.PROVIDER_PENDING, PaymentRefundStatus.INDETERMINATE]) {
      const row = await fixture(status, 100, 0);
      await reconcileRefundWebhook({ paymentId: row.payment.id, transactionId: `final-${status}`, amountCents: 1000, currency: 'EGP' });
      await reconcileRefundWebhook({ paymentId: row.payment.id, transactionId: `final-${status}`, amountCents: 1000, currency: 'EGP' });
      assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: row.payment.id } })).status, PaymentStatus.REFUNDED);
      assert.equal((await prisma.paymentRefund.findUniqueOrThrow({ where: { id: row.refund.id } })).status, PaymentRefundStatus.SUCCEEDED);
      assert.equal(await prisma.tokenTransaction.count({ where: { paymentId: row.payment.id, type: TokenTransactionType.REFUND } }), 1);
    }
  });
});
