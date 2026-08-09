import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { userRateLimit } from '../utils/rate-limit.js';
import * as ctrl from '../controllers/context-engine.controller.js';

const router = Router();

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).optional(),
  altitude: z.number().optional(),
  speed: z.number().min(0).optional(),
  heading: z.number().optional(),
  timestamp: z.number().optional(),
  reason: z.enum(['movement', 'geofence_enter', 'geofence_exit', 'initial', 'manual']).default('movement'),
  geofenceEvents: z
    .array(
      z.object({
        fenceId: z.string().optional(),
        name: z.string().optional(),
        type: z.enum(['enter', 'exit']),
        polygon: z.array(z.object({ lat: z.number(), lng: z.number() })).optional(),
      }),
    )
    .optional(),
});

const syncSchema = z.object({
  lastSync: z.string().optional(),
});

const idParam = z.object({ id: z.string().uuid() });

router.use(authenticate);

const locationReportLimiter = userRateLimit({ windowMs: 60 * 1000, max: 60 });

router.post('/location', locationReportLimiter, validate(locationSchema), ctrl.reportLocation);

router.get('/inbox', ctrl.getInbox);
router.get('/unread-count', ctrl.getUnreadCount);
router.patch('/inbox/read-all', ctrl.markAllRead);
router.post('/sync', validate(syncSchema), ctrl.syncAfterReconnect);
router.patch('/inbox/:id/read', validate(idParam, 'params'), ctrl.markRead);
router.delete('/inbox/:id', validate(idParam, 'params'), ctrl.deleteInbox);

router.get('/stream', ctrl.stream);

router.get('/reports', ctrl.listReports);
router.get('/reports/:id', validate(idParam, 'params'), ctrl.getReport);

router.get('/preferences', ctrl.getPreferences);
router.put('/preferences', ctrl.updatePreferences);

export default router;