import { prisma } from '../config/prisma.js';

type StatusKey = 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'REFUNDED';

const VALID_STATUSES = new Set<StatusKey>(['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED']);

interface PaymentRow {
  id: string;
  user: { id: string; displayName: string; email: string } | null;
  packageNameSnapshot: string;
  tokenPackageId: number;
  amount: { toNumber(): number };
  currency: string;
  status: string;
  provider: string;
  providerTransactionId: string | null;
  failureReason: string | null;
  tokensSnapshot: number;
  createdAt: Date;
  paidAt: Date | null;
}

export async function getPaymentsList(params: {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
}) {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));
  const where: Record<string, unknown> = {};

  if (params.status && VALID_STATUSES.has(params.status as StatusKey)) {
    where.status = params.status;
  }
  if (params.search) {
    where.OR = [
      { user: { displayName: { contains: params.search, mode: 'insensitive' } } },
      { user: { email: { contains: params.search, mode: 'insensitive' } } },
    ];
  }

  const [total, rawItems] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        user: { select: { id: true, displayName: true, email: true } },
      },
    }),
  ]);

  const items = rawItems as unknown as PaymentRow[];

  return {
    items: items.map((p) => ({
      id: p.id,
      user: p.user,
      packageName: p.packageNameSnapshot,
      packageId: p.tokenPackageId,
      amount: p.amount.toNumber(),
      currency: p.currency,
      status: p.status,
      provider: p.provider,
      providerTransactionId: p.providerTransactionId,
      failureReason: p.failureReason,
      tokens: p.tokensSnapshot,
      createdAt: p.createdAt,
      paidAt: p.paidAt,
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getPaymentsSummary() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [revenueAgg, revenueToday, counts, perPackage, topUsers, monthly] = await Promise.all([
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: { status: 'COMPLETED' },
    }),
    prisma.payment.aggregate({
      _sum: { amount: true },
      where: { status: 'COMPLETED', paidAt: { gte: todayStart } },
    }),
    prisma.payment.groupBy({ by: ['status'], _count: true }),
    prisma.payment.groupBy({
      by: ['tokenPackageId'],
      _count: true,
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      where: { status: 'COMPLETED' },
    }),
    prisma.payment.groupBy({
      by: ['userId'],
      _count: true,
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      where: { status: 'COMPLETED' },
      take: 10,
    }),
    prisma.payment.findMany({
      where: { status: 'COMPLETED', paidAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
      select: { paidAt: true, amount: true },
      orderBy: { paidAt: 'asc' },
    }),
  ]);

  const perPackageTyped = perPackage as unknown as Array<{
    tokenPackageId: number;
    _count: number;
    _sum: { amount: { toNumber(): number } | null };
  }>;
  const topUsersTyped = topUsers as unknown as Array<{
    userId: string;
    _count: number;
    _sum: { amount: { toNumber(): number } | null };
  }>;

  const [packages, topUsersMeta] = await Promise.all([
    prisma.tokenPackage.findMany({
      where: { id: { in: perPackageTyped.map((p) => p.tokenPackageId) } },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { id: { in: topUsersTyped.map((u) => u.userId) } },
      select: { id: true, displayName: true, email: true },
    }),
  ]);
  const pkgMap = new Map(packages.map((p: { id: number; name: string }) => [p.id, p.name]));
  const userMap = new Map(topUsersMeta.map((u: { id: string; displayName: string | null; email: string | null }) => [u.id, u]));

  const statusCounts = Object.fromEntries(counts.map((c: { status: string; _count: number }) => [c.status, c._count]));

  const byMonth: Record<string, number> = {};
  for (const p of monthly as unknown as Array<{ paidAt: Date | null; amount: { toNumber(): number } }>) {
    const key = p.paidAt
      ? `${p.paidAt.getFullYear()}-${String(p.paidAt.getMonth() + 1).padStart(2, '0')}`
      : 'unknown';
    byMonth[key] = (byMonth[key] ?? 0) + p.amount.toNumber();
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;

  return {
    revenue: round2(Number(revenueAgg._sum.amount ?? 0)),
    revenueToday: round2(Number(revenueToday._sum.amount ?? 0)),
    payments: {
      completed: statusCounts.COMPLETED ?? 0,
      pending: statusCounts.PENDING ?? 0,
      failed: statusCounts.FAILED ?? 0,
      refunded: statusCounts.REFUNDED ?? 0,
      cancelled: statusCounts.CANCELLED ?? 0,
    },
    perPackage: perPackageTyped.map((p) => ({
      packageId: p.tokenPackageId,
      name: pkgMap.get(p.tokenPackageId) ?? 'Unknown',
      orders: p._count,
      revenue: round2(Number(p._sum.amount ?? 0)),
    })),
    topUsers: topUsersTyped.map((u) => ({
      user: userMap.get(u.userId) ?? { id: u.userId, displayName: 'Unknown', email: null },
      orders: u._count,
      revenue: round2(Number(u._sum.amount ?? 0)),
    })),
    monthlyRevenue: Object.entries(byMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, amount]) => ({ month, amount: round2(amount) })),
  };
}
