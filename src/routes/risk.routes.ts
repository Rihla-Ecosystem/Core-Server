import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { fetchSafetyData, fetchSafetyChanges, fetchRiskHealth, triggerRiskRefresh } from '../services/risk.service.js';

const router = Router();

/* ── Schemas ────────────────────────────────────────────────────── */

const cityQuerySchema = z.object({
  city: z.string().min(1).optional(),
});

const changesQuerySchema = z.object({
  since: z.string().datetime({ message: 'since must be a valid ISO 8601 datetime' }),
  city: z.string().min(1).optional(),
});

const refreshQuerySchema = z.object({
  source: z.string().min(1).optional(),
});

/* ── Routes ─────────────────────────────────────────────────────── */

/**
 * @openapi
 * /risk/current:
 *   get:
 *     tags: [Risk]
 *     summary: Get current safety risk data
 *     description: Returns current risk state for a city, or all cities if omitted
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: city
 *         schema: { type: string, example: "Cairo" }
 *     responses:
 *       200:
 *         description: Safety risk state
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/current',
  authenticate,
  validate(cityQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { city } = req.query as { city?: string };
    const data = await fetchSafetyData(city);
    res.json(data ?? {});
  }),
);

/**
 * @openapi
 * /risk/changes:
 *   get:
 *     tags: [Risk]
 *     summary: Get safety change events since a timestamp
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: since
 *         required: true
 *         schema: { type: string, format: date-time, example: "2024-01-01T00:00:00Z" }
 *       - in: query
 *         name: city
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Change events list
 *       400:
 *         description: Missing or invalid since param
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/changes',
  authenticate,
  validate(changesQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { since, city } = req.query as { since: string; city?: string };
    const data = await fetchSafetyChanges(since, city);
    res.json(data);
  }),
);

/**
 * @openapi
 * /risk/health:
 *   get:
 *     tags: [Risk]
 *     summary: Get Risk Intelligence source adapter health
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Health status of all source adapters
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/health',
  authenticate,
  asyncHandler(async (_req, res) => {
    const data = await fetchRiskHealth();
    res.json(data ?? { status: 'unavailable' });
  }),
);

/**
 * @openapi
 * /risk/refresh:
 *   post:
 *     tags: [Risk]
 *     summary: Trigger manual safety data refresh (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: source
 *         schema: { type: string, description: "Specific source adapter name; omit to refresh all" }
 *     responses:
 *       200:
 *         description: Refresh result
 *       403:
 *         description: Admin only
 */
router.post(
  '/refresh',
  authenticate,
  requireRole('admin'),
  validate(refreshQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { source } = req.query as { source?: string };
    const result = await triggerRiskRefresh(source);
    res.json(result ?? { status: 'triggered' });
  }),
);

export default router;
