import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
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

router.post('/stream', authenticate, validate(streamSchema), async (req, res, next) => {
  try {
    const { message, lat, lon, conversation_id, persona } = req.body;
    const aiResponse = await streamChat(req.user!.userId, message, {
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

    const readable = Readable.fromWeb(aiResponse.body! as never as import('stream/web').ReadableStream);
    readable.pipe(res);
  } catch (err) {
    next(err);
  }
});

export default router;
