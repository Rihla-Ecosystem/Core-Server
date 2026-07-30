import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import type { AdminTokenPackageListQuery } from '../schemas/admin-token-package.schema.js';

export interface AdminTokenPackage {
  id: number;
  name: string;
  description: string | null;
  code: string;
  price: string;
  currency: string;
  tokens: number;
  sortOrder: number;
  isActive: boolean;
  paymentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginatedAdminTokenPackagesResult {
  items: AdminTokenPackage[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

const adminTokenPackageSelectFields = {
  id: true,
  name: true,
  description: true,
  code: true,
  price: true,
  currency: true,
  tokens: true,
  sortOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: { payments: true },
  },
} as const;

type AdminTokenPackageRaw = Prisma.TokenPackageGetPayload<{
  select: typeof adminTokenPackageSelectFields;
}>;

function toAdminTokenPackage(pkg: AdminTokenPackageRaw): AdminTokenPackage {
  return {
    id: pkg.id,
    name: pkg.name,
    description: pkg.description,
    code: pkg.code,
    price: pkg.price.toString(),
    currency: pkg.currency,
    tokens: pkg.tokens,
    sortOrder: pkg.sortOrder,
    isActive: pkg.isActive,
    paymentCount: pkg._count.payments,
    createdAt: pkg.createdAt,
    updatedAt: pkg.updatedAt,
  };
}

function buildWhere(query: AdminTokenPackageListQuery): Prisma.TokenPackageWhereInput {
  const where: Prisma.TokenPackageWhereInput = {};

  if (query.search !== undefined) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { code: { contains: query.search, mode: 'insensitive' } },
      { description: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  if (query.isActive !== undefined) {
    where.isActive = query.isActive;
  }

  if (query.currency !== undefined) {
    where.currency = query.currency;
  }

  return where;
}

function buildOrderBy(
  sortBy: AdminTokenPackageListQuery['sortBy'],
  sortOrder: AdminTokenPackageListQuery['sortOrder'],
): Prisma.TokenPackageOrderByWithRelationInput[] {
  switch (sortBy) {
    case 'name':
      return [{ name: sortOrder }, { id: 'asc' }];
    case 'price':
      return [{ price: sortOrder }, { id: 'asc' }];
    case 'tokens':
      return [{ tokens: sortOrder }, { id: 'asc' }];
    case 'sortOrder':
      return [{ sortOrder: sortOrder }, { createdAt: 'desc' }, { id: 'asc' }];
    case 'createdAt':
      return [{ createdAt: sortOrder }, { id: 'asc' }];
    case 'updatedAt':
      return [{ updatedAt: sortOrder }, { id: 'asc' }];
  }
}

export async function getAdminTokenPackages(
  query: AdminTokenPackageListQuery,
): Promise<PaginatedAdminTokenPackagesResult> {
  const { page, limit } = query;
  const skip = (page - 1) * limit;

  const where = buildWhere(query);
  const orderBy = buildOrderBy(query.sortBy, query.sortOrder);

  const [total, packages] = await Promise.all([
    prisma.tokenPackage.count({ where }),
    prisma.tokenPackage.findMany({
      where,
      orderBy,
      skip,
      take: limit,
      select: adminTokenPackageSelectFields,
    }),
  ]);

  const totalPages = total > 0 ? Math.ceil(total / limit) : 0;

  return {
    items: packages.map(toAdminTokenPackage),
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  };
}

export async function getAdminTokenPackageById(
  id: number,
): Promise<AdminTokenPackage> {
  const pkg = await prisma.tokenPackage.findUnique({
    where: { id },
    select: adminTokenPackageSelectFields,
  });

  if (!pkg) {
    throw new AppError(404, 'Token package not found');
  }

  return toAdminTokenPackage(pkg);
}
