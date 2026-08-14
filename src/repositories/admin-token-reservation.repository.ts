import { Prisma, TokenReservationStatus } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import type { AdminTokenReservationListQuery } from '../schemas/admin-token-reservation.schema.js';

export interface AdminTokenReservationRepository {
  findReservations(query: AdminTokenReservationListQuery): Promise<{
    items: Array<{
      id: string;
      referenceId: string;
      walletId: string;
      userId: string;
      feature: string;
      source: any;
      tokens: number;
      pricingVersion: number;
      status: TokenReservationStatus;
      createdAt: Date;
      expiresAt: Date;
      settledAt: Date | null;
      releasedAt: Date | null;
      metadata: unknown;
      user: {
        email: string;
        displayName: string;
      };
      billingOperation: {
        operationId: string;
        status: string;
        actualWalletTokens: number | null;
      } | null;
    }>;
    total: number;
    summary: {
      totalReservations: number;
      pendingReservations: number;
      completedReservations: number;
      releasedReservations: number;
      totalReservedTokens: number;
      totalActualWalletTokens: number;
      totalReturnedTokens: number;
    };
  }>;

  findReservationDetailById(reservationId: string): Promise<{
    reservation: any;
    user: any;
    wallet: any;
    billingOperation: any;
    fundingAllocations: any[];
    transactions: any[];
  } | null>;
}

export function buildTokenReservationWhereClause(
  query: AdminTokenReservationListQuery,
): Prisma.TokenReservationWhereInput {
  const where: Prisma.TokenReservationWhereInput = {};

  if (query.status) {
    where.status = query.status;
  }

  if (query.feature) {
    where.feature = query.feature;
  }

  if (query.source) {
    where.source = query.source;
  }

  if (query.userId) {
    where.userId = query.userId;
  }

  if (query.from || query.to) {
    where.createdAt = {};
    if (query.from) {
      where.createdAt.gte = new Date(query.from);
    }
    if (query.to) {
      where.createdAt.lte = new Date(query.to);
    }
  }

  if (query.search) {
    const trimmed = query.search.trim();
    if (trimmed) {
      const isUuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          trimmed,
        );
      where.OR = [
        ...(isUuid ? [{ id: trimmed }] : []),
        { referenceId: { contains: trimmed, mode: 'insensitive' } },
        { user: { email: { contains: trimmed, mode: 'insensitive' } } },
        { user: { displayName: { contains: trimmed, mode: 'insensitive' } } },
      ];
    }
  }

  return where;
}

export function createPrismaAdminTokenReservationRepository(): AdminTokenReservationRepository {
  return {
    async findReservations(query) {
      const where = buildTokenReservationWhereClause(query);
      const page = query.page;
      const limit = query.limit;
      const skip = (page - 1) * limit;

      const [items, allMatching] = await Promise.all([
        prisma.tokenReservation.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: {
                email: true,
                displayName: true,
              },
            },
            billingOperation: {
              select: {
                operationId: true,
                status: true,
                actualWalletTokens: true,
              },
            },
          },
        }),
        prisma.tokenReservation.findMany({
          where,
          select: {
            status: true,
            tokens: true,
            billingOperation: {
              select: {
                actualWalletTokens: true,
              },
            },
          },
        }),
      ]);

      const total = allMatching.length;
      let pendingReservations = 0;
      let completedReservations = 0;
      let releasedReservations = 0;
      let totalReservedTokens = 0;
      let totalActualWalletTokens = 0;
      let totalReturnedTokens = 0;

      for (const row of allMatching) {
        totalReservedTokens += row.tokens;

        if (row.status === 'PENDING') {
          pendingReservations += 1;
        } else if (row.status === 'COMPLETED') {
          completedReservations += 1;
        } else if (row.status === 'RELEASED') {
          releasedReservations += 1;
        }

        const actual = row.billingOperation?.actualWalletTokens;
        if (typeof actual === 'number' && Number.isInteger(actual) && actual >= 0) {
          totalActualWalletTokens += actual;
          if (actual <= row.tokens) {
            totalReturnedTokens += row.tokens - actual;
          }
        }
      }

      return {
        items,
        total,
        summary: {
          totalReservations: total,
          pendingReservations,
          completedReservations,
          releasedReservations,
          totalReservedTokens,
          totalActualWalletTokens,
          totalReturnedTokens,
        },
      };
    },

    async findReservationDetailById(reservationId) {
      const reservation = await prisma.tokenReservation.findUnique({
        where: { id: reservationId },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              displayName: true,
            },
          },
          wallet: {
            select: {
              id: true,
              tokenBalance: true,
              reservedBalance: true,
              status: true,
            },
          },
          billingOperation: true,
          fundingAllocations: {
            include: {
              fundingLot: true,
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!reservation) {
        return null;
      }

      const settlementReferenceId = `${reservation.referenceId}:settle`;
      const consumeTxId = reservation.billingOperation?.consumeTransactionId;

      const walletTransactions = await prisma.tokenTransaction.findMany({
        where: {
          walletId: reservation.walletId,
        },
        orderBy: { createdAt: 'asc' },
      });

      const linkedTransactions = walletTransactions.filter((tx) => {
        if (tx.referenceId === settlementReferenceId) {
          return true;
        }
        if (consumeTxId && tx.id === consumeTxId) {
          return true;
        }
        if (tx.metadata && typeof tx.metadata === 'object' && !Array.isArray(tx.metadata)) {
          const meta = tx.metadata as Record<string, unknown>;
          if (meta.reservationId === reservation.id) {
            return true;
          }
        }
        return false;
      });

      return {
        reservation,
        user: reservation.user,
        wallet: reservation.wallet,
        billingOperation: reservation.billingOperation,
        fundingAllocations: reservation.fundingAllocations,
        transactions: linkedTransactions,
      };
    },
  };
}
