import { prisma } from '../config/prisma.js';
import { fetchEnvContext } from './env.service.js';
import { fetchFullGeoContext } from './geo.service.js';
import { fetchSafetyContext } from './risk.service.js';
import { getCurrencyInfo, getExchangeRates, isSupportedCurrency } from './currency.service.js';
import { comparePassword } from '../utils/hash.js';

export async function getFullGeoContext(lat: number, lon: number, authorization?: string) {
  return fetchFullGeoContext(lat, lon, undefined, undefined, authorization);
}

export async function getFullSafetyContext(lat: number, lon: number, authorization?: string) {
  return fetchSafetyContext(lat, lon, authorization);
}

/**
 * Task 8.6 — Return a structured journey progress summary for a user.
 * Each journey entry includes per-step completion status so the AI can
 * suggest which step to tackle next and award relevant guidance.
 */
export async function getJourneyProgress(userId: string) {
  const journeys = await prisma.journey.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    include: {
      steps: {
        orderBy: { stepNumber: 'asc' },
        select: { id: true, stepNumber: true, title: true, xpReward: true },
      },
      progress: {
        where: { userId },
        include: { steps: { select: { stepId: true, completedAt: true } } },
      },
    },
  });

  return journeys.map((journey) => {
    const userProgress = journey.progress[0] ?? null;
    const completedStepIds = new Set((userProgress?.steps ?? []).map((s) => s.stepId));
    return {
      slug: journey.slug,
      title: journey.title,
      xpReward: journey.xpReward,
      totalSteps: journey.steps.length,
      completedSteps: completedStepIds.size,
      isCompleted: userProgress?.completedAt != null,
      startedAt: userProgress?.startedAt ?? null,
      completedAt: userProgress?.completedAt ?? null,
      steps: journey.steps.map((step) => ({
        stepNumber: step.stepNumber,
        title: step.title,
        xpReward: step.xpReward,
        completed: completedStepIds.has(step.id),
      })),
    };
  });
}

/**
 * Verify app-admin credentials for the GeoContext SQLAdmin dashboard.
 * No tokens are minted and no login side effects occur — this is a pure
 * credential + role check against the Core-Server user store.
 */
export async function verifyAdminLogin(email: string, password: string) {
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      displayName: true,
      passwordHash: true,
      isBanned: true,
      isDeleted: true,
      isActive: true,
      role: { select: { name: true } },
    },
  });

  if (!user || user.isBanned || user.isDeleted || !user.isActive) return { ok: false };
  if (user.role?.name !== 'admin') return { ok: false };
  if (!user.passwordHash) return { ok: false };
  if (!(await comparePassword(password, user.passwordHash))) return { ok: false };

  return { ok: true, userId: user.id, displayName: user.displayName };
}

export async function getUserContext(userId: string) {
  const [user, preferences, conversations] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        displayName: true,
        gender: true,
        nationality: true,
        language: true,
        budgetLevel: true,
        travelStyle: true,
        interests: true,
        accommodationType: true,
      },
    }),
    prisma.userPreference.findMany({ where: { userId }, select: { key: true, value: true } }),
    prisma.conversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 10 } },
    }),
  ]);
  if (!user) return null;
  return { user, preferences, conversations };
}

export async function getCombinedContext(userId: string, lat?: number, lon?: number, authorization?: string, baseCurrency = 'USD') {
  const [user, journeys] = await Promise.all([getUserContext(userId), getJourneyProgress(userId)]);
  if (!user) return null;
  const location = lat !== undefined && lon !== undefined;
  const [geography, safety, environment] = location
    ? await Promise.all([
        getFullGeoContext(lat, lon, authorization).catch(() => null),
        getFullSafetyContext(lat, lon, authorization),
        fetchEnvContext(lat, lon, authorization).catch(() => null),
      ])
    : [null, null, null];
  const currency = isSupportedCurrency(baseCurrency)
    ? await getExchangeRates(baseCurrency)
    : { ...getCurrencyInfo(), rates: null, available: false };
  return { ...user, journeys, geography, safety, environment, currency };
}
