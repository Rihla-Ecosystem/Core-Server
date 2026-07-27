import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { chat } from '../services/chat.service.js';

const router = Router();

const chatSchema = z.object({
  message: z.string().min(1).max(10000),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  base_currency: z.string().length(3).optional(),
  conversation_id: z.string().uuid().optional(),
  persona: z.enum(['auto', 'tour_guide', 'local_expert', 'safety_guru']).default('auto').optional(),
});

router.post('/', authenticate, validate(chatSchema), async (req, res, next) => {
  try {
    const { message, lat, lon, conversation_id, base_currency, persona } = req.body;
    const result = await chat(req.user!.userId, message, {
      lat,
      lon,
      conversationId: conversation_id,
      authorization: req.headers.authorization,
      baseCurrency: base_currency,
      persona,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
