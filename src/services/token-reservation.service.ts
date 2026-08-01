import {
  Prisma,
  TokenReservation,
  TokenReservationStatus,
  TokenTransaction,
} from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  BUSINESS_TOKEN_PRICING_VERSION,
  getBusinessTokenCost,
  isBusinessTokenFeature,
} from '../config/business-token-features.js';
import type { BusinessTokenFeature } from '../config/business-token-features.js';
import { isBusinessConsumptionSource } from './business-token-consumption.service.js';
import type { BusinessConsumptionSource } from './business-token-consumption.service.js';

const RESERVATION_TTL_MS = 15 * 60 * 1000;

export interface ReserveBusinessTokensInput {
  userId: string;
  feature: string;
  source: string;
  idempotencyKey: string;
  metadata?: Prisma.InputJsonValue;
}

export interface ReserveBusinessTokensResult {
  reservationId: string;
  referenceId: string;
  walletId: string;
  userId: string;
  feature: BusinessTokenFeature;
  source: BusinessConsumptionSource;
  tokens: number;
  pricingVersion: number;
  status: TokenReservationStatus;
  expiresAt: Date;
  metadata: Prisma.JsonValue | null;
  availableBalance: number;
  reservedBalance: number;
  totalBalance: number;
  idempotentReplay: boolean;
}

export interface SettleBusinessTokenReservationInput {
  reservationId: string;
}

export interface SettleBusinessTokenReservationResult {
  reservationId: string;
  referenceId: string;
  walletId: string;
  userId: string;
  feature: BusinessTokenFeature;
  source: BusinessConsumptionSource;
  tokens: number;
  pricingVersion: number;
  status: TokenReservationStatus;
  settledAt: Date;
  consumeTransactionId: string;
  idempotentReplay: boolean;
}

export interface ReleaseBusinessTokenReservationInput {
  reservationId: string;
  reason?: string;
}

export interface ReleaseBusinessTokenReservationResult {
  reservationId: string;
  referenceId: string;
  walletId: string;
  userId: string;
  feature: BusinessTokenFeature;
  source: BusinessConsumptionSource;
  tokens: number;
  pricingVersion: number;
  status: TokenReservationStatus;
  releasedAt: Date;
  releaseReason: string | null;
  idempotentReplay: boolean;
}

interface ReservationBalances {
  availableBalance: number;
  reservedBalance: number;
  totalBalance: number;
}

function toBalances(wallet: {
  tokenBalance: number;
  reservedBalance: number;
}): ReservationBalances {
  return {
    availableBalance: wallet.tokenBalance,
    reservedBalance: wallet.reservedBalance,
    totalBalance: wallet.tokenBalance + wallet.reservedBalance,
  };
}

function toReservationSummary(reservation: TokenReservation): {
  reservationId: string;
  referenceId: string;
  walletId: string;
  userId: string;
  feature: BusinessTokenFeature;
  source: BusinessConsumptionSource;
  tokens: number;
  pricingVersion: number;
  status: TokenReservationStatus;
  expiresAt: Date;
  metadata: Prisma.JsonValue | null;
} {
  return {
    reservationId: reservation.id,
    referenceId: reservation.referenceId,
    walletId: reservation.walletId,
    userId: reservation.userId,
    feature: reservation.feature as BusinessTokenFeature,
    source: reservation.source as BusinessConsumptionSource,
    tokens: reservation.tokens,
    pricingVersion: reservation.pricingVersion,
    status: reservation.status,
    expiresAt: reservation.expiresAt,
    metadata: reservation.metadata,
  };
}

function isReservationUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  return error.meta?.modelName === 'TokenReservation';
}

function isConsumeReferenceUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  if (error.meta?.modelName !== 'TokenTransaction') return false;

  const target = error.meta?.target;

  if (Array.isArray(target)) {
    const fields = target.filter((item): item is string => typeof item === 'string');
    return (
      fields.length === 2 &&
      fields.includes('source') &&
      fields.includes('referenceId')
    );
  }

  if (typeof target === 'string') {
    return target.includes('source') && target.includes('referenceId');
  }

  return false;
}

function assertReservationId(reservationId: string): string {
  const trimmed = reservationId.trim();
  if (!trimmed) {
    throw new AppError(400, 'reservationId must not be empty');
  }
  return trimmed;
}

function toSettledResult(
  consume: TokenTransaction | null,
  reservation: TokenReservation,
  idempotentReplay: boolean,
): SettleBusinessTokenReservationResult {
  if (!consume) {
    throw new AppError(409, 'Token reservation integrity conflict');
  }

  return {
    ...toReservationSummary(reservation),
    settledAt: reservation.settledAt ?? reservation.updatedAt,
    consumeTransactionId: consume.id,
    idempotentReplay,
  };
}

export async function reserveBusinessTokens(
  input: ReserveBusinessTokensInput,
): Promise<ReserveBusinessTokensResult> {
  const userId = input.userId.trim();
  const idempotencyKey = input.idempotencyKey.trim();

  if (!userId) {
    throw new AppError(400, 'userId must not be empty');
  }

  if (!idempotencyKey) {
    throw new AppError(400, 'idempotencyKey must not be empty');
  }

  if (!isBusinessTokenFeature(input.feature)) {
    throw new AppError(400, 'Invalid business token feature');
  }

  if (!isBusinessConsumptionSource(input.source)) {
    throw new AppError(400, 'Invalid business consumption source');
  }

  const feature: BusinessTokenFeature = input.feature;
  const source: BusinessConsumptionSource = input.source;

  // The token cost always comes from the backend pricing catalogue.
  const cost = getBusinessTokenCost(feature);
  const referenceId = `${userId}:${feature}:${idempotencyKey}`;
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);

  const existing = await prisma.tokenReservation.findUnique({
    where: { referenceId },
  });

  if (existing) {
    const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
    return {
      ...toReservationSummary(existing),
      ...(wallet ? toBalances(wallet) : { availableBalance: 0, reservedBalance: 0, totalBalance: 0 }),
      idempotentReplay: true,
    };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.tokenWallet.updateMany({
        where: {
          userId,
          status: 'ACTIVE',
          tokenBalance: { gte: cost },
        },
        data: {
          tokenBalance: { decrement: cost },
          reservedBalance: { increment: cost },
        },
      });

      if (updated.count === 0) {
        const wallet = await tx.tokenWallet.findUnique({ where: { userId } });

        if (!wallet) {
          throw new AppError(402, 'Insufficient token balance');
        }

        if (wallet.status !== 'ACTIVE') {
          throw new AppError(403, 'Token wallet is not active');
        }

        throw new AppError(402, 'Insufficient token balance');
      }

      const wallet = await tx.tokenWallet.findUnique({
        where: { userId },
        select: {
          id: true,
          tokenBalance: true,
          reservedBalance: true,
        },
      });

      if (!wallet) {
        throw new AppError(409, 'Token reservation conflict');
      }

      const reservation = await tx.tokenReservation.create({
        data: {
          walletId: wallet.id,
          userId,
          feature,
          source,
          tokens: cost,
          pricingVersion: BUSINESS_TOKEN_PRICING_VERSION,
          idempotencyKey,
          referenceId,
          status: TokenReservationStatus.PENDING,
          expiresAt,
          metadata: input.metadata ?? Prisma.DbNull,
        },
      });

      return {
        ...toReservationSummary(reservation),
        ...toBalances(wallet),
        idempotentReplay: false,
      };
    });
  } catch (err) {
    if (isReservationUniqueViolation(err)) {
      const existing = await prisma.tokenReservation.findUnique({
        where: { referenceId },
      });

      if (existing) {
        const wallet = await prisma.tokenWallet.findUnique({ where: { userId } });
        return {
          ...toReservationSummary(existing),
          ...(wallet ? toBalances(wallet) : { availableBalance: 0, reservedBalance: 0, totalBalance: 0 }),
          idempotentReplay: true,
        };
      }
    }
    throw err;
  }
}

export async function settleBusinessTokenReservation(
  input: SettleBusinessTokenReservationInput,
): Promise<SettleBusinessTokenReservationResult> {
  const reservationId = assertReservationId(input.reservationId);

  const reservation = await prisma.tokenReservation.findUnique({
    where: { id: reservationId },
  });

  if (!reservation) {
    throw new AppError(404, 'Reservation not found');
  }

  if (reservation.status === TokenReservationStatus.COMPLETED) {
    const consume = await prisma.tokenTransaction.findFirst({
      where: {
        walletId: reservation.walletId,
        userId: reservation.userId,
        type: 'CONSUME',
        referenceId: `${reservation.referenceId}:settle`,
      },
      orderBy: { createdAt: 'desc' },
    });

    return toSettledResult(consume, reservation, true);
  }

  if (reservation.status === TokenReservationStatus.RELEASED) {
    throw new AppError(409, 'Cannot settle a released reservation');
  }

  const settlementReferenceId = `${reservation.referenceId}:settle`;

  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.tokenReservation.updateMany({
        where: { id: reservationId, status: TokenReservationStatus.PENDING },
        data: {
          status: TokenReservationStatus.COMPLETED,
          settledAt: new Date(),
        },
      });

      if (claimed.count === 0) {
        const current = await tx.tokenReservation.findUnique({
          where: { id: reservationId },
        });

        if (!current) {
          throw new AppError(404, 'Reservation not found');
        }

        if (current.status === TokenReservationStatus.COMPLETED) {
          const consume = await tx.tokenTransaction.findFirst({
            where: {
              walletId: current.walletId,
              userId: current.userId,
              type: 'CONSUME',
              referenceId: settlementReferenceId,
            },
            orderBy: { createdAt: 'desc' },
          });

          return toSettledResult(consume, current, true);
        }

        throw new AppError(409, 'Cannot settle a released reservation');
      }

      // Settling works regardless of a later wallet status change, but the
      // wallet must still hold the reserved tokens it committed to.
      const walletUpdated = await tx.tokenWallet.updateMany({
        where: {
          id: reservation.walletId,
          reservedBalance: {
            gte: reservation.tokens,
          },
        },
        data: {
          reservedBalance: { decrement: reservation.tokens },
        },
      });

      if (walletUpdated.count !== 1) {
        throw new AppError(409, 'Token reservation integrity conflict');
      }

      const transaction = await tx.tokenTransaction.create({
        data: {
          walletId: reservation.walletId,
          userId: reservation.userId,
          type: 'CONSUME',
          tokens: reservation.tokens,
          source: reservation.source,
          paymentId: null,
          referenceId: settlementReferenceId,
          metadata: {
            feature: reservation.feature,
            reservationId: reservation.id,
            idempotencyKey: reservation.idempotencyKey,
            pricingVersion: reservation.pricingVersion,
          },
        },
      });

      const settled = await tx.tokenReservation.findUnique({
        where: { id: reservationId },
      });

      if (!settled) {
        throw new AppError(409, 'Token reservation conflict');
      }

      return {
        ...toReservationSummary(settled),
        settledAt: settled.settledAt ?? settled.updatedAt,
        consumeTransactionId: transaction.id,
        idempotentReplay: false,
      };
    });
  } catch (err) {
    if (isConsumeReferenceUniqueViolation(err)) {
      const settled = await prisma.tokenReservation.findUnique({
        where: { id: reservationId },
      });

      if (settled && settled.status === TokenReservationStatus.COMPLETED) {
        const consume = await prisma.tokenTransaction.findFirst({
          where: {
            walletId: settled.walletId,
            userId: settled.userId,
            type: 'CONSUME',
            referenceId: settlementReferenceId,
          },
          orderBy: { createdAt: 'desc' },
        });

        return toSettledResult(consume, settled, true);
      }
    }
    throw err;
  }
}

export async function releaseBusinessTokenReservation(
  input: ReleaseBusinessTokenReservationInput,
): Promise<ReleaseBusinessTokenReservationResult> {
  const reservationId = assertReservationId(input.reservationId);
  const reason = input.reason?.trim() || null;

  const reservation = await prisma.tokenReservation.findUnique({
    where: { id: reservationId },
  });

  if (!reservation) {
    throw new AppError(404, 'Reservation not found');
  }

  if (reservation.status === TokenReservationStatus.COMPLETED) {
    throw new AppError(409, 'Cannot release a completed reservation');
  }

  if (reservation.status === TokenReservationStatus.RELEASED) {
    return {
      ...toReservationSummary(reservation),
      releasedAt: reservation.releasedAt ?? reservation.updatedAt,
      releaseReason: reservation.releaseReason,
      idempotentReplay: true,
    };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.tokenReservation.updateMany({
        where: { id: reservationId, status: TokenReservationStatus.PENDING },
        data: {
          status: TokenReservationStatus.RELEASED,
          releasedAt: new Date(),
          releaseReason: reason,
        },
      });

      if (claimed.count === 0) {
        const current = await tx.tokenReservation.findUnique({
          where: { id: reservationId },
        });

        if (!current) {
          throw new AppError(404, 'Reservation not found');
        }

        if (current.status === TokenReservationStatus.RELEASED) {
          return {
            ...toReservationSummary(current),
            releasedAt: current.releasedAt ?? current.updatedAt,
            releaseReason: current.releaseReason,
            idempotentReplay: true,
          };
        }

        throw new AppError(409, 'Cannot release a completed reservation');
      }

      // Releasing works regardless of a later wallet status change, but the
      // wallet must still hold the reserved tokens it committed to.
      const walletUpdated = await tx.tokenWallet.updateMany({
        where: {
          id: reservation.walletId,
          reservedBalance: {
            gte: reservation.tokens,
          },
        },
        data: {
          reservedBalance: { decrement: reservation.tokens },
          tokenBalance: { increment: reservation.tokens },
        },
      });

      if (walletUpdated.count !== 1) {
        throw new AppError(409, 'Token reservation integrity conflict');
      }

      const released = await tx.tokenReservation.findUnique({
        where: { id: reservationId },
      });

      if (!released) {
        throw new AppError(409, 'Token reservation conflict');
      }

      return {
        ...toReservationSummary(released),
        releasedAt: released.releasedAt ?? released.updatedAt,
        releaseReason: released.releaseReason,
        idempotentReplay: false,
      };
    });
  } catch (err) {
    throw err;
  }
}
