import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import * as adminPaymentController from '../controllers/admin-payment.controller.js';
import { adminPaymentListQuerySchema, adminPaymentIdParamsSchema, adminPaymentRefundResolveBodySchema, adminPaymentRefundResolveParamsSchema } from '../schemas/admin-payment.schema.js';

const router = Router();

/**
 * @openapi
 * /admin/payments:
 *   get:
 *     tags: [Admin]
 *     summary: List all payments
 *     description: Retrieves a paginated list of payments with optional filters
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, COMPLETED, FAILED, CANCELLED, REFUNDED]
 *       - in: query
 *         name: currency
 *         schema:
 *           type: string
 *       - in: query
 *         name: tokenPackageId
 *         schema:
 *           type: integer
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: dateFrom
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: dateTo
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [createdAt, updatedAt, amount, paidAt]
 *           default: createdAt
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *     responses:
 *       200:
 *         description: Paginated list of payments
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.get('/', validate(adminPaymentListQuerySchema, 'query'), adminPaymentController.list);

/**
 * @openapi
 * /admin/payments/{id}:
 *   get:
 *     tags: [Admin]
 *     summary: Get payment by ID
 *     description: Retrieves a single payment by its UUID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Payment details
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Payment not found
 */
router.get('/:id', validate(adminPaymentIdParamsSchema, 'params'), adminPaymentController.getById);

/** Full package refund only; all monetary/provider identifiers are derived server-side. */
router.post('/:id/refund', validate(adminPaymentIdParamsSchema, 'params'), adminPaymentController.refund);
router.post('/refunds/:refundId/resolve', validate(adminPaymentRefundResolveParamsSchema, 'params'), validate(adminPaymentRefundResolveBodySchema), adminPaymentController.resolveRefundReview);

export default router;
