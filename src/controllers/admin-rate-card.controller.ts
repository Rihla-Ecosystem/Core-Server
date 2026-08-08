/**
 * Phase 2F-C Admin controller for the rate-card workflow.
 *
 * Thin HTTP adapter over the Admin service: validates `req.user`, calls the
 * service through the injected default dependencies, and responds with
 * `{ success: true, data }`. Errors are forwarded to the global error handler,
 * which maps the stable `ProviderRateCardAdminError` contract to status codes.
 */

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma.js';
import { AppError } from '../middleware/errorHandler.js';
import { createPrismaProviderRateCardAdminRepository } from '../repositories/provider-rate-card-admin.repository.js';
import * as adminRateCardService from '../services/admin-rate-card.service.js';
import { createDefaultProviderRateCardAdminDependencies } from '../services/admin-rate-card.service.js';
import type {
  AdminRateCardDraftBody,
  AdminRateCardImportBody,
  AdminRateCardPublishBody,
  AdminRateCardRetireBody,
  AdminRateCardCloneBody,
  AdminRateCardVersionParams,
  AdminRateCardListQuery,
  AdminRateCardEntryBody,
  AdminRateCardEntryPatch,
  AdminRateCardEntryParams,
} from '../schemas/admin-rate-card.schema.js';

const deps = createDefaultProviderRateCardAdminDependencies(
  createPrismaProviderRateCardAdminRepository(prisma),
);

function actor(req: Request): string {
  if (!req.user) {
    throw new AppError(401, 'Authentication required');
  }
  return req.user.userId;
}

/** GET /api/admin/rate-cards */
export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as AdminRateCardListQuery;
    const result = await adminRateCardService.listRateCardSnapshots(deps, {
      page: query.page,
      limit: query.limit,
      status: query.status,
    });
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/rate-cards/:version */
export async function getByVersion(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { version } = req.params as AdminRateCardVersionParams;
    const result = await adminRateCardService.getRateCardByVersion(deps, version);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/rate-cards/drafts */
export async function createDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = req.body as AdminRateCardDraftBody;
    const result = await adminRateCardService.createDraftRateCard(deps, body, actor(req));
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/rate-cards/drafts/:version/import */
export async function importEntries(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { version } = req.params as AdminRateCardVersionParams;
    const body = req.body as AdminRateCardImportBody;
    const result = await adminRateCardService.importRateCardEntries(deps, { version, ...body }, actor(req));
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/rate-cards/drafts/:version/validate */
export async function validateDraft(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { version } = req.params as AdminRateCardVersionParams;
    const result = await adminRateCardService.validateRateCardDraft(deps, version);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/rate-cards/:version/publish */
export async function publish(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { version } = req.params as AdminRateCardVersionParams;
    const body = req.body as AdminRateCardPublishBody;
    const result = await adminRateCardService.publishRateCard(deps, { version, ...body }, actor(req));
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/rate-cards/:version/retire */
export async function retire(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { version } = req.params as AdminRateCardVersionParams;
    const body = req.body as AdminRateCardRetireBody;
    const result = await adminRateCardService.retireRateCard(deps, { version, ...body }, actor(req));
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/rate-cards/:version/clone */
export async function clone(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { version } = req.params as AdminRateCardVersionParams;
    const body = req.body as AdminRateCardCloneBody;
    const result = await adminRateCardService.cloneRateCard(
      deps,
      { sourceVersion: version, newVersion: body.newVersion },
      actor(req),
    );
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/rate-cards/drafts/:version/entries */
export async function createEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { version } = req.params as AdminRateCardVersionParams;
    const body = req.body as AdminRateCardEntryBody;
    const result = await adminRateCardService.createDraftEntry(
      deps,
      { version, entry: body },
      actor(req),
    );
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/admin/rate-cards/drafts/:version/entries/:entryId */
export async function updateEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { version, entryId } = req.params as AdminRateCardEntryParams;
    const body = req.body as AdminRateCardEntryPatch;
    const result = await adminRateCardService.updateDraftEntry(
      deps,
      { version, entryId, patch: body },
      actor(req),
    );
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/admin/rate-cards/drafts/:version/entries/:entryId */
export async function deleteEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { version, entryId } = req.params as AdminRateCardEntryParams;
    const result = await adminRateCardService.deleteDraftEntry(
      deps,
      { version, entryId },
      actor(req),
    );
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

