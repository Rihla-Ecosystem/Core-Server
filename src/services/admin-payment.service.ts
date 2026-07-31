import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import type { AdminPaymentListQuery, AdminPaymentIdParams } from '../schemas/admin-payment.schema.js';

export interface AdminPaymentUser {
  id: string;
  displayName: string | null;
  email: string;
}

export interface AdminPaymentTokenPackage {
  id: number;
  name: string;
  code: string;
}

export interface AdminPaymentListItem {
  id: string;
  userId: string;
  tokenPackageId: number;
  amount: string;
  currency: string;
  status: string;
  packageNameSnapshot: string;
  tokensSnapshot: number;
  priceSnapshot: string;
  currencySnapshot: string;
  provider: string;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: AdminPaymentUser;
  tokenPackage: AdminPaymentTokenPackage;
}

export interface AdminPaymentDetails extends AdminPaymentListItem {
  providerIntentionId: string | null;
  providerOrderId: string | null;
  providerTransactionId: string | null;
  failureReason: string | null;
}

export interface PaginatedAdminPaymentsResult {
  items: AdminPaymentListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

const paymentListSelect = {
  id: true,
  userId: true,
  tokenPackageId: true,
  amount: true,
  currency: true,
  status: true,
  packageNameSnapshot: true,
  tokensSnapshot: true,
  priceSnapshot: true,
  currencySnapshot: true,
  provider: true,
  paidAt: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      displayName: true,
      email: true,
    },
  },
  tokenPackage: {
    select: {
      id: true,
      name: true,
      code: true,
    },
  },
} as const;

const paymentDetailsSelect = {
  id: true,
  userId: true,
  tokenPackageId: true,
  amount: true,
  currency: true,
  status: true,
  packageNameSnapshot: true,
  tokensSnapshot: true,
  priceSnapshot: true,
  currencySnapshot: true,
  provider: true,
  providerIntentionId: true,
  providerOrderId: true,
  providerTransactionId: true,
  failureReason: true,
  paidAt: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      displayName: true,
      email: true,
    },
  },
  tokenPackage: {
    select: {
      id: true,
      name: true,
      code: true,
    },
  },
} as const;

type PaymentListRaw = Prisma.PaymentGetPayload<{
  select: typeof paymentListSelect;
}>;

type PaymentDetailsRaw = Prisma.PaymentGetPayload<{
  select: typeof paymentDetailsSelect;
}>;

function toAdminPaymentListItem(payment: PaymentListRaw): AdminPaymentListItem {
  return {
    ...payment,
    amount: payment.amount.toString(),
    priceSnapshot: payment.priceSnapshot.toString(),
    paidAt: payment.paidAt?.toISOString() ?? null,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}

function toAdminPaymentDetails(payment: PaymentDetailsRaw): AdminPaymentDetails {
  return {
    ...payment,
    amount: payment.amount.toString(),
    priceSnapshot: payment.priceSnapshot.toString(),
    paidAt: payment.paidAt?.toISOString() ?? null,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}

function buildWhere(query: AdminPaymentListQuery): Prisma.PaymentWhereInput {
  const where: Prisma.PaymentWhereInput = {};

  if (query.status !== undefined) {
    where.status = query.status;
  }

  if (query.currency !== undefined) {
    where.currency = query.currency;
  }

  if (query.tokenPackageId !== undefined) {
    where.tokenPackageId = query.tokenPackageId;
  }

  if (query.userId !== undefined) {
    where.userId = query.userId;
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

function buildOrderBy(query: AdminPaymentListQuery): Prisma.PaymentOrderByWithRelationInput[] {
  const field = query.sortBy;
  const direction = query.sortOrder;

  return [{ [field]: direction }, { id: direction }];
}

export async function list(query: AdminPaymentListQuery): Promise<PaginatedAdminPaymentsResult> {
  const { page, limit } = query;
  const skip = (page - 1) * limit;

  const where = buildWhere(query);
  const orderBy = buildOrderBy(query);

  const [total, rawItems] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      select: paymentListSelect,
    }),
  ]);

  const items = rawItems.map(toAdminPaymentListItem);

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

export async function getById(params: AdminPaymentIdParams): Promise<AdminPaymentDetails> {
  const { id } = params;

  const payment = await prisma.payment.findUnique({
    where: { id },
    select: paymentDetailsSelect,
  });

  if (!payment) {
    throw new AppError(404, 'Payment not found');
  }

  return toAdminPaymentDetails(payment);
}
