// ---------------------------------------------------------------------------
// Notification Administration Service
// ---------------------------------------------------------------------------
// Powers the Dashboard's Notification Management module: create notifications,
// broadcast to all/selected users, target by role/governorate/city/polygon/
// radius, schedule, templates, categories, context reports, analytics, delivery
// logs, user inbox, read/unread statistics and settings.
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { toInputJsonValue } from '../utils/json.js';
import { publishToUser } from './notification-realtime.service.js';
import type {
  GeneratedNotification,
} from '../types/context-notification.js';

export interface AudienceSpec {
  all?: boolean;
  userIds?: string[];
  roles?: string[];
  governorates?: string[];
  cities?: string[];
  polygons?: Array<{ lat: number; lng: number }[]>;
  radius?: { lat: number; lng: number; km: number };
}

export interface CreateNotificationInput {
  title: string;
  message: string;
  type?: GeneratedNotification['type'];
  category?: GeneratedNotification['category'];
  priority?: GeneratedNotification['priority'];
  audience?: AudienceSpec;
  schedule?: { sendAt?: string };
  templateId?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeAudience(audience?: AudienceSpec): AudienceSpec {
  return audience ?? { all: true };
}

async function resolveRecipients(audience: AudienceSpec): Promise<{ userIds: string[]; total: number }> {
  const a = normalizeAudience(audience);
  if (a.all) {
    const users = await prisma.user.findMany({ where: { isDeleted: false }, select: { id: true } });
    return { userIds: users.map((u) => u.id), total: users.length };
  }

  const where: Prisma.UserWhereInput = {
    isDeleted: false,
    ...(a.roles && a.roles.length ? { role: { name: { in: a.roles.map((r) => r.toLowerCase()) } } } : {}),
  };

  const roleUsers = a.roles && a.roles.length
    ? await prisma.user.findMany({ where, select: { id: true } })
    : [];

  const ids = new Set<string>(a.userIds ?? []);
  for (const u of roleUsers) ids.add(u.id);

  // Governorate / city / polygon / radius targeting rely on the user's
  // latest reported location (UserNotificationStatus).
  if (a.governorates?.length || a.cities?.length || a.polygons?.length || a.radius) {
    const statuses = await prisma.userNotificationStatus.findMany({ select: { userId: true, lastLat: true, lastLng: true } });
    for (const s of statuses) {
      if (s.lastLat == null || s.lastLng == null) continue;
      if (a.radius && pointInRadius(s.lastLat, s.lastLng, a.radius)) {
        ids.add(s.userId);
        continue;
      }
      if (a.polygons?.length && a.polygons.some((poly) => pointInPolygon(s.lastLat!, s.lastLng!, poly))) {
        ids.add(s.userId);
      }
    }
  }

  return { userIds: [...ids], total: ids.size };
}

function pointInRadius(lat: number, lng: number, radius: { lat: number; lng: number; km: number }): boolean {
  return haversineKm(lat, lng, radius.lat, radius.lng) <= radius.km;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function pointInPolygon(lat: number, lng: number, polygon: Array<{ lat: number; lng: number }>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates(params: { page?: number; limit?: number; search?: string; isActive?: boolean }) {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const where: Prisma.NotificationTemplateWhereInput = {
    ...(params.isActive !== undefined ? { isActive: params.isActive } : {}),
    ...(params.search ? { OR: [{ name: { contains: params.search, mode: 'insensitive' } }, { code: { contains: params.search, mode: 'insensitive' } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.notificationTemplate.count({ where }),
    prisma.notificationTemplate.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return { templates: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function createTemplate(input: {
  code: string;
  name: string;
  title: string;
  message: string;
  type?: GeneratedNotification['type'];
  category?: GeneratedNotification['category'];
  priority?: GeneratedNotification['priority'];
  variables?: Record<string, unknown>;
  data?: Record<string, unknown>;
}, actorId: string) {
  const existing = await prisma.notificationTemplate.findUnique({ where: { code: input.code } });
  if (existing) throw new AppError(409, 'Template code already exists');
  return prisma.notificationTemplate.create({
    data: {
      code: input.code,
      name: input.name,
      title: input.title,
      message: input.message,
      type: input.type ?? 'INFO',
      category: input.category ?? 'SYSTEM',
      priority: input.priority ?? 'NORMAL',
      variables: input.variables != null ? toInputJsonValue(input.variables) : undefined,
      data: input.data != null ? toInputJsonValue(input.data) : undefined,
      createdById: actorId,
    },
  });
}

export async function updateTemplate(id: string, input: Partial<Record<string, unknown>>) {
  const template = await prisma.notificationTemplate.findUnique({ where: { id } });
  if (!template) throw new AppError(404, 'Template not found');
  return prisma.notificationTemplate.update({ where: { id }, data: input as never });
}

export async function deleteTemplate(id: string) {
  const template = await prisma.notificationTemplate.findUnique({ where: { id } });
  if (!template) throw new AppError(404, 'Template not found');
  await prisma.notificationTemplate.delete({ where: { id } });
  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// Notifications (admin CRUD + broadcast + scheduling)
// ---------------------------------------------------------------------------

export async function listAdminNotifications(params: {
  page?: number; limit?: number; search?: string;
  type?: string; category?: string; priority?: string; source?: string; isRead?: boolean; userId?: string;
}) {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const where: Prisma.NotificationInboxWhereInput = {
    ...(params.type ? { type: params.type as never } : {}),
    ...(params.category ? { category: params.category as never } : {}),
    ...(params.priority ? { priority: params.priority as never } : {}),
    ...(params.source ? { source: params.source as never } : {}),
    ...(params.isRead !== undefined ? { isRead: params.isRead } : {}),
    ...(params.userId ? { userId: params.userId } : {}),
    ...(params.search
      ? { OR: [{ title: { contains: params.search, mode: 'insensitive' } }, { message: { contains: params.search, mode: 'insensitive' } }] }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.notificationInbox.count({ where }),
    prisma.notificationInbox.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, displayName: true, email: true } } },
    }),
  ]);
  return { notifications: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function createAndSendNotification(input: CreateNotificationInput, actorId: string) {
  const audience = normalizeAudience(input.audience);
  const { userIds, total } = await resolveRecipients(audience);

  if (input.schedule?.sendAt && new Date(input.schedule.sendAt).getTime() > Date.now()) {
    const scheduled = await prisma.notificationHistory.create({
      data: {
        title: input.title,
        message: input.message,
        type: input.type ?? 'INFO',
        category: input.category ?? 'SYSTEM',
        priority: input.priority ?? 'NORMAL',
        source: 'ADMIN',
        audience: toInputJsonValue(audience),
        schedule: { sendAt: input.schedule.sendAt },
        status: 'SCHEDULED',
        scheduledAt: new Date(input.schedule.sendAt),
        recipients: total,
        createdById: actorId,
        templateId: input.templateId ?? undefined,
      },
    });
    return { scheduled: true, historyId: scheduled.id, recipients: total };
  }

  return sendNotification(input, actorId, userIds, total);
}

export async function sendNotification(
  input: CreateNotificationInput,
  actorId: string,
  userIds?: string[],
  total?: number,
) {
  let recipients = userIds;
  let recipientTotal = total ?? 0;
  if (!recipients) {
    const resolved = await resolveRecipients(normalizeAudience(input.audience));
    recipients = resolved.userIds;
    recipientTotal = resolved.total;
  }

  const history = await prisma.notificationHistory.create({
    data: {
      title: input.title,
      message: input.message,
      type: input.type ?? 'INFO',
      category: input.category ?? 'SYSTEM',
      priority: input.priority ?? 'NORMAL',
      source: 'ADMIN',
      audience: toInputJsonValue(normalizeAudience(input.audience)),
      status: 'SENT',
      sentAt: new Date(),
      recipients: recipientTotal,
      delivered: recipients.length,
      createdById: actorId,
      templateId: input.templateId ?? undefined,
    },
  });

  let delivered = 0;
  for (const userId of recipients) {
    const inbox = await prisma.notificationInbox.create({
      data: {
        userId,
        historyId: history.id,
        type: input.type ?? 'INFO',
        category: input.category ?? 'SYSTEM',
        priority: input.priority ?? 'NORMAL',
        source: 'ADMIN',
        title: input.title,
        message: input.message,
        data: input.data != null ? toInputJsonValue(input.data) : undefined,
      },
    });
    await prisma.notificationLog.create({
      data: { userId, notificationId: inbox.id, historyId: history.id, event: 'DELIVERED', detail: 'Admin broadcast' },
    });
    const sent = publishToUser(userId, inbox as never);
    if (sent > 0) delivered++;
  }

  await prisma.notificationAnalytics.upsert({
    where: { date: todayUtc() },
    update: { totalSent: { increment: recipients.length }, totalDelivered: { increment: recipients.length } },
    create: { date: todayUtc(), totalSent: recipients.length, totalDelivered: recipients.length },
  });

  return { notification: history, recipients: recipients.length, delivered };
}

function todayUtc(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function listHistory(params: { page?: number; limit?: number; search?: string; status?: string; category?: string }) {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const where: Prisma.NotificationHistoryWhereInput = {
    ...(params.status ? { status: params.status as never } : {}),
    ...(params.category ? { category: params.category as never } : {}),
    ...(params.search ? { title: { contains: params.search, mode: 'insensitive' } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.notificationHistory.count({ where }),
    prisma.notificationHistory.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
  ]);
  return { history: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function cancelScheduled(historyId: string) {
  const h = await prisma.notificationHistory.findUnique({ where: { id: historyId } });
  if (!h) throw new AppError(404, 'Notification history not found');
  if (h.status !== 'SCHEDULED') throw new AppError(400, 'Only scheduled notifications can be cancelled');
  const updated = await prisma.notificationHistory.update({ where: { id: historyId }, data: { status: 'CANCELLED' } });
  await prisma.notificationLog.create({ data: { historyId, event: 'CANCELLED', detail: 'Scheduled send cancelled' } });
  return updated;
}

// ---------------------------------------------------------------------------
// Analytics, logs, user inbox
// ---------------------------------------------------------------------------

export async function getAnalytics() {
  const [totalSent, totalUnread, totalRead, totalUsers, byCategory, today] = await Promise.all([
    prisma.notificationInbox.count(),
    prisma.notificationInbox.count({ where: { isRead: false } }),
    prisma.notificationInbox.count({ where: { isRead: true } }),
    prisma.user.count({ where: { isDeleted: false } }),
    prisma.notificationInbox.groupBy({ by: ['category'], _count: { _all: true } }),
    prisma.notificationAnalytics.findUnique({ where: { date: todayUtc() } }),
  ]);

  return {
    totalSent,
    totalUnread,
    totalRead,
    totalUsers,
    readRate: totalSent > 0 ? Math.round((totalRead / totalSent) * 100) : 0,
    byCategory: byCategory.map((g) => ({ category: g.category, count: g._count._all })),
    today: today ?? null,
  };
}

export async function getDeliveryLogs(params: { page?: number; limit?: number; event?: string; userId?: string }) {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const where: Prisma.NotificationLogWhereInput = {
    ...(params.event ? { event: params.event } : {}),
    ...(params.userId ? { userId: params.userId } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.notificationLog.count({ where }),
    prisma.notificationLog.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, displayName: true, email: true } } },
    }),
  ]);
  return { logs: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function listUserInbox(userId: string, params: { page?: number; limit?: number; isRead?: boolean }) {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const where: Prisma.NotificationInboxWhereInput = {
    userId,
    ...(params.isRead !== undefined ? { isRead: params.isRead } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.notificationInbox.count({ where }),
    prisma.notificationInbox.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
  ]);
  return { inbox: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getReadUnreadStats() {
  const [read, unread, total] = await Promise.all([
    prisma.notificationInbox.count({ where: { isRead: true } }),
    prisma.notificationInbox.count({ where: { isRead: false } }),
    prisma.notificationInbox.count(),
  ]);
  return { read, unread, total, readPercentage: total ? Math.round((read / total) * 100) : 0 };
}

export async function listContextReportsAdmin(params: { page?: number; limit?: number; search?: string }) {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const where: Prisma.ContextReportWhereInput = params.search
    ? { areaName: { contains: params.search, mode: 'insensitive' } }
    : {};
  const [total, rows] = await Promise.all([
    prisma.contextReport.count({ where }),
    prisma.contextReport.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, displayName: true, email: true } } },
    }),
  ]);
  return { reports: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getContextReportAdmin(reportId: string) {
  const report = await prisma.contextReport.findUnique({
    where: { id: reportId },
    include: { user: { select: { id: true, displayName: true, email: true } } },
  });
  if (!report) throw new AppError(404, 'Context report not found');
  return report;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'notification:global';

const DEFAULT_SETTINGS = {
  cooldownRules: {
    entering_restricted_area: '30m',
    approaching_restricted_area: '60m',
    photography_restricted: '30m',
    entering_dangerous_area: '30m',
    nearby_emergency: '10m',
    nearby_tourist_attraction: '3h',
    nearby_historical_site: '3h',
    severe_weather: '60m',
    heavy_traffic: '30m',
  },
  movementThresholdKm: 1,
  realtimeEnabled: true,
} as const;

export async function getNotificationSettings() {
  const row = await prisma.notificationSetting.findUnique({
    where: { key: SETTINGS_KEY },
  });
  if (!row) return { ...DEFAULT_SETTINGS };
  const value = row.value as {
    cooldownRules?: Record<string, string>;
    movementThresholdKm?: number;
    realtimeEnabled?: boolean;
  };
  return {
    cooldownRules: value.cooldownRules ?? DEFAULT_SETTINGS.cooldownRules,
    movementThresholdKm: value.movementThresholdKm ?? DEFAULT_SETTINGS.movementThresholdKm,
    realtimeEnabled: value.realtimeEnabled ?? DEFAULT_SETTINGS.realtimeEnabled,
  };
}

export async function updateNotificationSettings(patch: {
  cooldownRules?: Record<string, string>;
  movementThresholdKm?: number;
  realtimeEnabled?: boolean;
}): Promise<ReturnType<typeof getNotificationSettings>> {
  const current = await getNotificationSettings();
  const next = {
    cooldownRules: { ...current.cooldownRules, ...(patch.cooldownRules ?? {}) },
    movementThresholdKm: patch.movementThresholdKm ?? current.movementThresholdKm,
    realtimeEnabled: patch.realtimeEnabled ?? current.realtimeEnabled,
  };
  await prisma.notificationSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: next },
    update: { value: next },
  });
  return next;
}

// ---------------------------------------------------------------------------
// Scheduled sender (invoked by a cron/interval in index.ts)
// ---------------------------------------------------------------------------

export async function processScheduledNotifications(now = new Date()): Promise<{ sent: number; pending: number }> {
  const due = await prisma.notificationHistory.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledAt: { lte: now },
    },
    take: 50,
  });
  let sent = 0;
  for (const h of due) {
    try {
      const audience = (h.audience ?? { all: true }) as AudienceSpec;
      const userIds = (await resolveRecipients(audience)).userIds;
      const history = await prisma.notificationHistory.update({
        where: { id: h.id },
        data: { status: 'SENT', sentAt: new Date(), delivered: userIds.length, recipients: userIds.length },
      });
      for (const userId of userIds) {
        const inbox = await prisma.notificationInbox.create({
          data: {
            userId,
            historyId: h.id,
            type: h.type,
            category: h.category,
            priority: h.priority,
            source: 'ADMIN',
            title: h.title,
            message: h.message,
          },
        });
        await prisma.notificationLog.create({
          data: { userId, notificationId: inbox.id, historyId: h.id, event: 'DELIVERED', detail: 'Scheduled send' },
        });
        publishToUser(userId, inbox as never);
      }
      sent++;
    } catch {
      await prisma.notificationHistory.update({ where: { id: h.id }, data: { status: 'FAILED' } });
    }
  }
  const pending = await prisma.notificationHistory.count({ where: { status: 'SCHEDULED' } });
  return { sent, pending };
}