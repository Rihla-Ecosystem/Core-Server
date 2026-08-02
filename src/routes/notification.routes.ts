import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as ctrl from '../controllers/admin-enterprise.controller.js';

const router = Router();

const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
  isRead: z.enum(['true', 'false']).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid() });

router.use(authenticate);

router.get('/', validate(listSchema, 'query'), ctrl.getMyNotifications);
router.get('/unread-count', ctrl.getMyUnreadCount);
router.patch('/read-all', ctrl.markAllNotificationsRead);
router.patch('/:id/read', validate(idParamSchema, 'params'), ctrl.markNotificationRead);
router.delete('/:id', validate(idParamSchema, 'params'), ctrl.deleteNotification);

export default router;
