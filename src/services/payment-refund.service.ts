import { PaymentRefundStatus, PaymentStatus, Prisma, TokenTransactionType, TokenTransactionSource } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { HttpClientError } from '../utils/http-client.js';
import { getPaymobTransaction, refundPaymobTransaction, type PaymobRefundResponse } from './paymob.service.js';

type Tx = Prisma.TransactionClient;
export interface RefundResult { paymentId: string; refundId: string | null; status: string; eligible: boolean; reasonCode: string; }

function cents(amount: Prisma.Decimal): number { const v = amount.mul(100); if (!v.isInteger() || !Number.isSafeInteger(v.toNumber()) || v.lte(0)) throw new AppError(409, 'Invalid payment amount'); return v.toNumber(); }
function validSuccess(r: PaymobRefundResponse, paymentId: string, amountCents: number): boolean {
  return r.success === true && r.pending === false && r.is_refunded === true && r.is_voided === false && r.amount_cents === amountCents && r.order?.merchant_order_id === paymentId;
}
function reason(lot: { consumedTokens: number; reservedTokens: number; refundHeldTokens: number; refundedTokens: number }, paymentStatus: PaymentStatus): string {
  if (paymentStatus === PaymentStatus.REFUNDED) return 'ALREADY_REFUNDED';
  if (paymentStatus !== PaymentStatus.COMPLETED) return 'PAYMENT_NOT_COMPLETED';
  if (lot.consumedTokens > 0) return 'PURCHASE_POINTS_CONSUMED';
  if (lot.reservedTokens > 0) return 'PURCHASE_POINTS_RESERVED';
  if (lot.refundHeldTokens > 0) return 'REFUND_ALREADY_IN_PROGRESS';
  if (lot.refundedTokens > 0) return 'ALREADY_REFUNDED';
  return 'REFUND_NOT_ELIGIBLE';
}

async function hold(tx: Tx, paymentId: string, adminId: string | null) {
  await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${paymentId}::uuid FOR UPDATE`;
  const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { fundingLot: true, refund: true } });
  if (!payment) throw new AppError(404, 'Payment not found');
  if (payment.refund) return { existing: payment.refund, payment };
  const lot = payment.fundingLot;
  if (!lot) throw new AppError(409, 'PURCHASE_LOT_NOT_FOUND');
  await tx.$queryRaw`SELECT id FROM "TokenWallet" WHERE id = ${lot.walletId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "TokenFundingLot" WHERE id = ${lot.id}::uuid FOR UPDATE`;
  if (payment.status !== PaymentStatus.COMPLETED || lot.originalTokens !== payment.tokensSnapshot || lot.availableTokens !== lot.originalTokens || lot.consumedTokens !== 0 || lot.reservedTokens !== 0 || lot.refundHeldTokens !== 0 || lot.refundedTokens !== 0 || lot.refundedAt || !payment.providerTransactionId) {
    throw new AppError(409, reason(lot, payment.status));
  }
  const amountCents = cents(payment.priceSnapshot);
  const wallet = await tx.tokenWallet.updateMany({ where: { id: lot.walletId, tokenBalance: { gte: lot.originalTokens } }, data: { tokenBalance: { decrement: lot.originalTokens } } });
  if (wallet.count !== 1) throw new AppError(409, 'WALLET_LOT_RECONCILIATION_CONFLICT');
  const moved = await tx.tokenFundingLot.updateMany({ where: { id: lot.id, availableTokens: lot.originalTokens, refundHeldTokens: 0 }, data: { availableTokens: { decrement: lot.originalTokens }, refundHeldTokens: { increment: lot.originalTokens } } });
  if (moved.count !== 1) throw new AppError(409, 'REFUND_HOLD_CONFLICT');
  const refund = await tx.paymentRefund.create({ data: { paymentId, fundingLotId: lot.id, requestedByAdminId: adminId, tokenAmount: lot.originalTokens, amountCents, currency: payment.currencySnapshot, provider: payment.provider, originalProviderTransactionId: payment.providerTransactionId, status: PaymentRefundStatus.HOLD_CREATED } });
  return { refund, payment };
}

export async function finalizePaymentRefund(refundId: string, providerResponse: PaymobRefundResponse): Promise<RefundResult> {
  return prisma.$transaction(async tx => {
    const refund = await tx.paymentRefund.findUnique({ where: { id: refundId }, include: { payment: true, fundingLot: true } });
    if (!refund) throw new AppError(404, 'Refund not found');
    if (refund.status === PaymentRefundStatus.SUCCEEDED) return { paymentId: refund.paymentId, refundId, status: refund.status, eligible: true, reasonCode: 'REFUND_ELIGIBLE' };
    if (!validSuccess(providerResponse, refund.paymentId, refund.amountCents)) throw new AppError(409, 'PROVIDER_RESPONSE_MISMATCH');
    await tx.$queryRaw`SELECT id FROM "TokenFundingLot" WHERE id = ${refund.fundingLotId}::uuid FOR UPDATE`;
    const lotUpdated = await tx.tokenFundingLot.updateMany({ where: { id: refund.fundingLotId, refundHeldTokens: { gte: refund.tokenAmount } }, data: { refundHeldTokens: { decrement: refund.tokenAmount }, refundedTokens: { increment: refund.tokenAmount }, refundedAt: new Date() } });
    if (lotUpdated.count !== 1) throw new AppError(409, 'REFUND_FINALIZATION_CONFLICT');
    await tx.payment.update({ where: { id: refund.paymentId }, data: { status: PaymentStatus.REFUNDED } });
    const providerRefundTransactionId = String(providerResponse.id);
    await tx.paymentRefund.update({ where: { id: refundId }, data: { status: PaymentRefundStatus.SUCCEEDED, providerRefundTransactionId, providerData: { id: providerRefundTransactionId, amountCents: providerResponse.amount_cents }, completedAt: new Date(), failureReason: null } });
    await tx.tokenTransaction.upsert({ where: { source_referenceId: { source: TokenTransactionSource.PURCHASE, referenceId: `refund:${refundId}` } }, create: { walletId: refund.fundingLot.walletId, userId: refund.fundingLot.userId, type: TokenTransactionType.REFUND, tokens: refund.tokenAmount, source: TokenTransactionSource.PURCHASE, paymentId: refund.paymentId, referenceId: `refund:${refundId}`, metadata: { refundId, providerRefundTransactionId } }, update: {} });
    return { paymentId: refund.paymentId, refundId, status: PaymentRefundStatus.SUCCEEDED, eligible: true, reasonCode: 'REFUND_ELIGIBLE' };
  });
}

export async function releasePaymentRefundHold(refundId: string, failureReason: string): Promise<RefundResult> {
  return prisma.$transaction(async tx => {
    const refund = await tx.paymentRefund.findUnique({ where: { id: refundId }, include: { fundingLot: true } });
    if (!refund) throw new AppError(404, 'Refund not found');
    if (refund.status === PaymentRefundStatus.FAILED) return { paymentId: refund.paymentId, refundId, status: refund.status, eligible: false, reasonCode: 'PROVIDER_REFUND_FAILED' };
    if (refund.status === PaymentRefundStatus.SUCCEEDED) return { paymentId: refund.paymentId, refundId, status: refund.status, eligible: true, reasonCode: 'REFUND_ELIGIBLE' };
    const restored = await tx.tokenFundingLot.updateMany({ where: { id: refund.fundingLotId, refundHeldTokens: { gte: refund.tokenAmount } }, data: { refundHeldTokens: { decrement: refund.tokenAmount }, availableTokens: { increment: refund.tokenAmount } } });
    if (restored.count !== 1) throw new AppError(409, 'REFUND_RELEASE_CONFLICT');
    await tx.tokenWallet.update({ where: { id: refund.fundingLot.walletId }, data: { tokenBalance: { increment: refund.tokenAmount } } });
    await tx.paymentRefund.update({ where: { id: refundId }, data: { status: PaymentRefundStatus.FAILED, failureReason } });
    return { paymentId: refund.paymentId, refundId, status: PaymentRefundStatus.FAILED, eligible: false, reasonCode: 'PROVIDER_REFUND_FAILED' };
  });
}

async function reconcile(refundId: string): Promise<RefundResult | null> {
  const refund = await prisma.paymentRefund.findUnique({ where: { id: refundId } });
  if (!refund) return null;
  try { const result = await getPaymobTransaction(refund.originalProviderTransactionId); if (validSuccess(result, refund.paymentId, refund.amountCents)) return finalizePaymentRefund(refundId, result); } catch { /* bounded lookup leaves hold intact */ }
  await prisma.paymentRefund.updateMany({ where: { id: refundId, status: { in: [PaymentRefundStatus.HOLD_CREATED, PaymentRefundStatus.PROVIDER_PENDING, PaymentRefundStatus.INDETERMINATE] } }, data: { status: PaymentRefundStatus.REVIEW_REQUIRED, failureReason: 'PROVIDER_RESULT_INDETERMINATE' } });
  return { paymentId: refund.paymentId, refundId, status: PaymentRefundStatus.REVIEW_REQUIRED, eligible: false, reasonCode: 'PROVIDER_RESULT_INDETERMINATE' };
}

export async function requestPaymentRefund(paymentId: string, adminId: string): Promise<RefundResult> {
  let held: Awaited<ReturnType<typeof hold>>;
  try { held = await prisma.$transaction(tx => hold(tx, paymentId, adminId)); } catch (e) { if (e instanceof AppError) throw e; throw e; }
  const existing = 'existing' in held ? held.existing : undefined;
  if (existing) return { paymentId, refundId: existing.id, status: existing.status, eligible: existing.status === PaymentRefundStatus.SUCCEEDED, reasonCode: existing.status === PaymentRefundStatus.SUCCEEDED ? 'ALREADY_REFUNDED' : 'REFUND_ALREADY_IN_PROGRESS' };
  const refund = held.refund;
  if (!refund) throw new AppError(500, 'Refund hold did not create a refund');
  const refundId = refund.id;
  await prisma.paymentRefund.update({ where: { id: refundId }, data: { status: PaymentRefundStatus.PROVIDER_PENDING } });
  try {
    const response = await refundPaymobTransaction({ transactionId: refund.originalProviderTransactionId, amountCents: refund.amountCents });
    if (validSuccess(response, paymentId, refund.amountCents)) return finalizePaymentRefund(refundId, response);
    return reconcile(refundId) as Promise<RefundResult>;
  } catch (e) {
    if (e instanceof HttpClientError && (e.status === 400 || e.status === 422)) {
      const body = typeof e.body === 'string' ? e.body : JSON.stringify(e.body ?? '');
      if (/already been refunded/i.test(body)) return reconcile(refundId) as Promise<RefundResult>;
      return releasePaymentRefundHold(refundId, 'PAYMOB_REFUND_REJECTED');
    }
    await prisma.paymentRefund.update({ where: { id: refundId }, data: { status: PaymentRefundStatus.INDETERMINATE, failureReason: 'PAYMOB_REFUND_INDETERMINATE' } });
    return reconcile(refundId) as Promise<RefundResult>;
  }
}

/** HMAC-verified refund callbacks reconcile the existing workflow without a second provider call. */
export async function reconcileRefundWebhook(input: { paymentId: string; transactionId: string; amountCents: number; currency: string }): Promise<void> {
  const refund = await prisma.paymentRefund.findUnique({ where: { paymentId: input.paymentId } });
  if (refund) {
    const providerResponse = { id: input.transactionId, success: true, pending: false, is_refunded: true, is_voided: false, amount_cents: input.amountCents, currency: input.currency, order: { merchant_order_id: input.paymentId } };
    if (refund.status === PaymentRefundStatus.SUCCEEDED) return;
    if (refund.status === PaymentRefundStatus.FAILED) {
      // The provider says money moved after our explicit failure released the
      // local hold. Do not take arbitrary available Wallet points: preserve a
      // durable manual-reconciliation case instead.
      await prisma.paymentRefund.updateMany({
        where: { id: refund.id, status: PaymentRefundStatus.FAILED },
        data: { status: PaymentRefundStatus.REVIEW_REQUIRED, failureReason: 'LATE_PROVIDER_REFUND_AFTER_LOCAL_FAILURE', providerRefundTransactionId: input.transactionId, providerData: { id: input.transactionId, amountCents: input.amountCents, webhook: true } },
      });
      return;
    }
    if (refund.status === PaymentRefundStatus.REVIEW_REQUIRED) {
      // Review workflows normally have no hold (for example external refunds
      // after usage). Only the rare review state that still owns the complete
      // original hold may safely use normal finalization.
      const lot = await prisma.tokenFundingLot.findUnique({ where: { id: refund.fundingLotId }, select: { refundHeldTokens: true } });
      if (!lot || lot.refundHeldTokens !== refund.tokenAmount) return;
    }
    await finalizePaymentRefund(refund.id, providerResponse);
    return;
  }
  // External dashboard refund: only reverse an untouched lot; otherwise create durable review.
  await prisma.$transaction(async tx => {
    const payment = await tx.payment.findUnique({ where: { id: input.paymentId }, include: { fundingLot: true } });
    if (!payment?.fundingLot || payment.status !== PaymentStatus.COMPLETED) return;
    const lot = payment.fundingLot;
    const clean = lot.availableTokens === lot.originalTokens && lot.reservedTokens === 0 && lot.consumedTokens === 0 && lot.refundHeldTokens === 0 && lot.refundedTokens === 0;
    const refund = await tx.paymentRefund.create({ data: { paymentId: payment.id, fundingLotId: lot.id, tokenAmount: lot.originalTokens, amountCents: cents(payment.priceSnapshot), currency: payment.currencySnapshot, provider: payment.provider, originalProviderTransactionId: payment.providerTransactionId ?? '', status: clean ? PaymentRefundStatus.HOLD_CREATED : PaymentRefundStatus.REVIEW_REQUIRED, failureReason: clean ? null : 'EXTERNAL_REFUND_CONFLICT' } });
    if (!clean) return;
    await tx.tokenWallet.update({ where: { id: lot.walletId }, data: { tokenBalance: { decrement: lot.originalTokens } } });
    await tx.tokenFundingLot.update({ where: { id: lot.id }, data: { availableTokens: 0, refundedTokens: lot.originalTokens, refundedAt: new Date() } });
    await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.REFUNDED } });
    await tx.paymentRefund.update({ where: { id: refund.id }, data: { status: PaymentRefundStatus.SUCCEEDED, providerRefundTransactionId: input.transactionId, completedAt: new Date() } });
    await tx.tokenTransaction.create({ data: { walletId: lot.walletId, userId: lot.userId, type: TokenTransactionType.REFUND, tokens: lot.originalTokens, source: TokenTransactionSource.PURCHASE, paymentId: payment.id, referenceId: `refund:${refund.id}`, metadata: { refundId: refund.id, providerRefundTransactionId: input.transactionId, externalReconciliation: true } } });
  });
}
