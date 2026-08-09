// ---------------------------------------------------------------------------
// Incident Report routes (user-facing) — /api/reports
// ---------------------------------------------------------------------------
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { userRateLimit } from '../utils/rate-limit.js';
import * as ctrl from '../controllers/incident-report.controller.js';

const router = Router();

const createReportSchema = z.object({
  type: z.enum(['SAFETY', 'SCAM', 'SERVICE', 'DAMAGE', 'ACCESSIBILITY', 'OTHER']),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  description: z.string().trim().min(10).max(2000),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  relatedSiteName: z.string().trim().min(1).max(255).optional(),
});

const idParam = z.object({ id: z.string().uuid() });

const reportCreateLimiter = userRateLimit({ windowMs: 60 * 1000, max: 5 });

router.use(authenticate);

router.post('/', reportCreateLimiter, validate(createReportSchema), ctrl.createReport);
router.get('/', ctrl.listReports);
router.get('/:id', validate(idParam, 'params'), ctrl.getReport);
router.delete('/:id', validate(idParam, 'params'), ctrl.deleteReport);

export default router;