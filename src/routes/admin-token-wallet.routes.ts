import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import * as adminTokenWalletController from '../controllers/admin-token-wallet.controller.js';
import {
  adminTokenWalletListQuerySchema,
  adminTokenWalletUserIdParamsSchema,
  adminTokenWalletTransactionsQuerySchema,
  adminTokenWalletBonusBodySchema,
  adminTokenWalletAdjustmentBodySchema,
} from '../schemas/admin-token-wallet.schema.js';

const router = Router();

/**
 * @openapi
 * /admin/token-wallets:
 *   get:
 *     tags: [Admin]
 *     summary: List token wallets (admin)
 *     description: Lists TokenWallet records for non-deleted users with search, status filter, and stable pagination.
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
 *         schema: { type: string, maxLength: 100, description: Case-insensitive match against user email, displayName, or id }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [ACTIVE, INACTIVE, BLOCKED] }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [tokenBalance, createdAt, updatedAt], default: updatedAt }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [asc, desc], default: desc }
 *     responses:
 *       200:
 *         description: Paginated list of token wallets
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 */
router.get(
  '/',
  validate(adminTokenWalletListQuerySchema, 'query'),
  adminTokenWalletController.list,
);

/**
 * @openapi
 * /admin/token-wallets/{userId}:
 *   get:
 *     tags: [Admin]
 *     summary: Get wallet details and token summary for a user (admin)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Wallet details and token summary. Returns a safe virtual wallet state when no wallet exists.
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: User not found
 */
router.get(
  '/:userId',
  validate(adminTokenWalletUserIdParamsSchema, 'params'),
  adminTokenWalletController.getByUserId,
);

/**
 * @openapi
 * /admin/token-wallets/{userId}/transactions:
 *   get:
 *     tags: [Admin]
 *     summary: List a user's token transactions (admin)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [GRANT, CONSUME, REFUND, BONUS, ADJUSTMENT] }
 *       - in: query
 *         name: source
 *         schema: { type: string, enum: [CHAT, IMAGE, FILE_UPLOAD, OCR, VOICE, ITINERARY, PURCHASE, ADMIN] }
 *       - in: query
 *         name: dateFrom
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: dateTo
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [asc, desc], default: desc }
 *     responses:
 *       200:
 *         description: Paginated list of token transactions
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: User not found
 */
router.get(
  '/:userId/transactions',
  validate(adminTokenWalletUserIdParamsSchema, 'params'),
  validate(adminTokenWalletTransactionsQuerySchema, 'query'),
  adminTokenWalletController.getTransactions,
);

/**
 * @openapi
 * /admin/token-wallets/{userId}/bonus:
 *   post:
 *     tags: [Admin]
 *     summary: Grant bonus tokens to a user (admin)
 *     description: |
 *       Atomically credits bonus tokens to a user's wallet, records a TokenTransaction
 *       with type BONUS and source ADMIN, and creates a token_bonus_granted AuditLog.
 *       The operation is idempotent: reusing the same idempotencyKey returns the
 *       original result with idempotentReplay true and does not double-credit.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tokens, reason, idempotencyKey]
 *             additionalProperties: false
 *             properties:
 *               tokens:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 2147483647
 *                 description: Positive integer number of bonus tokens
 *               reason:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 500
 *               idempotencyKey:
 *                 type: string
 *                 format: uuid
 *                 description: Idempotency identity; the transaction reference becomes bonus:<idempotencyKey>
 *           example:
 *             tokens: 100
 *             reason: Welcome campaign
 *             idempotencyKey: 550e8400-e29b-41d4-a716-446655440000
 *     responses:
 *       201:
 *         description: Bonus granted (newly created)
 *       200:
 *         description: Idempotent replay of a previously granted bonus
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required or authenticated actor missing/deleted
 *       403:
 *         description: Insufficient permissions or target wallet is not ACTIVE
 *       404:
 *         description: Target user not found
 *       409:
 *         description: Token bonus idempotency conflict (same key with different parameters)
 */
router.post(
  '/:userId/bonus',
  validate(adminTokenWalletUserIdParamsSchema, 'params'),
  validate(adminTokenWalletBonusBodySchema),
  adminTokenWalletController.grantBonus,
);

/**
 * @openapi
 * /admin/token-wallets/{userId}/adjustments:
 *   post:
 *     tags: [Admin]
 *     summary: Create a manual token adjustment for a user (admin)
 *     description: |
 *       Atomically applies a CREDIT or DEBIT adjustment to a user's wallet and records a
 *       TokenTransaction with type ADJUSTMENT and source ADMIN. The operation is idempotent:
 *       reusing the same idempotencyKey and actor returns the original result with
 *       idempotentReplay true and does not re-apply the adjustment. A token_adjustment_created
 *       AuditLog is created atomically with the transaction.
 *
 *       CREDIT creates an ACTIVE wallet when missing and prevents exceeding MAX_TOKEN_BALANCE.
 *       DEBIT never creates a wallet; a missing wallet or insufficient balance returns
 *       409 "Insufficient token balance for adjustment", and an INACTIVE/BLOCKED wallet
 *       returns 403 "Token wallet is not active".
 *
 *       An optional paymentId must belong to the target user. An optional relatedTransactionId
 *       must reference a TokenTransaction belonging to the target user; if both are provided
 *       and the related transaction has a non-null paymentId that differs from the supplied
 *       paymentId, the request returns 409 "Adjustment reference conflict". Neither referenced
 *       record is ever modified.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [operation, tokens, reason, idempotencyKey]
 *             additionalProperties: false
 *             properties:
 *               operation:
 *                 type: string
 *                 enum: [CREDIT, DEBIT]
 *                 description: Whether tokens are added to or removed from the wallet
 *               tokens:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 2147483647
 *                 description: Positive integer number of tokens; stored positive for both operations
 *               reason:
 *                 type: string
 *                 minLength: 5
 *                 maxLength: 500
 *               idempotencyKey:
 *                 type: string
 *                 format: uuid
 *                 description: Idempotency identity; the transaction reference becomes adjustment:<idempotencyKey>
 *               paymentId:
 *                 type: string
 *                 format: uuid
 *                 description: Optional Payment id that must belong to the target user
 *               relatedTransactionId:
 *                 type: string
 *                 format: uuid
 *                 description: Optional TokenTransaction id that must belong to the target user
 *           example:
 *             operation: CREDIT
 *             tokens: 100
 *             reason: Manual credit adjustment
 *             idempotencyKey: 550e8400-e29b-41d4-a716-446655440000
 *     responses:
 *       201:
 *         description: Adjustment applied (newly created)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   required: [transactionId, walletId, userId, operation, tokensAdjusted, previousBalance, newBalance, reason, paymentId, relatedTransactionId, idempotentReplay, createdAt]
 *                   properties:
 *                     transactionId: { type: string, format: uuid }
 *                     walletId: { type: string, format: uuid }
 *                     userId: { type: string, format: uuid }
 *                     operation: { type: string, enum: [CREDIT, DEBIT] }
 *                     tokensAdjusted: { type: integer, minimum: 1 }
 *                     previousBalance: { type: integer }
 *                     newBalance: { type: integer }
 *                     reason: { type: string }
 *                     paymentId: { type: string, format: uuid, nullable: true }
 *                     relatedTransactionId: { type: string, format: uuid, nullable: true }
 *                     idempotentReplay: { type: boolean }
 *                     createdAt: { type: string, format: date-time }
 *       200:
 *         description: Idempotent replay of a previously applied adjustment with the same actor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   required: [transactionId, walletId, userId, operation, tokensAdjusted, previousBalance, newBalance, reason, paymentId, relatedTransactionId, idempotentReplay, createdAt]
 *                   properties:
 *                     transactionId: { type: string, format: uuid }
 *                     walletId: { type: string, format: uuid }
 *                     userId: { type: string, format: uuid }
 *                     operation: { type: string, enum: [CREDIT, DEBIT] }
 *                     tokensAdjusted: { type: integer, minimum: 1 }
 *                     previousBalance: { type: integer }
 *                     newBalance: { type: integer }
 *                     reason: { type: string }
 *                     paymentId: { type: string, format: uuid, nullable: true }
 *                     relatedTransactionId: { type: string, format: uuid, nullable: true }
 *                     idempotentReplay: { type: boolean }
 *                     createdAt: { type: string, format: date-time }
 *       400:
 *         description: Validation error
 *       401:
 *         description: Authentication required or authenticated actor missing/deleted
 *       403:
 *         description: Insufficient permissions or target wallet is not ACTIVE
 *       404:
 *         description: Target user, payment, or related transaction not found
 *       409:
 *         description: Token adjustment idempotency conflict, balance limit exceeded, insufficient balance for adjustment, or adjustment reference conflict
 */
router.post(
  '/:userId/adjustments',
  validate(adminTokenWalletUserIdParamsSchema, 'params'),
  validate(adminTokenWalletAdjustmentBodySchema),
  adminTokenWalletController.createAdjustment,
);

export default router;
