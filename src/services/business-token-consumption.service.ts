import { Prisma, TokenTransactionSource } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { getBusinessTokenCost } from '../config/business-token-features.js';
import type { BusinessTokenFeature } from '../config/business-token-features.js';
import { isTokenExemptUser, type TokenExemptUser } from '../utils/token-exempt.js';

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
  referenceId: string;
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
      referenceId: existing.referenceId ?? referenceId,
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
        referenceId,
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
            referenceId: existing.referenceId ?? referenceId,
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

export interface ExemptAwareConsumeResult extends ConsumeBusinessTokensResult {
  /** true when the user is admin-exempt and no debit occurred. */
  exempt: boolean;
}

/**
 * Consumption wrapper honouring the admin exemption: admins are never debited
 * and always receive an `exempt: true` result (never an idempotent replay).
 */
export async function consumeBusinessTokensOrExempt(
  user: TokenExemptUser | null | undefined,
  input: ConsumeBusinessTokensInput,
): Promise<ExemptAwareConsumeResult> {
  if (isTokenExemptUser(user)) {
    return {
      transactionId: '',
      referenceId: '',
      walletId: '',
      feature: input.feature,
      source: input.source,
      tokensConsumed: 0,
      walletBalance: 0,
      idempotentReplay: false,
      exempt: true,
    };
  }
  const result = await consumeBusinessTokens(input);
  return { ...result, exempt: false };
}

/**
 * Refund wrapper honouring the admin exemption: admin-exempt users have no
 * consume record to reverse, so this is a no-op for them.
 */
export async function reverseBusinessTokensOrExempt(
  user: TokenExemptUser | null | undefined,
  input: ReverseBusinessTokensInput,
): Promise<void> {
  if (isTokenExemptUser(user)) return;
  await reverseBusinessTokens(input);
}

export interface ReverseBusinessTokensInput {
  userId: string;
  feature: BusinessTokenFeature;
  source: BusinessConsumptionSource;
  businessRequestId: string;
}

export interface ReverseBusinessTokensResult {
  transactionId: string;
  walletId: string;
  feature: BusinessTokenFeature;
  source: BusinessConsumptionSource;
  tokensRefunded: number;
  walletBalance: number;
  idempotentReplay: boolean;
}

export async function reverseBusinessTokens(
  input: ReverseBusinessTokensInput,
): Promise<ReverseBusinessTokensResult> {
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

  const consumeReferenceId = `${userId}:${input.feature}:${businessRequestId}`;
  const refundReferenceId = `${consumeReferenceId}:refund`;

  const consumed = await prisma.tokenTransaction.findUnique({
    where: {
      source_referenceId: {
        source: input.source,
        referenceId: consumeReferenceId,
      },
    },
  });

  if (!consumed || consumed.type !== 'CONSUME' || consumed.userId !== userId) {
    throw new AppError(409, 'Token refund conflict');
  }

  const tokensToRefund = consumed.tokens;

  const existingRefund = await prisma.tokenTransaction.findUnique({
    where: {
      source_referenceId: {
        source: input.source,
        referenceId: refundReferenceId,
      },
    },
  });

  if (existingRefund) {
    if (existingRefund.type !== 'REFUND' || existingRefund.userId !== userId) {
      throw new AppError(409, 'Token refund conflict');
    }

    const wallet = await prisma.tokenWallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      throw new AppError(409, 'Token refund conflict');
    }

    return {
      transactionId: existingRefund.id,
      walletId: existingRefund.walletId,
      feature: input.feature,
      source: input.source,
      tokensRefunded: existingRefund.tokens,
      walletBalance: wallet.tokenBalance,
      idempotentReplay: true,
    };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.tokenWallet.updateMany({
        where: { userId },
        data: {
          tokenBalance: { increment: tokensToRefund },
        },
      });

      if (updated.count === 0) {
        throw new AppError(409, 'Token refund conflict');
      }

      const updatedWallet = await tx.tokenWallet.findUnique({
        where: { userId },
      });

      if (!updatedWallet) {
        throw new AppError(409, 'Token refund conflict');
      }

      const transaction = await tx.tokenTransaction.create({
        data: {
          walletId: updatedWallet.id,
          userId,
          type: 'REFUND',
          tokens: tokensToRefund,
          source: input.source,
          paymentId: null,
          referenceId: refundReferenceId,
          metadata: {
            feature: input.feature,
            businessRequestId,
            refundedTransactionId: consumed.id,
          },
        },
      });

      return {
        transactionId: transaction.id,
        walletId: transaction.walletId,
        feature: input.feature,
        source: input.source,
        tokensRefunded: transaction.tokens,
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
            referenceId: refundReferenceId,
          },
        },
      });

      if (existing && existing.type === 'REFUND' && existing.userId === userId) {
        const wallet = await prisma.tokenWallet.findUnique({
          where: { userId },
        });

        if (wallet) {
          return {
            transactionId: existing.id,
            walletId: existing.walletId,
            feature: input.feature,
            source: input.source,
            tokensRefunded: existing.tokens,
            walletBalance: wallet.tokenBalance,
            idempotentReplay: true,
          };
        }
      }
    }
    throw err;
  }
}
