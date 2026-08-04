import { prisma } from '../../src/config/prisma.js';
import type { Role } from '@prisma/client';

export const ADMIN_ROLE_NAME = 'admin';
export const USER_ROLE_NAME = 'user';

/**
 * Upsert a role by its unique `name` (the schema constraint is on `Role.name`).
 * Returns the persisted role record so callers can bind `roleId` to the actual
 * auto-increment `id` instead of relying on a fixed/hardcoded role id.
 */
export async function ensureTestRole(name: string): Promise<Role> {
  return prisma.role.upsert({
    where: { name },
    update: {},
    create: { name },
  });
}

/**
 * Ensures the canonical application `admin` role exists and returns it.
 */
export function ensureAdminRole(): Promise<Role> {
  return ensureTestRole(ADMIN_ROLE_NAME);
}

/**
 * Ensures the canonical regular-user role exists and returns it. Callers must
 * use the returned role's `id` (e.g. `roleId: role.id`) when creating User
 * fixtures rather than relying on any fixed role id.
 */
export function ensureUserRole(): Promise<Role> {
  return ensureTestRole(USER_ROLE_NAME);
}