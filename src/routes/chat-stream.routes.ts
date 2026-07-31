import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { streamChat } from '../services/chat-stream.service.js';
import { Readable } from 'stream';

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

router.post('/stream', authenticate, validate(streamSchema), async (req, res, next) => {
  try {
    const { message, lat, lon, conversation_id, persona } = req.body;
    const businessRequestId = readIdempotencyKey(req);
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError(401, 'Unauthorized');
    }

    const { body } = await streamChat(userId, message, {
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

    const readable = Readable.fromWeb(body);

    function detachListeners(): void {
      readable.off('error', onReadableError);
      res.off('error', onResponseError);
      res.off('close', onResponseClose);
    }

    function onResponseClose(): void {
      readable.destroy();
      detachListeners();
    }

    function onReadableError(): void {
      detachListeners();
      res.destroy();
    }

    function onResponseError(): void {
      detachListeners();
      readable.destroy();
    }

    readable.on('error', onReadableError);
    res.on('error', onResponseError);
    res.on('close', onResponseClose);
    readable.pipe(res);
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    next(err);
  }
});

export default router;
