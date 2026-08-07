import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { streamChat } from '../services/chat-stream.service.js';
import {
  failChatStreamUsageBasedBilling,
  settleChatStreamUsageBasedBilling,
} from '../services/chat-stream-billing.service.js';
import { recordAiUsage } from '../services/ai-usage.service.js';
import { prisma } from '../config/prisma.js';
import { walletPolicyConfig } from '../config/env.js';
import { parseChatLimitsConfig } from '../config/chat-limits.js';
import { Readable } from 'stream';
import { userRateLimit } from '../utils/rate-limit.js';

const router = Router();

const streamSchema = z.object({
  message: z.string().min(1).max(10000),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  conversation_id: z.string().uuid().optional(),
  persona: z.enum(['auto', 'tour_guide', 'local_expert', 'safety_guru']).default('auto').optional(),
});

const idempotencyKeySchema = z.string().uuid();

function readIdempotencyKey(req: Request): string {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError(400, 'Idempotency-Key header is required');
  }
  const parsed = idempotencyKeySchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new AppError(400, 'Idempotency-Key header must be a valid UUID');
  }
  return parsed.data;
}

router.post(
  '/stream',
  authenticate,
  userRateLimit({ windowMs: 60 * 1000, max: 60 }),
  validate(streamSchema),
  async (req, res, next) => {
  try {
    const { message, lat, lon, conversation_id, persona } = req.body;
    const businessRequestId = readIdempotencyKey(req);
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError(401, 'Unauthorized');
    }

    const { body, conversationId, billing } = await streamChat(userId, message, {
      businessRequestId,
      lat,
      lon,
      conversationId: conversation_id,
      authorization: req.headers.authorization,
      persona,
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(`data: ${JSON.stringify({ conversation_id: conversationId })}\n\n`);

    const readable = Readable.fromWeb(body);

    const isUsageBased = billing.mode === 'USAGE_BASED';
    let billingSettled = false;

    async function failStreamIfNeeded(): Promise<void> {
      if (!isUsageBased || billingSettled) return;
      billingSettled = true;
      await failChatStreamUsageBasedBilling({
        operationId: billing.operationId,
        reservationId: billing.reservationId,
      });
    }

    function detachListeners(): void {
      readable.off('error', onReadableError);
      res.off('error', onResponseError);
      res.off('close', onResponseClose);
    }

    function onResponseClose(): void {
      void failStreamIfNeeded();
      readable.destroy();
      detachListeners();
    }

    function onReadableError(): void {
      void failStreamIfNeeded();
      detachListeners();
      res.destroy();
    }

    function onResponseError(): void {
      void failStreamIfNeeded();
      detachListeners();
      readable.destroy();
    }

    let fullResponse = '';
    let usage: { model?: string | null; inputTokens?: number; outputTokens?: number; totalTokens?: number } | null = null;
    let providerCalls: unknown = undefined;
    let providerAttempts: unknown = undefined;
    let buffer = '';

    readable.on('data', (chunk: Buffer) => {
      res.write(chunk);
      buffer += chunk.toString();
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const evt of events) {
        for (const line of evt.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          try {
            const payload = JSON.parse(raw);
            if (payload.done && typeof payload.full_response === 'string') {
              fullResponse = payload.full_response;
            }
            if (payload.usage && typeof payload.usage === 'object') {
              usage = payload.usage;
            }
            if (Array.isArray(payload.providerCalls)) {
              providerCalls = payload.providerCalls;
            }
            if (Array.isArray(payload.providerAttempts)) {
              providerAttempts = payload.providerAttempts;
            }
          } catch {
            // ignore malformed event
          }
        }
      }
    });

    readable.on('end', async () => {
      try {
        if (isUsageBased) {
          billingSettled = true;
          await settleChatStreamUsageBasedBilling({
            operationId: billing.operationId,
            reservationId: billing.reservationId,
            userId,
            feature: 'AI_CHAT_QUERY',
            reservedTokens: billing.reservedTokens,
            usage,
            providerCalls,
            providerAttempts,
            chatLimits: parseChatLimitsConfig(process.env),
            rateCard: billing.rateCard,
            pricingSource: billing.pricingSource,
            walletPolicy: walletPolicyConfig,
          });
        }
        if (fullResponse) {
          await prisma.message.create({
            data: { conversationId, role: 'assistant', content: fullResponse },
          });
        }
        await recordAiUsage({
          userId,
          conversationId,
          source: 'stream',
          usage,
          providerCalls,
          providerAttempts,
        });
      } catch (err) {
        console.error('Failed to persist stream output', err);
      }
      res.end();
    });

    readable.on('error', onReadableError);
    res.on('error', onResponseError);
    res.on('close', onResponseClose);
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    next(err);
  }
});

export default router;
