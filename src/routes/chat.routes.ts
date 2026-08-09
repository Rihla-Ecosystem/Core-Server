import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { chat, getConversations, getMessages, deleteConversation } from '../services/chat.service.js';
import { userRateLimit } from '../utils/rate-limit.js';

const router = Router();

const chatSchema = z.object({
  message: z.string().min(1).max(10000),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  base_currency: z.string().length(3).optional(),
  conversation_id: z.string().uuid().optional(),
  persona: z.enum(['auto', 'tour_guide', 'local_expert', 'safety_guru']).default('auto').optional(),
  context: z.record(z.string(), z.any()).optional(),
  title: z.string().min(1).max(120).optional(),
});

const idempotencyKeySchema = z.string().uuid();

const conversationIdParamSchema = z.object({
  id: z.string().uuid(),
});

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
  '/',
  authenticate,
  userRateLimit({ windowMs: 60 * 1000, max: 60 }),
  validate(chatSchema),
  async (req, res, next) => {
  try {
    const { message, lat, lon, conversation_id, base_currency, persona, context, title } = req.body;
    const businessRequestId = readIdempotencyKey(req);
    const result = await chat(req.user!.userId, message, {
      businessRequestId,
      lat,
      lon,
      conversationId: conversation_id,
      authorization: req.headers.authorization,
      baseCurrency: base_currency,
      persona,
      context,
      title,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/conversations', authenticate, async (req, res, next) => {
  try {
    const convs = await getConversations(req.user!.userId);
    res.json({ conversations: convs });
  } catch (err) {
    next(err);
  }
});

router.get('/conversations/:id/messages', authenticate, validate(conversationIdParamSchema, 'params'), async (req, res, next) => {
  try {
    const msgs = await getMessages(req.user!.userId, req.params.id as string);
    res.json({ messages: msgs });
  } catch (err) {
    next(err);
  }
});

router.delete('/conversations/:id', authenticate, validate(conversationIdParamSchema, 'params'), async (req, res, next) => {
  try {
    await deleteConversation(req.user!.userId, req.params.id as string);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
