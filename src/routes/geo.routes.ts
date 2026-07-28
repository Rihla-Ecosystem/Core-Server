import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { fetchPois, searchPlaces, fetchSitesByGovernorate } from '../services/geo.service.js';

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

/**
 * @openapi
 * /geo/pois:
 *   get:
 *     tags: [Geo]
 *     summary: Get points of interest
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: lat
 *         required: true
 *         schema: { type: number }
 *       - in: query
 *         name: lon
 *         required: true
 *         schema: { type: number }
 *       - in: query
 *         name: radius
 *         schema: { type: number }
 *       - in: query
 *         name: categories
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Points of interest
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GeoContext'
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 */
router.get('/pois', authenticate, validate(poisQuerySchema, 'query'), async (req, res, next) => {
  try {
    const { lat, lon, radius, categories } = req.query as unknown as { lat: number; lon: number; radius?: number; categories?: string };
    const result = await fetchPois(lat, lon, radius, categories, req.headers.authorization);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /geo/search:
 *   get:
 *     tags: [Geo]
 *     summary: Search places
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: lat
 *         schema: { type: number }
 *       - in: query
 *         name: lon
 *         schema: { type: number }
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GeoContext'
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 */
router.get('/search', authenticate, validate(searchQuerySchema, 'query'), async (req, res, next) => {
  try {
    const { q, lat, lon } = req.query as unknown as { q: string; lat?: number; lon?: number };
    const result = await searchPlaces(q, lat, lon, req.headers.authorization);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const governorateSchema = z.object({
  governorate_name: z.string().min(1),
  category: z.string().optional(),
});

router.get('/sites-by-governorate', authenticate, validate(governorateSchema, 'query'), async (req, res, next) => {
  try {
    const { governorate_name, category } = req.query as unknown as { governorate_name: string; category?: string };
    const result = await fetchSitesByGovernorate(governorate_name, category, req.headers.authorization);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
