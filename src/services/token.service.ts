import { prisma } from '../config/prisma.js';

export interface WalletBalanceResult {
  balance: number;
  availableBalance: number;
  reservedBalance: number;
  totalBalance: number;
  status: string;
}

export interface PublicTokenTransaction {
  id: string;
  type: string;
  source: string;
  tokens: number;
  referenceId: string | null;
  paymentId: string | null;
  createdAt: Date;
}

export interface PaginatedTransactionsResult {
  items: PublicTokenTransaction[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface TokenSummaryResult {
  remainingTokens: number;
  purchasedTokens: number;
  consumedTokens: number;
  refundedTokens: number;
  netConsumedTokens: number;
  bonusTokens: number;
  adjustmentCredits: number;
  adjustmentDebits: number;
  netAdjustments: number;
}

/**
 * Retrieves the Token Wallet balance and status for a given user.
 * If the user has no TokenWallet record, returns a safe default balance (0)
 * and status ("ACTIVE") without modifying or inserting any database records.
 *
 * @param userId - Verified user UUID from JWT
 */
export async function getTokenWalletBalance(userId: string): Promise<WalletBalanceResult> {
  const wallet = await prisma.tokenWallet.findUnique({
    where: {
      userId,
    },
    select: {
      tokenBalance: true,
      reservedBalance: true,
      status: true,
    },
  });

  if (!wallet) {
    return {
      balance: 0,
      availableBalance: 0,
      reservedBalance: 0,
      totalBalance: 0,
      status: 'ACTIVE',
    };
  }

  const availableBalance = wallet.tokenBalance;
  const reservedBalance = wallet.reservedBalance;

  return {
    balance: availableBalance,
    availableBalance,
    reservedBalance,
    totalBalance: availableBalance + reservedBalance,
    status: wallet.status,
  };
}

/**
 * Retrieves paginated Token Transactions for a given user, ordered by createdAt descending
 * with id descending as a stable secondary sort.
 *
 * @param userId - Verified user UUID from JWT
 * @param page - Positive integer page number
 * @param limit - Positive integer item limit (max 100)
 */
export async function getTokenTransactions(
  userId: string,
  page: number,
  limit: number,
): Promise<PaginatedTransactionsResult> {
  const skip = (page - 1) * limit;

  const [total, transactions] = await Promise.all([
    prisma.tokenTransaction.count({
      where: {
        userId,
      },
    }),
    prisma.tokenTransaction.findMany({
      where: {
        userId,
      },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      skip,
      take: limit,
      select: {
        id: true,
        type: true,
        source: true,
        tokens: true,
        referenceId: true,
        paymentId: true,
        createdAt: true,
      },
    }),
  ]);

  const totalPages = total > 0 ? Math.ceil(total / limit) : 0;

  return {
    items: transactions,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  };
}

/**
 * Retrieves token usage summary metrics for a given user.
 * Read-only database aggregations.
 *
 * @param userId - Verified user UUID from JWT
 */
export async function getTokenSummary(userId: string): Promise<TokenSummaryResult> {
  const [wallet, grouped, adjustments] = await Promise.all([
    prisma.tokenWallet.findUnique({
      where: { userId },
      select: { tokenBalance: true },
    }),
    prisma.tokenTransaction.groupBy({
      by: ['type', 'source'],
      where: { userId },
      _sum: { tokens: true },
    }),
    prisma.tokenTransaction.findMany({
      where: {
        userId,
        type: 'ADJUSTMENT',
      },
      select: {
        tokens: true,
        metadata: true,
      },
    }),
  ]);

  const remainingTokens = wallet ? wallet.tokenBalance : 0;

  let purchasedTokens = 0;
  let consumedTokens = 0;
  let refundedTokens = 0;
  let bonusTokens = 0;
  let adjustmentCredits = 0;
  let adjustmentDebits = 0;

  for (const item of grouped) {
    const amount = item._sum.tokens ?? 0;
    if (item.type === 'GRANT' && item.source === 'PURCHASE') {
      purchasedTokens += amount;
    } else if (item.type === 'CONSUME') {
      consumedTokens += amount;
    } else if (item.type === 'REFUND') {
      refundedTokens += amount;
    } else if (item.type === 'BONUS') {
      bonusTokens += amount;
    }
  }

  for (const adjustment of adjustments) {
    const operation =
      adjustment.metadata !== null &&
      typeof adjustment.metadata === 'object' &&
      !Array.isArray(adjustment.metadata) &&
      typeof (adjustment.metadata as { operation?: unknown }).operation === 'string'
        ? (adjustment.metadata as { operation: string }).operation
        : undefined;

    if (operation === 'CREDIT') {
      adjustmentCredits += adjustment.tokens;
    } else if (operation === 'DEBIT') {
      adjustmentDebits += adjustment.tokens;
    }
  }

  const netConsumedTokens = consumedTokens - refundedTokens;
  const netAdjustments = adjustmentCredits - adjustmentDebits;

  return {
    remainingTokens,
    purchasedTokens,
    consumedTokens,
    refundedTokens,
    netConsumedTokens,
    bonusTokens,
    adjustmentCredits,
    adjustmentDebits,
    netAdjustments,
  };
}

