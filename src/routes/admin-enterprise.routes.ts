import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import * as ctrl from '../controllers/admin-enterprise.controller.js';
import {
  roleListQuerySchema,
  roleCreateBodySchema,
  roleUpdateBodySchema,
  intParamSchema,
  idParamSchema,
  badgeListQuerySchema,
  badgeCreateBodySchema,
  badgeUpdateBodySchema,
  journeyListQuerySchema,
  journeyCreateBodySchema,
  journeyUpdateBodySchema,
  journeyStepBodySchema,
  journeyStepUpdateBodySchema,
  tripListQuerySchema,
  conversationListQuerySchema,
  transactionListQuerySchema,
  notificationListQuerySchema,
  notificationCreateBodySchema,
  auditLogListQuerySchema,
} from '../schemas/admin-enterprise.schema.js';

const router = Router();

// Roles
router.get('/roles', validate(roleListQuerySchema, 'query'), ctrl.listRoles);
router.post('/roles', validate(roleCreateBodySchema), ctrl.createRole);
router.get('/roles/:id', validate(intParamSchema, 'params'), ctrl.getRole);
router.patch('/roles/:id', validate(intParamSchema, 'params'), validate(roleUpdateBodySchema), ctrl.updateRole);
router.delete('/roles/:id', validate(intParamSchema, 'params'), ctrl.deleteRole);

// Badges
router.get('/badges', validate(badgeListQuerySchema, 'query'), ctrl.listBadges);
router.post('/badges', validate(badgeCreateBodySchema), ctrl.createBadge);
router.get('/badges/:id', validate(intParamSchema, 'params'), ctrl.getBadge);
router.patch('/badges/:id', validate(intParamSchema, 'params'), validate(badgeUpdateBodySchema), ctrl.updateBadge);
router.delete('/badges/:id', validate(intParamSchema, 'params'), ctrl.deleteBadge);

// Journeys
router.get('/journeys', validate(journeyListQuerySchema, 'query'), ctrl.listJourneys);
router.post('/journeys', validate(journeyCreateBodySchema), ctrl.createJourney);
router.get('/journeys/:id', validate(idParamSchema, 'params'), ctrl.getJourney);
router.patch('/journeys/:id', validate(idParamSchema, 'params'), validate(journeyUpdateBodySchema), ctrl.updateJourney);
router.delete('/journeys/:id', validate(idParamSchema, 'params'), ctrl.deleteJourney);
router.post('/journeys/:id/steps', validate(idParamSchema, 'params'), validate(journeyStepBodySchema), ctrl.addJourneyStep);
router.patch('/journeys/:id/steps/:stepId', validate(idParamSchema, 'params'), validate(journeyStepUpdateBodySchema), ctrl.updateJourneyStep);
router.delete('/journeys/:id/steps/:stepId', validate(idParamSchema, 'params'), ctrl.deleteJourneyStep);

// Trips
router.get('/trips', validate(tripListQuerySchema, 'query'), ctrl.listTrips);
router.get('/trips/:id', validate(idParamSchema, 'params'), ctrl.getTrip);
router.delete('/trips/:id', validate(idParamSchema, 'params'), ctrl.deleteTrip);

// Conversations
router.get('/conversations', validate(conversationListQuerySchema, 'query'), ctrl.listConversations);
router.get('/conversations/:id', validate(idParamSchema, 'params'), ctrl.getConversation);

// Token transactions
router.get('/transactions/statistics', ctrl.getTransactionStatistics);
router.get('/transactions', validate(transactionListQuerySchema, 'query'), ctrl.listTransactions);

// Notifications (admin)
router.get('/notifications', validate(notificationListQuerySchema, 'query'), ctrl.listNotifications);
router.post('/notifications', validate(notificationCreateBodySchema), ctrl.createNotification);

// Audit logs
router.get('/audit-logs', validate(auditLogListQuerySchema, 'query'), ctrl.listAuditLogs);

// Overview / health
router.get('/overview', ctrl.getOverview);
router.get('/system-health', ctrl.getSystemHealth);
router.get('/entity-statistics', ctrl.getEntityStatistics);

// API monitoring
router.get('/api-monitoring/summary', ctrl.getApiMonitoringSummary);
router.get('/api-monitoring', ctrl.getApiMonitoringLogs);

// AI Admin Assistant (admin only — mounted under /admin/enterprise)
router.post('/assistant', ctrl.runAssistant);

export default router;
