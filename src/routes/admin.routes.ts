import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import * as adminController from '../controllers/admin.controller.js';
import * as shadowPricingAdminController from '../controllers/ai-shadow-pricing-admin.controller.js';
import adminTokenPackageRoutes from './admin-token-package.routes.js';
import adminPaymentRoutes from './admin-payment.routes.js';
import adminTokenWalletRoutes from './admin-token-wallet.routes.js';

import adminEnterpriseRoutes from './admin-enterprise.routes.js';
import notificationAdminRoutes from './notification-admin.routes.js';

import adminRateCardRoutes from './admin-rate-card.routes.js';
import incidentReportAdminRoutes from './incident-report-admin.routes.js';
import {
  adminObservationsQuerySchema,
  adminRecomputeBodySchema,
} from '../schemas/admin-shadow-pricing.schema.js';
import * as adminBillingRecoveryController from '../controllers/admin-billing-recovery.controller.js';
import {
  adminBillingRecoveryActionBodySchema,
  adminBillingRecoveryQueueQuerySchema,
  adminBillingRecoveryReservationParamsSchema,
  adminBillingRecoveryWalletParamsSchema,
} from '../schemas/admin-billing-recovery.schema.js';
import * as adminTokenReservationController from '../controllers/admin-token-reservation.controller.js';
import {
  adminTokenReservationListQuerySchema,
  adminTokenReservationParamsSchema,
} from '../schemas/admin-token-reservation.schema.js';

const router = Router();

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests, please try again later' },
});

router.use(authenticate);
router.use(adminLimiter);

router.use(
  '/enterprise',
  requireRole('admin'),
  adminEnterpriseRoutes,
);

router.use(
  '/notifications',
  requireRole('admin', 'moderator'),
  notificationAdminRoutes,
);

router.use(
  '/token-packages',
  requireRole('admin'),
  adminTokenPackageRoutes,
);

router.use(
  '/payments',
  requireRole('admin'),
  adminPaymentRoutes,
);

router.use(
  '/token-wallets',
  requireRole('admin'),
  adminTokenWalletRoutes,
);

// Phase 2F-C — admin rate-card Draft / Import / Validate / Publish / Retire.
router.use(
  '/rate-cards',
  requireRole('admin'),
  adminRateCardRoutes,
);

router.use(
  '/incident-reports',
  requireRole('admin', 'moderator'),
  incidentReportAdminRoutes,
);

const roleUpdateSchema = z.object({
  role_id: z.number().int().positive(),
});

/**
 * @openapi
 * /admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: List all users (admin/moderator)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of users
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 *       403:
 *         description: Insufficient permissions
 */
router.get('/users', requireRole('admin', 'moderator'), adminController.getAllUsers);

/**
 * @openapi
 * /admin/users/{id}/role:
 *   patch:
 *     tags: [Admin]
 *     summary: Change user role (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateRoleInput'
 *     responses:
 *       200:
 *         description: Role updated
 *       403:
 *         description: Insufficient permissions
 */
router.patch('/users/:id/role', requireRole('admin'), validate(roleUpdateSchema), adminController.updateUserRole);

/**
 * @openapi
 * /admin/users/{id}/ban:
 *   patch:
 *     tags: [Admin]
 *     summary: Toggle ban status (admin/moderator)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Ban status toggled
 *       403:
 *         description: Insufficient permissions
 */
router.patch('/users/:id/ban', requireRole('admin', 'moderator'), adminController.banUser);

router.patch('/users/:id/unban', requireRole('admin', 'moderator'), adminController.unbanUser);

/**
 * @openapi
 * /admin/audit-logs:
 *   get:
 *     tags: [Admin]
 *     summary: View audit logs (admin only)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Audit log entries
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/AuditLog'
 *       403:
 *         description: Insufficient permissions
 */
router.get('/audit-logs', requireRole('admin'), adminController.getAuditLogs);

router.get('/stats', requireRole('admin'), adminController.getStats);

router.get('/stats/monthly', requireRole('admin'), adminController.getMonthlyStats);

router.get('/ai-usage', requireRole('admin'), adminController.getAiUsage);

router.get('/system/health', requireRole('admin'), adminController.getSystemHealthController);

// Phase 2D-B — read-only shadow-pricing admin endpoints.
router.get(
  '/ai-shadow-pricing/summary',
  requireRole('admin'),
  shadowPricingAdminController.getShadowPricingSummary,
);

router.get(
  '/billing-recovery/wallets/:walletId/reconcile',
  requireRole('admin'),
  validate(adminBillingRecoveryWalletParamsSchema, 'params'),
  adminBillingRecoveryController.reconcileWallet,
);


router.get(
  '/ai-shadow-pricing/observations',
  requireRole('admin'),
  validate(adminObservationsQuerySchema, 'query'),
  shadowPricingAdminController.getShadowPricingObservations,
);

router.post(
  '/ai-shadow-pricing/recompute-preview',
  requireRole('admin'),
  validate(adminRecomputeBodySchema, 'body'),
  shadowPricingAdminController.recomputePreview,
);

/**
 * @openapi
 * /admin/billing-recovery/queue:
 *   get:
 *     tags: [Admin]
 *     summary: List the AI billing recovery queue (admin)
 *     description: |
 *       Returns unresolved AI billing token reservations with pagination and aggregate totals.
 *       Reservations in PENDING status are the primary recovery candidates and are classified by
 *       metadata status (METADATA_MISSING, METADATA_INVALID, or PENDING_REVIEW). Expired
 *       reservations are flagged with isExpired. COMPLETED and RELEASED reservations are included
 *       when explicitly filtered and are reported as RESOLVED in the queue listing; use the
 *       inspect endpoint for per-reservation integrity assessment.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [PENDING, COMPLETED, RELEASED] }
 *       - in: query
 *         name: feature
 *         schema: { type: string, maxLength: 50 }
 *     responses:
 *       200:
 *         description: Paginated recovery queue with aggregate token totals
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 */
router.get(
  '/billing-recovery/queue',
  requireRole('admin'),
  validate(adminBillingRecoveryQueueQuerySchema, 'query'),
  adminBillingRecoveryController.getRecoveryQueue,
);

router.get(
  '/billing-recovery/wallets/:walletId/reconcile',
  requireRole('admin'),
  validate(adminBillingRecoveryWalletParamsSchema, 'params'),
  adminBillingRecoveryController.reconcileWallet,
);

router.get(
  '/billing-recovery/:reservationId',
  requireRole('admin'),
  validate(adminBillingRecoveryReservationParamsSchema, 'params'),
  adminBillingRecoveryController.inspectRecoveryReservation,
);

router.post(
  '/billing-recovery/:reservationId/action',
  requireRole('admin'),
  validate(adminBillingRecoveryReservationParamsSchema, 'params'),
  validate(adminBillingRecoveryActionBodySchema),
  adminBillingRecoveryController.recoverReservation,
);

router.get(
  '/token-reservations',
  requireRole('admin'),
  validate(adminTokenReservationListQuerySchema, 'query'),
  adminTokenReservationController.listTokenReservations,
);

router.get(
  '/token-reservations/:reservationId',
  requireRole('admin'),
  validate(adminTokenReservationParamsSchema, 'params'),
  adminTokenReservationController.inspectTokenReservation,
);

export default router;
