import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { streamChat } from '../services/chat-stream.service.js';
import { recordAiUsage } from '../services/ai-usage.service.js';
import { prisma } from '../config/prisma.js';
import { Readable } from 'stream';

const router = Router();

const streamSchema = z.object({
  message: z.string().min(1).max(10000),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  conversation_id: z.string().uuid().optional(),
  persona: z.enum(['auto', 'tour_guide', 'local_expert', 'safety_guru']).default('auto').optional(),
});

router.post('/stream', authenticate, validate(streamSchema), async (req, res, next) => {
  try {
    const { message, lat, lon, conversation_id, persona } = req.body;
    const { response: aiResponse, conversationId } = await streamChat(req.user!.userId, message, {
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

    const readable = Readable.fromWeb(aiResponse.body! as never as import('stream/web').ReadableStream);

    let fullResponse = '';
    let usage: { model?: string | null; inputTokens?: number; outputTokens?: number; totalTokens?: number } | null = null;
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
          } catch {
            // ignore malformed event
          }
        }
      }
    });

    readable.on('end', async () => {
      try {
        if (fullResponse) {
          await prisma.message.create({
            data: { conversationId, role: 'assistant', content: fullResponse },
          });
        }
        await recordAiUsage({
          userId: req.user!.userId,
          conversationId,
          source: 'stream',
          usage,
        });
      } catch (err) {
        console.error('Failed to persist stream output', err);
      }
      res.end();
    });

    readable.on('error', (err) => {
      console.error('Chat stream error', err);
      res.end();
    });
  } catch (err) {
    next(err);
  }
});

export default router;
