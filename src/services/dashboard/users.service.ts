import { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { AppError } from '../../middleware/errorHandler.js';

export type DashboardOrder = 'asc' | 'desc';
export type DashboardSortField = 'createdAt' | 'lastLoginAt' | 'displayName' | 'email' | 'xp' | 'level' | 'id' | 'walletBalance';
export type DashboardExportFormat = 'csv' | 'excel';

export const EXPORT_MAX_ROWS = 1000;

export interface DashboardListFilters {
  page: number;
  limit: number;
  search?: string;
  sort: DashboardSortField;
  order: DashboardOrder;
  role?: string;
  gender?: 'MALE' | 'FEMALE';
  nationality?: string;
  language?: string;
  active?: boolean;
  verified?: boolean;
  banned?: boolean;
  deleted?: boolean;
  walletStatus?: 'ACTIVE' | 'INACTIVE' | 'BLOCKED';
  createdFrom?: Date;
  createdTo?: Date;
  lastLoginFrom?: Date;
  lastLoginTo?: Date;
  minXP?: number;
  maxXP?: number;
  minLevel?: number;
  maxLevel?: number;
  hasWallet?: boolean;
  hasPayments?: boolean;
  hasTrips?: boolean;
  hasBadges?: boolean;
  hasJourney?: boolean;
}

export interface DashboardUserSummary {
  id: string;
  displayName: string;
  email: string;
  avatar: string | null;
  role: string;
  walletBalance: number;
  walletStatus: string | null;
  xp: number;
  level: number;
  active: boolean;
  verified: boolean;
  banned: boolean;
  deleted: boolean;
  createdAt: Date;
  lastLogin: Date | null;
  paymentsCount: number;
  tripsCount: number;
  badgesCount: number;
  conversationCount: number;
}

export interface DashboardPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface DashboardUsersStatistics {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  verifiedUsers: number;
  unverifiedUsers: number;
  bannedUsers: number;
  deletedUsers: number;
  walletUsers: number;
  usersWithoutWallet: number;
  averageXp: number;
  averageLevel: number;
  averageWalletBalance: number;
  totalWalletTokens: number;
  totalPayments: number;
  totalTrips: number;
  totalBadges: number;
  totalConversations: number;
}

export interface DashboardUsersListResult {
  users: DashboardUserSummary[];
  pagination: DashboardPagination;
  statistics: DashboardUsersStatistics;
}

export interface DashboardUserProfileResult {
  basicInformation: Record<string, unknown>;
  role: Record<string, unknown> | null;
  wallet: Record<string, unknown> | null;
  currentTokens: number;
  xp: number;
  level: number;
  paymentHistory: unknown[];
  paymentStatistics: Record<string, unknown>;
  tokenTransactions: unknown[];
  journeyProgress: Record<string, unknown>;
  journeySteps: unknown[];
  trips: unknown[];
  tripCount: number;
  conversationCount: number;
  messagesCount: number;
  badges: unknown[];
  preferences: unknown[];
  feedback: unknown[];
  interactionSummary: unknown[];
  refreshTokens: unknown[];
  passwordResetTokens: unknown[];
  verificationTokens: unknown[];
  auditLogs: unknown[];
  createdAt: Date;
  updatedAt: Date;
  lastLogin: Date | null;
  accountAgeDays: number;
}

export interface DashboardUserStatisticsResult {
  totalPayments: number;
  completedPayments: number;
  pendingPayments: number;
  failedPayments: number;
  cancelledPayments: number;
  refundedPayments: number;
  revenue: number;
  walletBalance: number;
  totalTokensEarned: number;
  totalTokensSpent: number;
  netTokens: number;
  xp: number;
  level: number;
  badges: number;
  trips: number;
  journeyProgressPercent: number;
  completedJourneys: number;
  conversationCount: number;
  messagesCount: number;
  feedbackCount: number;
  preferencesCount: number;
  interactionCount: number;
  accountAgeDays: number;
  daysSinceLastLogin: number | null;
}

export interface DashboardStatisticsResult {
  totalUsers: number;
  newUsersToday: number;
  newUsersThisWeek: number;
  newUsersThisMonth: number;
  activeUsers: number;
  inactiveUsers: number;
  verifiedUsers: number;
  unverifiedUsers: number;
  bannedUsers: number;
  deletedUsers: number;
  male: number;
  female: number;
  walletUsers: number;
  usersWithoutWallet: number;
  averageXp: number;
  averageLevel: number;
  averageWalletBalance: number;
  totalWalletTokens: number;
  topCountries: Array<{ nationality: string; count: number }>;
  topLanguages: Array<{ language: string; count: number }>;
  topRoles: Array<{ role: string; count: number }>;
  topTravelers: Array<{ id: string; displayName: string; email: string; avatar: string | null; tripsCount: number }>;
  topXpUsers: Array<{ id: string; displayName: string; email: string; avatar: string | null; xp: number; level: number }>;
  topTokenHolders: Array<{ id: string; displayName: string; email: string; avatar: string | null; walletBalance: number }>;
  topPayingUsers: Array<{ id: string; displayName: string; email: string; avatar: string | null; revenue: number }>;
  topConversations: Array<{ id: string; displayName: string; email: string; avatar: string | null; conversationsCount: number }>;
  revenueToday: number;
  revenueThisWeek: number;
  revenueThisMonth: number;
  revenueTotal: number;
  completedPayments: number;
  pendingPayments: number;
  failedPayments: number;
  cancelledPayments: number;
  refundedPayments: number;
}

export interface DashboardActivityItem {
  id: string;
  title: string;
  subtitle: string | null;
  timestamp: Date;
  type: string;
  userId: string;
  avatar: string | null;
}

export interface DashboardRecentActivityResult {
  newRegistrations: DashboardActivityItem[];
  recentLogins: DashboardActivityItem[];
  recentPayments: Array<Record<string, unknown>>;
  recentTrips: Array<Record<string, unknown>>;
  recentConversations: Array<Record<string, unknown>>;
  recentBadgeUnlocks: Array<Record<string, unknown>>;
  recentJourneyProgress: Array<Record<string, unknown>>;
}

export interface DashboardGrowthAnalyticsResult {
  daily: Array<{ period: string; users: number }>;
  weekly: Array<{ period: string; users: number }>;
  monthly: Array<{ period: string; users: number }>;
  yearly: Array<{ period: string; users: number }>;
}

export interface DashboardRevenueAnalyticsResult {
  revenueByDay: Array<{ period: string; revenue: number }>;
  revenueByWeek: Array<{ period: string; revenue: number }>;
  revenueByMonth: Array<{ period: string; revenue: number }>;
  revenueByYear: Array<{ period: string; revenue: number }>;
}

export interface DashboardRetentionAnalyticsResult {
  activeToday: number;
  active7Days: number;
  active30Days: number;
  inactiveUsers: number;
  dormantUsers: number;
}

export interface DashboardTopUsersResult {
  topXp: Array<Record<string, unknown>>;
  topWallet: Array<Record<string, unknown>>;
  topRevenue: Array<Record<string, unknown>>;
  topTravelers: Array<Record<string, unknown>>;
  topConversations: Array<Record<string, unknown>>;
  topActiveUsers: Array<Record<string, unknown>>;
}

export interface DashboardAdminTimelineResult {
  deleteActions: Array<Record<string, unknown>>;
  restoreActions: Array<Record<string, unknown>>;
  banActions: Array<Record<string, unknown>>;
  roleChanges: Array<Record<string, unknown>>;
  exports: Array<Record<string, unknown>>;
  activations: Array<Record<string, unknown>>;
  deactivations: Array<Record<string, unknown>>;
}

const dashboardAuditActions = new Set([
  'user_deleted',
  'user_restored',
  'user_banned',
  'user_unbanned',
  'user_activated',
  'user_deactivated',
  'email_verified',
  'role_changed',
  'wallet_reset',
  'xp_reset',
  'users_bulk_deleted',
  'users_bulk_restored',
  'users_bulk_banned',
  'users_bulk_unbanned',
  'users_bulk_activated',
  'users_bulk_deactivated',
  'users_bulk_verified',
  'users_bulk_role_changed',
  'users_exported',
  'users_bulk_exported',
]);

const userSummarySelect = {
  id: true,
  displayName: true,
  email: true,
  avatarUrl: true,
  xp: true,
  level: true,
  isActive: true,
  isEmailVerified: true,
  isBanned: true,
  isDeleted: true,
  createdAt: true,
  lastLoginAt: true,
  role: {
    select: {
      name: true,
    },
  },
  tokenWallet: {
    select: {
      tokenBalance: true,
      status: true,
    },
  },
  _count: {
    select: {
      payments: true,
      tripHistories: true,
      userBadges: true,
      conversations: true,
    },
  },
} satisfies Prisma.UserSelect;

type UserSummaryRow = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
  xp: number;
  level: number;
  isActive: boolean;
  isEmailVerified: boolean;
  isBanned: boolean;
  isDeleted: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
  role: { name: string };
  tokenWallet: { tokenBalance: number; status: string } | null;
  _count: { payments: number; tripHistories: number; userBadges: number; conversations: number };
};

type BasicUserRow = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  gender: 'MALE' | 'FEMALE';
  nationality: string;
  language: Prisma.JsonValue;
  budgetLevel: string | null;
  arrivalDate: Date | null;
  departureDate: Date | null;
  travelStyle: string | null;
  interests: Prisma.JsonValue | null;
  accommodationType: string | null;
  isEmailVerified: boolean;
  isActive: boolean;
  isBanned: boolean;
  isDeleted: boolean;
  roleId: number;
  xp: number;
  level: number;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  role: { id: number; name: string; permissions: Prisma.JsonValue };
};

function logDashboardAction(action: string, payload: Record<string, unknown>): void {
  console.info(`[dashboard/users] ${action}`, payload);
}

function sanitizeAuditFilters(filters: DashboardListFilters & { format: DashboardExportFormat }): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null) {
      sanitized[key] = value instanceof Date ? value.toISOString() : value;
    }
  }
  return sanitized;
}

function decimalToNumber(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return value instanceof Prisma.Decimal ? value.toNumber() : value;
}

function normalizeDate(input?: string): Date | undefined {
  if (!input) {
    return undefined;
  }

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new AppError(400, 'Invalid date value');
  }

  return date;
}

function toStartOfDay(date: Date): Date {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  return clone;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function addMonths(date: Date, months: number): Date {
  const clone = new Date(date);
  clone.setMonth(clone.getMonth() + months);
  return clone;
}

function addYears(date: Date, years: number): Date {
  const clone = new Date(date);
  clone.setFullYear(clone.getFullYear() + years);
  return clone;
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function formatYear(date: Date): string {
  return String(date.getUTCFullYear());
}

function formatWeek(date: Date): string {
  const start = getWeekStart(date);
  return `${start.getUTCFullYear()}-W${String(getIsoWeekNumber(start)).padStart(2, '0')}`;
}

function getWeekStart(date: Date): Date {
  const clone = toStartOfDay(date);
  const day = clone.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  clone.setUTCDate(clone.getUTCDate() + diff);
  return clone;
}

function getIsoWeekNumber(date: Date): number {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
}

function daysBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86400000));
}

function numberFromUnknown(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return 0;
}

function asStringArray(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function flattenLanguages(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => (typeof entry === 'string' ? [entry] : []));
}

function buildUserWhere(filters: Omit<DashboardListFilters, 'page' | 'limit' | 'sort' | 'order'>): Prisma.UserWhereInput {
  const and: Prisma.UserWhereInput[] = [];

  if (filters.search) {
    const search = filters.search.trim();
    if (search.length > 0) {
      and.push({
        OR: [
          { id: search },
          { displayName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      });
    }
  }

  if (filters.role) {
    and.push({ role: { is: { name: filters.role } } });
  }

  if (filters.gender) {
    and.push({ gender: filters.gender });
  }

  if (filters.nationality) {
    and.push({ nationality: { equals: filters.nationality, mode: 'insensitive' } });
  }

  if (filters.language) {
    and.push({ language: { array_contains: [filters.language] } as Prisma.JsonFilter });
  }

  if (filters.active !== undefined) {
    and.push({ isActive: filters.active });
  }

  if (filters.verified !== undefined) {
    and.push({ isEmailVerified: filters.verified });
  }

  if (filters.banned !== undefined) {
    and.push({ isBanned: filters.banned });
  }

  if (filters.deleted !== undefined) {
    and.push({ isDeleted: filters.deleted });
  }

  if (filters.walletStatus) {
    and.push({ tokenWallet: { is: { status: filters.walletStatus } } });
  }

  if (filters.createdFrom || filters.createdTo) {
    and.push({
      createdAt: {
        ...(filters.createdFrom ? { gte: filters.createdFrom } : {}),
        ...(filters.createdTo ? { lte: filters.createdTo } : {}),
      },
    });
  }

  if (filters.lastLoginFrom || filters.lastLoginTo) {
    and.push({
      lastLoginAt: {
        ...(filters.lastLoginFrom ? { gte: filters.lastLoginFrom } : {}),
        ...(filters.lastLoginTo ? { lte: filters.lastLoginTo } : {}),
      },
    });
  }

  if (filters.minXP !== undefined || filters.maxXP !== undefined) {
    and.push({
      xp: {
        ...(filters.minXP !== undefined ? { gte: filters.minXP } : {}),
        ...(filters.maxXP !== undefined ? { lte: filters.maxXP } : {}),
      },
    });
  }

  if (filters.minLevel !== undefined || filters.maxLevel !== undefined) {
    and.push({
      level: {
        ...(filters.minLevel !== undefined ? { gte: filters.minLevel } : {}),
        ...(filters.maxLevel !== undefined ? { lte: filters.maxLevel } : {}),
      },
    });
  }

  if (filters.hasWallet !== undefined) {
    and.push(filters.hasWallet ? { tokenWallet: { isNot: null } } : { tokenWallet: { is: null } });
  }

  if (filters.hasPayments !== undefined) {
    and.push(filters.hasPayments ? { payments: { some: {} } } : { payments: { none: {} } });
  }

  if (filters.hasTrips !== undefined) {
    and.push(filters.hasTrips ? { tripHistories: { some: {} } } : { tripHistories: { none: {} } });
  }

  if (filters.hasBadges !== undefined) {
    and.push(filters.hasBadges ? { userBadges: { some: {} } } : { userBadges: { none: {} } });
  }

  if (filters.hasJourney !== undefined) {
    and.push(filters.hasJourney ? { journeyProgress: { some: {} } } : { journeyProgress: { none: {} } });
  }

  return and.length > 0 ? { AND: and } : {};
}

function composeWhere(base: Prisma.UserWhereInput, clause: Prisma.UserWhereInput): Prisma.UserWhereInput {
  return Object.keys(base).length === 0 ? clause : { AND: [base, clause] };
}

function relationUserWhere(where: Prisma.UserWhereInput): Prisma.UserScalarRelationFilter {
  return { is: where };
}

function tokenWalletWhereForUsers(where: Prisma.UserWhereInput): Prisma.TokenWalletWhereInput {
  return { user: { is: where } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toInputJsonObject(value: Record<string, unknown>, ancestors = new Set<object>()): Prisma.InputJsonObject {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AppError(400, 'Audit metadata must contain plain objects');
  }

  if (ancestors.has(value)) {
    throw new AppError(400, 'Audit metadata must not contain circular references');
  }

  ancestors.add(value);
  try {
    const result: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value)) {
      const jsonValue = toInputJsonValue(item, ancestors);
      if (jsonValue !== undefined) {
        result[key] = jsonValue;
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function toInputJsonValue(value: unknown, ancestors: Set<object>): Prisma.InputJsonValue | null | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AppError(400, 'Audit metadata must contain finite numbers');
    }
    return value;
  }

  if (value === undefined) {
    throw new AppError(400, 'Audit metadata must not contain undefined values');
  }

  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new AppError(400, 'Audit metadata contains a non-JSON value');
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new AppError(400, 'Audit metadata contains an invalid date');
    }
    return value.toISOString();
  }

  if (typeof value !== 'object') {
    throw new AppError(400, 'Audit metadata contains an unsupported value');
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new AppError(400, 'Audit metadata must not contain circular references');
    }

    ancestors.add(value);
    try {
      const result: Array<Prisma.InputJsonValue | null> = [];
      for (const item of value) {
        result.push(toInputJsonValue(item, ancestors) ?? null);
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  return toInputJsonObject(value, ancestors);
}

function mapSummary(row: UserSummaryRow): DashboardUserSummary {
  return {
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    avatar: row.avatarUrl,
    role: row.role?.name ?? 'user',
    walletBalance: row.tokenWallet?.tokenBalance ?? 0,
    walletStatus: row.tokenWallet?.status ?? null,
    xp: row.xp,
    level: row.level,
    active: row.isActive,
    verified: row.isEmailVerified,
    banned: row.isBanned,
    deleted: row.isDeleted,
    createdAt: row.createdAt,
    lastLogin: row.lastLoginAt,
    paymentsCount: row._count.payments,
    tripsCount: row._count.tripHistories,
    badgesCount: row._count.userBadges,
    conversationCount: row._count.conversations,
  };
}

function buildOrderBy(sort: DashboardSortField, order: DashboardOrder): Prisma.UserOrderByWithRelationInput[] {
  switch (sort) {
    case 'walletBalance':
      return [
        { tokenWallet: { tokenBalance: order } } as Prisma.UserOrderByWithRelationInput,
        { createdAt: 'desc' },
      ];
    case 'lastLoginAt':
      return [
        { lastLoginAt: order },
        { createdAt: 'desc' },
      ];
    case 'displayName':
      return [{ displayName: order }, { id: 'desc' }];
    case 'email':
      return [{ email: order }, { id: 'desc' }];
    case 'xp':
      return [{ xp: order }, { id: 'desc' }];
    case 'level':
      return [{ level: order }, { id: 'desc' }];
    case 'id':
      return [{ id: order }];
    case 'createdAt':
    default:
      return [{ createdAt: order }, { id: 'desc' }];
  }
}

async function createAuditLog(actorId: string, targetUserId: string | null, action: string, metadata?: Record<string, unknown>): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId,
      targetUserId,
      action,
      metadata: metadata ? toInputJsonObject(metadata) : undefined,
    },
  });
}

async function updateSingleUser(
  targetUserId: string,
  actorId: string,
  action: string,
  data: Prisma.UserUpdateInput,
  metadata?: Record<string, unknown>,
): Promise<BasicUserRow> {
  const currentUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: {
      id: true,
      roleId: true,
      isEmailVerified: true,
      isActive: true,
      isBanned: true,
      isDeleted: true,
      xp: true,
      level: true,
      lastLoginAt: true,
      tokenWallet: {
        select: {
          tokenBalance: true,
          status: true,
        },
      },
    },
  });

  if (!currentUser) {
    throw new AppError(404, 'User not found');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: targetUserId },
      data,
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        bio: true,
        gender: true,
        nationality: true,
        language: true,
        budgetLevel: true,
        arrivalDate: true,
        departureDate: true,
        travelStyle: true,
        interests: true,
        accommodationType: true,
        isEmailVerified: true,
        isActive: true,
        isBanned: true,
        isDeleted: true,
        roleId: true,
        xp: true,
        level: true,
        createdAt: true,
        updatedAt: true,
        lastLoginAt: true,
        role: {
          select: {
            id: true,
            name: true,
            permissions: true,
          },
        },
      },
    });

    await tx.auditLog.create({
      data: {
        actorId,
        targetUserId,
        action,
        metadata: toInputJsonObject({
          ...metadata,
          previous: {
            isEmailVerified: currentUser.isEmailVerified,
            isActive: currentUser.isActive,
            isBanned: currentUser.isBanned,
            isDeleted: currentUser.isDeleted,
            roleId: currentUser.roleId,
            xp: currentUser.xp,
            level: currentUser.level,
            lastLoginAt: currentUser.lastLoginAt,
            walletBalance: currentUser.tokenWallet?.tokenBalance ?? null,
            walletStatus: currentUser.tokenWallet?.status ?? null,
          },
        }),
      },
    });

    return user;
  });

  logDashboardAction(action, { actorId, targetUserId, ...metadata });

  return updated;
}

async function getUserRoleOrThrow(roleId: number): Promise<{ id: number; name: string; permissions: Prisma.JsonValue }> {
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    select: { id: true, name: true, permissions: true },
  });

  if (!role) {
    throw new AppError(404, 'Role not found');
  }

  return role;
}

function getCountByStatus(items: Array<{ status: string; _count: { _all: number } }>, status: string): number {
  return items.find((item) => item.status === status)?._count._all ?? 0;
}

function buildSeries<T>(points: Array<{ timestamp: Date; value: number }>, start: Date, end: Date, step: 'day' | 'week' | 'month' | 'year'): Array<{ period: string; users: number } | { period: string; revenue: number }> {
  const buckets = new Map<string, number>();
  const cursor = new Date(start);

  while (cursor <= end) {
    const period = step === 'day'
      ? formatDay(cursor)
      : step === 'week'
        ? formatWeek(cursor)
        : step === 'month'
          ? formatMonth(cursor)
          : formatYear(cursor);
    buckets.set(period, 0);

    if (step === 'day') {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } else if (step === 'week') {
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    } else if (step === 'month') {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    } else {
      cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
    }
  }

  for (const point of points) {
    const period = step === 'day'
      ? formatDay(point.timestamp)
      : step === 'week'
        ? formatWeek(point.timestamp)
        : step === 'month'
          ? formatMonth(point.timestamp)
          : formatYear(point.timestamp);
    buckets.set(period, (buckets.get(period) ?? 0) + point.value);
  }

  return Array.from(buckets.entries()).map(([period, value]) => ({ period, users: value, revenue: value } as { period: string; users: number } | { period: string; revenue: number }));
}

function formatActivityUser(user: { id: string; displayName: string; avatarUrl: string | null }): { id: string; displayName: string; avatar: string | null } {
  return {
    id: user.id,
    displayName: user.displayName,
    avatar: user.avatarUrl,
  };
}

function toCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    return JSON.stringify(value).replaceAll('"', '""');
  }
  return String(value).replaceAll('"', '""');
}

function buildCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) {
    return '';
  }

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];

  for (const row of rows) {
    lines.push(headers.map((header) => `"${toCsvValue(row[header])}"`).join(','));
  }

  return lines.join('\n');
}

function buildExcelXml(rows: Array<Record<string, unknown>>): string {
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const escapeXml = (value: unknown): string =>
    toCsvValue(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');

  const headerRow = headers.map((header) => `<Cell><Data ss:Type="String">${escapeXml(header)}</Data></Cell>`).join('');
  const dataRows = rows.map((row) => {
    const cells = headers.map((header) => `<Cell><Data ss:Type="String">${escapeXml(row[header])}</Data></Cell>`).join('');
    return `<Row>${cells}</Row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Users"><Table><Row>${headerRow}</Row>${dataRows}</Table></Worksheet></Workbook>`;
}

function mapAnalyticsRows<T extends { key: string; value: number }>(rows: T[], keyName: string): Array<Record<string, unknown>> {
  return rows.map((row) => ({ [keyName]: row.key, count: row.value }));
}

export async function listUsers(filters: DashboardListFilters): Promise<DashboardUsersListResult> {
  const where = buildUserWhere(filters);
  const skip = (filters.page - 1) * filters.limit;

  const [total, rows, activeUsers, verifiedUsers, bannedUsers, deletedUsers, walletUsers, avgUser, walletAggregate, paymentAggregate, tripCount, badgeCount, conversationCount] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      skip,
      take: filters.limit,
      orderBy: buildOrderBy(filters.sort, filters.order),
      select: userSummarySelect,
    }) as Promise<UserSummaryRow[]>,
    prisma.user.count({ where: composeWhere(where, { isActive: true }) }),
    prisma.user.count({ where: composeWhere(where, { isEmailVerified: true }) }),
    prisma.user.count({ where: composeWhere(where, { isBanned: true }) }),
    prisma.user.count({ where: composeWhere(where, { isDeleted: true }) }),
    prisma.tokenWallet.count({ where: tokenWalletWhereForUsers(where) }),
    prisma.user.aggregate({
      where,
      _avg: { xp: true, level: true },
    }),
    prisma.tokenWallet.aggregate({
      where: tokenWalletWhereForUsers(where),
      _avg: { tokenBalance: true },
      _sum: { tokenBalance: true },
      _count: { _all: true },
    }),
    prisma.payment.aggregate({
      where: { user: relationUserWhere(where) },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.tripHistory.count({ where: { user: relationUserWhere(where) } }),
    prisma.userBadge.count({ where: { user: relationUserWhere(where) } }),
    prisma.conversation.count({ where: { user: relationUserWhere(where) } }),
  ]);

  const totalPages = total > 0 ? Math.ceil(total / filters.limit) : 0;
  const averageWalletBalance = decimalToNumber(walletAggregate._avg?.tokenBalance ?? null);
  const totalWalletTokens = walletAggregate._sum?.tokenBalance ?? 0;
  const revenue = decimalToNumber(paymentAggregate._sum.amount);

  const statistics: DashboardUsersStatistics = {
    totalUsers: total,
    activeUsers,
    inactiveUsers: total - activeUsers,
    verifiedUsers,
    unverifiedUsers: total - verifiedUsers,
    bannedUsers,
    deletedUsers,
    walletUsers,
    usersWithoutWallet: total - walletUsers,
    averageXp: avgUser._avg.xp ?? 0,
    averageLevel: avgUser._avg.level ?? 0,
    averageWalletBalance,
    totalWalletTokens,
    totalPayments: paymentAggregate._count._all,
    totalTrips: tripCount,
    totalBadges: badgeCount,
    totalConversations: conversationCount,
  };

  return {
    users: rows.map(mapSummary),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      totalPages,
    },
    statistics: {
      ...statistics,
      totalPayments: paymentAggregate._count._all,
      totalWalletTokens,
    },
  };
}

export async function getUserProfile(userId: string): Promise<DashboardUserProfileResult> {
  const userPromise = prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      gender: true,
      nationality: true,
      language: true,
      budgetLevel: true,
      arrivalDate: true,
      departureDate: true,
      travelStyle: true,
      interests: true,
      accommodationType: true,
      isEmailVerified: true,
      isActive: true,
      isBanned: true,
      isDeleted: true,
      roleId: true,
      xp: true,
      level: true,
      createdAt: true,
      updatedAt: true,
      lastLoginAt: true,
      role: {
        select: {
          id: true,
          name: true,
          permissions: true,
        },
      },
    },
  });

  const walletPromise = prisma.tokenWallet.findUnique({
    where: { userId },
    select: {
      id: true,
      tokenBalance: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const paymentsPromise = prisma.payment.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
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
    },
  });

  const paymentStatsPromise = prisma.payment.aggregate({
    where: { userId },
    _count: { _all: true },
    _sum: { amount: true },
  });

  const paymentStatusCountsPromise = prisma.payment.groupBy({
    by: ['status'],
    where: { userId },
    _count: { _all: true },
  });

  const tokenTransactionsPromise = prisma.tokenTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      type: true,
      source: true,
      tokens: true,
      paymentId: true,
      referenceId: true,
      metadata: true,
      createdAt: true,
    },
  });

  const tokenSummaryPromise = prisma.tokenTransaction.groupBy({
    by: ['type', 'source'],
    where: { userId },
    _sum: { tokens: true },
  });

  const journeysPromise = prisma.userJourney.findMany({
    where: { userId },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      startedAt: true,
      completedAt: true,
      journey: {
        select: {
          id: true,
          slug: true,
          title: true,
          xpReward: true,
        },
      },
      steps: {
        orderBy: { completedAt: 'asc' },
        select: {
          id: true,
          completedAt: true,
          step: {
            select: {
              id: true,
              stepNumber: true,
              title: true,
              xpReward: true,
            },
          },
        },
      },
    },
  });

  const journeySummaryPromise = Promise.all([
    prisma.journey.count(),
    prisma.userJourney.count({ where: { userId, completedAt: { not: null } } }),
    prisma.userJourney.count({ where: { userId } }),
    prisma.userJourneyStep.count({ where: { userJourney: { is: { userId } } } }),
  ]);

  const tripsPromise = prisma.tripHistory.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      destination: true,
      startDate: true,
      endDate: true,
      itinerary: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const preferencesPromise = prisma.userPreference.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      key: true,
      value: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const feedbackPromise = prisma.userFeedback.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      type: true,
      targetId: true,
      targetType: true,
      rating: true,
      comment: true,
      createdAt: true,
    },
  });

  const interactionSummaryPromise = prisma.interactionSummary.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      summary: true,
      periodStart: true,
      periodEnd: true,
      createdAt: true,
    },
  });

  const badgesPromise = prisma.userBadge.findMany({
    where: { userId },
    orderBy: { awardedAt: 'desc' },
    select: {
      id: true,
      awardedAt: true,
      badge: {
        select: {
          id: true,
          name: true,
          description: true,
          iconUrl: true,
          criteriaType: true,
          criteriaValue: true,
        },
      },
    },
  });

  const refreshTokensPromise = prisma.refreshToken.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      deviceInfo: true,
      ipAddress: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  const passwordResetTokensPromise = prisma.passwordResetToken.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      expiresAt: true,
      usedAt: true,
      createdAt: true,
    },
  });

  const verificationTokensPromise = prisma.emailVerificationToken.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      expiresAt: true,
      usedAt: true,
      createdAt: true,
    },
  });

  const auditLogsPromise = prisma.auditLog.findMany({
    where: {
      OR: [{ targetUserId: userId }, { actorId: userId }],
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      actorId: true,
      action: true,
      targetUserId: true,
      metadata: true,
      createdAt: true,
      actor: {
        select: {
          id: true,
          displayName: true,
          email: true,
        },
      },
      target: {
        select: {
          id: true,
          displayName: true,
          email: true,
        },
      },
    },
  });

  const messageCountPromise = prisma.message.count({
    where: { conversation: { is: { userId } } },
  });

  const [user, wallet, payments, paymentStats, paymentStatuses, tokenTransactions, tokenSummary, journeys, journeySummary, trips, preferences, feedback, interactionSummary, badges, refreshTokens, passwordResetTokens, verificationTokens, auditLogs, messagesCount] = await Promise.all([
    userPromise,
    walletPromise,
    paymentsPromise,
    paymentStatsPromise,
    paymentStatusCountsPromise,
    tokenTransactionsPromise,
    tokenSummaryPromise,
    journeysPromise,
    journeySummaryPromise,
    tripsPromise,
    preferencesPromise,
    feedbackPromise,
    interactionSummaryPromise,
    badgesPromise,
    refreshTokensPromise,
    passwordResetTokensPromise,
    verificationTokensPromise,
    auditLogsPromise,
    messageCountPromise,
  ]);

  if (!user) {
    throw new AppError(404, 'User not found');
  }

  const [totalJourneys, completedJourneys, startedJourneys, completedJourneySteps] = journeySummary;
  const totalTokensEarned = tokenSummary.reduce((sum, item) => {
    const amount = item._sum.tokens ?? 0;
    if (item.type === 'GRANT' || item.type === 'BONUS' || item.type === 'REFUND' || item.type === 'ADJUSTMENT') {
      return sum + amount;
    }
    return sum;
  }, 0);
  const totalTokensSpent = tokenSummary.reduce((sum, item) => {
    const amount = item._sum.tokens ?? 0;
    if (item.type === 'CONSUME') {
      return sum + amount;
    }
    return sum;
  }, 0);

  const accountAgeDays = daysBetween(user.createdAt, new Date());
  const lastLogin = user.lastLoginAt;
  const daysSinceLastLogin = lastLogin ? daysBetween(lastLogin, new Date()) : null;
  const progressPercent = totalJourneys > 0 ? Math.round((completedJourneys / totalJourneys) * 100) : 0;

  return {
    basicInformation: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatar: user.avatarUrl,
      bio: user.bio,
      gender: user.gender,
      nationality: user.nationality,
      language: flattenLanguages(user.language),
      budgetLevel: user.budgetLevel,
      arrivalDate: user.arrivalDate,
      departureDate: user.departureDate,
      travelStyle: user.travelStyle,
      interests: asStringArray(user.interests),
      accommodationType: user.accommodationType,
      active: user.isActive,
      verified: user.isEmailVerified,
      banned: user.isBanned,
      deleted: user.isDeleted,
      roleId: user.roleId,
    },
    role: user.role,
    wallet: wallet
      ? {
        id: wallet.id,
        balance: wallet.tokenBalance,
        status: wallet.status,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      }
      : null,
    currentTokens: wallet?.tokenBalance ?? 0,
    xp: user.xp,
    level: user.level,
    paymentHistory: payments,
    paymentStatistics: {
      totalPayments: paymentStats._count._all,
      revenue: decimalToNumber(paymentStats._sum.amount),
      completedPayments: getCountByStatus(paymentStatuses, 'COMPLETED'),
      pendingPayments: getCountByStatus(paymentStatuses, 'PENDING'),
      failedPayments: getCountByStatus(paymentStatuses, 'FAILED'),
      cancelledPayments: getCountByStatus(paymentStatuses, 'CANCELLED'),
      refundedPayments: getCountByStatus(paymentStatuses, 'REFUNDED'),
    },
    tokenTransactions,
    journeyProgress: {
      totalJourneys,
      completedJourneys,
      startedJourneys,
      completedJourneySteps,
      progressPercent,
      journeys,
    },
    journeySteps: journeys.flatMap((journey) => journey.steps.map((step) => ({
      journeyId: journey.journey.id,
      journeySlug: journey.journey.slug,
      journeyTitle: journey.journey.title,
      journeyCompletedAt: journey.completedAt,
      stepId: step.step.id,
      stepNumber: step.step.stepNumber,
      stepTitle: step.step.title,
      stepXpReward: step.step.xpReward,
      completedAt: step.completedAt,
    }))),
    trips,
    tripCount: trips.length,
    conversationCount: await prisma.conversation.count({ where: { userId } }),
    messagesCount,
    badges: badges.map((badge) => ({
      userBadgeId: badge.id,
      awardedAt: badge.awardedAt,
      ...badge.badge,
    })),
    preferences,
    feedback,
    interactionSummary,
    refreshTokens,
    passwordResetTokens,
    verificationTokens,
    auditLogs,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLogin,
    accountAgeDays,
  };
}

export async function getUserStatistics(userId: string): Promise<DashboardUserStatisticsResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      createdAt: true,
      lastLoginAt: true,
      xp: true,
      level: true,
    },
  });

  if (!user) {
    throw new AppError(404, 'User not found');
  }

  const [wallet, payments, paymentStatusCounts, tokenSummary, badges, trips, conversations, messagesCount, feedbackCount, preferencesCount, interactionCount, completedJourneys, totalJourneys] = await Promise.all([
    prisma.tokenWallet.findUnique({
      where: { userId },
      select: { tokenBalance: true },
    }),
    prisma.payment.aggregate({
      where: { userId },
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.payment.groupBy({
      by: ['status'],
      where: { userId },
      _count: { _all: true },
    }),
    prisma.tokenTransaction.groupBy({
      by: ['type'],
      where: { userId },
      _sum: { tokens: true },
    }),
    prisma.userBadge.count({ where: { userId } }),
    prisma.tripHistory.count({ where: { userId } }),
    prisma.conversation.count({ where: { userId } }),
    prisma.message.count({ where: { conversation: { is: { userId } } } }),
    prisma.userFeedback.count({ where: { userId } }),
    prisma.userPreference.count({ where: { userId } }),
    prisma.interactionSummary.count({ where: { userId } }),
    prisma.userJourney.count({ where: { userId, completedAt: { not: null } } }),
    prisma.journey.count(),
  ]);

  const paymentStatusMap = new Map(paymentStatusCounts.map((item) => [item.status, item._count._all]));

  const totalTokensEarned = tokenSummary.reduce((sum, item) => {
    const amount = item._sum.tokens ?? 0;
    if (item.type === 'GRANT' || item.type === 'BONUS' || item.type === 'REFUND' || item.type === 'ADJUSTMENT') {
      return sum + amount;
    }
    return sum;
  }, 0);

  const totalTokensSpent = tokenSummary.reduce((sum, item) => {
    const amount = item._sum.tokens ?? 0;
    if (item.type === 'CONSUME') {
      return sum + amount;
    }
    return sum;
  }, 0);

  const accountAgeDays = daysBetween(user.createdAt, new Date());
  const daysSinceLastLogin = user.lastLoginAt ? daysBetween(user.lastLoginAt, new Date()) : null;

  return {
    totalPayments: payments._count._all,
    completedPayments: paymentStatusMap.get('COMPLETED') ?? 0,
    pendingPayments: paymentStatusMap.get('PENDING') ?? 0,
    failedPayments: paymentStatusMap.get('FAILED') ?? 0,
    cancelledPayments: paymentStatusMap.get('CANCELLED') ?? 0,
    refundedPayments: paymentStatusMap.get('REFUNDED') ?? 0,
    revenue: decimalToNumber(payments._sum.amount),
    walletBalance: wallet?.tokenBalance ?? 0,
    totalTokensEarned,
    totalTokensSpent,
    netTokens: (wallet?.tokenBalance ?? 0),
    xp: user.xp,
    level: user.level,
    badges,
    trips,
    journeyProgressPercent: totalJourneys > 0 ? Math.round((completedJourneys / totalJourneys) * 100) : 0,
    completedJourneys,
    conversationCount: conversations,
    messagesCount,
    feedbackCount,
    preferencesCount,
    interactionCount,
    accountAgeDays,
    daysSinceLastLogin,
  };
}

export async function getDashboardStatistics(filters: Omit<DashboardListFilters, 'page' | 'limit' | 'sort' | 'order'> = {}): Promise<DashboardStatisticsResult> {
  const where = buildUserWhere(filters);
  const now = new Date();
  const todayStart = toStartOfDay(now);
  const weekStart = toStartOfDay(addDays(now, -7));
  const monthStart = toStartOfDay(addDays(now, -30));
  const thisWeekStart = getWeekStart(now);
  const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const userTotalsPromise = prisma.user.aggregate({
    where,
    _count: { _all: true },
    _avg: { xp: true, level: true },
  });

  const [totalUsers, activeUsers, verifiedUsers, bannedUsers, deletedUsers, maleUsers, femaleUsers, walletUsers, averageWallet, totalWallet, paymentStatusCounts, revenueTodayRows, revenueWeekRows, revenueMonthRows, revenueAllRows, topCountriesRows, roleRows, topXpUsers, topTokenWallets, topPayments, topTravelersRows, topConversationRows, totalTrips, totalBadges, totalConversations, userTotals] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.count({ where: composeWhere(where, { isActive: true }) }),
    prisma.user.count({ where: composeWhere(where, { isEmailVerified: true }) }),
    prisma.user.count({ where: composeWhere(where, { isBanned: true }) }),
    prisma.user.count({ where: composeWhere(where, { isDeleted: true }) }),
    prisma.user.count({ where: composeWhere(where, { gender: 'MALE' }) }),
    prisma.user.count({ where: composeWhere(where, { gender: 'FEMALE' }) }),
    prisma.tokenWallet.count({ where: tokenWalletWhereForUsers(where) }),
    prisma.tokenWallet.aggregate({ where: tokenWalletWhereForUsers(where), _avg: { tokenBalance: true }, _sum: { tokenBalance: true } }),
    prisma.tokenWallet.aggregate({ where: tokenWalletWhereForUsers(where), _sum: { tokenBalance: true } }),
    prisma.payment.groupBy({ by: ['status'], where: { user: relationUserWhere(where) }, _count: { _all: true } }),
    getRevenueSeries(where, todayStart, now, 'day'),
    getRevenueSeries(where, thisWeekStart, now, 'week'),
    getRevenueSeries(where, thisMonthStart, now, 'month'),
    getRevenueSeries(where, new Date(Date.UTC(now.getUTCFullYear() - 4, 0, 1)), now, 'year'),
    prisma.user.groupBy({ by: ['nationality'], where, _count: { _all: true }, orderBy: { _count: { nationality: 'desc' } }, take: 10 }),
    prisma.user.groupBy({ by: ['roleId'], where, _count: { _all: true }, orderBy: { _count: { roleId: 'desc' } }, take: 10 }),
    prisma.user.findMany({ where, orderBy: { xp: 'desc' }, take: 10, select: { id: true, displayName: true, email: true, avatarUrl: true, xp: true, level: true } }),
    prisma.tokenWallet.findMany({ orderBy: { tokenBalance: 'desc' }, take: 10, select: { tokenBalance: true, user: { select: { id: true, displayName: true, email: true, avatarUrl: true } } } }),
    prisma.payment.groupBy({ by: ['userId'], where: { status: 'COMPLETED', user: relationUserWhere(where) }, _sum: { amount: true }, orderBy: { _sum: { amount: 'desc' } }, take: 10 }),
    prisma.tripHistory.groupBy({ by: ['userId'], where: { user: relationUserWhere(where) }, _count: { _all: true }, orderBy: { _count: { userId: 'desc' } }, take: 10 }),
    prisma.conversation.groupBy({ by: ['userId'], where: { user: relationUserWhere(where) }, _count: { _all: true }, orderBy: { _count: { userId: 'desc' } }, take: 10 }),
    prisma.tripHistory.count({ where: { user: relationUserWhere(where) } }),
    prisma.userBadge.count({ where: { user: relationUserWhere(where) } }),
    prisma.conversation.count({ where: { user: relationUserWhere(where) } }),
    userTotalsPromise,
  ]);

  const [newUsersToday, newUsersThisWeek, newUsersThisMonth] = await Promise.all([
    prisma.user.count({ where: { AND: [where, { createdAt: { gte: todayStart } }] } }),
    prisma.user.count({ where: { AND: [where, { createdAt: { gte: thisWeekStart } }] } }),
    prisma.user.count({ where: { AND: [where, { createdAt: { gte: thisMonthStart } }] } }),
  ]);

  const topRolesLookup = await prisma.role.findMany({
    where: {
      id: { in: roleRows.map((item) => item.roleId) },
    },
    select: { id: true, name: true },
  });

  const topRolesMap = new Map(topRolesLookup.map((role) => [role.id, role.name]));

  const topCountries = topCountriesRows.map((item) => ({ nationality: item.nationality, count: item._count._all }));
  const topRoles = roleRows.map((item) => ({ role: topRolesMap.get(item.roleId) ?? String(item.roleId), count: item._count._all }));

  const languageRows = await prisma.user.findMany({
    where,
    select: { language: true },
  });
  const languageCounts = new Map<string, number>();
  for (const row of languageRows) {
    for (const language of flattenLanguages(row.language)) {
      languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    }
  }
  const topLanguages = Array.from(languageCounts.entries())
    .map(([language, count]) => ({ language, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 10);

  const revenueToday = revenueTodayRows.reduce((sum, row) => sum + row.revenue, 0);
  const revenueThisWeek = revenueWeekRows.reduce((sum, row) => sum + row.revenue, 0);
  const revenueThisMonth = revenueMonthRows.reduce((sum, row) => sum + row.revenue, 0);
  const revenueTotal = revenueAllRows.reduce((sum, row) => sum + row.revenue, 0);

  const paymentStatusMap = new Map(paymentStatusCounts.map((item) => [item.status, item._count._all]));

  const userIds = new Set([
    ...topPayments.map((row) => row.userId),
    ...topTravelersRows.map((row) => row.userId),
    ...topConversationRows.map((row) => row.userId),
  ]);
  const users = await prisma.user.findMany({
    where: { id: { in: [...userIds] } },
    select: { id: true, displayName: true, email: true, avatarUrl: true },
  });
  const userLookup = new Map(users.map((user) => [user.id, user]));

  const topTravelers = topTravelersRows.map((row) => {
    const user = userLookup.get(row.userId);
    return {
      id: row.userId,
      displayName: user?.displayName ?? '',
      email: user?.email ?? '',
      avatar: user?.avatarUrl ?? null,
      tripsCount: row._count._all,
    };
  });

  const topConversationUsers = topConversationRows.map((row) => {
    const user = userLookup.get(row.userId);
    return {
      id: row.userId,
      displayName: user?.displayName ?? '',
      email: user?.email ?? '',
      avatar: user?.avatarUrl ?? null,
      conversationsCount: row._count._all,
    };
  });

  const topPayingUsers = topPayments.map((row) => {
    const user = userLookup.get(row.userId);
    return {
      id: row.userId,
      displayName: user?.displayName ?? '',
      email: user?.email ?? '',
      avatar: user?.avatarUrl ?? null,
      revenue: decimalToNumber(row._sum.amount),
    };
  });

  return {
    totalUsers,
    newUsersToday,
    newUsersThisWeek,
    newUsersThisMonth,
    activeUsers,
    inactiveUsers: totalUsers - activeUsers,
    verifiedUsers,
    unverifiedUsers: totalUsers - verifiedUsers,
    bannedUsers,
    deletedUsers,
    male: maleUsers,
    female: femaleUsers,
    walletUsers,
    usersWithoutWallet: totalUsers - walletUsers,
    averageXp: userTotals._avg.xp ?? 0,
    averageLevel: userTotals._avg.level ?? 0,
    averageWalletBalance: decimalToNumber(averageWallet._avg?.tokenBalance ?? null),
    totalWalletTokens: totalWallet._sum?.tokenBalance ?? 0,
    topCountries,
    topLanguages,
    topRoles,
    topTravelers,
    topXpUsers: topXpUsers.map((user) => ({
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      avatar: user.avatarUrl,
      xp: user.xp,
      level: user.level,
    })),
    topTokenHolders: topTokenWallets.map((wallet) => ({
      id: wallet.user.id,
      displayName: wallet.user.displayName,
      email: wallet.user.email,
      avatar: wallet.user.avatarUrl,
      walletBalance: wallet.tokenBalance,
    })),
    topPayingUsers,
    topConversations: topConversationUsers,
    revenueToday,
    revenueThisWeek,
    revenueThisMonth,
    revenueTotal,
    completedPayments: paymentStatusMap.get('COMPLETED') ?? 0,
    pendingPayments: paymentStatusMap.get('PENDING') ?? 0,
    failedPayments: paymentStatusMap.get('FAILED') ?? 0,
    cancelledPayments: paymentStatusMap.get('CANCELLED') ?? 0,
    refundedPayments: paymentStatusMap.get('REFUNDED') ?? 0,
  };
}

async function getRevenueSeries(where: Prisma.UserWhereInput, start: Date, end: Date, step: 'day' | 'week' | 'month' | 'year'): Promise<Array<{ period: string; revenue: number }>> {
  const payments = await prisma.payment.findMany({
    where: {
      status: 'COMPLETED',
      user: relationUserWhere(where),
      createdAt: { gte: start, lte: end },
    },
    select: {
      amount: true,
      paidAt: true,
      createdAt: true,
    },
  });

  const grouped = new Map<string, number>();
  const cursor = new Date(start);
  while (cursor <= end) {
    const period = step === 'day'
      ? formatDay(cursor)
      : step === 'week'
        ? formatWeek(cursor)
        : step === 'month'
          ? formatMonth(cursor)
          : formatYear(cursor);
    grouped.set(period, 0);

    if (step === 'day') {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } else if (step === 'week') {
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    } else if (step === 'month') {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    } else {
      cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
    }
  }

  for (const payment of payments) {
    const timestamp = payment.paidAt ?? payment.createdAt;
    const period = step === 'day'
      ? formatDay(timestamp)
      : step === 'week'
        ? formatWeek(timestamp)
        : step === 'month'
          ? formatMonth(timestamp)
          : formatYear(timestamp);
    grouped.set(period, (grouped.get(period) ?? 0) + decimalToNumber(payment.amount));
  }

  return Array.from(grouped.entries()).map(([period, revenue]) => ({ period, revenue }));
}

export async function getRecentActivity(): Promise<DashboardRecentActivityResult> {
  const [newRegistrations, recentLogins, recentPayments, recentTrips, recentConversations, recentBadgeUnlocks, recentJourneyProgress] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        displayName: true,
        avatarUrl: true,
        createdAt: true,
      },
    }),
    prisma.user.findMany({
      where: { lastLoginAt: { not: null } },
      orderBy: { lastLoginAt: 'desc' },
      take: 10,
      select: {
        id: true,
        displayName: true,
        avatarUrl: true,
        lastLoginAt: true,
      },
    }),
    prisma.payment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        amount: true,
        currency: true,
        status: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true,
          },
        },
        tokenPackage: {
          select: {
            id: true,
            name: true,
            tokens: true,
          },
        },
      },
    }),
    prisma.tripHistory.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        title: true,
        destination: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
    }),
    prisma.conversation.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        title: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true,
          },
        },
        _count: {
          select: {
            messages: true,
          },
        },
      },
    }),
    prisma.userBadge.findMany({
      orderBy: { awardedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        awardedAt: true,
        user: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true,
          },
        },
        badge: {
          select: {
            id: true,
            name: true,
            iconUrl: true,
          },
        },
      },
    }),
    prisma.userJourney.findMany({
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        startedAt: true,
        completedAt: true,
        user: {
          select: {
            id: true,
            displayName: true,
            avatarUrl: true,
          },
        },
        journey: {
          select: {
            id: true,
            title: true,
            slug: true,
          },
        },
      },
    }),
  ]);

  return {
    newRegistrations: newRegistrations.map((item) => ({
      id: item.id,
      title: item.displayName,
      subtitle: 'New registration',
      timestamp: item.createdAt,
      type: 'registration',
      userId: item.id,
      avatar: item.avatarUrl,
    })),
    recentLogins: recentLogins.map((item) => ({
      id: item.id,
      title: item.displayName,
      subtitle: 'Recent login',
      timestamp: item.lastLoginAt ?? new Date(),
      type: 'login',
      userId: item.id,
      avatar: item.avatarUrl,
    })),
    recentPayments: recentPayments.map((payment) => ({
      id: payment.id,
      userId: payment.user.id,
      user: payment.user,
      amount: decimalToNumber(payment.amount),
      currency: payment.currency,
      status: payment.status,
      package: payment.tokenPackage,
      createdAt: payment.createdAt,
    })),
    recentTrips: recentTrips.map((trip) => ({
      id: trip.id,
      userId: trip.user.id,
      user: trip.user,
      title: trip.title,
      destination: trip.destination,
      createdAt: trip.createdAt,
    })),
    recentConversations: recentConversations.map((conversation) => ({
      id: conversation.id,
      userId: conversation.user.id,
      user: conversation.user,
      title: conversation.title,
      messagesCount: conversation._count.messages,
      createdAt: conversation.createdAt,
    })),
    recentBadgeUnlocks: recentBadgeUnlocks.map((badge) => ({
      id: badge.id,
      userId: badge.user.id,
      user: badge.user,
      badge: badge.badge,
      awardedAt: badge.awardedAt,
    })),
    recentJourneyProgress: recentJourneyProgress.map((progress) => ({
      id: progress.id,
      userId: progress.user.id,
      user: progress.user,
      journey: progress.journey,
      startedAt: progress.startedAt,
      completedAt: progress.completedAt,
    })),
  };
}

export async function getGrowthAnalytics(): Promise<DashboardGrowthAnalyticsResult> {
  const now = new Date();
  const dailyStart = addDays(now, -29);
  const weeklyStart = addDays(now, -83);
  const monthlyStart = addMonths(now, -11);
  const yearlyStart = addYears(now, -4);

  const countByTruncatedPeriod = async (column: 'created_at', step: 'day' | 'week' | 'month' | 'year'): Promise<Array<{ created_at: Date; count: bigint }>> => {
    const start = step === 'day' ? dailyStart : step === 'week' ? weeklyStart : step === 'month' ? monthlyStart : yearlyStart;
    return prisma.$queryRaw`
      SELECT date_trunc(${Prisma.raw(`'${step}'`)}, ${Prisma.raw(column)}::timestamptz) AS created_at, COUNT(*)::bigint AS count
      FROM ${Prisma.raw('users')}
      WHERE ${Prisma.raw(column)}::timestamptz >= ${start}
      GROUP BY 1
    `;
  };

  const [dailyRows, weeklyRows, monthlyRows, yearlyRows] = await Promise.all([
    countByTruncatedPeriod('created_at', 'day'),
    countByTruncatedPeriod('created_at', 'week'),
    countByTruncatedPeriod('created_at', 'month'),
    countByTruncatedPeriod('created_at', 'year'),
  ]);

  const build = (rows: Array<{ created_at: Date; count: bigint }>, start: Date, step: 'day' | 'week' | 'month' | 'year') => {
    const map = new Map<string, number>();
    const cursor = new Date(start);

    while (cursor <= now) {
      const period = step === 'day'
        ? formatDay(cursor)
        : step === 'week'
          ? formatWeek(cursor)
          : step === 'month'
            ? formatMonth(cursor)
            : formatYear(cursor);
      map.set(period, 0);

      if (step === 'day') {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      } else if (step === 'week') {
        cursor.setUTCDate(cursor.getUTCDate() + 7);
      } else if (step === 'month') {
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      } else {
        cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
      }
    }

    for (const item of rows) {
      const period = step === 'day'
        ? formatDay(item.created_at)
        : step === 'week'
          ? formatWeek(item.created_at)
          : step === 'month'
            ? formatMonth(item.created_at)
            : formatYear(item.created_at);
      map.set(period, (map.get(period) ?? 0) + Number(item.count));
    }

    return Array.from(map.entries()).map(([period, users]) => ({ period, users }));
  };

  return {
    daily: build(dailyRows, dailyStart, 'day'),
    weekly: build(weeklyRows, getWeekStart(weeklyStart), 'week'),
    monthly: build(monthlyRows, new Date(Date.UTC(monthlyStart.getUTCFullYear(), monthlyStart.getUTCMonth(), 1)), 'month'),
    yearly: build(yearlyRows, new Date(Date.UTC(yearlyStart.getUTCFullYear(), 0, 1)), 'year'),
  };
}

export async function getRevenueAnalytics(): Promise<DashboardRevenueAnalyticsResult> {
  const now = new Date();
  const dailyStart = addDays(now, -29);
  const weeklyStart = addDays(now, -83);
  const monthlyStart = addMonths(now, -11);
  const yearlyStart = addYears(now, -4);

  const revenueByTruncatedPeriod = async (step: 'day' | 'week' | 'month' | 'year'): Promise<Array<{ paid_at: Date; revenue: Prisma.Decimal }>> => {
    const start = step === 'day' ? dailyStart : step === 'week' ? weeklyStart : step === 'month' ? monthlyStart : yearlyStart;
    return prisma.$queryRaw`
      SELECT COALESCE(date_trunc(${Prisma.raw(`'${step}'`)}, "paidAt"::timestamptz), date_trunc(${Prisma.raw(`'${step}'`)}, "createdAt"::timestamptz)) AS paid_at, COALESCE(SUM(amount), 0) AS revenue
      FROM ${Prisma.raw('"Payment"')}
      WHERE status = 'COMPLETED' AND "createdAt"::timestamptz >= ${start}
      GROUP BY 1
    `;
  };

  const [dailyRows, weeklyRows, monthlyRows, yearlyRows] = await Promise.all([
    revenueByTruncatedPeriod('day'),
    revenueByTruncatedPeriod('week'),
    revenueByTruncatedPeriod('month'),
    revenueByTruncatedPeriod('year'),
  ]);

  const buildRevenue = (rows: Array<{ paid_at: Date; revenue: Prisma.Decimal }>, start: Date, step: 'day' | 'week' | 'month' | 'year') => {
    const map = new Map<string, number>();
    const cursor = new Date(start);

    while (cursor <= now) {
      const period = step === 'day'
        ? formatDay(cursor)
        : step === 'week'
          ? formatWeek(cursor)
          : step === 'month'
            ? formatMonth(cursor)
            : formatYear(cursor);
      map.set(period, 0);

      if (step === 'day') {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      } else if (step === 'week') {
        cursor.setUTCDate(cursor.getUTCDate() + 7);
      } else if (step === 'month') {
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      } else {
        cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
      }
    }

    for (const payment of rows) {
      const period = step === 'day'
        ? formatDay(payment.paid_at)
        : step === 'week'
          ? formatWeek(payment.paid_at)
          : step === 'month'
            ? formatMonth(payment.paid_at)
            : formatYear(payment.paid_at);
      map.set(period, (map.get(period) ?? 0) + decimalToNumber(payment.revenue));
    }

    return Array.from(map.entries()).map(([period, revenue]) => ({ period, revenue }));
  };

  return {
    revenueByDay: buildRevenue(dailyRows, dailyStart, 'day'),
    revenueByWeek: buildRevenue(weeklyRows, getWeekStart(weeklyStart), 'week'),
    revenueByMonth: buildRevenue(monthlyRows, new Date(Date.UTC(monthlyStart.getUTCFullYear(), monthlyStart.getUTCMonth(), 1)), 'month'),
    revenueByYear: buildRevenue(yearlyRows, new Date(Date.UTC(yearlyStart.getUTCFullYear(), 0, 1)), 'year'),
  };
}

export async function getCountryAnalytics(): Promise<Array<{ nationality: string; count: number }>> {
  const rows = await prisma.user.groupBy({
    by: ['nationality'],
    _count: { _all: true },
    orderBy: { _count: { nationality: 'desc' } },
    take: 50,
  });

  return rows.map((row) => ({ nationality: row.nationality, count: row._count._all }));
}

export async function getLanguageAnalytics(): Promise<Array<{ language: string; count: number }>> {
  const rows = await prisma.$queryRaw<Array<{ language: string; count: bigint }>>`
    SELECT lang AS language, COUNT(*)::bigint AS count
    FROM users, jsonb_array_elements_text(COALESCE(languages, '[]'::jsonb)) AS lang
    GROUP BY lang
    ORDER BY count DESC
  `;

  return rows.map((row) => ({ language: row.language, count: Number(row.count) }));
}

export async function getRetentionAnalytics(): Promise<DashboardRetentionAnalyticsResult> {
  const now = new Date();
  const todayStart = toStartOfDay(now);
  const sevenDaysAgo = addDays(now, -7);
  const thirtyDaysAgo = addDays(now, -30);
  const ninetyDaysAgo = addDays(now, -90);

  const [activeToday, active7Days, active30Days, inactiveUsers, dormantUsers] = await Promise.all([
    prisma.user.count({ where: { lastLoginAt: { gte: todayStart } } }),
    prisma.user.count({ where: { lastLoginAt: { gte: sevenDaysAgo } } }),
    prisma.user.count({ where: { lastLoginAt: { gte: thirtyDaysAgo } } }),
    prisma.user.count({ where: { OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: thirtyDaysAgo } }] } }),
    prisma.user.count({ where: { OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: ninetyDaysAgo } }] } }),
  ]);

  return {
    activeToday,
    active7Days,
    active30Days,
    inactiveUsers,
    dormantUsers,
  };
}

export async function getTopUsers(): Promise<DashboardTopUsersResult> {
  const [topXp, topWallet, topRevenueRows, topTravelersRows, topConversationsRows, topActiveUsers] = await Promise.all([
    prisma.user.findMany({
      orderBy: { xp: 'desc' },
      take: 10,
      select: {
        id: true,
        displayName: true,
        email: true,
        avatarUrl: true,
        xp: true,
        level: true,
      },
    }),
    prisma.tokenWallet.findMany({
      orderBy: { tokenBalance: 'desc' },
      take: 10,
      select: {
        tokenBalance: true,
        user: {
          select: {
            id: true,
            displayName: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
    }),
    prisma.payment.groupBy({
      by: ['userId'],
      where: { status: 'COMPLETED' },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 10,
    }),
    prisma.tripHistory.groupBy({
      by: ['userId'],
      _count: { _all: true },
      orderBy: { _count: { userId: 'desc' } },
      take: 10,
    }),
    prisma.conversation.groupBy({
      by: ['userId'],
      _count: { _all: true },
      orderBy: { _count: { userId: 'desc' } },
      take: 10,
    }),
    prisma.user.findMany({
      where: { lastLoginAt: { not: null } },
      orderBy: { lastLoginAt: 'desc' },
      take: 10,
      select: {
        id: true,
        displayName: true,
        email: true,
        avatarUrl: true,
        lastLoginAt: true,
      },
    }),
  ]);

  const userIds = [...new Set([...topRevenueRows.map((row) => row.userId), ...topTravelersRows.map((row) => row.userId), ...topConversationsRows.map((row) => row.userId)])];
  const userLookup = new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, email: true, avatarUrl: true } })).map((user) => [user.id, user]));

  return {
    topXp: topXp,
    topWallet: topWallet.map((wallet) => ({
      id: wallet.user.id,
      displayName: wallet.user.displayName,
      email: wallet.user.email,
      avatar: wallet.user.avatarUrl,
      walletBalance: wallet.tokenBalance,
    })),
    topRevenue: topRevenueRows.map((row) => {
      const user = userLookup.get(row.userId);
      return {
        id: row.userId,
        displayName: user?.displayName ?? '',
        email: user?.email ?? '',
        avatar: user?.avatarUrl ?? null,
        revenue: decimalToNumber(row._sum.amount),
      };
    }),
    topTravelers: topTravelersRows.map((row) => {
      const user = userLookup.get(row.userId);
      return {
        id: row.userId,
        displayName: user?.displayName ?? '',
        email: user?.email ?? '',
        avatar: user?.avatarUrl ?? null,
        tripsCount: row._count._all,
      };
    }),
    topConversations: topConversationsRows.map((row) => {
      const user = userLookup.get(row.userId);
      return {
        id: row.userId,
        displayName: user?.displayName ?? '',
        email: user?.email ?? '',
        avatar: user?.avatarUrl ?? null,
        conversationsCount: row._count._all,
      };
    }),
    topActiveUsers,
  };
}

export async function getAdminTimeline(): Promise<DashboardAdminTimelineResult> {
  const logs = await prisma.auditLog.findMany({
    where: { action: { in: Array.from(dashboardAuditActions) } },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      action: true,
      targetUserId: true,
      metadata: true,
      createdAt: true,
      actor: {
        select: {
          id: true,
          displayName: true,
          email: true,
        },
      },
      target: {
        select: {
          id: true,
          displayName: true,
          email: true,
        },
      },
    },
  });

  return {
    deleteActions: logs.filter((item) => item.action === 'user_deleted' || item.action === 'users_bulk_deleted'),
    restoreActions: logs.filter((item) => item.action === 'user_restored' || item.action === 'users_bulk_restored'),
    banActions: logs.filter((item) => item.action === 'user_banned' || item.action === 'user_unbanned' || item.action === 'users_bulk_banned' || item.action === 'users_bulk_unbanned'),
    roleChanges: logs.filter((item) => item.action === 'role_changed' || item.action === 'users_bulk_role_changed'),
    exports: logs.filter((item) => item.action === 'users_exported' || item.action === 'users_bulk_exported'),
    activations: logs.filter((item) => item.action === 'user_activated' || item.action === 'users_bulk_activated'),
    deactivations: logs.filter((item) => item.action === 'user_deactivated' || item.action === 'users_bulk_deactivated'),
  };
}

export async function searchUsers(search: string): Promise<Array<Record<string, unknown>>> {
  const term = search.trim();
  if (!term) {
    return [];
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term);

  const rows = await prisma.user.findMany({
    where: {
      OR: [
        ...(isUuid ? [{ id: term }] : []),
        { displayName: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
      ],
    },
    take: 10,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      displayName: true,
      email: true,
      avatarUrl: true,
      xp: true,
      level: true,
    },
  });

  return rows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    avatar: row.avatarUrl,
    xp: row.xp,
    level: row.level,
  }));
}

export async function exportUsers(actorId: string, filters: DashboardListFilters & { format: DashboardExportFormat }): Promise<{ filename: string; contentType: string; data: string }> {
  const where = buildUserWhere(filters);
  const users = await prisma.user.findMany({
    where,
    orderBy: buildOrderBy(filters.sort, filters.order),
    select: userSummarySelect,
    take: EXPORT_MAX_ROWS,
  }) as UserSummaryRow[];

  const rows = users.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    avatar: row.avatarUrl,
    role: row.role?.name ?? 'user',
    walletBalance: row.tokenWallet?.tokenBalance ?? 0,
    walletStatus: row.tokenWallet?.status ?? null,
    xp: row.xp,
    level: row.level,
    active: row.isActive,
    verified: row.isEmailVerified,
    banned: row.isBanned,
    deleted: row.isDeleted,
    createdAt: row.createdAt.toISOString(),
    lastLogin: row.lastLoginAt?.toISOString() ?? '',
    paymentsCount: row._count.payments,
    tripsCount: row._count.tripHistories,
    badgesCount: row._count.userBadges,
    conversationCount: row._count.conversations,
  }));

  const data = filters.format === 'csv' ? buildCsv(rows) : buildExcelXml(rows);
  const filename = `dashboard-users-${Date.now()}.${filters.format === 'csv' ? 'csv' : 'xls'}`;

  logDashboardAction('users_exported', { format: filters.format, total: rows.length });
  await createAuditLog(actorId, null, 'users_exported', {
    format: filters.format,
    filters: sanitizeAuditFilters(filters),
    total: rows.length,
  }).catch(() => undefined);

  return {
    filename,
    contentType: filters.format === 'csv'
      ? 'text/csv; charset=utf-8'
      : 'application/vnd.ms-excel; charset=utf-8',
    data,
  };
}

export async function deleteUser(targetUserId: string, actorId: string): Promise<BasicUserRow> {
  return updateSingleUser(targetUserId, actorId, 'user_deleted', {
    isDeleted: true,
    deletedAt: new Date(),
  }, { deletedAt: new Date().toISOString() });
}

export async function restoreUser(targetUserId: string, actorId: string): Promise<BasicUserRow> {
  return updateSingleUser(targetUserId, actorId, 'user_restored', {
    isDeleted: false,
    deletedAt: null,
  }, { restoredAt: new Date().toISOString() });
}

export async function banUser(targetUserId: string, actorId: string): Promise<BasicUserRow> {
  const user = await prisma.user.findUnique({ where: { id: targetUserId }, select: { isBanned: true } });
  if (!user) {
    throw new AppError(404, 'User not found');
  }

  return updateSingleUser(targetUserId, actorId, user.isBanned ? 'user_unbanned' : 'user_banned', {
    isBanned: !user.isBanned,
  }, { banned: !user.isBanned });
}

export async function unbanUser(targetUserId: string, actorId: string): Promise<BasicUserRow> {
  return updateSingleUser(targetUserId, actorId, 'user_unbanned', {
    isBanned: false,
  }, { banned: false });
}

export async function activateUser(targetUserId: string, actorId: string): Promise<BasicUserRow> {
  return updateSingleUser(targetUserId, actorId, 'user_activated', {
    isActive: true,
  }, { active: true });
}

export async function deactivateUser(targetUserId: string, actorId: string): Promise<BasicUserRow> {
  return updateSingleUser(targetUserId, actorId, 'user_deactivated', {
    isActive: false,
  }, { active: false });
}

export async function verifyEmail(targetUserId: string, actorId: string): Promise<BasicUserRow> {
  return updateSingleUser(targetUserId, actorId, 'email_verified', {
    isEmailVerified: true,
  }, { verified: true });
}

export async function changeRole(targetUserId: string, roleId: number, actorId: string): Promise<BasicUserRow> {
  const role = await getUserRoleOrThrow(roleId);
  return updateSingleUser(targetUserId, actorId, 'role_changed', {
    role: { connect: { id: roleId } },
  }, { roleId, roleName: role.name });
}

export async function resetWallet(targetUserId: string, actorId: string): Promise<BasicUserRow> {
  const wallet = await prisma.tokenWallet.findUnique({
    where: { userId: targetUserId },
    select: { id: true, tokenBalance: true },
  });

  const previousBalance = wallet?.tokenBalance ?? 0;
  await prisma.$transaction(async (tx) => {
    if (wallet && wallet.tokenBalance !== 0) {
      await tx.tokenTransaction.create({
        data: {
          walletId: wallet.id,
          userId: targetUserId,
          type: 'ADJUSTMENT',
          source: 'ADMIN',
          tokens: -wallet.tokenBalance,
          referenceId: `wallet-reset:${targetUserId}:${Date.now()}`,
          metadata: { reason: 'admin_reset_wallet' },
        },
      });

      await tx.tokenWallet.update({
        where: { userId: targetUserId },
        data: { tokenBalance: 0, status: 'ACTIVE' },
      });
    } else if (!wallet) {
      await tx.tokenWallet.create({
        data: {
          userId: targetUserId,
          tokenBalance: 0,
          status: 'ACTIVE',
        },
      });
    }

    await tx.auditLog.create({
      data: {
        actorId,
        targetUserId,
        action: 'wallet_reset',
        metadata: { previousBalance },
      },
    });
  });

  logDashboardAction('wallet_reset', { actorId, targetUserId });

  return getBasicUser(targetUserId);
}

export async function resetXp(targetUserId: string, actorId: string): Promise<BasicUserRow> {
  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { xp: true, level: true },
  });

  if (!user) {
    throw new AppError(404, 'User not found');
  }

  await prisma.$transaction(async (tx) => {
    if (user.xp !== 0) {
      await tx.xpTransaction.create({
        data: {
          userId: targetUserId,
          amount: -user.xp,
          reason: 'admin_reset_xp',
        },
      });
    }

    await tx.user.update({
      where: { id: targetUserId },
      data: { xp: 0, level: 1 },
    });

    await tx.auditLog.create({
      data: {
        actorId,
        targetUserId,
        action: 'xp_reset',
        metadata: { previousXp: user.xp, previousLevel: user.level },
      },
    });
  });

  logDashboardAction('xp_reset', { actorId, targetUserId, previousXp: user.xp });

  return getBasicUser(targetUserId);
}

async function getBasicUser(targetUserId: string): Promise<BasicUserRow> {
  return prisma.user.findUniqueOrThrow({
    where: { id: targetUserId },
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      bio: true,
      gender: true,
      nationality: true,
      language: true,
      budgetLevel: true,
      arrivalDate: true,
      departureDate: true,
      travelStyle: true,
      interests: true,
      accommodationType: true,
      isEmailVerified: true,
      isActive: true,
      isBanned: true,
      isDeleted: true,
      roleId: true,
      xp: true,
      level: true,
      createdAt: true,
      updatedAt: true,
      lastLoginAt: true,
      role: {
        select: {
          id: true,
          name: true,
          permissions: true,
        },
      },
    },
  });
}

export async function bulkAction(action: 'delete' | 'restore' | 'ban' | 'unban' | 'activate' | 'deactivate' | 'verify', ids: string[], actorId: string, roleId?: number): Promise<{ affected: number }> {
  if (ids.length === 0) {
    throw new AppError(400, 'At least one user id is required');
  }

  const now = new Date();
  const uniqueIds = Array.from(new Set(ids));
  const where = { id: { in: uniqueIds } };

  const [auditAction, data, metadata]: [string, Prisma.UserUpdateManyMutationInput, Record<string, unknown>] = (() => {
    switch (action) {
      case 'delete':
        return ['users_bulk_deleted', { isDeleted: true, deletedAt: now }, { ids: uniqueIds }];
      case 'restore':
        return ['users_bulk_restored', { isDeleted: false, deletedAt: null }, { ids: uniqueIds }];
      case 'ban':
        return ['users_bulk_banned', { isBanned: true }, { ids: uniqueIds }];
      case 'unban':
        return ['users_bulk_unbanned', { isBanned: false }, { ids: uniqueIds }];
      case 'activate':
        return ['users_bulk_activated', { isActive: true }, { ids: uniqueIds }];
      case 'deactivate':
        return ['users_bulk_deactivated', { isActive: false }, { ids: uniqueIds }];
      case 'verify':
        return ['users_bulk_verified', { isEmailVerified: true }, { ids: uniqueIds }];
    }
  })();

  const result = await prisma.$transaction(async (tx) => {
    const update = await tx.user.updateMany({ where, data });
    await tx.auditLog.create({
      data: {
        actorId,
        targetUserId: null,
        action: auditAction,
        metadata: { ...metadata, affected: update.count },
      },
    });
    return update;
  });

  logDashboardAction(auditAction, { actorId, affected: result.count });
  return { affected: result.count };
}

export async function bulkChangeRole(ids: string[], roleId: number, actorId: string): Promise<{ affected: number }> {
  if (ids.length === 0) {
    throw new AppError(400, 'At least one user id is required');
  }

  const uniqueIds = Array.from(new Set(ids));
  const role = await getUserRoleOrThrow(roleId);

  const result = await prisma.$transaction(async (tx) => {
    const update = await tx.user.updateMany({
      where: { id: { in: uniqueIds } },
      data: { roleId },
    });

    await tx.auditLog.create({
      data: {
        actorId,
        targetUserId: null,
        action: 'users_bulk_role_changed',
        metadata: {
          ids: uniqueIds,
          roleId,
          roleName: role.name,
          affected: update.count,
        },
      },
    });

    return update;
  });

  logDashboardAction('users_bulk_role_changed', { actorId, affected: result.count, roleId });

  return { affected: result.count };
}

export async function bulkExport(ids: string[], actorId: string, format: DashboardExportFormat): Promise<{ filename: string; contentType: string; data: string }> {
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) {
    throw new AppError(400, 'At least one user id is required');
  }

  const users = await prisma.user.findMany({
    where: { id: { in: uniqueIds } },
    orderBy: { createdAt: 'desc' },
    select: userSummarySelect,
  }) as UserSummaryRow[];

  const rows = users.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    avatar: row.avatarUrl,
    role: row.role?.name ?? 'user',
    walletBalance: row.tokenWallet?.tokenBalance ?? 0,
    walletStatus: row.tokenWallet?.status ?? null,
    xp: row.xp,
    level: row.level,
    active: row.isActive,
    verified: row.isEmailVerified,
    banned: row.isBanned,
    deleted: row.isDeleted,
    createdAt: row.createdAt.toISOString(),
    lastLogin: row.lastLoginAt?.toISOString() ?? '',
    paymentsCount: row._count.payments,
    tripsCount: row._count.tripHistories,
    badgesCount: row._count.userBadges,
    conversationCount: row._count.conversations,
  }));

  const data = format === 'csv' ? buildCsv(rows) : buildExcelXml(rows);
  const filename = `dashboard-users-bulk-${Date.now()}.${format === 'csv' ? 'csv' : 'xls'}`;

  await createAuditLog(actorId, null, 'users_bulk_exported', { ids: uniqueIds, format, total: rows.length });
  logDashboardAction('users_bulk_exported', { actorId, total: rows.length, format });

  return {
    filename,
    contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.ms-excel; charset=utf-8',
    data,
  };
}
