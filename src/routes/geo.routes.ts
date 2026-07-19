import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { fetchPois, searchPlaces } from '../services/geo.service.js';

const router = Router();

const poisQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().optional(),
  categories: z.string().optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
});

router.get('/pois', authenticate, validate(poisQuerySchema, 'query'), async (req, res, next) => {
  try {
    const { lat, lon, radius, categories } = req.query as unknown as { lat: number; lon: number; radius?: number; categories?: string };
    const result = await fetchPois(lat, lon, radius, categories);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/search', authenticate, validate(searchQuerySchema, 'query'), async (req, res, next) => {
  try {
    const { q, lat, lon } = req.query as unknown as { q: string; lat?: number; lon?: number };
    const result = await searchPlaces(q, lat, lon);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
