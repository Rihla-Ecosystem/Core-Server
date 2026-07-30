import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { adminTokenPackageListQuerySchema, adminTokenPackageIdParamsSchema } from '../schemas/admin-token-package.schema.js';
import * as adminTokenPackageController from '../controllers/admin-token-package.controller.js';

const router = Router();

/**
 * @openapi
 * /admin/token-packages:
 *   get:
 *     tags: [Admin]
 *     summary: List token packages (admin)
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
 *         schema: { type: string, maxLength: 100 }
 *       - in: query
 *         name: isActive
 *         schema: { type: string, enum: ['true', 'false'] }
 *       - in: query
 *         name: currency
 *         schema: { type: string, minLength: 3, maxLength: 3 }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: ['name', 'price', 'tokens', 'sortOrder', 'createdAt', 'updatedAt'], default: 'sortOrder' }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: ['asc', 'desc'], default: 'asc' }
 *     responses:
 *       200:
 *         description: Paginated list of token packages
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 */
router.get(
  '/',
  validate(adminTokenPackageListQuerySchema, 'query'),
  adminTokenPackageController.getAdminTokenPackages,
);

/**
 * @openapi
 * /admin/token-packages/{id}:
 *   get:
 *     tags: [Admin]
 *     summary: Get token package by ID (admin)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: Token package details
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: Token package not found
 */
router.get(
  '/:id',
  validate(adminTokenPackageIdParamsSchema, 'params'),
  adminTokenPackageController.getAdminTokenPackageById,
);

export default router;
