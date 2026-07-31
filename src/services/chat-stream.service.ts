import { ReadableStream } from 'node:stream/web';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { fetchEnvContext } from './env.service.js';
import { fetchPois } from './geo.service.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  consumeBusinessTokens,
  reverseBusinessTokens,
} from './business-token-consumption.service.js';

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

function buildWrappedStream(
  userId: string,
  businessRequestId: string,
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let cancelled = false;
  let refunded = false;

  async function refundOnce(originalError: unknown): Promise<void> {
    if (refunded || cancelled) return;
    refunded = true;
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
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        }
      } catch (err) {
        if (cancelled) return;
        try {
          await refundOnce(err);
          controller.error(err);
        } catch (refundError) {
          controller.error(refundError);
        }
      }
    },
    cancel() {
      cancelled = true;
      void reader.cancel().catch(() => {});
    },
  });
}

export interface StreamChatResult {
  body: ReadableStream<Uint8Array>;
}

export async function streamChat(
  userId: string,
  message: string,
  options: {
    businessRequestId: string;
    lat?: number;
    lon?: number;
    conversationId?: string;
    authorization?: string;
    persona?: string;
  },
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

    if (!aiResponse.body) {
      throw new AppError(502, 'AI service unavailable');
    }

    return {
      body: buildWrappedStream(userId, options.businessRequestId, aiResponse.body),
    };
  } catch (err) {
    return revertAndRethrow(userId, options.businessRequestId, err);
  }
}
