import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { fetchNearbySites, fetchSpatialContext, fetchSitesByGovernorate } from '../services/geo.service.js';

const router = Router();

/* ── Schemas ────────────────────────────────────────────────────── */

const nearbySitesSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().optional(),
  category: z.string().optional(),
});

const contextSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().optional(),
});

const byGovernorateSchema = z.object({
  governorate: z.string().min(1),
  category: z.string().optional(),
});

/* ── Routes ─────────────────────────────────────────────────────── */

/**
 * @openapi
 * /geo/nearby-sites:
 *   get:
 *     tags: [Geo]
 *     summary: Get nearby archaeological/tourist sites
 *     security: [{ bearerAuth: [] }]
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
 *         schema: { type: number, description: "Search radius in metres (default: 5000)" }
 *       - in: query
 *         name: category
 *         schema: { type: string, example: "archaeological" }
 *     responses:
 *       200:
 *         description: List of nearby sites
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/nearby-sites',
  authenticate,
  validate(nearbySitesSchema, 'query'),
  asyncHandler(async (req, res) => {
    const { lat, lon, radius, category } = req.query as unknown as z.infer<typeof nearbySitesSchema>;
    const sites = await fetchNearbySites(lat, lon, radius, category);
    res.json(sites);
  }),
);

/**
 * @openapi
 * /geo/context:
 *   get:
 *     tags: [Geo]
 *     summary: Get full spatial context for a coordinate
 *     description: Returns governorate, current site, nearby sites, and restricted zones
 *     security: [{ bearerAuth: [] }]
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
 *         description: Spatial context object
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/context',
  authenticate,
  validate(contextSchema, 'query'),
  asyncHandler(async (req, res) => {
    const { lat, lon, radius } = req.query as unknown as z.infer<typeof contextSchema>;
    const context = await fetchSpatialContext(lat, lon, radius);
    res.json(context ?? {});
  }),
);

/**
 * @openapi
 * /geo/sites/by-governorate:
 *   get:
 *     tags: [Geo]
 *     summary: Get sites filtered by governorate name
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: governorate
 *         required: true
 *         schema: { type: string, example: "Cairo" }
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of sites in the governorate
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/sites/by-governorate',
  authenticate,
  validate(byGovernorateSchema, 'query'),
  asyncHandler(async (req, res) => {
    const { governorate, category } = req.query as unknown as z.infer<typeof byGovernorateSchema>;
    const sites = await fetchSitesByGovernorate(governorate, category);
    res.json(sites);
  }),
);

export default router;
