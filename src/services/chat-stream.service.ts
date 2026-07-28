import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { fetchEnvContext } from './env.service.js';
import { fetchPois } from './geo.service.js';
import { AppError } from '../middleware/errorHandler.js';

export async function streamChat(
  userId: string,
  message: string,
  options?: {
    lat?: number;
    lon?: number;
    conversationId?: string;
    authorization?: string;
    persona?: string;
  },
): Promise<Response> {
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
      fetchEnvContext(options.lat, options.lon, options.authorization).catch(() => null),
      fetchPois(options.lat, options.lon, undefined, undefined, options.authorization).catch(() => null),
    ]);
  }

  let conversationId = options?.conversationId;
  if (!conversationId) {
    const conv = await prisma.conversation.create({
      data: { userId, title: message.slice(0, 100) },
    });
    conversationId = conv.id;
  }

  await prisma.message.create({
    data: { conversationId: conversationId!, role: 'user', content: message },
  });

  const aiPayload: Record<string, unknown> = {
    message,
    conversation_id: conversationId,
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
  if (options?.lat !== undefined) aiPayload.lat = options.lat;
  if (options?.lon !== undefined) aiPayload.lon = options.lon;
  if (envContext) aiPayload.environment = envContext;
  if (geoContext) aiPayload.geography = geoContext;

  const aiResponse = await fetch(`${env.AI_SERVICE_URL}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.authorization ? { Authorization: options.authorization } : {}),
      'X-Internal-Api-Key': env.INTERNAL_API_KEY,
    },
    body: JSON.stringify(aiPayload),
  });

  if (!aiResponse.ok) {
    throw new AppError(502, 'AI service unavailable');
  }

  return aiResponse;
}
