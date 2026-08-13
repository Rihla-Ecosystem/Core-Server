import { AppError } from '../middleware/errorHandler.js';
import type { Prisma, TokenTransactionSource } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export async function createFundingLot(tx: Tx, input: {
  walletId: string; userId: string; source: TokenTransactionSource;
  sourceTransactionId: string; tokens: number; paymentId?: string | null;
}): Promise<void> {
  if (!Number.isSafeInteger(input.tokens) || input.tokens <= 0) {
    throw new AppError(409, 'Funding lot tokens must be positive');
  }
  await tx.tokenFundingLot.create({ data: {
    walletId: input.walletId, userId: input.userId, source: input.source,
    sourceTransactionId: input.sourceTransactionId, paymentId: input.paymentId ?? null,
    originalTokens: input.tokens, availableTokens: input.tokens,
  } });
}

/** Locks the wallet and candidate lots so concurrent reservations cannot share a point. */
export async function allocateFundingLotsForReservation(tx: Tx, input: {
  walletId: string; reservationId: string; tokens: number;
}): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "TokenWallet" WHERE id = ${input.walletId}::uuid FOR UPDATE`;
  const lots = await tx.tokenFundingLot.findMany({
    where: { walletId: input.walletId, availableTokens: { gt: 0 }, refundedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  let remaining = input.tokens;
  for (const lot of lots) {
    if (remaining === 0) break;
    const allocated = Math.min(remaining, lot.availableTokens);
    const updated = await tx.tokenFundingLot.updateMany({
      where: { id: lot.id, availableTokens: { gte: allocated } },
      data: { availableTokens: { decrement: allocated }, reservedTokens: { increment: allocated } },
    });
    if (updated.count !== 1) throw new AppError(409, 'Funding lot allocation conflict');
    await tx.tokenReservationFundingAllocation.create({ data: {
      reservationId: input.reservationId, fundingLotId: lot.id, reservedTokens: allocated,
    } });
    remaining -= allocated;
  }
  if (remaining !== 0) throw new AppError(409, 'Funding lots do not reconcile with wallet balance');
}

/** Settles only against the lots captured at reservation time, never global FIFO anew. */
export async function settleFundingLotAllocations(tx: Tx, input: { reservationId: string; actualTokens: number }): Promise<void> {
  const allocations = await tx.tokenReservationFundingAllocation.findMany({
    where: { reservationId: input.reservationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  let remaining = input.actualTokens;
  for (const allocation of allocations) {
    const consumed = Math.min(remaining, allocation.reservedTokens);
    const restored = allocation.reservedTokens - consumed;
    const lot = await tx.tokenFundingLot.updateMany({ where: { id: allocation.fundingLotId, reservedTokens: { gte: allocation.reservedTokens } }, data: {
      reservedTokens: { decrement: allocation.reservedTokens }, availableTokens: { increment: restored }, consumedTokens: { increment: consumed },
    } });
    if (lot.count !== 1) throw new AppError(409, 'Funding lot settlement conflict');
    const updated = await tx.tokenReservationFundingAllocation.updateMany({ where: { id: allocation.id, consumedTokens: 0 }, data: { consumedTokens: consumed } });
    if (updated.count !== 1) throw new AppError(409, 'Funding allocation settlement conflict');
    remaining -= consumed;
  }
  if (remaining !== 0) throw new AppError(409, 'Funding allocation integrity conflict');
}

export async function releaseFundingLotAllocations(tx: Tx, reservationId: string): Promise<void> {
  const allocations = await tx.tokenReservationFundingAllocation.findMany({ where: { reservationId } });
  for (const allocation of allocations) {
    const updated = await tx.tokenFundingLot.updateMany({ where: { id: allocation.fundingLotId, reservedTokens: { gte: allocation.reservedTokens } }, data: {
      reservedTokens: { decrement: allocation.reservedTokens }, availableTokens: { increment: allocation.reservedTokens },
    } });
    if (updated.count !== 1) throw new AppError(409, 'Funding lot release conflict');
  }
}

/** Administrative debits are real FIFO consumption, but have no reservation. */
export async function consumeAvailableFundingLots(tx: Tx, walletId: string, tokens: number): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "TokenWallet" WHERE id = ${walletId}::uuid FOR UPDATE`;
  const lots = await tx.tokenFundingLot.findMany({ where: { walletId, availableTokens: { gt: 0 } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  let remaining = tokens;
  for (const lot of lots) {
    if (remaining === 0) break;
    const consumed = Math.min(remaining, lot.availableTokens);
    const updated = await tx.tokenFundingLot.updateMany({ where: { id: lot.id, availableTokens: { gte: consumed } }, data: { availableTokens: { decrement: consumed }, consumedTokens: { increment: consumed } } });
    if (updated.count !== 1) throw new AppError(409, 'Funding lot debit conflict');
    remaining -= consumed;
  }
  if (remaining !== 0) throw new AppError(409, 'Funding lots do not reconcile with wallet balance');
}

export async function getPurchaseRefundEligibility(paymentId: string): Promise<{ eligible: boolean; reason: string }> {
  const { prisma } = await import('../config/prisma.js');
  const lot = await prisma.tokenFundingLot.findUnique({ where: { paymentId }, include: { payment: true } });
  if (!lot || !lot.payment) return { eligible: false, reason: 'PURCHASE_LOT_NOT_FOUND' };
  if (lot.payment.status !== 'COMPLETED') return { eligible: false, reason: 'PAYMENT_NOT_COMPLETED' };
  if (!isPurchaseLotRefundEligible(lot)) {
    return { eligible: false, reason: 'PURCHASE_POINTS_USED_OR_RESERVED' };
  }
  return { eligible: true, reason: 'ELIGIBLE' };
}

export function isPurchaseLotRefundEligible(lot: {
  originalTokens: number; availableTokens: number; reservedTokens: number; refundHeldTokens?: number; consumedTokens: number; refundedTokens?: number; refundedAt: Date | null;
}): boolean {
  return lot.originalTokens > 0 && lot.availableTokens === lot.originalTokens && lot.reservedTokens === 0 && (lot.refundHeldTokens ?? 0) === 0 && lot.consumedTokens === 0 && (lot.refundedTokens ?? 0) === 0 && lot.refundedAt === null;
}

export function fundingLotsReconcile(input: { walletAvailable: number; walletReserved: number; lots: Array<{ originalTokens: number; availableTokens: number; reservedTokens: number; refundHeldTokens?: number; consumedTokens: number; refundedTokens?: number }> }): boolean {
  return input.lots.every((lot) => lot.originalTokens === lot.availableTokens + lot.reservedTokens + (lot.refundHeldTokens ?? 0) + lot.consumedTokens + (lot.refundedTokens ?? 0))
    && input.walletAvailable === input.lots.reduce((sum, lot) => sum + lot.availableTokens, 0)
    && input.walletReserved === input.lots.reduce((sum, lot) => sum + lot.reservedTokens, 0);
}
