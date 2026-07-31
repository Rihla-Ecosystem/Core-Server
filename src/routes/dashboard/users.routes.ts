import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import * as usersController from '../../controllers/dashboard/users.controller.js';

const router = Router();

const toBoolean = z.preprocess((value) => {
  if (value === 'true' || value === true) {
    return true;
  }
  if (value === 'false' || value === false) {
    return false;
  }
  return value;
}, z.boolean());

const baseFilterSchema = z.object({
  search: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).optional(),
  gender: z.enum(['MALE', 'FEMALE']).optional(),
  nationality: z.string().trim().min(1).optional(),
  language: z.string().trim().min(1).optional(),
  active: toBoolean.optional(),
  verified: toBoolean.optional(),
  banned: toBoolean.optional(),
  deleted: toBoolean.optional(),
  walletStatus: z.enum(['ACTIVE', 'INACTIVE', 'BLOCKED']).optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  lastLoginFrom: z.coerce.date().optional(),
  lastLoginTo: z.coerce.date().optional(),
  minXP: z.coerce.number().int().min(0).optional(),
  maxXP: z.coerce.number().int().min(0).optional(),
  minLevel: z.coerce.number().int().min(1).optional(),
  maxLevel: z.coerce.number().int().min(1).optional(),
  hasWallet: toBoolean.optional(),
  hasPayments: toBoolean.optional(),
  hasTrips: toBoolean.optional(),
  hasBadges: toBoolean.optional(),
  hasJourney: toBoolean.optional(),
});

const listQuerySchema = baseFilterSchema.extend({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  sort: z.enum(['createdAt', 'lastLoginAt', 'displayName', 'email', 'xp', 'level', 'id', 'walletBalance']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const statisticsQuerySchema = baseFilterSchema;

const exportQuerySchema = baseFilterSchema.extend({
  sort: z.enum(['createdAt', 'lastLoginAt', 'displayName', 'email', 'xp', 'level', 'id', 'walletBalance']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  format: z.enum(['csv', 'excel']).default('csv'),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

const idsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500).refine((ids) => new Set(ids).size === ids.length, {
    message: 'Duplicate ids are not allowed',
  }),
});

const changeRoleSchema = idsSchema.extend({
  role_id: z.coerce.number().int().positive(),
});

const bulkExportSchema = idsSchema.extend({
  format: z.enum(['csv', 'excel']).default('csv'),
});

const searchQuerySchema = z.object({
  search: z.string().trim().min(1),
});

router.use(authenticate);

/**
 * @openapi
 * /dashboard/users:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: List dashboard users
 *     description: Returns paginated users with filters, sorting, counts, and dashboard statistics.
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
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Users list
 */
router.get('/', requireRole('admin', 'moderator'), validate(listQuerySchema, 'query'), usersController.listUsers);

/**
 * @openapi
 * /dashboard/users/statistics:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: Get global dashboard statistics
 *     description: Returns aggregate user, wallet, payment, and leaderboards statistics for the dashboard.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard statistics
 */
router.get('/statistics', requireRole('admin', 'moderator'), validate(statisticsQuerySchema, 'query'), usersController.getGlobalStatistics);

/**
 * @openapi
 * /dashboard/users/recent-activity:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: Get recent dashboard activity
 *     description: Returns the latest registrations, logins, payments, trips, conversations, badge unlocks, and journey progress updates.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Recent activity
 */
router.get('/recent-activity', requireRole('admin', 'moderator'), usersController.getRecentActivity);

/**
 * @openapi
 * /dashboard/users/analytics/growth:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: Get user growth analytics
 *     description: Returns user creation trends across daily, weekly, monthly, and yearly ranges.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Growth analytics
 */
router.get('/analytics/growth', requireRole('admin', 'moderator'), usersController.getGrowthAnalytics);

/**
 * @openapi
 * /dashboard/users/analytics/revenue:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: Get revenue analytics
 *     description: Returns completed payment revenue trends across daily, weekly, monthly, and yearly ranges.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Revenue analytics
 */
router.get('/analytics/revenue', requireRole('admin', 'moderator'), usersController.getRevenueAnalytics);

/**
 * @openapi
 * /dashboard/users/analytics/countries:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: Get country analytics
 *     description: Returns users grouped by nationality.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Country analytics
 */
router.get('/analytics/countries', requireRole('admin', 'moderator'), usersController.getCountryAnalytics);

/**
 * @openapi
 * /dashboard/users/analytics/languages:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: Get language analytics
 *     description: Returns language usage statistics across all users.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Language analytics
 */
router.get('/analytics/languages', requireRole('admin', 'moderator'), usersController.getLanguageAnalytics);

/**
 * @openapi
 * /dashboard/users/analytics/retention:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: Get retention analytics
 *     description: Returns active, inactive, and dormant user counts based on last login.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Retention analytics
 */
router.get('/analytics/retention', requireRole('admin', 'moderator'), usersController.getRetentionAnalytics);

/**
 * @openapi
 * /dashboard/users/top:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: Get top users
 *     description: Returns top XP, wallet, revenue, traveler, conversation, and active user lists.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Top users
 */
router.get('/top', requireRole('admin', 'moderator'), usersController.getTopUsers);

/**
 * @openapi
 * /dashboard/users/search:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: Search users
 *     description: Fast search by name, email, or id.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Search suggestions
 */
router.get('/search', requireRole('admin', 'moderator'), validate(searchQuerySchema, 'query'), usersController.searchUsers);

/**
 * @openapi
 * /dashboard/users/export:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: Export users
 *     description: Exports users with all active filters in CSV or Excel format.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Export file
 */
router.get('/export', requireRole('admin', 'moderator'), validate(exportQuerySchema, 'query'), usersController.exportUsers);

/**
 * @openapi
 * /dashboard/users/admin-timeline:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: Get admin timeline
 *     description: Returns delete, restore, ban, role change, export, activation, and deactivation audit actions.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Admin timeline
 */
router.get('/admin-timeline', requireRole('admin', 'moderator'), usersController.adminTimeline);

/**
 * @openapi
 * /dashboard/users/{id}:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: Get user profile
 *     description: Returns a complete dashboard profile for a single user.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: User profile
 */
router.get('/:id', requireRole('admin', 'moderator'), validate(idParamSchema, 'params'), usersController.getUser);

/**
 * @openapi
 * /dashboard/users/{id}/statistics:
 *   get:
 *     tags: [Dashboard Users]
 *     summary: Get user statistics
 *     description: Returns payment, wallet, XP, journey, badge, trip, and engagement statistics for a single user.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: User statistics
 */
router.get('/:id/statistics', requireRole('admin', 'moderator'), validate(idParamSchema, 'params'), usersController.getUserStatistics);

/**
 * @openapi
 * /dashboard/users/{id}:
 *   delete:
 *     tags: [Dashboard Users]
 *     summary: Soft delete user
 *     description: Marks the user as deleted and sets deletedAt.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: User soft deleted
 */
router.delete('/:id', requireRole('admin'), validate(idParamSchema, 'params'), usersController.deleteUser);

/**
 * @openapi
 * /dashboard/users/{id}/restore:
 *   patch:
 *     tags: [Dashboard Users]
 *     summary: Restore user
 *     description: Restores a previously soft-deleted user.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: User restored
 */
router.patch('/:id/restore', requireRole('admin'), validate(idParamSchema, 'params'), usersController.restoreUser);

/**
 * @openapi
 * /dashboard/users/{id}/ban:
 *   patch:
 *     tags: [Dashboard Users]
 *     summary: Toggle user ban
 *     description: Bans an active user or unbans a banned user.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Ban status updated
 */
router.patch('/:id/ban', requireRole('admin'), validate(idParamSchema, 'params'), usersController.banUser);

/**
 * @openapi
 * /dashboard/users/{id}/unban:
 *   patch:
 *     tags: [Dashboard Users]
 *     summary: Unban user
 *     description: Clears the banned flag for the user.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: User unbanned
 */
router.patch('/:id/unban', requireRole('admin'), validate(idParamSchema, 'params'), usersController.unbanUser);

/**
 * @openapi
 * /dashboard/users/{id}/activate:
 *   patch:
 *     tags: [Dashboard Users]
 *     summary: Activate user
 *     description: Sets the user as active.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: User activated
 */
router.patch('/:id/activate', requireRole('admin'), validate(idParamSchema, 'params'), usersController.activateUser);

/**
 * @openapi
 * /dashboard/users/{id}/deactivate:
 *   patch:
 *     tags: [Dashboard Users]
 *     summary: Deactivate user
 *     description: Sets the user as inactive.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: User deactivated
 */
router.patch('/:id/deactivate', requireRole('admin'), validate(idParamSchema, 'params'), usersController.deactivateUser);

/**
 * @openapi
 * /dashboard/users/{id}/verify-email:
 *   patch:
 *     tags: [Dashboard Users]
 *     summary: Verify user email
 *     description: Marks the user email as verified.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Email verified
 */
router.patch('/:id/verify-email', requireRole('admin'), validate(idParamSchema, 'params'), usersController.verifyEmail);

/**
 * @openapi
 * /dashboard/users/{id}/role:
 *   patch:
 *     tags: [Dashboard Users]
 *     summary: Change user role
 *     description: Assigns a new role to the user.
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
 *             type: object
 *             required: [role_id]
 *             properties:
 *               role_id: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: Role updated
 */
router.patch('/:id/role', requireRole('admin'), validate(idParamSchema, 'params'), validate(z.object({ role_id: z.coerce.number().int().positive() })), usersController.changeRole);

/**
 * @openapi
 * /dashboard/users/{id}/reset-wallet:
 *   patch:
 *     tags: [Dashboard Users]
 *     summary: Reset user wallet
 *     description: Sets wallet balance to zero and records the adjustment.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Wallet reset
 */
router.patch('/:id/reset-wallet', requireRole('admin'), validate(idParamSchema, 'params'), usersController.resetWallet);

/**
 * @openapi
 * /dashboard/users/{id}/reset-xp:
 *   patch:
 *     tags: [Dashboard Users]
 *     summary: Reset user XP
 *     description: Resets XP to zero and level to one.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: XP reset
 */
router.patch('/:id/reset-xp', requireRole('admin'), validate(idParamSchema, 'params'), usersController.resetXp);

/**
 * @openapi
 * /dashboard/users/bulk/delete:
 *   post:
 *     tags: [Dashboard Users]
 *     summary: Bulk soft delete users
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Bulk delete completed
 */
router.post('/bulk/delete', requireRole('admin'), validate(idsSchema), usersController.bulkDelete);

/**
 * @openapi
 * /dashboard/users/bulk/restore:
 *   post:
 *     tags: [Dashboard Users]
 *     summary: Bulk restore users
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Bulk restore completed
 */
router.post('/bulk/restore', requireRole('admin'), validate(idsSchema), usersController.bulkRestore);

/**
 * @openapi
 * /dashboard/users/bulk/ban:
 *   post:
 *     tags: [Dashboard Users]
 *     summary: Bulk ban users
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Bulk ban completed
 */
router.post('/bulk/ban', requireRole('admin'), validate(idsSchema), usersController.bulkBan);

/**
 * @openapi
 * /dashboard/users/bulk/unban:
 *   post:
 *     tags: [Dashboard Users]
 *     summary: Bulk unban users
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Bulk unban completed
 */
router.post('/bulk/unban', requireRole('admin'), validate(idsSchema), usersController.bulkUnban);

/**
 * @openapi
 * /dashboard/users/bulk/activate:
 *   post:
 *     tags: [Dashboard Users]
 *     summary: Bulk activate users
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Bulk activate completed
 */
router.post('/bulk/activate', requireRole('admin'), validate(idsSchema), usersController.bulkActivate);

/**
 * @openapi
 * /dashboard/users/bulk/deactivate:
 *   post:
 *     tags: [Dashboard Users]
 *     summary: Bulk deactivate users
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Bulk deactivate completed
 */
router.post('/bulk/deactivate', requireRole('admin'), validate(idsSchema), usersController.bulkDeactivate);

/**
 * @openapi
 * /dashboard/users/bulk/verify:
 *   post:
 *     tags: [Dashboard Users]
 *     summary: Bulk verify emails
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Bulk verify completed
 */
router.post('/bulk/verify', requireRole('admin'), validate(idsSchema), usersController.bulkVerify);

/**
 * @openapi
 * /dashboard/users/bulk/change-role:
 *   post:
 *     tags: [Dashboard Users]
 *     summary: Bulk change role
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids, role_id]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *               role_id: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: Bulk role update completed
 */
router.post('/bulk/change-role', requireRole('admin'), validate(changeRoleSchema), usersController.bulkChangeRole);

/**
 * @openapi
 * /dashboard/users/bulk/export:
 *   post:
 *     tags: [Dashboard Users]
 *     summary: Bulk export users
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *               format:
 *                 type: string
 *                 enum: [csv, excel]
 *     responses:
 *       200:
 *         description: Bulk export file
 */
router.post('/bulk/export', requireRole('admin', 'moderator'), validate(bulkExportSchema), usersController.bulkExport);

export default router;
