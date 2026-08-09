import { ReadableStream } from 'node:stream/web';
import { prisma } from '../config/prisma.js';
import { env, walletPolicyConfig } from '../config/env.js';
import { fetchEnvContext } from './env.service.js';
import { fetchPois } from './geo.service.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  beginChatStreamUsageBasedBilling,
  failChatStreamUsageBasedBilling,
} from './chat-stream-billing.service.js';
import type { ChatStreamBillingContext } from './chat-stream-billing.service.js';
import { isTokenExemptUser } from '../utils/token-exempt.js';
import {
  BillingRateCardUnavailableError,
  resolveBillingRateCard,
} from './billing-rate-card.service.js';
import { parseChatLimitsConfig } from '../config/chat-limits.js';
import { detectPromptInjection } from '../utils/prompt-injection.js';

const AI_CHAT_STREAM_TIMEOUT_MS = 120_000;

export interface StreamChatResult {
  body: ReadableStream<Uint8Array>;
  conversationId: string;
  billing: ChatStreamBillingContext;
}

interface StreamChatUser {
  displayName: string | null;
  gender: string | null;
  nationality: string | null;
  language: unknown;
  budgetLevel: string | null;
  travelStyle: string | null;
  interests: unknown;
  accommodationType: string | null;
}

interface StreamChatOptions {
  businessRequestId: string;
  lat?: number;
  lon?: number;
  conversationId?: string;
  authorization?: string;
  persona?: string;
  context?: Record<string, unknown>;
  title?: string;
}

async function dispatchChatStreamCore(
  userId: string,
  message: string,
  options: StreamChatOptions,
  user: StreamChatUser,
): Promise<{ aiResponse: globalThis.Response; body: ReadableStream<Uint8Array>; conversationId: string }> {
  const injection = detectPromptInjection(message);
  if (injection) {
    throw new AppError(400, 'Message blocked: looks like a prompt-injection attempt');
  }

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
  if (conversationId) {
    const existing = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!existing) conversationId = undefined;
  }
  if (!conversationId) {
    const conv = await prisma.conversation.create({
      data: {
        userId,
        title: options?.title?.trim() ? options.title.trim().slice(0, 100) : message.slice(0, 100),
      },
    });
    conversationId = conv.id;
  }

  const priorMessages = await prisma.message.findMany({
    where: { conversationId: conversationId! },
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: { role: true, content: true },
  });
  const history = priorMessages
    .filter((item) => item.role === 'assistant' || item.role === 'user')
    .map((item) => ({ role: item.role, content: item.content }));

  await prisma.message.create({
    data: { conversationId: conversationId!, role: 'user', content: message },
  });

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { role: true, content: true },
      },
    },
  });
  if (!conversation) throw new AppError(404, 'Conversation not found');

  const aiPayload: Record<string, unknown> = {
    message,
    conversation_id: conversationId,
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
    history,
  };
  if (options?.lat !== undefined) aiPayload.lat = options.lat;
  if (options?.lon !== undefined) aiPayload.lon = options.lon;
  if (envContext) aiPayload.environment = envContext;
  if (geoContext) aiPayload.geography = geoContext;
  if (options?.context) aiPayload.context = options.context;

  const upstreamAbort = new AbortController();
  const timeout = setTimeout(() => upstreamAbort.abort(), AI_CHAT_STREAM_TIMEOUT_MS);
  let aiResponse: globalThis.Response;
  try {
    aiResponse = await fetch(`${env.AI_SERVICE_URL}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.authorization ? { Authorization: options.authorization } : {}),
      'X-Internal-Api-Key': env.INTERNAL_API_KEY,
    },
    body: JSON.stringify(aiPayload),
      signal: upstreamAbort.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }

  if (!aiResponse.ok) {
    clearTimeout(timeout);
    throw new AppError(502, 'AI service unavailable');
  }

  const body = aiResponse.body;
  if (!body) {
    clearTimeout(timeout);
    throw new AppError(502, 'AI service unavailable');
  }

  const reader = body.getReader();
  const timedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          clearTimeout(timeout);
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (err) {
        clearTimeout(timeout);
        controller.error(err);
      }
    },
    async cancel(reason) {
      clearTimeout(timeout);
      upstreamAbort.abort();
      await reader.cancel(reason);
    },
  });

  return { aiResponse, body: timedBody, conversationId: conversationId! };
}

export async function streamChat(
  userId: string,
  message: string,
  options: StreamChatOptions,
): Promise<StreamChatResult> {
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
      role: { select: { name: true } },
    },
  });
  if (!user) throw new AppError(404, 'User not found');

  // Resolve the authoritative rate card ONCE per operation before executing AI.
  let resolved;
  try {
    resolved = await resolveBillingRateCard();
  } catch (err) {
    if (err instanceof BillingRateCardUnavailableError) {
      throw new AppError(502, `Rate card unavailable: ${err.message}`);
    }
    throw err;
  }

  // Reserve BEFORE dispatch; settle exactly once after the stream completes.
  const billing = await beginChatStreamUsageBasedBilling({
    userId,
    feature: 'AI_CHAT_QUERY',
    source: 'CHAT',
    idempotencyKey: options.businessRequestId,
    operationId: `usage:AI_CHAT_QUERY:${options.businessRequestId}`,
    adminExempt: isTokenExemptUser(user),
    chatLimits: parseChatLimitsConfig(process.env),
    rateCard: resolved.card,
    pricingSource: resolved.source,
    walletPolicy: walletPolicyConfig,
  });

  let dispatched;
  try {
    dispatched = await dispatchChatStreamCore(userId, message, options, user);
  } catch (err) {
    if (billing.mode === 'USAGE_BASED') {
      await failChatStreamUsageBasedBilling({
        operationId: billing.operationId,
        reservationId: billing.reservationId,
      });
    }
    throw err;
  }
  const { body, conversationId } = dispatched;
return {
  body,
  conversationId,
  billing,
};
}
