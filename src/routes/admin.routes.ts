import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import * as adminController from '../controllers/admin.controller.js';
import * as shadowPricingAdminController from '../controllers/ai-shadow-pricing-admin.controller.js';
import adminTokenPackageRoutes from './admin-token-package.routes.js';
import adminPaymentRoutes from './admin-payment.routes.js';
import adminTokenWalletRoutes from './admin-token-wallet.routes.js';
import {
  adminObservationsQuerySchema,
  adminRecomputeBodySchema,
} from '../schemas/admin-shadow-pricing.schema.js';

const router = Router();

router.use(authenticate);

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

export default router;
