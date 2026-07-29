import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { post } from '../utils/http-client.js';
import { fetchEnvContext } from './env.service.js';
import { fetchSpatialContext } from './geo.service.js';
import { fetchSafetyData } from './risk.service.js';
import { addXp } from './xp.service.js';
import { AppError } from '../middleware/errorHandler.js';

/* ── Daily XP cap for messages ─────────────────────────────────── */
const MESSAGE_XP_AMOUNT = 2;
const MESSAGE_XP_DAILY_CAP = 20;

async function awardMessageXp(userId: string): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayXp = await prisma.xpTransaction.aggregate({
    where: { userId, reason: 'message_sent', createdAt: { gte: today } },
    _sum: { amount: true },
  });

  const earnedToday = todayXp._sum.amount ?? 0;
  if (earnedToday < MESSAGE_XP_DAILY_CAP) {
    await addXp(userId, MESSAGE_XP_AMOUNT, 'message_sent').catch(() => {});
  }
}

/* ── Main chat function ─────────────────────────────────────────── */

export async function chat(
  userId: string,
  message: string,
  options?: {
    lat?: number;
    lon?: number;
    conversationId?: string;
    persona?: string;
  },
) {
  // 1. Load user profile + preferences in parallel
  const [user, preferences] = await Promise.all([
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
    prisma.userPreference.findMany({
      where: { userId },
      select: { key: true, value: true },
    }),
  ]);

  if (!user) throw new AppError(404, 'User not found');

  const prefs: Record<string, unknown> = {};
  for (const p of preferences) prefs[p.key] = p.value;

  // 2. Fetch all context sources in parallel (all failures are swallowed)
  const hasLocation = options?.lat !== undefined && options?.lon !== undefined;

  const [envContext, geoContext, safetyData] = await Promise.all([
    hasLocation
      ? fetchEnvContext(options!.lat!, options!.lon!).catch(() => null)
      : Promise.resolve(null),
    hasLocation
      ? fetchSpatialContext(options!.lat!, options!.lon!).catch(() => null)
      : Promise.resolve(null),
    // Derive city from user nationality as best-effort fallback for safety lookup
    fetchSafetyData().catch(() => null),
  ]);

  // 3. Persist conversation + user message
  let conversationId = options?.conversationId;
  if (!conversationId) {
    const conv = await prisma.conversation.create({
      data: { userId, title: message.slice(0, 100) },
    });
    conversationId = conv.id;
  }
  const cid = conversationId!;

  await prisma.message.create({
    data: { conversationId: cid, role: 'user', content: message },
  });

  // 4. Build AI payload — mirrors ChatRequest schema in ai-service
  const aiPayload: Record<string, unknown> = {
    message,
    conversation_id: cid,
    persona: options?.persona ?? 'auto',
    user: {
      display_name: user.displayName,
      gender: user.gender,
      nationality: user.nationality,
      language: user.language,
      budget_level: user.budgetLevel,
      travel_style: user.travelStyle,
      interests: user.interests,
      accommodation_type: user.accommodationType,
      preferences: prefs,
    },
  };

  // Attach location at root level so AI can do location-based tool calls
  if (hasLocation) {
    aiPayload.lat = options!.lat;
    aiPayload.lon = options!.lon;
  }

  if (envContext && Object.keys(envContext).length > 0) {
    aiPayload.environment = envContext;
  }

  if (geoContext) {
    aiPayload.geography = geoContext;
  }

  if (safetyData) {
    aiPayload.safety = safetyData;
  }

  // 5. Call AI service
  const aiResponse = await post<{ response: string; persona?: string; blocked?: boolean; reason?: string }>(
    `${env.AI_SERVICE_URL}/chat`,
    aiPayload,
  ).catch(() => {
    throw new AppError(502, 'AI service unavailable');
  });

  // 6. Persist assistant reply
  await prisma.message.create({
    data: {
      conversationId: cid,
      role: 'assistant',
      content: aiResponse.response,
    },
  });

  // 7. Award XP for sending a message (capped at MESSAGE_XP_DAILY_CAP/day)
  await awardMessageXp(userId);

  // 8. Return response
  const result: Record<string, unknown> = {
    response: aiResponse.response,
    conversation_id: cid,
    persona: aiResponse.persona,
  };

  if (aiResponse.blocked) result.blocked = true;
  if (aiResponse.reason) result.reason = aiResponse.reason;
  if (envContext && Object.keys(envContext).length > 0) result.environment = envContext;
  if (geoContext) result.geography = geoContext;

  return result;
}
