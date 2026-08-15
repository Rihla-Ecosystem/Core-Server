// ---------------------------------------------------------------------------
// Context Engine
// ---------------------------------------------------------------------------
// The Core Backend's Context Engine: receives smart location updates, builds
// the aggregated Context Object, asks the AI Service to analyze it, generates
// smart notifications + a Context Intelligence Report, persists everything, and
// delivers in realtime when the user is online.
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { toInputJsonValue } from '../utils/json.js';
import { buildContextObject } from './context-aggregator.service.js';
import { analyzeContext } from '../clients/ai-context.client.js';
import { evaluateRules, prioritizeEvaluations, RULE_COOLDOWN_MS } from './notification-rules.service.js';
import { publishToUser, isUserOnline, publishContextEvent } from './notification-realtime.service.js';
import { EGYPT_EMERGENCY_CONTACTS } from '../types/context-notification.js';
import { getNotificationSettings } from './notification-admin.service.js';
import { resolveBillingRateCard, BillingRateCardUnavailableError } from './billing-rate-card.service.js';
import {
  indeterminateSystemFundedContextAnalyze,
  priceSystemFundedContextAnalyze,
  unavailableSystemFundedContextAnalyze,
} from './context-analyze-billing.service.js';
import { randomUUID } from 'node:crypto';
import type {
  ContextAnalysisResult,
  ContextEngineResult,
  ContextObject,
  ContextReport,
  GeneratedNotification,
  LocationPoint,
} from '../types/context-notification.js';

const UNKNOWN_SERVER_ERROR = 'Failed to process location update';

// Zone-class severity mapping for anonymous SSE zone events (identity never exposed).
const ZONE_EVENT_SEVERITY: Record<string, 'critical' | 'warning' | 'info'> = {
  restricted: 'critical',
  caution: 'warning',
  protected: 'info',
};

/**
 * Server-side zone state machine. Tracks which zone CLASSES the user is
 * currently inside (`activeGeofences` on UserNotificationStatus) and publishes
 * anonymous `zone` enter/exit events over SSE on transitions. Only the CLASS is
 * exposed — never the name/description/reason of the area.
 */
async function trackZoneState(
  userId: string,
  context: ContextObject,
): Promise<void> {
  const zones = (context.geoContext?.restrictedAreas ?? []) as Array<{ type?: string }>;
  const activeClasses = new Set<string>();
  for (const z of zones) {
    const cls = String(z.type || '').toLowerCase();
    if (cls === 'restricted' || cls === 'caution' || cls === 'protected') activeClasses.add(cls);
  }

  const prev = await prisma.userNotificationStatus.findUnique({
    where: { userId },
    select: { activeGeofences: true },
  });
  const prevClasses = new Set<string>(
    Array.isArray(prev?.activeGeofences) ? prev.activeGeofences.map(String) : [],
  );

  const entered = [...activeClasses].filter((c) => !prevClasses.has(c));
  const exited = [...prevClasses].filter((c) => !activeClasses.has(c));

  if (entered.length === 0 && exited.length === 0) return;

  for (const cls of entered) {
    publishContextEvent(userId, {
      kind: 'zone',
      data: { event: 'enter', class: cls, severity: ZONE_EVENT_SEVERITY[cls] ?? 'warning', distance_meters: 0 },
    });
  }
  for (const cls of exited) {
    publishContextEvent(userId, {
      kind: 'zone',
      data: { event: 'exit', class: cls, severity: ZONE_EVENT_SEVERITY[cls] ?? 'warning' },
    });
  }

  await prisma.userNotificationStatus.upsert({
    where: { userId },
    update: { activeGeofences: [...activeClasses] },
    create: { userId, activeGeofences: [...activeClasses] },
  });
}

// Only a movement of at least this distance from the last reported point
// re-triggers the full context pipeline. Keeps repeated GPS pings from
// re-running the AI analyze + writing a new ContextReport on every ping.
const MIN_REPORT_DISTANCE_METERS = 50;

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// A manual / geofence-triggered or first-ever report always processes; only
// routine `movement` pings are throttled when the GPS point barely moved.
async function shouldProcessLocationUpdate(
  userId: string,
  location: LocationPoint,
): Promise<boolean> {
  if (location.reason !== 'movement') return true;
  const status = await prisma.userNotificationStatus.findUnique({
    where: { userId },
    select: { lastLat: true, lastLng: true },
  });
  if (!status?.lastLat || !status?.lastLng) return true;
  return haversineMeters(status.lastLat, status.lastLng, location.lat, location.lng) >= MIN_REPORT_DISTANCE_METERS;
}

async function upsertUserStatus(userId: string, location: LocationPoint): Promise<void> {
  await prisma.userNotificationStatus.upsert({
    where: { userId },
    update: {
      lastLat: location.lat,
      lastLng: location.lng,
      lastReportedAt: new Date(),
      lastSyncAt: new Date(),
    },
    create: {
      userId,
      lastLat: location.lat,
      lastLng: location.lng,
      lastReportedAt: new Date(),
      lastSyncAt: new Date(),
    },
  });
}

function cooldownMsFor(rule: string, cooldown: Record<string, string>): number {
  if (cooldown[rule]) {
    const match = cooldown[rule].match(/^(\d+)\s*(ms|s|m|h|d)?$/i);
    if (match) {
      const value = Number(match[1]);
      const unit = (match[2] ?? 'm').toLowerCase();
      const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
      return value * mult;
    }
  }
  return RULE_COOLDOWN_MS[rule] ?? 30 * 60 * 1000;
}

function isCooledDown(
  recent: Array<{ cooldownKey: string | null; createdAt: Date }>,
  rule: string,
  now: number,
  cooldown: Record<string, string>,
): boolean {
  for (const n of recent) {
    if (n.cooldownKey === rule) {
      return n.createdAt.getTime() + cooldownMsFor(rule, cooldown) > now;
    }
  }
  return false;
}

function buildAreaInformation(context: ContextObject): Record<string, unknown> {
  return {
    area: context.geoContext.currentArea ?? null,
    governorate: context.geoContext.governorate ?? null,
    zone: context.geoContext.zone ?? null,
    atSite: context.geoContext.atSite?.name ?? null,
    nearbyAttractionsCount: (context.geoContext.nearbyAttractions ?? []).length,
    nearbyServicesCount: (context.geoContext.nearbyServices ?? []).length,
    restrictedAreas: (context.geoContext.restrictedAreas ?? []).map((r) => r.name),
    photographyRestrictions: context.geoContext.photographyRestrictions ?? [],
  };
}

export async function processLocationUpdate(
  userId: string,
  location: LocationPoint,
): Promise<ContextEngineResult> {
  if (typeof location.lat !== 'number' || typeof location.lng !== 'number') {
    throw new AppError(400, 'lat and lng are required');
  }

  // Repeated GPS pings that barely move do not re-run the AI pipeline; only
  // the freshest position is kept so the next real movement is detected.
  const process = await shouldProcessLocationUpdate(userId, location);
  await upsertUserStatus(userId, location);

  // Zone enter/exit transitions must be detected even when the AI pipeline is
  // throttled for slow movement, so a boundary crossing at walking speed is
  // never missed. This is a lightweight GeoContext call, not the AI analyze.
  const zoneContext = await buildContextObject(userId, location).catch(() => null);
  if (zoneContext) {
    await trackZoneState(userId, zoneContext).catch(() => undefined);
  }

  if (!process) {
    return { notifications: [], contextReport: null, skipped: true };
  }

  // 1. Aggregate the full Context Object.
  const context = zoneContext ?? (await buildContextObject(userId, location));

  // 2. Ask the AI Service to analyze the aggregated context.
  let aiReport: ContextAnalysisResult;
  let aiGenerated: GeneratedNotification[] = [];
  const contextAnalyzeOperationId = `context-analyze:${randomUUID()}`;
  let contextAnalyzeAudit;
  try {
    // Context Analyze is system-funded, but its actual provider cost is still
    // recorded against this one active database rate-card snapshot. Do not
    // execute the provider path if the authoritative card is unavailable.
    const resolved = await resolveBillingRateCard();
    if (resolved.source !== 'DATABASE_PRIMARY') {
      throw new BillingRateCardUnavailableError('RATE_CARD_SOURCE_INVALID', 'active database rate card is required');
    }
    const ai = await analyzeContext(context, contextAnalyzeOperationId);
    contextAnalyzeAudit = priceSystemFundedContextAnalyze({
      operationId: contextAnalyzeOperationId,
      providerCalls: ai.providerCalls,
      providerAttempts: ai.providerAttempts,
      rateCard: resolved.card,
    });
    aiReport = ai.report;
    aiGenerated = (ai.generatedNotifications ?? [])
      .filter((n) => n.title && n.message)
      .map((n) => ({
        title: n.title as string,
        message: n.message as string,
        type: n.priority === 'CRITICAL' ? 'ERROR' : n.priority === 'HIGH' ? 'WARNING' : 'INFO',
        category: (n.category as GeneratedNotification['category']) ?? 'SYSTEM',
        priority: (n.priority as GeneratedNotification['priority']) ?? 'NORMAL',
        source: 'AI',
        cooldownKey: `ai_${n.rule ?? 'generic'}`,
        lat: location.lat,
        lng: location.lng,
      }));
  } catch (err) {
    contextAnalyzeAudit = err instanceof BillingRateCardUnavailableError
      ? unavailableSystemFundedContextAnalyze(contextAnalyzeOperationId, err.code)
      : indeterminateSystemFundedContextAnalyze(contextAnalyzeOperationId, 'AI_CONTEXT_ANALYZE_FAILED');
    // If the AI service is unavailable, fall back to deterministic sections
    // built entirely from the aggregated context (still useful, never throws).
    aiReport = {
      executiveSummary: `Context analysis for ${context.geoContext.currentArea ?? 'your area'} is temporarily unavailable. Stay informed with the safety recommendations below.`,
      currentSituation: `You are located in ${context.geoContext.currentArea ?? 'an urban area'} with a ${context.riskContext.riskLevel ?? 'info'} risk level.`,
      safetyAssessment: context.riskContext.safetyScore != null
        ? `Safety score: ${context.riskContext.safetyScore}/100 (${context.riskContext.riskLevel ?? 'info'} risk).`
        : 'Safety assessment not available at this time.',
      riskAnalysis: `Threats reported nearby: ${(context.riskContext.threats ?? []).map((t) => t.headline ?? t.category).filter(Boolean).join(', ') || 'none'}.`,
      personalizedRecommendations: ['Carry identification documents.', 'Keep emergency numbers saved.'],
      touristTips: ['Drink bottled water.', 'Respect local customs.'],
      historicalSummary: context.geoContext.historicalPlaces?.length
        ? `You are near historical sites such as ${context.geoContext.historicalPlaces.map((h) => h.name).join(', ')}.`
        : 'No major historical sites reported nearby.',
      interestingFacts: [],
      thingsToAvoid: ['Venturing into restricted areas.', 'Photography where prohibited.'],
      recommendedActions: ['Stay aware of your surroundings.', 'Follow local guidance.'],
      emergencyInstructions: ['In an emergency, dial 122 (Police), 123 (Ambulance), or 180 (Fire).'],
    };
  }

  // 3. Evaluate deterministic smart rules.
  const evaluations = prioritizeEvaluations(evaluateRules(context));

  // 4. Deduplicate against recently delivered notifications + cooldown.
  const recent = await prisma.notificationInbox.findMany({
    where: {
      userId,
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
    select: { cooldownKey: true, createdAt: true, title: true },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  const cooldownRules = (await getNotificationSettings()).cooldownRules;
  const now = Date.now();
  const seenTitles = new Set(recent.map((n) => n.title));
  const finalized: GeneratedNotification[] = [];
  const seenCooldownKeys = new Set<string>();

  const consider = (n: GeneratedNotification) => {
    if (seenTitles.has(n.title) && n.source !== 'EMERGENCY') return;
    if (n.cooldownKey && (seenCooldownKeys.has(n.cooldownKey) || isCooledDown(recent, n.cooldownKey, now, cooldownRules))) {
      if (n.priority === 'CRITICAL') {
        // Critical alerts always get through after 10 minutes.
        if (isCooledDown(recent, n.cooldownKey, now, cooldownRules)) return;
      } else {
        return;
      }
    }
    seenTitles.add(n.title);
    seenCooldownKeys.add(n.cooldownKey ?? n.title);
    finalized.push(n);
  };

  for (const n of aiGenerated) consider(n);
  for (const ev of evaluations) consider(ev.notification);

  // Sort critical-first for storage & delivery order.
  const priorityRank: Record<string, number> = { CRITICAL: 4, HIGH: 3, NORMAL: 2, LOW: 1 };
  finalized.sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority]);

  // 5. Persist generated notifications to the inbox.
  const persisted = await persistNotifications(userId, finalized, context);

  // 6. Build + store the Context Intelligence Report.
  const report = buildContextReport(context, aiReport, finalized);
  const storedReport = await prisma.contextReport.create({
    data: {
      userId,
      lat: location.lat,
      lng: location.lng,
      areaName: context.geoContext.currentArea ?? null,
      context: toInputJsonValue({
        ...contextSnapshot(context),
        aiBilling: contextAnalyzeAudit,
      }),
      report: toInputJsonValue(report as unknown as Record<string, unknown>),
      notifications: persisted.map((n) => ({ id: n.id, title: n.title, priority: n.priority })),
      summary: aiReport.executiveSummary,
    },
  });

  // 7. Realtime delivery for online users.
  for (const n of persisted) {
    publishToUser(userId, { ...n });
  }

  // 8. Track analytics.
  await trackAnalytics(persisted, context);

  return {
    notifications: persisted,
    contextReport: {
      ...report,
      generatedAt: new Date().toISOString(),
    },
  };
}

async function persistNotifications(
  userId: string,
  notifications: GeneratedNotification[],
  context: ContextObject,
) {
  const created: Array<GeneratedNotification & { id: string }> = [];
  for (const n of notifications) {
    const row = await prisma.notificationInbox.create({
      data: {
        userId,
        type: n.type,
        category: n.category,
        priority: n.priority,
        source: n.source,
        title: n.title,
        message: n.message,
        data: {
          ...(n.data ?? {}),
          area: context.geoContext.currentArea ?? null,
          riskLevel: context.riskContext.riskLevel ?? null,
          contextReportArea: context.geoContext.currentArea ?? null,
        },
        cooldownKey: n.cooldownKey,
        lat: n.lat ?? context.location.lat,
        lng: n.lng ?? context.location.lng,
      },
    });
    created.push({ ...n, id: row.id });
    await prisma.notificationLog.create({
      data: {
        userId,
        notificationId: row.id,
        event: 'GENERATED',
        detail: `Rule/type: ${n.cooldownKey} priority=${n.priority}`,
        metadata: { cooldownKey: n.cooldownKey, priority: n.priority, source: n.source },
      },
    });
  }
  return created;
}

async function trackAnalytics(notifications: Array<{ priority: string; category: string; source: string }>, context: ContextObject): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const existing = await prisma.notificationAnalytics.findUnique({ where: { date: today } });
  const counts = {
    totalSent: notifications.length,
    byPriority: notifications.reduce<Record<string, number>>((acc, n) => {
      acc[n.priority] = (acc[n.priority] ?? 0) + 1;
      return acc;
    }, {}),
    byCategory: notifications.reduce<Record<string, number>>((acc, n) => {
      acc[n.category] = (acc[n.category] ?? 0) + 1;
      return acc;
    }, {}),
    bySource: notifications.reduce<Record<string, number>>((acc, n) => {
      acc[n.source] = (acc[n.source] ?? 0) + 1;
      return acc;
    }, {}),
  };
  const riskLevel = context.riskContext.riskLevel ?? 'info';
  const baseBySource = existing?.bySource && typeof existing.bySource === 'object' ? (existing.bySource as Record<string, number>) : {};
  const baseByCat = existing?.byCategory && typeof existing.byCategory === 'object' ? (existing.byCategory as Record<string, number>) : {};
  const baseByPri = existing?.byPriority && typeof existing.byPriority === 'object' ? (existing.byPriority as Record<string, number>) : {};

  await prisma.notificationAnalytics.upsert({
    where: { date: today },
    update: {
      totalSent: (existing?.totalSent ?? 0) + counts.totalSent,
      totalDelivered: (existing?.totalDelivered ?? 0) + counts.totalSent,
      byPriority: mergeCounts(baseByPri, counts.byPriority),
      byCategory: mergeCounts(baseByCat, counts.byCategory),
      bySource: mergeCounts(baseBySource, counts.bySource),
    },
    create: {
      date: today,
      totalSent: counts.totalSent,
      totalDelivered: counts.totalSent,
      byPriority: counts.byPriority,
      byCategory: counts.byCategory,
      bySource: counts.bySource,
    },
  });
}

function mergeCounts(base: Record<string, number>, add: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...base };
  for (const [k, v] of Object.entries(add)) out[k] = (out[k] ?? 0) + v;
  return out;
}

function contextSnapshot(context: ContextObject): Record<string, unknown> {
  return {
    location: context.location,
    geoContext: context.geoContext,
    riskContext: context.riskContext,
    userProfile: context.userProfile,
    collectedAt: context.collectedAt,
  };
}

function buildContextReport(
  context: ContextObject,
  ai: ContextAnalysisResult,
  notifications: GeneratedNotification[],
): Omit<ContextReport, 'generatedAt'> {
  return {
    areaInformation: buildAreaInformation(context),
    aiSummary: ai,
    safetyScore: context.riskContext.safetyScore ?? 70,
    riskLevel: context.riskContext.riskLevel ?? 'info',
    historicalInformation: ai.historicalSummary,
    touristTips: ai.touristTips,
    recommendations: ai.personalizedRecommendations,
    thingsToAvoid: ai.thingsToAvoid,
    nearbyAttractions: context.geoContext.nearbyAttractions ?? [],
    nearbyRestaurants: context.geoContext.nearbyRestaurants ?? [],
    nearbyHotels: context.geoContext.nearbyHotels ?? [],
    nearbyHospitals: context.geoContext.nearbyHospitals ?? [],
    nearbyPoliceStations: context.geoContext.nearbyPoliceStations ?? [],
    nearbyTransportation: context.geoContext.nearbyTransportation ?? [],
    emergencyContacts: EGYPT_EMERGENCY_CONTACTS,
  };
}

// ---------------------------------------------------------------------------
// Synchronization — unread notifications for offline users
// ---------------------------------------------------------------------------

export async function listInboxNotifications(
  userId: string,
  page: number,
  limit: number,
  isRead?: boolean,
) {
  const where = {
    userId,
    ...(isRead !== undefined ? { isRead } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.notificationInbox.count({ where }),
    prisma.notificationInbox.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return { notifications: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notificationInbox.count({ where: { userId, isRead: false } });
}

export async function markRead(userId: string, notificationId: string) {
  const row = await prisma.notificationInbox.findFirst({ where: { id: notificationId, userId } });
  if (!row) throw new AppError(404, 'Notification not found');
  const updated = await prisma.notificationInbox.update({
    where: { id: notificationId },
    data: { isRead: true, readAt: new Date() },
  });
  await prisma.notificationLog.create({
    data: { userId, notificationId, event: 'READ', detail: 'Marked as read' },
  });
  return updated;
}

export async function markAllRead(userId: string) {
  const { count } = await prisma.notificationInbox.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return { updated: count };
}

export async function deleteInboxNotification(userId: string, notificationId: string) {
  const row = await prisma.notificationInbox.findFirst({ where: { id: notificationId, userId } });
  if (!row) throw new AppError(404, 'Notification not found');
  await prisma.notificationInbox.delete({ where: { id: notificationId } });
  return { id: notificationId, deleted: true };
}

/** Sync endpoint used by the frontend after reconnecting. */
export async function syncUnreadAfterReconnect(userId: string, lastSync?: Date) {
  const where: Record<string, unknown> = { userId, isRead: false };
  if (lastSync) where.createdAt = { gte: lastSync };
  const [unread, total] = await Promise.all([
    prisma.notificationInbox.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.notificationInbox.count({ where: { userId, isRead: false } }),
  ]);
  await prisma.userNotificationStatus.update({
    where: { userId },
    data: { lastSyncAt: new Date() },
  });
  return { notifications: unread, totalUnread: total };
}

export async function getContextReports(userId: string, page: number, limit: number) {
  const where = { userId };
  const [total, rows] = await Promise.all([
    prisma.contextReport.count({ where }),
    prisma.contextReport.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  return { reports: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function getContextReport(userId: string, reportId: string) {
  const report = await prisma.contextReport.findFirst({ where: { id: reportId, userId } });
  if (!report) throw new AppError(404, 'Context report not found');
  return report;
}

// ---------------------------------------------------------------------------
// Notification preferences (per-user)
// ---------------------------------------------------------------------------

const DEFAULT_USER_PREFERENCES = {
  enabled: true,
  categories: {
    SAFETY: true,
    SECURITY: true,
    WEATHER: true,
    TRAFFIC: true,
    TOURIST: true,
    HISTORICAL: true,
    EMERGENCY: true,
    RESTRICTED_AREA: true,
    PHOTOGRAPHY: true,
    RECOMMENDATION: true,
    SYSTEM: true,
  },
  quietHours: { enabled: false, from: '22:00', to: '07:00' },
} as const;

export async function getUserNotificationPreferences(userId: string) {
  const status = await prisma.userNotificationStatus.findUnique({
    where: { userId },
    select: { preferences: true },
  });
  const prefs = (status?.preferences as Record<string, unknown> | null) ?? {};
  return { ...DEFAULT_USER_PREFERENCES, ...prefs };
}

export async function updateUserNotificationPreferences(userId: string, patch: Record<string, unknown>) {
  const current = await getUserNotificationPreferences(userId);
  const next = { ...current, ...patch };
  await prisma.userNotificationStatus.upsert({
    where: { userId },
    create: { userId, preferences: toInputJsonValue(next) },
    update: { preferences: toInputJsonValue(next) },
  });
  return next;
}

export { isUserOnline, UNKNOWN_SERVER_ERROR };
