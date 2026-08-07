import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import * as ctrl from '../controllers/notification-admin.controller.js';

const router = Router();

const idParam = z.object({ id: z.string().uuid() });

const createSchema = z.object({
  title: z.string().min(1).max(200),
  message: z.string().min(1),
  type: z.enum(['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'SYSTEM']).optional(),
  category: z
    .enum([
      'SAFETY', 'SECURITY', 'WEATHER', 'TRAFFIC', 'TOURIST', 'HISTORICAL',
      'EMERGENCY', 'RESTRICTED_AREA', 'PHOTOGRAPHY', 'RECOMMENDATION', 'SYSTEM',
    ])
    .optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
  audience: z.any().optional(),
  schedule: z.object({ sendAt: z.string().optional() }).optional(),
  templateId: z.string().uuid().optional(),
  data: z.record(z.any()).optional(),
});

const templateCreateSchema = z.object({
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  message: z.string().min(1),
  type: z.string().optional(),
  category: z.string().optional(),
  priority: z.string().optional(),
  variables: z.record(z.any()).optional(),
  data: z.record(z.any()).optional(),
});

router.get('/notifications', ctrl.listNotifications);
router.post('/notifications', validate(createSchema), ctrl.createNotification);

router.get('/templates', ctrl.listTemplates);
router.post('/templates', validate(templateCreateSchema), ctrl.createTemplate);
router.patch('/templates/:id', ctrl.updateTemplate);
router.delete('/templates/:id', validate(idParam, 'params'), ctrl.deleteTemplate);

router.get('/history', ctrl.listHistory);
router.post('/history/:id/cancel', validate(idParam, 'params'), ctrl.cancelScheduled);

router.get('/analytics', ctrl.getAnalytics);
router.get('/analytics/read-unread', ctrl.getReadUnreadStats);

router.get('/logs', ctrl.getDeliveryLogs);

router.get('/inbox/:userId', ctrl.listUserInbox);

router.get('/context-reports', ctrl.listContextReports);
router.get('/context-reports/:id', validate(idParam, 'params'), ctrl.getContextReport);

router.get('/settings', ctrl.getSettings);
router.put('/settings', ctrl.updateSettings);
router.get('/categories', ctrl.getCategories);
router.post('/process-scheduled', ctrl.processScheduled);

export default router;