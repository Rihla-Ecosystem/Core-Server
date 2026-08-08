import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import * as adminRateCardController from '../controllers/admin-rate-card.controller.js';
import {
  adminRateCardDraftBodySchema,
  adminRateCardImportBodySchema,
  adminRateCardPublishBodySchema,
  adminRateCardRetireBodySchema,
  adminRateCardCloneBodySchema,
  adminRateCardVersionParamsSchema,
  adminRateCardListQuerySchema,
  adminRateCardEntryBodySchema,
  adminRateCardEntryPatchSchema,
  adminRateCardEntryParamsSchema,
} from '../schemas/admin-rate-card.schema.js';

const router = Router();

/**
 * @openapi
 * /admin/rate-cards:
 *   get:
 *     tags: [Admin]
 *     summary: List provider rate-card snapshots (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [DRAFT, ACTIVE, RETIRED] }
 *     responses:
 *       200:
 *         description: Paginated snapshot list
 *       403:
 *         description: Insufficient permissions
 */
router.get('/', validate(adminRateCardListQuerySchema, 'query'), adminRateCardController.list);

/**
 * @openapi
 * /admin/rate-cards/{version}:
 *   get:
 *     tags: [Admin]
 *     summary: Get one provider rate-card snapshot by immutable version (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: version
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Snapshot detail with engine-domain entries
 *       404:
 *         description: Snapshot not found
 */
router.get('/:version', validate(adminRateCardVersionParamsSchema, 'params'), adminRateCardController.getByVersion);

/**
 * @openapi
 * /admin/rate-cards/drafts:
 *   post:
 *     tags: [Admin]
 *     summary: Create an empty DRAFT rate-card snapshot (admin only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [version, source, generatedAt]
 *             properties:
 *               version: { type: string }
 *               source: { type: string }
 *               generatedAt: { type: string, format: date }
 *               effectiveFrom: { type: string, format: date }
 *               effectiveTo: { type: string, format: date }
 *     responses:
 *       201:
 *         description: Draft created
 *       409:
 *         description: Version already exists
 */
router.post('/drafts', validate(adminRateCardDraftBodySchema), adminRateCardController.createDraft);

/**
 * @openapi
 * /admin/rate-cards/drafts/{version}/import:
 *   post:
 *     tags: [Admin]
 *     summary: Import engine-domain entries into a DRAFT snapshot (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: version
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [source, generatedAt, entries]
 *             properties:
 *               source: { type: string }
 *               generatedAt: { type: string, format: date }
 *               entries: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: Entries imported
 *       404:
 *         description: Draft not found
 *       409:
 *         description: Snapshot is not a DRAFT (immutable)
 */
router.post(
  '/drafts/:version/import',
  validate(adminRateCardVersionParamsSchema, 'params'),
  validate(adminRateCardImportBodySchema),
  adminRateCardController.importEntries,
);

/**
 * @openapi
 * /admin/rate-cards/drafts/{version}/entries:
 *   post:
 *     tags: [Admin]
 *     summary: Create a single entry in a DRAFT snapshot (admin only)
 *     description: |
 *       Validates the entry through the pure engine validator (strict Zod at
 *       the boundary, unknown fields rejected; money as non-negative integer
 *       strings converted to exact bigint), then creates one entry row in the
 *       DRAFT snapshot. A duplicate (provider, model, tier) identity returns
 *       400 RATE_CARD_ADMIN_DUPLICATE_IDENTITY. ACTIVE and RETIRED snapshots
 *       are immutable (409).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: version
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [provider, model, status, billingUnit, effectiveFrom, inactive]
 *             additionalProperties: false
 *     responses:
 *       201:
 *         description: Entry created; returns the snapshot metadata with entryCount
 *       400:
 *         description: Validation error or duplicate identity
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: Draft not found
 *       409:
 *         description: Snapshot is not a DRAFT (immutable)
 */
router.post(
  '/drafts/:version/entries',
  validate(adminRateCardVersionParamsSchema, 'params'),
  validate(adminRateCardEntryBodySchema),
  adminRateCardController.createEntry,
);

/**
 * @openapi
 * /admin/rate-cards/drafts/{version}/entries/{entryId}:
 *   patch:
 *     tags: [Admin]
 *     summary: Update a single entry in a DRAFT snapshot (admin only)
 *     description: |
 *       Partial update (PATCH): only provided fields change. Scalar fields
 *       replace; sub-objects (tokenRates, modalityRates, tts) replace wholesale
 *       when provided; explicit null clears optional values. The merged entry
 *       is re-validated through the pure engine validator. Changing the entry
 *       to collide with another (provider, model, tier) identity in the same
 *       DRAFT returns 400 RATE_CARD_ADMIN_DUPLICATE_IDENTITY.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: version
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: entryId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *     responses:
 *       200:
 *         description: Entry updated; returns the snapshot metadata
 *       400:
 *         description: Validation error or duplicate identity
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: Draft or entry not found
 *       409:
 *         description: Snapshot is not a DRAFT (immutable)
 *   delete:
 *     tags: [Admin]
 *     summary: Delete a single entry from a DRAFT snapshot (admin only)
 *     description: |
 *       Removes one entry row from the DRAFT snapshot. ACTIVE and RETIRED
 *       snapshots are immutable (409). The entry must belong to the DRAFT
 *       snapshot (404 otherwise).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: version
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: entryId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Entry deleted; returns the snapshot metadata
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: Draft or entry not found
 *       409:
 *         description: Snapshot is not a DRAFT (immutable)
 */
router.patch(
  '/drafts/:version/entries/:entryId',
  validate(adminRateCardEntryParamsSchema, 'params'),
  validate(adminRateCardEntryPatchSchema),
  adminRateCardController.updateEntry,
);

router.delete(
  '/drafts/:version/entries/:entryId',
  validate(adminRateCardEntryParamsSchema, 'params'),
  adminRateCardController.deleteEntry,
);

/**
 * @openapi
 * /admin/rate-cards/drafts/{version}/validate:
 *   post:
 *     tags: [Admin]
 *     summary: Validate a DRAFT snapshot against the pure engine mapper (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: version
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Draft is publishable
 *       400:
 *         description: Draft is not publishable
 */
router.post(
  '/drafts/:version/validate',
  validate(adminRateCardVersionParamsSchema, 'params'),
  adminRateCardController.validateDraft,
);

/**
 * @openapi
 * /admin/rate-cards/{version}/publish:
 *   post:
 *     tags: [Admin]
 *     summary: Publish a DRAFT snapshot (transactional, overlap-checked; admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: version
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               effectiveFrom: { type: string, format: date }
 *               effectiveTo: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Snapshot published (ACTIVE)
 *       409:
 *         description: Not a DRAFT or overlaps an ACTIVE snapshot
 */
router.post(
  '/:version/publish',
  validate(adminRateCardVersionParamsSchema, 'params'),
  validate(adminRateCardPublishBodySchema),
  adminRateCardController.publish,
);

/**
 * @openapi
 * /admin/rate-cards/{version}/retire:
 *   post:
 *     tags: [Admin]
 *     summary: Retire an ACTIVE snapshot (transactional; admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: version
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               retiredAt: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Snapshot retired (RETIRED)
 *       409:
 *         description: Not ACTIVE
 */
router.post(
  '/:version/retire',
  validate(adminRateCardVersionParamsSchema, 'params'),
  validate(adminRateCardRetireBodySchema),
  adminRateCardController.retire,
);

/**
 * @openapi
 * /admin/rate-cards/{version}/clone:
 *   post:
 *     tags: [Admin]
 *     summary: Clone a snapshot's pricing into a new DRAFT (atomic; admin only)
 *     description: |
 *       Copies ALL pricing entries of the source snapshot into a brand-new
 *       DRAFT under `newVersion`. Snapshot creation + entry copying happen in
 *       ONE database transaction, so a failed copy rolls back completely. The
 *       source is never modified, never retired, and its ACTIVE/RETIRED
 *       lifecycle state is never copied. `newVersion` must differ from
 *       `:version`.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: version
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [newVersion]
 *             properties:
 *               newVersion: { type: string }
 *     responses:
 *       201:
 *         description: Clone created as a DRAFT
 *       400:
 *         description: newVersion equals the source version
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Insufficient permissions
 *       404:
 *         description: Source snapshot not found
 *       409:
 *         description: newVersion already exists
 */
router.post(
  '/:version/clone',
  validate(adminRateCardVersionParamsSchema, 'params'),
  validate(adminRateCardCloneBodySchema),
  adminRateCardController.clone,
);

export default router;
