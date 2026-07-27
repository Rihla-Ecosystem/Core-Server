import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { fetchSafetyContext } from '../services/risk.service.js';

const router = Router();
const querySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});

router.get('/', authenticate, validate(querySchema, 'query'), async (req, res, next) => {
  try {
    const { lat, lon } = req.query as unknown as { lat: number; lon: number };
    res.json({ safety: await fetchSafetyContext(lat, lon, req.headers.authorization) });
  } catch (error) {
    next(error);
  }
});

export default router;
