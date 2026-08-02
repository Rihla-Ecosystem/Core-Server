import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { userRateLimit } from '../utils/rate-limit.js';
import * as journeyService from '../services/journey.service.js';

const router = Router();
const slugSchema = z.object({ slug: z.string().min(1).max(100) });
const stepSchema = z.object({ step_number: z.coerce.number().int().positive() });

const journeyRateLimit = userRateLimit({ windowMs: 60 * 1000, max: 10 });

router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    res.json(await journeyService.listJourneys(req.user!.userId));
  } catch (e) {
    next(e);
  }
});

router.get('/:slug', validate(slugSchema, 'params'), async (req, res, next) => {
  try {
    const result = await journeyService.getJourneyDetail(
      req.user!.userId,
      req.params.slug as string,
    );
    if (!result) return res.status(404).json({ error: 'Journey not found' });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/:slug/start', journeyRateLimit, validate(slugSchema, 'params'), async (req, res, next) => {
  try {
    const result = await journeyService.startJourney(req.user!.userId, req.params.slug as string);
    if (!result) return res.status(404).json({ error: 'Journey not found' });
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/:slug/steps/complete', journeyRateLimit, validate(slugSchema, 'params'), validate(stepSchema), async (req, res, next) => {
  try {
    const result = await journeyService.completeJourneyStep(
      req.user!.userId,
      req.params.slug as string,
      req.body.step_number,
    );
    if (!result) return res.status(404).json({ error: 'Journey step not found' });
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default router;
