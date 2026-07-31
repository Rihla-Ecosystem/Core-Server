import { Prisma, TokenTransactionSource } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { getBusinessTokenCost } from '../config/business-token-features.js';
import type { BusinessTokenFeature } from '../config/business-token-features.js';

export type BusinessConsumptionSource = Exclude<
  TokenTransactionSource,
  'PURCHASE' | 'ADMIN'
>;

export interface ConsumeBusinessTokensInput {
  userId: string;
  feature: BusinessTokenFeature;
  source: BusinessConsumptionSource;
  businessRequestId: string;
}

export interface ConsumeBusinessTokensResult {
  transactionId: string;
  walletId: string;
  feature: BusinessTokenFeature;
  source: BusinessConsumptionSource;
  tokensConsumed: number;
  walletBalance: number;
  idempotentReplay: boolean;
}

const ALL_TRANSACTION_SOURCES: readonly string[] = Object.values(TokenTransactionSource);
const BUSINESS_EXCLUDED_SOURCES: readonly string[] = ['PURCHASE', 'ADMIN'];

export function isBusinessConsumptionSource(
  value: string,
): value is BusinessConsumptionSource {
  return (
    ALL_TRANSACTION_SOURCES.includes(value) &&
    !BUSINESS_EXCLUDED_SOURCES.includes(value)
  );
}

function isSourceReferenceUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;

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

export async function consumeBusinessTokens(
  input: ConsumeBusinessTokensInput,
): Promise<ConsumeBusinessTokensResult> {
  const userId = input.userId.trim();
  const businessRequestId = input.businessRequestId.trim();

  if (!userId) {
    throw new AppError(400, 'userId must not be empty');
  }

  if (!businessRequestId) {
    throw new AppError(400, 'businessRequestId must not be empty');
  }

  if (!isBusinessConsumptionSource(input.source)) {
    throw new AppError(400, 'Invalid business consumption source');
  }

  const cost = getBusinessTokenCost(input.feature);
  const referenceId = `${userId}:${input.feature}:${businessRequestId}`;

  const existing = await prisma.tokenTransaction.findUnique({
    where: {
      source_referenceId: {
        source: input.source,
        referenceId,
      },
    },
  });

  if (existing) {
    if (existing.type !== 'CONSUME' || existing.userId !== userId) {
      throw new AppError(409, 'Token consumption conflict');
    }

    const wallet = await prisma.tokenWallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      throw new AppError(409, 'Token consumption conflict');
    }

    return {
      transactionId: existing.id,
      walletId: existing.walletId,
      feature: input.feature,
      source: input.source,
      tokensConsumed: existing.tokens,
      walletBalance: wallet.tokenBalance,
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
        },
      });

      if (updated.count === 0) {
        const wallet = await tx.tokenWallet.findUnique({
          where: { userId },
        });

        if (!wallet) {
          throw new AppError(402, 'Insufficient token balance');
        }

        if (wallet.status !== 'ACTIVE') {
          throw new AppError(403, 'Token wallet is not active');
        }

        throw new AppError(402, 'Insufficient token balance');
      }

      const updatedWallet = await tx.tokenWallet.findUnique({
        where: { userId },
      });

      if (!updatedWallet) {
        throw new AppError(409, 'Token wallet state conflict');
      }

      const transaction = await tx.tokenTransaction.create({
        data: {
          walletId: updatedWallet.id,
          userId,
          type: 'CONSUME',
          tokens: cost,
          source: input.source,
          paymentId: null,
          referenceId,
          metadata: {
            feature: input.feature,
            businessRequestId,
          },
        },
      });

      return {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        feature: input.feature,
        source: input.source,
        tokensConsumed: transaction.tokens,
        walletBalance: updatedWallet.tokenBalance,
        idempotentReplay: false,
      };
    });
  } catch (err) {
    if (isSourceReferenceUniqueViolation(err)) {
      const existing = await prisma.tokenTransaction.findUnique({
        where: {
          source_referenceId: {
            source: input.source,
            referenceId,
          },
        },
      });

      if (existing && existing.type === 'CONSUME' && existing.userId === userId) {
        const wallet = await prisma.tokenWallet.findUnique({
          where: { userId },
        });

        if (wallet) {
          return {
            transactionId: existing.id,
            walletId: existing.walletId,
            feature: input.feature,
            source: input.source,
            tokensConsumed: existing.tokens,
            walletBalance: wallet.tokenBalance,
            idempotentReplay: true,
          };
        }
      }
    }
    throw err;
  }
}
