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
