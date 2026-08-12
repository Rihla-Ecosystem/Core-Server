// ---------------------------------------------------------------------------
// Favorite Place routes (user-facing) — /api/places
// ---------------------------------------------------------------------------
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { userRateLimit } from '../utils/rate-limit.js';
import * as ctrl from '../controllers/favorite-place.controller.js';

const router = Router();

const favoriteSchema = z.object({
  placeId: z.string().trim().min(1).max(255),
  placeName: z.string().trim().min(1).max(255),
  category: z.string().trim().max(100).optional(),
  governorate: z.string().trim().max(100).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  img: z.string().trim().max(2000).optional(),
});

const idParam = z.object({ placeId: z.string().trim().min(1).max(255) });

const eventSchema = z.object({
  event: z.string().trim().min(1).max(100),
  siteId: z.string().trim().max(255).optional(),
  siteName: z.string().trim().max(255).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const favoriteLimiter = userRateLimit({ windowMs: 60 * 1000, max: 20 });
const eventLimiter = userRateLimit({ windowMs: 60 * 1000, max: 60 });

router.use(authenticate);

router.get('/favorites', ctrl.listFavorites);
router.get('/favorites/:placeId', validate(idParam, 'params'), ctrl.checkFavorite);
router.post('/favorites', favoriteLimiter, validate(favoriteSchema), ctrl.addFavorite);
router.delete('/favorites/:placeId', validate(idParam, 'params'), ctrl.removeFavorite);
router.post('/events', eventLimiter, validate(eventSchema), ctrl.recordEvent);

export default router;
