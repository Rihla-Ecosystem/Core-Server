import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { post } from '../utils/http-client.js';
import { fetchEnvContext } from './env.service.js';
import { fetchPois } from './geo.service.js';
import { AppError } from '../middleware/errorHandler.js';

export async function chat(
  userId: string,
  message: string,
  options?: {
    lat?: number;
    lon?: number;
    conversationId?: string;
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

  const preferences = await prisma.userPreference.findMany({
    where: { userId },
    select: { key: true, value: true },
  });
  const prefs: Record<string, unknown> = {};
  for (const p of preferences) prefs[p.key] = p.value;

  let envContext: unknown = null;
  let geoContext: unknown = null;

  if (options?.lat !== undefined && options?.lon !== undefined) {
    [envContext, geoContext] = await Promise.all([
      fetchEnvContext(options.lat, options.lon).catch(() => null),
      fetchPois(options.lat, options.lon).catch(() => null),
    ]);
  }

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

  const aiPayload: Record<string, unknown> = {
    message,
    conversation_id: cid,
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
  if (envContext) aiPayload.environment = envContext;
  if (geoContext) aiPayload.geography = geoContext;

  const aiResponse = await post<{ response: string; context?: unknown }>(
    `${env.AI_SERVICE_URL}/chat`,
    aiPayload,
  ).catch(() => {
    throw new AppError(502, 'AI service unavailable');
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
  };
  if (envContext) result.environment = envContext;
  if (geoContext) result.geography = geoContext;

  return result;
}
