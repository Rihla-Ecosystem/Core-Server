import {
  Prisma,
  TokenReservation,
  TokenReservationStatus,
  TokenTransactionSource,
  TokenWallet,
  WalletStatus,
} from '@prisma/client';
import { prisma } from '../config/prisma.js';

export interface AIBillingRecoveryReservationRow {
  id: string;
  walletId: string;
  userId: string;
  feature: string;
  source: TokenTransactionSource;
  tokens: number;
  pricingVersion: number;
  status: TokenReservationStatus;
  expiresAt: Date;
  settledAt: Date | null;
  releasedAt: Date | null;
  releaseReason: string | null;
  metadata: unknown;
  referenceId: string;
}

export interface AIBillingRecoveryWalletRow {
  id: string;
  userId: string;
  tokenBalance: number;
  reservedBalance: number;
  status: WalletStatus;
}

export interface AIBillingRecoveryConsumeRow {
  id: string;
  tokens: number;
  source: TokenTransactionSource;
  referenceId: string | null;
}

export interface AIBillingRecoveryPendingAggregate {
  count: number;
  totalTokens: number;
}

export interface AIBillingRecoveryReconciliationSnapshot {
  wallet: AIBillingRecoveryWalletRow | null;
  pending: AIBillingRecoveryPendingAggregate;
}

export interface AIBillingRecoveryRepository {
  findReservationById(reservationId: string): Promise<AIBillingRecoveryReservationRow | null>;
  findWalletById(walletId: string): Promise<AIBillingRecoveryWalletRow | null>;
  findConsumeForReservation(
    reservation: AIBillingRecoveryReservationRow,
  ): Promise<AIBillingRecoveryConsumeRow[]>;
  aggregatePendingReservations(walletId: string): Promise<AIBillingRecoveryPendingAggregate>;
  readReconciliationSnapshot(
    walletId: string,
  ): Promise<AIBillingRecoveryReconciliationSnapshot>;
}

function toReservationRow(reservation: TokenReservation): AIBillingRecoveryReservationRow {
  return {
    id: reservation.id,
    walletId: reservation.walletId,
    userId: reservation.userId,
    feature: reservation.feature,
    source: reservation.source,
    tokens: reservation.tokens,
    pricingVersion: reservation.pricingVersion,
    status: reservation.status,
    expiresAt: reservation.expiresAt,
    settledAt: reservation.settledAt,
    releasedAt: reservation.releasedAt,
    releaseReason: reservation.releaseReason,
    metadata: reservation.metadata,
    referenceId: reservation.referenceId,
  };
}

function toWalletRow(wallet: TokenWallet): AIBillingRecoveryWalletRow {
  return {
    id: wallet.id,
    userId: wallet.userId,
    tokenBalance: wallet.tokenBalance,
    reservedBalance: wallet.reservedBalance,
    status: wallet.status,
  };
}

export function createPrismaAIBillingRecoveryRepository(): AIBillingRecoveryRepository {
  return {
    async findReservationById(reservationId) {
      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reservationId },
      });
      return reservation ? toReservationRow(reservation) : null;
    },

    async findWalletById(walletId) {
      const wallet = await prisma.tokenWallet.findUnique({ where: { id: walletId } });
      return wallet ? toWalletRow(wallet) : null;
    },

    async findConsumeForReservation(reservation) {
      const settlementReferenceId = `${reservation.referenceId}:settle`;
      const consumes = await prisma.tokenTransaction.findMany({
        where: {
          walletId: reservation.walletId,
          userId: reservation.userId,
          type: 'CONSUME',
          source: reservation.source,
          referenceId: settlementReferenceId,
        },
      });
      return consumes.map((consume) => ({
        id: consume.id,
        tokens: consume.tokens,
        source: consume.source,
        referenceId: consume.referenceId,
      }));
    },

    async aggregatePendingReservations(walletId) {
      const aggregate = await prisma.tokenReservation.aggregate({
        where: { walletId, status: TokenReservationStatus.PENDING },
        _count: { _all: true },
        _sum: { tokens: true },
      });
      return {
        count: aggregate._count._all,
        totalTokens: aggregate._sum.tokens ?? 0,
      };
    },

    async readReconciliationSnapshot(walletId) {
      return prisma.$transaction(
        async (tx) => {
          const wallet = await tx.tokenWallet.findUnique({ where: { id: walletId } });
          const aggregate = await tx.tokenReservation.aggregate({
            where: { walletId, status: TokenReservationStatus.PENDING },
            _count: { _all: true },
            _sum: { tokens: true },
          });
          return {
            wallet: wallet ? toWalletRow(wallet) : null,
            pending: {
              count: aggregate._count._all,
              totalTokens: aggregate._sum.tokens ?? 0,
            },
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    },
  };
}
