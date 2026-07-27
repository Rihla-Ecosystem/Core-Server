import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { fetchEnvContext } from '../services/env.service.js';

const router = Router();

const envQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});

/**
 * @openapi
 * /env:
 *   get:
 *     tags: [Environment]
 *     summary: Get environmental context
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
 *     responses:
 *       200:
 *         description: Environmental context
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EnvContext'
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 */
router.get('/', authenticate, validate(envQuerySchema, 'query'), async (req, res, next) => {
  try {
    const { lat, lon } = req.query as unknown as { lat: number; lon: number };
    const context = await fetchEnvContext(lat, lon);
    res.json(context);
  } catch (err) {
    next(err);
  }
});

export default router;
