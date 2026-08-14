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

export interface AIBillingRecoveryQueueFilter {
  status?: TokenReservationStatus;
  feature?: string;
  page: number;
  limit: number;
}

export interface AIBillingRecoveryQueuePage {
  items: AIBillingRecoveryReservationRow[];
  total: number;
  aggregate: AIBillingRecoveryPendingAggregate;
}

export interface AIBillingRecoveryAuditLogRecord {
  id: string;
  actorId: string | null;
  action: string;
  targetUserId: string | null;
  metadata: unknown;
  createdAt: Date;
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
  listReservationsForRecovery(filter: AIBillingRecoveryQueueFilter): Promise<AIBillingRecoveryQueuePage>;
  recordAuditLog(data: {
    actorId?: string;
    action: string;
    targetUserId?: string;
    metadata: Record<string, unknown>;
  }): Promise<AIBillingRecoveryAuditLogRecord>;
  findLatestRecoveryAuditLog(reservationId: string): Promise<AIBillingRecoveryAuditLogRecord | null>;
  findLatestRecoveryReviewAuditLog(reservationId: string): Promise<AIBillingRecoveryAuditLogRecord | null>;
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

    async listReservationsForRecovery(filter) {
      const where: Prisma.TokenReservationWhereInput = {};
      if (filter.status !== undefined) {
        where.status = filter.status;
      }
      if (filter.feature !== undefined) {
        where.feature = filter.feature;
      }

      const skip = (filter.page - 1) * filter.limit;
      const [total, reservations, aggregate] = await Promise.all([
        prisma.tokenReservation.count({ where }),
        prisma.tokenReservation.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: filter.limit,
        }),
        prisma.tokenReservation.aggregate({
          where,
          _count: { _all: true },
          _sum: { tokens: true },
        }),
      ]);

      return {
        items: reservations.map(toReservationRow),
        total,
        aggregate: {
          count: aggregate._count._all,
          totalTokens: aggregate._sum.tokens ?? 0,
        },
      };
    },

    async recordAuditLog(data) {
      const created = await prisma.auditLog.create({
        data: {
          actorId: data.actorId ?? null,
          action: data.action,
          targetUserId: data.targetUserId ?? null,
          metadata: data.metadata as Prisma.InputJsonValue,
        },
      });
      return {
        id: created.id,
        actorId: created.actorId,
        action: created.action,
        targetUserId: created.targetUserId,
        metadata: created.metadata,
        createdAt: created.createdAt,
      };
    },

    async findLatestRecoveryAuditLog(reservationId) {
      const matched = await prisma.auditLog.findFirst({
        where: {
          action: { startsWith: 'AI_BILLING_RECOVERY_' },
          metadata: {
            path: ['reservationId'],
            equals: reservationId,
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return matched
        ? {
            id: matched.id,
            actorId: matched.actorId,
            action: matched.action,
            targetUserId: matched.targetUserId,
            metadata: matched.metadata,
            createdAt: matched.createdAt,
          }
        : null;
    },

    async findLatestRecoveryReviewAuditLog(reservationId) {
      const matched = await prisma.auditLog.findFirst({
        where: {
          action: 'AI_BILLING_RECOVERY_REVIEW',
          metadata: {
            path: ['reservationId'],
            equals: reservationId,
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      return matched
        ? {
            id: matched.id,
            actorId: matched.actorId,
            action: matched.action,
            targetUserId: matched.targetUserId,
            metadata: matched.metadata,
            createdAt: matched.createdAt,
          }
        : null;
    },
  };
}
