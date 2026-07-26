import { prisma } from '../config/prisma.js';

export interface WalletBalanceResult {
  balance: number;
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
      status: true,
    },
  });

  if (!wallet) {
    return {
      balance: 0,
      status: 'ACTIVE',
    };
  }

  return {
    balance: wallet.tokenBalance,
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
