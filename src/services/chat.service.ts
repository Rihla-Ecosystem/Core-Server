import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { post } from '../utils/http-client.js';
import { fetchEnvContext } from './env.service.js';
import { fetchPois } from './geo.service.js';
import { fetchSafetyContext } from './risk.service.js';
import { getExchangeRates, isSupportedCurrency } from './currency.service.js';
import { getJourneyProgress } from './internal.service.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  consumeBusinessTokens,
  reverseBusinessTokens,
} from './business-token-consumption.service.js';
import { recordAiUsage } from './ai-usage.service.js';

export type ChatPersona = 'auto' | 'tour_guide' | 'local_expert' | 'safety_guru';

async function revertAndRethrow(
  userId: string,
  businessRequestId: string,
  originalError: unknown,
): Promise<never> {
  try {
    await reverseBusinessTokens({
      userId,
      feature: 'AI_CHAT_QUERY',
      source: 'CHAT',
      businessRequestId,
    });
  } catch (refundError) {
    console.error(
      'Failed to restore consumed tokens',
      {
        userId,
        businessRequestId,
        originalError: originalError instanceof Error ? originalError.message : String(originalError),
        refundError: refundError instanceof Error ? refundError.message : String(refundError),
      },
    );
    throw new AppError(500, 'Unable to restore consumed tokens');
  }
  throw originalError;
}

export async function chat(
  userId: string,
  message: string,
  options: {
    businessRequestId: string;
    lat?: number;
    lon?: number;
    conversationId?: string;
    authorization?: string;
    baseCurrency?: string;
    persona?: ChatPersona;
  },
) {
  const user = await prisma.user.findUnique({
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
  });
  if (!user) throw new AppError(404, 'User not found');

  const consumption = await consumeBusinessTokens({
    userId,
    feature: 'AI_CHAT_QUERY',
    source: 'CHAT',
    businessRequestId: options.businessRequestId,
  });

  if (consumption.idempotentReplay) {
    throw new AppError(409, 'Chat request already processed');
  }

  try {
    const preferences = await prisma.userPreference.findMany({
      where: { userId },
      select: { key: true, value: true },
    });
    const prefs: Record<string, unknown> = {};
    for (const p of preferences) prefs[p.key] = p.value;

    let envContext: unknown = null;
    let geoContext: unknown = null;
    let safetyContext: unknown = null;
    let currencyContext: unknown = null;

    if (options?.lat !== undefined && options?.lon !== undefined) {
      [envContext, geoContext, safetyContext, currencyContext] = await Promise.all([
        fetchEnvContext(options.lat, options.lon, options.authorization).catch(() => null),
        fetchPois(options.lat, options.lon, undefined, undefined, options.authorization).catch(() => null),
        fetchSafetyContext(options.lat, options.lon, options.authorization),
        options.baseCurrency && isSupportedCurrency(options.baseCurrency) ? getExchangeRates(options.baseCurrency) : Promise.resolve(null),
      ]);
    }

    // Always fetch journey progress for gamification context (Task 8.6)
    const journeyProgress = await getJourneyProgress(userId).catch(() => null);

    let conversationId = options?.conversationId;
    if (!conversationId) {
      const conv = await prisma.conversation.create({
        data: { userId, title: message.slice(0, 100) },
      });
      conversationId = conv.id;
    }
    const cid = conversationId!;

    const conversation = await prisma.conversation.findFirst({
      where: { id: cid, userId },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 20, select: { role: true, content: true } } },
    });
    if (!conversation) throw new AppError(404, 'Conversation not found');

    await prisma.message.create({
      data: { conversationId: cid, role: 'user', content: message },
    });

    const aiPayload: Record<string, unknown> = {
      message,
      conversation_id: cid,
      persona: options?.persona ?? 'auto',
      user_id: userId,
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
      history: conversation.messages.reverse().map((item) => ({ role: item.role, content: item.content })),
    };
    if (options?.lat !== undefined) aiPayload.lat = options.lat;
    if (options?.lon !== undefined) aiPayload.lon = options.lon;
    if (envContext) aiPayload.environment = envContext;
    if (geoContext) aiPayload.geography = geoContext;
    if (safetyContext) aiPayload.safety = safetyContext;
    if (currencyContext) aiPayload.currency = currencyContext;
    if (journeyProgress) aiPayload.user_journeys = journeyProgress;

    const aiResponse = await post<{ response: string; context?: unknown; persona?: string; blocked?: boolean; reason?: string | null; usage?: { model?: string | null; inputTokens?: number; outputTokens?: number; totalTokens?: number } | null }>(
      `${env.AI_SERVICE_URL}/chat`,
      aiPayload,
      {
        ...(options?.authorization ? { Authorization: options.authorization } : {}),
        'X-Internal-Api-Key': env.INTERNAL_API_KEY,
      },
    ).catch(() => {
      throw new AppError(502, 'AI service unavailable');
    });

    await recordAiUsage({
      userId,
      conversationId: cid,
      source: 'chat',
      usage: aiResponse.usage,
    });

    await prisma.message.create({
      data: {
        conversationId: cid,
        role: 'assistant',
        content: aiResponse.response,
      },
    });

    const result: Record<string, unknown> = {
      response: aiResponse.response,
      conversation_id: cid,
      persona: aiResponse.persona ?? options?.persona ?? 'auto',
    };
    if (aiResponse.blocked != null) result.blocked = aiResponse.blocked;
    if (aiResponse.reason != null) result.reason = aiResponse.reason;
    if (envContext) result.environment = envContext;
    if (geoContext) result.geography = geoContext;
    if (safetyContext) result.safety = safetyContext;
    if (currencyContext) result.currency = currencyContext;
    if (journeyProgress) result.user_journeys = journeyProgress;

    return result;
  } catch (err) {
    return revertAndRethrow(userId, options.businessRequestId, err);
  }
}

export async function getConversations(userId: string) {
  return prisma.conversation.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { messages: true } } },
  });
}

export async function getMessages(userId: string, conversationId: string) {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  });
  if (!conv) throw new AppError(404, 'Conversation not found');
  return prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, content: true, createdAt: true },
  });
}

export async function deleteConversation(userId: string, id: string) {
  const conv = await prisma.conversation.findFirst({
    where: { id, userId },
  });
  if (!conv) throw new AppError(404, 'Conversation not found');
  await prisma.conversation.delete({ where: { id } });
}
