import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';

export interface PublicTokenPackage {
  id: number;
  name: string;
  description: string | null;
  code: string;
  price: string;
  currency: string;
  tokens: number;
  sortOrder: number;
}

type SelectedTokenPackage = Prisma.TokenPackageGetPayload<{
  select: {
    id: true;
    name: true;
    description: true;
    code: true;
    price: true;
    currency: true;
    tokens: true;
    sortOrder: true;
  };
}>;

/**
 * Retrieves all active token packages ordered by sortOrder ascending,
 * then id ascending as a stable secondary sort.
 * Returns only safe, public-facing package fields with Decimal price serialized as string.
 */
export async function getActiveTokenPackages(): Promise<PublicTokenPackage[]> {
  const packages = await prisma.tokenPackage.findMany({
    where: {
      isActive: true,
    },
    orderBy: [
      { sortOrder: 'asc' },
      { id: 'asc' },
    ],
    select: {
      id: true,
      name: true,
      description: true,
      code: true,
      price: true,
      currency: true,
      tokens: true,
      sortOrder: true,
    },
  });

  return packages.map((pkg: SelectedTokenPackage) => ({
    id: pkg.id,
    name: pkg.name,
    description: pkg.description,
    code: pkg.code,
    price: pkg.price.toString(),
    currency: pkg.currency,
    tokens: pkg.tokens,
    sortOrder: pkg.sortOrder,
  }));
}
