import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import {
  fetchPois,
  searchPlaces,
  fetchSitesByGovernorate,
  fetchGovernorates,
  fetchCountryBoundary,
  fetchSiteById,
  fetchAreaNotice,
  fetchZonePolygons,
  fetchLegalGuide,
  type AreaNotice,
} from '../services/geo.service.js';

const router = Router();

const poisQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().optional(),
  categories: z.string().optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1),
  category: z.string().optional(),
  governorate: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
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
    const { q, category, governorate, limit } = req.query as unknown as { q: string; category?: string; governorate?: string; limit?: number };
    const result = await searchPlaces(q, category, governorate, limit, req.headers.authorization);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const governorateSchema = z.object({
  governorate_name: z.string().min(1),
  category: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

router.get('/sites-by-governorate', authenticate, validate(governorateSchema, 'query'), async (req, res, next) => {
  try {
    const { governorate_name, category, limit } = req.query as unknown as { governorate_name: string; category?: string; limit?: number };
    const result = await fetchSitesByGovernorate(governorate_name, category, limit, req.headers.authorization);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/governorates', authenticate, async (req, res, next) => {
  try {
    const result = await fetchGovernorates(req.headers.authorization);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/country', authenticate, async (req, res, next) => {
  try {
    const result = await fetchCountryBoundary(req.headers.authorization);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/sites/:id', authenticate, async (req, res, next) => {
  try {
    const result = await fetchSiteById(req.params.id as string, req.headers.authorization);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const noticeSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().optional(),
});

router.get('/notice', authenticate, validate(noticeSchema, 'query'), async (req, res, next) => {
  try {
    const { lat, lon, radius } = req.query as unknown as { lat: number; lon: number; radius?: number };
    const result = await fetchAreaNotice(lat, lon, radius, req.headers.authorization);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const zonesSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().optional(),
});

/**
 * @openapi
 * /geo/zones:
 *   get:
 *     tags: [Geo]
 *     summary: Anonymous sensitive-zone polygons for map rendering
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
 *     responses:
 *       200:
 *         description: Anonymous polygons (class + severity + geometry only)
 */
router.get('/zones', authenticate, validate(zonesSchema, 'query'), async (req, res, next) => {
  try {
    const { lat, lon, radius } = req.query as unknown as { lat: number; lon: number; radius?: number };
    const result = await fetchZonePolygons(lat, lon, radius, req.headers.authorization);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const lawSchema = z.object({
  class: z.enum(['restricted', 'caution', 'protected']),
  synthesize: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

/**
 * @openapi
 * /geo/law:
 *   get:
 *     tags: [Geo]
 *     summary: Egyptian laws/guides for a zone class (RAG + optional AI advice)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: class
 *         required: true
 *         schema: { type: string, enum: [restricted, caution, protected] }
 *     responses:
 *       200:
 *         description: Legal guidance for the zone class
 */
router.get('/law', authenticate, validate(lawSchema, 'query'), async (req, res, next) => {
  try {
    const { class: zoneClass, synthesize } = req.query as unknown as { class: AreaNotice['class']; synthesize: boolean };
    const result = await fetchLegalGuide(zoneClass!, synthesize);
    if (!result) {
      res.status(502).json({ error: 'Legal guide unavailable' });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
