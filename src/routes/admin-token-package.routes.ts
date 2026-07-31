import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { adminTokenPackageListQuerySchema, adminTokenPackageIdParamsSchema, adminTokenPackageCreateBodySchema, adminTokenPackageUpdateBodySchema, adminTokenPackageStatusBodySchema } from '../schemas/admin-token-package.schema.js';
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
 * /admin/token-packages:
 *   post:
 *     tags: [Admin]
 *     summary: Create token package
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - code
 *               - price
 *               - currency
 *               - tokens
 *               - sortOrder
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 2
 *                 maxLength: 100
 *               description:
 *                 type: string
 *                 maxLength: 500
 *                 nullable: true
 *               code:
 *                 type: string
 *                 pattern: '^[A-Z0-9_]+$'
 *                 example: STARTER_100
 *               price:
 *                 oneOf:
 *                   - type: number
 *                   - type: string
 *                 example: '49.99'
 *               currency:
 *                 type: string
 *                 enum: [EGP]
 *               tokens:
 *                 type: integer
 *                 minimum: 1
 *               sortOrder:
 *                 type: integer
 *                 minimum: 0
 *               isActive:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       201:
 *         description: Token package created successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 *       409:
 *         description: Token package code already exists
 */
router.post(
  '/',
  validate(adminTokenPackageCreateBodySchema),
  adminTokenPackageController.createAdminTokenPackage,
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

/**
 * @openapi
 * /admin/token-packages/{id}:
 *   patch:
 *     tags: [Admin]
 *     summary: Update token package
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 2
 *                 maxLength: 100
 *               description:
 *                 type: string
 *                 maxLength: 500
 *                 nullable: true
 *                 description: Use null or a whitespace-only string to clear the description
 *               price:
 *                 oneOf:
 *                   - type: number
 *                   - type: string
 *                 example: '59.99'
 *               currency:
 *                 type: string
 *                 enum: [EGP]
 *               tokens:
 *                 type: integer
 *                 minimum: 1
 *               sortOrder:
 *                 type: integer
 *                 minimum: 0
 *           description: At least one allowed field is required
 *     responses:
 *       200:
 *         description: Token package updated successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: Token package not found
 */
router.patch(
  '/:id',
  validate(adminTokenPackageIdParamsSchema, 'params'),
  validate(adminTokenPackageUpdateBodySchema),
  adminTokenPackageController.updateAdminTokenPackage,
);

/**
 * @openapi
 * /admin/token-packages/{id}/status:
 *   patch:
 *     tags: [Admin]
 *     summary: Activate or deactivate token package
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *           minimum: 1
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - isActive
 *             additionalProperties: false
 *             properties:
 *               isActive:
 *                 type: boolean
 *                 description: true activates the package; false deactivates it
 *           example:
 *             isActive: false
 *     responses:
 *       200:
 *         description: Token package status updated successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: Token package not found
 */
router.patch(
  '/:id/status',
  validate(adminTokenPackageIdParamsSchema, 'params'),
  validate(adminTokenPackageStatusBodySchema),
  adminTokenPackageController.updateAdminTokenPackageStatus,
);

/**
 * @openapi
 * /admin/token-packages/{id}:
 *   delete:
 *     tags: [Admin]
 *     summary: Delete token package
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *           minimum: 1
 *     responses:
 *       200:
 *         description: Token package deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required:
 *                 - success
 *                 - data
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   required:
 *                     - id
 *                     - code
 *                     - deleted
 *                   properties:
 *                     id:
 *                       type: integer
 *                       example: 1
 *                     code:
 *                       type: string
 *                       example: STARTER
 *                     deleted:
 *                       type: boolean
 *                       enum: [true]
 *                       example: true
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: Token package not found
 *       409:
 *         description: Token package has related payments; deactivate it instead
 */
router.delete(
  '/:id',
  validate(adminTokenPackageIdParamsSchema, 'params'),
  adminTokenPackageController.deleteAdminTokenPackage,
);

export default router;
