// ---------------------------------------------------------------------------
// Incident Report admin routes — /api/admin/incident-reports
// ---------------------------------------------------------------------------
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import * as ctrl from '../controllers/incident-report-admin.controller.js';

const router = Router();

const idParam = z.object({ id: z.string().uuid() });

const statusSchema = z
  .object({
    status: z.enum(['PENDING', 'IN_REVIEW', 'RESOLVED', 'REJECTED']),
    adminNotes: z.string().trim().max(2000).optional(),
  })
  .strict();

router.get('/', ctrl.listReportsAdmin);
router.get('/:id', validate(idParam, 'params'), ctrl.getReportAdmin);
router.patch('/:id', validate(idParam, 'params'), validate(statusSchema), ctrl.updateReportStatus);

export default router;