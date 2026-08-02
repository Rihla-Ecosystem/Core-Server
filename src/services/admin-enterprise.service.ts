import { Prisma, NotificationType } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export interface RoleListParams {
  page: number;
  limit: number;
  search?: string;
  sort?: 'id' | 'name' | 'createdAt';
  order?: 'asc' | 'desc';
}

export async function listRoles(params: RoleListParams) {
  const { page, limit, search, sort = 'id', order = 'asc' } = params;
  const where: Prisma.RoleWhereInput = search
    ? { name: { contains: search, mode: 'insensitive' } }
    : {};

  const [total, rows] = await Promise.all([
    prisma.role.count({ where }),
    prisma.role.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { [sort]: order },
      include: { _count: { select: { users: true } } },
    }),
  ]);

  const roles = rows.map((role) => ({
    ...role,
    permissions: Array.isArray(role.permissions) ? role.permissions : [],
    userCount: role._count.users,
    _count: undefined,
  }));

  return {
    roles,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getRole(id: number) {
  const role = await prisma.role.findUnique({
    where: { id },
    include: { _count: { select: { users: true } } },
  });
  if (!role) throw new AppError(404, 'Role not found');
  return {
    ...role,
    permissions: Array.isArray(role.permissions) ? role.permissions : [],
    userCount: role._count.users,
    _count: undefined,
  };
}

export async function createRole(data: { name: string; permissions?: string[] }) {
  const existing = await prisma.role.findUnique({ where: { name: data.name } });
  if (existing) throw new AppError(409, 'Role already exists');
  return prisma.role.create({ data: { name: data.name, permissions: data.permissions ?? [] } });
}

export async function updateRole(id: number, data: { name?: string; permissions?: string[] }) {
  await getRole(id);
  return prisma.role.update({
    where: { id },
    data: { ...(data.name !== undefined ? { name: data.name } : {}), ...(data.permissions !== undefined ? { permissions: data.permissions } : {}) },
  });
}

export async function deleteRole(id: number, actorId: string) {
  const role = await getRole(id);
  if (role.userCount > 0) throw new AppError(409, 'Role has users assigned; reassign them before deleting');
  await prisma.role.delete({ where: { id } });
  await prisma.auditLog.create({
    data: { actorId, action: 'role_deleted', metadata: { roleId: id, roleName: role.name } },
  });
  return { id, name: role.name, deleted: true };
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export interface BadgeListParams {
  page: number;
  limit: number;
  search?: string;
  criteriaType?: string;
}

export async function listBadges(params: BadgeListParams) {
  const { page, limit, search, criteriaType } = params;
  const where: Prisma.BadgeWhereInput = {
    ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
    ...(criteriaType ? { criteriaType } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.badge.count({ where }),
    prisma.badge.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { userBadges: true } } },
    }),
  ]);

  const badges = rows.map((badge) => ({ ...badge, awardedCount: badge._count.userBadges, _count: undefined }));
  return {
    badges,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getBadge(id: number) {
  const badge = await prisma.badge.findUnique({
    where: { id },
    include: { _count: { select: { userBadges: true } } },
  });
  if (!badge) throw new AppError(404, 'Badge not found');
  return { ...badge, awardedCount: badge._count.userBadges, _count: undefined };
}

export async function createBadge(data: {
  name: string;
  description?: string | null;
  iconUrl?: string | null;
  criteriaType?: 'xp_threshold' | 'action_count' | 'manual';
  criteriaValue?: number | null;
}) {
  const existing = await prisma.badge.findUnique({ where: { name: data.name } });
  if (existing) throw new AppError(409, 'Badge already exists');
  return prisma.badge.create({
    data: {
      name: data.name,
      description: data.description ?? null,
      iconUrl: data.iconUrl ?? null,
      criteriaType: data.criteriaType ?? 'manual',
      criteriaValue: data.criteriaValue ?? null,
    },
  });
}

export async function updateBadge(id: number, data: Prisma.BadgeUpdateInput) {
  await getBadge(id);
  return prisma.badge.update({ where: { id }, data });
}

export async function deleteBadge(id: number, actorId: string) {
  const badge = await getBadge(id);
  await prisma.userBadge.deleteMany({ where: { badgeId: id } });
  await prisma.badge.delete({ where: { id } });
  await prisma.auditLog.create({
    data: { actorId, action: 'badge_deleted', metadata: { badgeId: id, badgeName: badge.name } },
  });
  return { id, name: badge.name, deleted: true };
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

export interface JourneyListParams {
  page: number;
  limit: number;
  search?: string;
  isActive?: boolean;
  sort?: 'title' | 'xpReward' | 'createdAt' | 'updatedAt';
  order?: 'asc' | 'desc';
}

export async function listJourneys(params: JourneyListParams) {
  const { page, limit, search, isActive, sort = 'createdAt', order = 'desc' } = params;
  const where: Prisma.JourneyWhereInput = {
    ...(search ? { title: { contains: search, mode: 'insensitive' } } : {}),
    ...(isActive !== undefined ? { isActive } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.journey.count({ where }),
    prisma.journey.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { [sort]: order },
      include: {
        _count: { select: { steps: true, progress: true } },
        progress: { select: { completedAt: true } },
      },
    }),
  ]);

  const journeys = rows.map(({ progress, ...journey }) => ({
    ...journey,
    stepsCount: journey._count.steps,
    participantsCount: journey._count.progress,
    completedCount: progress.filter((p) => p.completedAt !== null).length,
    _count: undefined,
  }));

  return {
    journeys,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getJourney(id: string) {
  const journey = await prisma.journey.findUnique({
    where: { id },
    include: {
      steps: { orderBy: { stepNumber: 'asc' } },
      _count: { select: { progress: true } },
      progress: {
        select: { userId: true, startedAt: true, completedAt: true },
        orderBy: { startedAt: 'desc' },
        take: 50,
      },
    },
  });
  if (!journey) throw new AppError(404, 'Journey not found');
  return journey;
}

export async function createJourney(data: {
  slug: string;
  title: string;
  description?: string | null;
  xpReward?: number;
  isActive?: boolean;
  steps?: Array<{ stepNumber: number; title: string; content: string; xpReward?: number }>;
}) {
  const existing = await prisma.journey.findUnique({ where: { slug: data.slug } });
  if (existing) throw new AppError(409, 'Journey slug already exists');

  return prisma.$transaction(async (tx) => {
    const journey = await tx.journey.create({
      data: {
        slug: data.slug,
        title: data.title,
        description: data.description ?? null,
        xpReward: data.xpReward ?? 0,
        isActive: data.isActive ?? true,
      },
    });
    if (data.steps && data.steps.length > 0) {
      await tx.journeyStep.createMany({
        data: data.steps.map((step) => ({
          journeyId: journey.id,
          stepNumber: step.stepNumber,
          title: step.title,
          content: step.content,
          xpReward: step.xpReward ?? 0,
        })),
      });
    }
    return journey;
  });
}

export async function updateJourney(id: string, data: Prisma.JourneyUpdateInput) {
  await getJourney(id);
  return prisma.journey.update({ where: { id }, data });
}

export async function deleteJourney(id: string, actorId: string) {
  const journey = await getJourney(id);
  await prisma.journey.delete({ where: { id } });
  await prisma.auditLog.create({
    data: { actorId, action: 'journey_deleted', metadata: { journeyId: id, title: journey.title } },
  });
  return { id, title: journey.title, deleted: true };
}

export async function addJourneyStep(
  journeyId: string,
  data: { stepNumber: number; title: string; content: string; xpReward?: number },
) {
  await getJourney(journeyId);
  const duplicate = await prisma.journeyStep.findUnique({
    where: { journeyId_stepNumber: { journeyId, stepNumber: data.stepNumber } },
  });
  if (duplicate) throw new AppError(409, 'A step with this stepNumber already exists');
  return prisma.journeyStep.create({
    data: { journeyId, ...data, xpReward: data.xpReward ?? 0 },
  });
}

export async function updateJourneyStep(journeyId: string, stepId: string, data: Prisma.JourneyStepUpdateInput) {
  const step = await prisma.journeyStep.findFirst({ where: { id: stepId, journeyId } });
  if (!step) throw new AppError(404, 'Journey step not found');
  return prisma.journeyStep.update({ where: { id: stepId }, data });
}

export async function deleteJourneyStep(journeyId: string, stepId: string) {
  const step = await prisma.journeyStep.findFirst({ where: { id: stepId, journeyId } });
  if (!step) throw new AppError(404, 'Journey step not found');
  await prisma.journeyStep.delete({ where: { id: stepId } });
  return { id: stepId, deleted: true };
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

export interface TripListParams {
  page: number;
  limit: number;
  search?: string;
  destination?: string;
  from?: Date;
  to?: Date;
  sort?: 'startDate' | 'endDate' | 'createdAt' | 'updatedAt' | 'title';
  order?: 'asc' | 'desc';
}

export async function listTrips(params: TripListParams) {
  const { page, limit, search, destination, from, to, sort = 'createdAt', order = 'desc' } = params;
  const where: Prisma.TripHistoryWhereInput = {
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { destination: { contains: search, mode: 'insensitive' } },
            { user: { displayName: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
    ...(destination ? { destination: { contains: destination, mode: 'insensitive' } } : {}),
    ...(from || to
      ? {
          startDate: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.tripHistory.count({ where }),
    prisma.tripHistory.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { [sort]: order },
      include: { user: { select: { id: true, displayName: true, email: true } } },
    }),
  ]);

  return {
    trips: rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getTrip(id: string) {
  const trip = await prisma.tripHistory.findUnique({
    where: { id },
    include: { user: { select: { id: true, displayName: true, email: true } } },
  });
  if (!trip) throw new AppError(404, 'Trip not found');
  return trip;
}

export async function deleteTrip(id: string, actorId: string) {
  const trip = await getTrip(id);
  await prisma.tripHistory.delete({ where: { id } });
  await prisma.auditLog.create({
    data: { actorId, action: 'trip_deleted', metadata: { tripId: id, title: trip.title } },
  });
  return { id, title: trip.title, deleted: true };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export interface ConversationListParams {
  page: number;
  limit: number;
  search?: string;
  sort?: 'createdAt' | 'updatedAt' | 'title';
  order?: 'asc' | 'desc';
}

export async function listConversations(params: ConversationListParams) {
  const { page, limit, search, sort = 'updatedAt', order = 'desc' } = params;
  const where: Prisma.ConversationWhereInput = search
    ? {
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { user: { displayName: { contains: search, mode: 'insensitive' } } },
          { user: { email: { contains: search, mode: 'insensitive' } } },
        ],
      }
    : {};

  const [total, rows] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { [sort]: order },
      include: {
        user: { select: { id: true, displayName: true, email: true } },
        _count: { select: { messages: true } },
      },
    }),
  ]);

  const conversations = rows.map(({ _count, ...conversation }) => ({
    ...conversation,
    messagesCount: _count.messages,
  }));

  return {
    conversations,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getConversation(id: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, displayName: true, email: true } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!conversation) throw new AppError(404, 'Conversation not found');
  return conversation;
}

// ---------------------------------------------------------------------------
// Token transactions
// ---------------------------------------------------------------------------

export interface TransactionListParams {
  page: number;
  limit: number;
  search?: string;
  type?: string;
  source?: string;
  userId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  sort?: 'createdAt' | 'tokens';
  order?: 'asc' | 'desc';
}

export async function listTransactions(params: TransactionListParams) {
  const { page, limit, search, type, source, userId, dateFrom, dateTo, sort = 'createdAt', order = 'desc' } = params;
  const where: Prisma.TokenTransactionWhereInput = {
    ...(type ? { type: type as never } : {}),
    ...(source ? { source: source as never } : {}),
    ...(userId ? { userId } : {}),
    ...(dateFrom || dateTo
      ? { createdAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } }
      : {}),
    ...(search
      ? {
          OR: [
            { user: { displayName: { contains: search, mode: 'insensitive' } } },
            { user: { email: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.tokenTransaction.count({ where }),
    prisma.tokenTransaction.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { [sort]: order },
      include: {
        user: { select: { id: true, displayName: true, email: true } },
        payment: { select: { id: true, amount: true, status: true } },
      },
    }),
  ]);

  return {
    transactions: rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getTransactionStatistics() {
  const [byType, bySource, totals] = await Promise.all([
    prisma.tokenTransaction.groupBy({
      by: ['type'],
      _sum: { tokens: true },
      _count: { id: true },
    }),
    prisma.tokenTransaction.groupBy({
      by: ['source'],
      _sum: { tokens: true },
      _count: { id: true },
    }),
    prisma.tokenTransaction.aggregate({
      _sum: { tokens: true },
      _count: { id: true },
    }),
  ]);

  return {
    totalTransactions: totals._count.id,
    totalTokens: totals._sum.tokens ?? 0,
    byType: byType.map((row) => ({
      type: row.type,
      tokens: row._sum.tokens ?? 0,
      count: row._count.id,
    })),
    bySource: bySource.map((row) => ({
      source: row.source,
      tokens: row._sum.tokens ?? 0,
      count: row._count.id,
    })),
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationListParams {
  page: number;
  limit: number;
  type?: string;
  isRead?: boolean;
  userId?: string;
  sort?: 'createdAt';
  order?: 'asc' | 'desc';
}

export async function listNotifications(params: NotificationListParams) {
  const { page, limit, type, isRead, userId, sort = 'createdAt', order = 'desc' } = params;
  const where: Prisma.NotificationWhereInput = {
    ...(type ? { type: type as NotificationType } : {}),
    ...(isRead !== undefined ? { isRead } : {}),
    ...(userId ? { userId } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { [sort]: order },
      include: { user: { select: { id: true, displayName: true, email: true } } },
    }),
  ]);

  return {
    notifications: rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function listUserNotifications(userId: string, page: number, limit: number, isRead?: boolean) {
  const where: Prisma.NotificationWhereInput = { userId, ...(isRead !== undefined ? { isRead } : {}) };
  const [total, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
  ]);
  return { notifications: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getUnreadCount(userId: string) {
  return prisma.notification.count({ where: { userId, isRead: false } });
}

export async function markNotificationRead(notificationId: string, userId: string) {
  const notification = await prisma.notification.findFirst({ where: { id: notificationId, userId } });
  if (!notification) throw new AppError(404, 'Notification not found');
  return prisma.notification.update({
    where: { id: notificationId },
    data: { isRead: true, readAt: new Date() },
  });
}

export async function markAllNotificationsRead(userId: string) {
  const { count } = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return { updated: count };
}

export async function deleteNotification(notificationId: string, userId: string) {
  const notification = await prisma.notification.findFirst({ where: { id: notificationId, userId } });
  if (!notification) throw new AppError(404, 'Notification not found');
  await prisma.notification.delete({ where: { id: notificationId } });
  return { id: notificationId, deleted: true };
}

export async function createNotification(data: {
  type: NotificationType;
  title: string;
  message: string;
  data?: Prisma.InputJsonValue;
  userId?: string;
}) {
  if (data.userId) {
    const user = await prisma.user.findUnique({ where: { id: data.userId } });
    if (!user) throw new AppError(404, 'Target user not found');
    const notification = await prisma.notification.create({
      data: {
        type: data.type,
        title: data.title,
        message: data.message,
        data: data.data ?? undefined,
        userId: data.userId,
      },
    });
    return { notification };
  }

  // Broadcast to all non-deleted users.
  const users = await prisma.user.findMany({ where: { isDeleted: false }, select: { id: true } });
  await prisma.notification.createMany({
    data: users.map((user) => ({
      type: data.type,
      title: data.title,
      message: data.message,
      data: data.data ?? undefined,
      userId: user.id,
    })),
  });
  return { broadcast: true, recipients: users.length };
}

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------

export interface AuditLogListParams {
  page: number;
  limit: number;
  search?: string;
  action?: string;
  actorId?: string;
  targetUserId?: string;
  from?: Date;
  to?: Date;
}

export async function listAuditLogs(params: AuditLogListParams) {
  const { page, limit, search, action, actorId, targetUserId, from, to } = params;
  const where: Prisma.AuditLogWhereInput = {
    ...(action ? { action: { contains: action, mode: 'insensitive' } } : {}),
    ...(actorId ? { actorId } : {}),
    ...(targetUserId ? { targetUserId } : {}),
    ...(from || to
      ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
    ...(search
      ? {
          OR: [
            { action: { contains: search, mode: 'insensitive' } },
            { actor: { displayName: { contains: search, mode: 'insensitive' } } },
            { target: { displayName: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        actor: { select: { displayName: true, email: true } },
        target: { select: { displayName: true, email: true } },
      },
    }),
  ]);

  return { logs, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// ---------------------------------------------------------------------------
// Overview & system health
// ---------------------------------------------------------------------------

export async function getOverview() {
  const [
    userCounts,
    paymentCounts,
    tokenTotals,
    badgeCount,
    journeyCount,
    tripCount,
    conversationCount,
    messageCount,
    transactionCount,
    auditLogCount,
    walletTotals,
    notificationCount,
    activeSessionCount,
  ] = await Promise.all([
    prisma.user.aggregate({
      _count: { id: true },
      _sum: { xp: true },
      _avg: { level: true },
      _max: { level: true },
    }),
    prisma.payment.groupBy({ by: ['status'], _count: { id: true }, _sum: { amount: true } }),
    prisma.tokenTransaction.aggregate({
      _sum: { tokens: true },
      _count: { id: true },
    }),
    prisma.badge.count(),
    prisma.journey.count(),
    prisma.tripHistory.count(),
    prisma.conversation.count(),
    prisma.message.count(),
    prisma.tokenTransaction.count(),
    prisma.auditLog.count(),
    prisma.tokenWallet.aggregate({ _sum: { tokenBalance: true }, _count: { id: true } }),
    prisma.notification.count(),
    prisma.refreshToken.count({ where: { revokedAt: null } }),
  ]);

  const statusBreakdown: Record<string, { count: number; total: number }> = {};
  for (const row of paymentCounts) {
    statusBreakdown[row.status] = { count: row._count.id, total: Number(row._sum.amount ?? 0) };
  }

  return {
    users: {
      total: userCounts._count.id,
      totalXp: userCounts._sum.xp ?? 0,
      averageLevel: Math.round((userCounts._avg.level ?? 0) * 100) / 100,
      maxLevel: userCounts._max.level ?? 0,
      activeSessions: activeSessionCount,
    },
    payments: {
      total: paymentCounts.reduce((sum, row) => sum + row._count.id, 0),
      totalRevenue: paymentCounts.reduce((sum, row) => sum + Number(row._sum.amount ?? 0), 0),
      byStatus: statusBreakdown,
    },
    tokens: {
      totalTokens: tokenTotals._sum.tokens ?? 0,
      totalTransactions: tokenTotals._count.id,
      walletBalance: walletTotals._sum.tokenBalance ?? 0,
      walletCount: walletTotals._count.id,
    },
    content: {
      badges: badgeCount,
      journeys: journeyCount,
      trips: tripCount,
      conversations: conversationCount,
      messages: messageCount,
      transactions: transactionCount,
      auditLogs: auditLogCount,
      notifications: notificationCount,
    },
  };
}

export interface ServiceHealth {
  name: string;
  status: 'online' | 'offline' | 'degraded' | 'unknown';
  latencyMs: number | null;
  error: string | null;
  version?: string;
}

async function probeService(name: string, url: string, path: string, timeoutMs = 3000): Promise<ServiceHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${url}${path}`, { signal: controller.signal });
    const latencyMs = Date.now() - started;
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      name,
      status: response.ok ? 'online' : 'degraded',
      latencyMs,
      error: response.ok ? null : `HTTP ${response.status}`,
      version: typeof data.version === 'string' ? data.version : undefined,
    };
  } catch (err) {
    return { name, status: 'offline', latencyMs: null, error: err instanceof Error ? err.message : 'Unknown error' };
  } finally {
    clearTimeout(timer);
  }
}

export async function getSystemHealth() {
  const started = Date.now();

  let databaseStatus: 'online' | 'offline' = 'online';
  let databaseError: string | null = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    databaseStatus = 'offline';
    databaseError = err instanceof Error ? err.message : 'Unknown error';
  }

  const services = await Promise.all([
    probeService('ai-service', env.AI_SERVICE_URL, '/health'),
    probeService('geocontext', env.GIS_SERVICE_URL, '/healthz'),
    probeService('risk-intelligence', env.RISK_SERVICE_URL, '/healthz'),
    probeService('core-server', `http://localhost:${env.PORT}`, '/health'),
  ]);

  return {
    status: databaseStatus === 'offline' || services.every((s) => s.status === 'offline') ? 'degraded' : 'ok',
    time: new Date().toISOString(),
    responseTimeMs: Date.now() - started,
    uptimeSeconds: Math.round(process.uptime()),
    version: '0.1.0',
    database: { name: 'core-server-postgres', status: databaseStatus, error: databaseError },
    services,
  };
}

export async function getEntityStatistics() {
  const [roles, badges, journeys, trips, conversations, transactions, payments, packages, notifications] =
    await Promise.all([
      prisma.role.count(),
      prisma.badge.count(),
      prisma.journey.count(),
      prisma.tripHistory.count(),
      prisma.conversation.count(),
      prisma.tokenTransaction.count(),
      prisma.payment.count(),
      prisma.tokenPackage.count(),
      prisma.notification.count(),
    ]);

  return {
    roles,
    badges,
    journeys,
    trips,
    conversations,
    transactions,
    payments,
    tokenPackages: packages,
    notifications,
  };
}
