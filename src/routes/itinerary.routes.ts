import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { generateItineraryWithTokens } from '../services/itinerary.service.js';
import { userRateLimit } from '../utils/rate-limit.js';

const router = Router();

const itinerarySchema = z.object({
  interests: z.array(z.string().min(1).max(50)).min(1).max(10),
  days: z.coerce.number().int().min(1).max(14),
  budget: z.enum(['budget', 'mid', 'luxury']),
  style: z
    .enum(['cultural', 'adventure', 'relaxation', 'family', 'solo', 'romantic'])
    .optional(),
  cities: z.array(z.string().min(1).max(50)).max(10).optional(),
  base_currency: z.string().length(3).optional(),
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
  '/',
  authenticate,
  userRateLimit({ windowMs: 60 * 1000, max: 10 }),
  validate(itinerarySchema),
  async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError(401, 'Unauthorized');
    }

    const result = await generateItineraryWithTokens({
      userId,
      businessRequestId: readIdempotencyKey(req),
      interests: req.body.interests,
      days: req.body.days,
      budget: req.body.budget,
      style: req.body.style,
      cities: req.body.cities,
      baseCurrency: req.body.base_currency,
      authorization: req.headers.authorization,
      user: req.user,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
