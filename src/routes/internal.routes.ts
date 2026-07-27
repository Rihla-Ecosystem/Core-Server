import { Router } from 'express';
import { z } from 'zod';
import { requireInternalApiKey } from '../middleware/internal-api-key.js';
import {
  getCombinedContext,
  getFullGeoContext,
  getFullSafetyContext,
  getUserContext,
  getJourneyProgress,
} from '../services/internal.service.js';

const router = Router();
const locationSchema = z.object({ lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180) });
const userSchema = z.object({ user_id: z.string().uuid() });
const combinedSchema = userSchema.merge(locationSchema.partial()).extend({ base_currency: z.string().optional() });

router.use(requireInternalApiKey);

router.get('/geo', async (req, res, next) => {
  try { const { lat, lon } = locationSchema.parse(req.query); res.json(await getFullGeoContext(lat, lon, req.headers.authorization)); } catch (e) { next(e); }
});
router.get('/safety', async (req, res, next) => {
  try { const { lat, lon } = locationSchema.parse(req.query); res.json({ safety: await getFullSafetyContext(lat, lon, req.headers.authorization) }); } catch (e) { next(e); }
});
router.get('/user', async (req, res, next) => {
  try { const { user_id } = userSchema.parse(req.query); res.json(await getUserContext(user_id)); } catch (e) { next(e); }
});
router.get('/journeys', async (req, res, next) => {
  try { const { user_id } = userSchema.parse(req.query); res.json(await getJourneyProgress(user_id)); } catch (e) { next(e); }
});
router.get('/combined-context', async (req, res, next) => {
  try { const input = combinedSchema.parse(req.query); res.json(await getCombinedContext(input.user_id, input.lat, input.lon, req.headers.authorization, input.base_currency)); } catch (e) { next(e); }
});

export default router;
