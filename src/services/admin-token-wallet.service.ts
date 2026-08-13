import {
  Prisma,
  TokenTransaction,
  TokenTransactionSource,
  TokenTransactionType,
  WalletStatus,
} from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { MAX_TOKEN_BALANCE } from '../config/business-token-features.js';
import { AppError } from '../middleware/errorHandler.js';
import { consumeAvailableFundingLots, createFundingLot } from './token-funding-lot.service.js';
import { getTokenSummary } from './token.service.js';
import type { TokenSummaryResult } from './token.service.js';
import type {
  AdminTokenWalletListQuery,
  AdminTokenWalletTransactionsQuery,
  AdminTokenWalletBonusBody,
  AdminTokenWalletAdjustmentBody,
} from '../schemas/admin-token-wallet.schema.js';

export interface AdminTokenWalletUser {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  isBanned: boolean;
}

export interface AdminTokenWalletListItem {
  id: string;
  userId: string;
  tokenBalance: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  user: AdminTokenWalletUser;
}

export interface PaginatedAdminTokenWalletsResult {
  items: AdminTokenWalletListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface AdminTokenWalletDetails {
  wallet: {
    id: string | null;
    userId: string;
    tokenBalance: number;
    status: string;
    createdAt: string | null;
    updatedAt: string | null;
  };
  user: AdminTokenWalletUser;
  summary: TokenSummaryResult;
}

export interface AdminTokenTransactionItem {
  id: string;
  walletId: string;
  userId: string;
  type: string;
  tokens: number;
  source: string;
  paymentId: string | null;
  referenceId: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: string;
}

export interface PaginatedAdminTokenTransactionsResult {
  items: AdminTokenTransactionItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface AdminBonusResult {
  transactionId: string;
  walletId: string;
  userId: string;
  tokensGranted: number;
  previousBalance: number;
  newBalance: number;
  reason: string;
  idempotentReplay: boolean;
  createdAt: Date;
}

export interface AdminAdjustmentResult {
  transactionId: string;
  walletId: string;
  userId: string;
  operation: 'CREDIT' | 'DEBIT';
  tokensAdjusted: number;
  previousBalance: number;
  newBalance: number;
  reason: string;
  paymentId: string | null;
  relatedTransactionId: string | null;
  idempotentReplay: boolean;
  createdAt: string;
}

interface BonusTransactionMetadata {
  reason: string;
  actorId: string;
  idempotencyKey: string;
  previousBalance: number;
  newBalance: number;
}

interface AdjustmentTransactionMetadata {
  operation: 'CREDIT' | 'DEBIT';
  reason: string;
  actorId: string;
  idempotencyKey: string;
  previousBalance: number;
  newBalance: number;
  relatedTransactionId: string | null;
}

const adminWalletListSelect = {
  id: true,
  userId: true,
  tokenBalance: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      email: true,
      displayName: true,
      isActive: true,
      isBanned: true,
    },
  },
} as const;

type AdminWalletListRaw = Prisma.TokenWalletGetPayload<{
  select: typeof adminWalletListSelect;
}>;

const adminTransactionSelect = {
  id: true,
  walletId: true,
  userId: true,
  type: true,
  tokens: true,
  source: true,
  paymentId: true,
  referenceId: true,
  metadata: true,
  createdAt: true,
} as const;

const userSafeSelect = {
  id: true,
  email: true,
  displayName: true,
  isActive: true,
  isBanned: true,
} as const;

function toAdminWalletListItem(wallet: AdminWalletListRaw): AdminTokenWalletListItem {
  return {
    id: wallet.id,
    userId: wallet.userId,
    tokenBalance: wallet.tokenBalance,
    status: wallet.status,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
    user: {
      id: wallet.user.id,
      email: wallet.user.email,
      displayName: wallet.user.displayName,
      isActive: wallet.user.isActive,
      isBanned: wallet.user.isBanned,
    },
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildWalletWhere(query: AdminTokenWalletListQuery): Prisma.TokenWalletWhereInput {
  const where: Prisma.TokenWalletWhereInput = {
    user: { isDeleted: false },
  };

  if (query.search !== undefined) {
    const userWhere: Prisma.UserWhereInput[] = [
      { email: { contains: query.search, mode: 'insensitive' } },
      { displayName: { contains: query.search, mode: 'insensitive' } },
    ];
    if (UUID_PATTERN.test(query.search)) {
      userWhere.push({ id: { equals: query.search } });
    }
    where.user = {
      isDeleted: false,
      OR: userWhere,
    };
  }

  if (query.status !== undefined) {
    where.status = query.status;
  }

  return where;
}

function buildWalletOrderBy(
  query: AdminTokenWalletListQuery,
): Prisma.TokenWalletOrderByWithRelationInput[] {
  return [{ [query.sortBy]: query.sortOrder }, { id: query.sortOrder }];
}

function buildTransactionWhere(
  userId: string,
  query: AdminTokenWalletTransactionsQuery,
): Prisma.TokenTransactionWhereInput {
  const where: Prisma.TokenTransactionWhereInput = {
    userId,
  };

  if (query.type !== undefined) {
    where.type = query.type;
  }

  if (query.source !== undefined) {
    where.source = query.source;
  }

  if (query.dateFrom !== undefined || query.dateTo !== undefined) {
    where.createdAt = {};

    if (query.dateFrom !== undefined) {
      where.createdAt.gte = query.dateFrom;
    }

    if (query.dateTo !== undefined) {
      where.createdAt.lte = query.dateTo;
    }
  }

  return where;
}

function isSourceReferenceUniqueViolation(error: unknown): boolean {
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

function isWalletUserIdUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  if (error.meta?.modelName !== 'TokenWallet') return false;

  const target = error.meta?.target;

  if (Array.isArray(target)) {
    const fields = target.filter((item): item is string => typeof item === 'string');
    return fields.length === 1 && fields[0] === 'userId';
  }

  if (typeof target === 'string') {
    return target === 'userId' || target.endsWith('.userId');
  }

  return false;
}

function isWriteConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2034'
  );
}

function isRetryableGrantError(error: unknown): boolean {
  return isWalletUserIdUniqueViolation(error) || isWriteConflict(error);
}

function isJsonObject(value: Prisma.JsonValue | null): value is { [key: string]: Prisma.JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matchesBonusReplay(
  existing: TokenTransaction,
  targetUserId: string,
  input: AdminTokenWalletBonusBody,
): boolean {
  if (existing.type !== TokenTransactionType.BONUS) return false;
  if (existing.source !== TokenTransactionSource.ADMIN) return false;
  if (existing.userId !== targetUserId) return false;
  if (existing.tokens !== input.tokens) return false;
  return isJsonObject(existing.metadata) && existing.metadata.reason === input.reason;
}

function toReplayResult(existing: TokenTransaction): AdminBonusResult {
  const metadata = isJsonObject(existing.metadata) ? existing.metadata : {};
  return {
    transactionId: existing.id,
    walletId: existing.walletId,
    userId: existing.userId,
    tokensGranted: existing.tokens,
    previousBalance: typeof metadata.previousBalance === 'number' ? metadata.previousBalance : 0,
    newBalance: typeof metadata.newBalance === 'number' ? metadata.newBalance : existing.tokens,
    reason: typeof metadata.reason === 'string' ? metadata.reason : '',
    idempotentReplay: true,
    createdAt: existing.createdAt,
  };
}

function matchesAdjustmentReplay(
  existing: TokenTransaction,
  actorId: string,
  targetUserId: string,
  input: AdminTokenWalletAdjustmentBody,
): boolean {
  if (existing.type !== TokenTransactionType.ADJUSTMENT) return false;
  if (existing.source !== TokenTransactionSource.ADMIN) return false;
  if (existing.userId !== targetUserId) return false;
  if (existing.tokens !== input.tokens) return false;
  if ((existing.paymentId ?? null) !== (input.paymentId ?? null)) return false;
  if (!isJsonObject(existing.metadata)) return false;
  if (existing.metadata.actorId !== actorId) return false;
  if (existing.metadata.reason !== input.reason) return false;
  if (existing.metadata.operation !== input.operation) return false;
  if ((existing.metadata.relatedTransactionId ?? null) !== (input.relatedTransactionId ?? null)) {
    return false;
  }
  return true;
}

function toAdjustmentReplayResult(existing: TokenTransaction): AdminAdjustmentResult {
  const metadata = isJsonObject(existing.metadata) ? existing.metadata : {};
  return {
    transactionId: existing.id,
    walletId: existing.walletId,
    userId: existing.userId,
    operation: metadata.operation === 'DEBIT' ? 'DEBIT' : 'CREDIT',
    tokensAdjusted: existing.tokens,
    previousBalance: typeof metadata.previousBalance === 'number' ? metadata.previousBalance : 0,
    newBalance: typeof metadata.newBalance === 'number' ? metadata.newBalance : existing.tokens,
    reason: typeof metadata.reason === 'string' ? metadata.reason : '',
    paymentId: existing.paymentId ?? null,
    relatedTransactionId:
      typeof metadata.relatedTransactionId === 'string' ? metadata.relatedTransactionId : null,
    idempotentReplay: true,
    createdAt: existing.createdAt.toISOString(),
  };
}

export async function list(
  query: AdminTokenWalletListQuery,
): Promise<PaginatedAdminTokenWalletsResult> {
  const { page, limit } = query;
  const skip = (page - 1) * limit;

  const where = buildWalletWhere(query);
  const orderBy = buildWalletOrderBy(query);

  const [total, rawItems] = await Promise.all([
    prisma.tokenWallet.count({ where }),
    prisma.tokenWallet.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      select: adminWalletListSelect,
    }),
  ]);

  const items = rawItems.map(toAdminWalletListItem);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: total > 0 ? Math.ceil(total / limit) : 0,
    },
  };
}

export async function getWalletDetails(userId: string): Promise<AdminTokenWalletDetails> {
  const user = await prisma.user.findFirst({
    where: { id: userId, isDeleted: false },
    select: userSafeSelect,
  });

  if (!user) {
    throw new AppError(404, 'User not found');
  }

  const [wallet, summary] = await Promise.all([
    prisma.tokenWallet.findUnique({
      where: { userId },
    }),
    getTokenSummary(userId),
  ]);

  if (!wallet) {
    return {
      wallet: {
        id: null,
        userId,
        tokenBalance: 0,
        status: WalletStatus.ACTIVE,
        createdAt: null,
        updatedAt: null,
      },
      user,
      summary,
    };
  }

  return {
    wallet: {
      id: wallet.id,
      userId: wallet.userId,
      tokenBalance: wallet.tokenBalance,
      status: wallet.status,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    },
    user,
    summary,
  };
}

export async function getTransactions(
  userId: string,
  query: AdminTokenWalletTransactionsQuery,
): Promise<PaginatedAdminTokenTransactionsResult> {
  const user = await prisma.user.findFirst({
    where: { id: userId, isDeleted: false },
    select: { id: true },
  });

  if (!user) {
    throw new AppError(404, 'User not found');
  }

  const { page, limit } = query;
  const skip = (page - 1) * limit;

  const where = buildTransactionWhere(userId, query);
  const orderBy: Prisma.TokenTransactionOrderByWithRelationInput[] = [
    { createdAt: query.sortOrder },
    { id: query.sortOrder },
  ];

  const [total, transactions] = await Promise.all([
    prisma.tokenTransaction.count({ where }),
    prisma.tokenTransaction.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      select: adminTransactionSelect,
    }),
  ]);

  const items: AdminTokenTransactionItem[] = transactions.map((transaction) => ({
    id: transaction.id,
    walletId: transaction.walletId,
    userId: transaction.userId,
    type: transaction.type,
    tokens: transaction.tokens,
    source: transaction.source,
    paymentId: transaction.paymentId,
    referenceId: transaction.referenceId,
    metadata: transaction.metadata,
    createdAt: transaction.createdAt.toISOString(),
  }));

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: total > 0 ? Math.ceil(total / limit) : 0,
    },
  };
}

const MAX_BONUS_GRANT_ATTEMPTS = 3;

export async function grantBonus(
  actorId: string,
  targetUserId: string,
  input: AdminTokenWalletBonusBody,
): Promise<AdminBonusResult> {
  const referenceId = `bonus:${input.idempotencyKey}`;

  const [actor, targetUser, existing] = await Promise.all([
    prisma.user.findFirst({
      where: { id: actorId, isDeleted: false },
      select: { id: true },
    }),
    prisma.user.findFirst({
      where: { id: targetUserId, isDeleted: false },
      select: { id: true },
    }),
    prisma.tokenTransaction.findUnique({
      where: {
        source_referenceId: {
          source: TokenTransactionSource.ADMIN,
          referenceId,
        },
      },
    }),
  ]);

  if (!actor) {
    throw new AppError(401, 'Authenticated user not found');
  }

  if (!targetUser) {
    throw new AppError(404, 'User not found');
  }

  if (existing) {
    if (matchesBonusReplay(existing, targetUserId, input)) {
      return toReplayResult(existing);
    }
    throw new AppError(409, 'Token bonus idempotency conflict');
  }

  for (let attempt = 1; attempt <= MAX_BONUS_GRANT_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const existingInTx = await tx.tokenTransaction.findUnique({
          where: {
            source_referenceId: {
              source: TokenTransactionSource.ADMIN,
              referenceId,
            },
          },
        });

        if (existingInTx) {
          if (matchesBonusReplay(existingInTx, targetUserId, input)) {
            return toReplayResult(existingInTx);
          }
          throw new AppError(409, 'Token bonus idempotency conflict');
        }

        const wallet = await tx.tokenWallet.upsert({
          where: { userId: targetUserId },
          update: {},
          create: {
            userId: targetUserId,
            tokenBalance: 0,
            status: WalletStatus.ACTIVE,
          },
        });

        if (wallet.status !== WalletStatus.ACTIVE) {
          throw new AppError(403, 'Token wallet is not active');
        }

        const updated = await tx.tokenWallet.updateMany({
          where: {
            userId: targetUserId,
            status: WalletStatus.ACTIVE,
            tokenBalance: {
              lte: MAX_TOKEN_BALANCE - input.tokens,
            },
          },
          data: {
            tokenBalance: {
              increment: input.tokens,
            },
          },
        });

        if (updated.count === 0) {
          const conflictedWallet = await tx.tokenWallet.findUnique({
            where: { userId: targetUserId },
          });

          if (!conflictedWallet) {
            throw new AppError(404, 'Token wallet not found');
          }

          if (conflictedWallet.status !== WalletStatus.ACTIVE) {
            throw new AppError(403, 'Token wallet is not active');
          }

          throw new AppError(409, 'Token balance limit exceeded');
        }

        const updatedWallet = await tx.tokenWallet.findUnique({
          where: { userId: targetUserId },
          select: {
            id: true,
            userId: true,
            tokenBalance: true,
            status: true,
          },
        });

        if (!updatedWallet) {
          throw new AppError(404, 'Token wallet not found');
        }

        const newBalance = updatedWallet.tokenBalance;
        const previousBalance = newBalance - input.tokens;

        const transaction = await tx.tokenTransaction.create({
          data: {
            walletId: updatedWallet.id,
            userId: targetUserId,
            type: TokenTransactionType.BONUS,
            tokens: input.tokens,
            source: TokenTransactionSource.ADMIN,
            paymentId: null,
            referenceId,
            metadata: {
              reason: input.reason,
              actorId,
              idempotencyKey: input.idempotencyKey,
              previousBalance,
              newBalance,
            },
          },
        });
        await createFundingLot(tx, {
          walletId: updatedWallet.id, userId: targetUserId, source: TokenTransactionSource.ADMIN,
          sourceTransactionId: transaction.id, tokens: input.tokens,
        });

        await tx.auditLog.create({
          data: {
            actorId,
            action: 'token_bonus_granted',
            targetUserId,
            metadata: {
              walletId: updatedWallet.id,
              transactionId: transaction.id,
              tokens: input.tokens,
              reason: input.reason,
              idempotencyKey: input.idempotencyKey,
              previousBalance,
              newBalance,
            },
          },
        });

        return {
          transactionId: transaction.id,
          walletId: transaction.walletId,
          userId: transaction.userId,
          tokensGranted: transaction.tokens,
          previousBalance,
          newBalance,
          reason: input.reason,
          idempotentReplay: false,
          createdAt: transaction.createdAt,
        };
      });
    } catch (err) {
      if (isSourceReferenceUniqueViolation(err)) {
        const existingAfter = await prisma.tokenTransaction.findUnique({
          where: {
            source_referenceId: {
              source: TokenTransactionSource.ADMIN,
              referenceId,
            },
          },
        });

        if (existingAfter && matchesBonusReplay(existingAfter, targetUserId, input)) {
          return toReplayResult(existingAfter);
        }

        throw new AppError(409, 'Token bonus idempotency conflict');
      }

      if (isRetryableGrantError(err) && attempt < MAX_BONUS_GRANT_ATTEMPTS) {
        continue;
      }

      throw err;
    }
  }

  throw new AppError(500, 'Token bonus grant failed after retries');
}

const MAX_ADJUSTMENT_ATTEMPTS = 3;

export async function adjust(
  actorId: string,
  targetUserId: string,
  input: AdminTokenWalletAdjustmentBody,
): Promise<AdminAdjustmentResult> {
  const referenceId = `adjustment:${input.idempotencyKey}`;

  const [actor, targetUser, existing] = await Promise.all([
    prisma.user.findFirst({
      where: { id: actorId, isDeleted: false },
      select: { id: true },
    }),
    prisma.user.findFirst({
      where: { id: targetUserId, isDeleted: false },
      select: { id: true },
    }),
    prisma.tokenTransaction.findUnique({
      where: {
        source_referenceId: {
          source: TokenTransactionSource.ADMIN,
          referenceId,
        },
      },
    }),
  ]);

  if (!actor) {
    throw new AppError(401, 'Authenticated user not found');
  }

  if (!targetUser) {
    throw new AppError(404, 'User not found');
  }

  if (existing) {
    if (matchesAdjustmentReplay(existing, actorId, targetUserId, input)) {
      return toAdjustmentReplayResult(existing);
    }
    throw new AppError(409, 'Token adjustment idempotency conflict');
  }

  for (let attempt = 1; attempt <= MAX_ADJUSTMENT_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const existingInTx = await tx.tokenTransaction.findUnique({
          where: {
            source_referenceId: {
              source: TokenTransactionSource.ADMIN,
              referenceId,
            },
          },
        });

        if (existingInTx) {
          if (matchesAdjustmentReplay(existingInTx, actorId, targetUserId, input)) {
            return toAdjustmentReplayResult(existingInTx);
          }
          throw new AppError(409, 'Token adjustment idempotency conflict');
        }

        const [actorInTx, targetInTx] = await Promise.all([
          tx.user.findFirst({
            where: { id: actorId, isDeleted: false },
            select: { id: true },
          }),
          tx.user.findFirst({
            where: { id: targetUserId, isDeleted: false },
            select: { id: true },
          }),
        ]);

        if (!actorInTx) {
          throw new AppError(401, 'Authenticated user not found');
        }

        if (!targetInTx) {
          throw new AppError(404, 'User not found');
        }

        if (input.paymentId !== undefined) {
          const payment = await tx.payment.findFirst({
            where: { id: input.paymentId, userId: targetUserId },
            select: { id: true },
          });

          if (!payment) {
            throw new AppError(404, 'Payment not found');
          }
        }

        if (input.relatedTransactionId !== undefined) {
          const related = await tx.tokenTransaction.findFirst({
            where: { id: input.relatedTransactionId, userId: targetUserId },
            select: { id: true, userId: true, paymentId: true },
          });

          if (!related) {
            throw new AppError(404, 'Related token transaction not found');
          }

          if (
            input.paymentId !== undefined &&
            related.paymentId !== null &&
            related.paymentId !== input.paymentId
          ) {
            throw new AppError(409, 'Adjustment reference conflict');
          }
        }

        if (input.operation === 'CREDIT') {
          const upserted = await tx.tokenWallet.upsert({
            where: { userId: targetUserId },
            update: {},
            create: {
              userId: targetUserId,
              tokenBalance: 0,
              status: WalletStatus.ACTIVE,
            },
          });

          if (upserted.status !== WalletStatus.ACTIVE) {
            throw new AppError(403, 'Token wallet is not active');
          }

          const updated = await tx.tokenWallet.updateMany({
            where: {
              userId: targetUserId,
              status: WalletStatus.ACTIVE,
              tokenBalance: {
                lte: MAX_TOKEN_BALANCE - input.tokens,
              },
            },
            data: {
              tokenBalance: {
                increment: input.tokens,
              },
            },
          });

          if (updated.count === 0) {
            const conflictedWallet = await tx.tokenWallet.findUnique({
              where: { userId: targetUserId },
            });

            if (!conflictedWallet) {
              throw new AppError(404, 'Token wallet not found');
            }

            if (conflictedWallet.status !== WalletStatus.ACTIVE) {
              throw new AppError(403, 'Token wallet is not active');
            }

            throw new AppError(409, 'Token balance limit exceeded');
          }
        } else {
          const existingWallet = await tx.tokenWallet.findUnique({
            where: { userId: targetUserId },
          });

          if (!existingWallet) {
            throw new AppError(409, 'Insufficient token balance for adjustment');
          }

          if (existingWallet.status !== WalletStatus.ACTIVE) {
            throw new AppError(403, 'Token wallet is not active');
          }

          const updated = await tx.tokenWallet.updateMany({
            where: {
              userId: targetUserId,
              status: WalletStatus.ACTIVE,
              tokenBalance: {
                gte: input.tokens,
              },
            },
            data: {
              tokenBalance: {
                decrement: input.tokens,
              },
            },
          });

          if (updated.count === 0) {
            const conflictedWallet = await tx.tokenWallet.findUnique({
              where: { userId: targetUserId },
            });

            if (!conflictedWallet) {
              throw new AppError(409, 'Insufficient token balance for adjustment');
            }

            if (conflictedWallet.status !== WalletStatus.ACTIVE) {
              throw new AppError(403, 'Token wallet is not active');
            }

            throw new AppError(409, 'Insufficient token balance for adjustment');
          }
          await consumeAvailableFundingLots(tx, existingWallet.id, input.tokens);
        }

        const updatedWallet = await tx.tokenWallet.findUnique({
          where: { userId: targetUserId },
          select: {
            id: true,
            userId: true,
            tokenBalance: true,
            status: true,
          },
        });

        if (!updatedWallet) {
          throw new AppError(404, 'Token wallet not found');
        }

        const newBalance = updatedWallet.tokenBalance;
        const previousBalance =
          input.operation === 'CREDIT'
            ? newBalance - input.tokens
            : newBalance + input.tokens;

        const transaction = await tx.tokenTransaction.create({
          data: {
            walletId: updatedWallet.id,
            userId: targetUserId,
            type: TokenTransactionType.ADJUSTMENT,
            tokens: input.tokens,
            source: TokenTransactionSource.ADMIN,
            paymentId: input.paymentId ?? null,
            referenceId,
            metadata: {
              operation: input.operation,
              reason: input.reason,
              actorId,
              idempotencyKey: input.idempotencyKey,
              previousBalance,
              newBalance,
              relatedTransactionId: input.relatedTransactionId ?? null,
            } satisfies AdjustmentTransactionMetadata,
          },
        });
        if (input.operation === 'CREDIT') {
          await createFundingLot(tx, {
            walletId: updatedWallet.id, userId: targetUserId, source: TokenTransactionSource.ADMIN,
            // Payment references on adjustments are audit context, not a
            // purchase funding lot; only PURCHASE lots own a Payment.
            sourceTransactionId: transaction.id, tokens: input.tokens,
          });
        }

        await tx.auditLog.create({
          data: {
            actorId,
            action: 'token_adjustment_created',
            targetUserId,
            metadata: {
              walletId: updatedWallet.id,
              transactionId: transaction.id,
              operation: input.operation,
              tokens: input.tokens,
              reason: input.reason,
              idempotencyKey: input.idempotencyKey,
              previousBalance,
              newBalance,
              paymentId: input.paymentId ?? null,
              relatedTransactionId: input.relatedTransactionId ?? null,
            },
          },
        });

        return {
          transactionId: transaction.id,
          walletId: transaction.walletId,
          userId: transaction.userId,
          operation: input.operation,
          tokensAdjusted: transaction.tokens,
          previousBalance,
          newBalance,
          reason: input.reason,
          paymentId: transaction.paymentId ?? null,
          relatedTransactionId: input.relatedTransactionId ?? null,
          idempotentReplay: false,
          createdAt: transaction.createdAt.toISOString(),
        };
      });
    } catch (err) {
      if (isSourceReferenceUniqueViolation(err)) {
        const existingAfter = await prisma.tokenTransaction.findUnique({
          where: {
            source_referenceId: {
              source: TokenTransactionSource.ADMIN,
              referenceId,
            },
          },
        });

        if (existingAfter && matchesAdjustmentReplay(existingAfter, actorId, targetUserId, input)) {
          return toAdjustmentReplayResult(existingAfter);
        }

        throw new AppError(409, 'Token adjustment idempotency conflict');
      }

      if (isRetryableGrantError(err) && attempt < MAX_ADJUSTMENT_ATTEMPTS) {
        continue;
      }

      throw err;
    }
  }

  throw new AppError(500, 'Token adjustment failed after retries');
}
