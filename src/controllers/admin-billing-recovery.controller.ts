import type { Request, Response, NextFunction } from 'express';
import {
  inspectAIBillingRecovery,
  listAIBillingRecoveryQueue,
  reconcileWalletReservations,
  recoverAIBillingReservation,
} from '../services/ai-billing-recovery.service.js';
import type {
  AdminBillingRecoveryActionBody,
  AdminBillingRecoveryQueueQuery,
} from '../schemas/admin-billing-recovery.schema.js';

export async function getRecoveryQueue(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as unknown as AdminBillingRecoveryQueueQuery;
    const result = await listAIBillingRecoveryQueue({
      page: query.page,
      limit: query.limit,
      status: query.status,
      feature: query.feature,
    });
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function inspectRecoveryReservation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const reservationId = Array.isArray(req.params.reservationId) ? req.params.reservationId[0] : req.params.reservationId;
    const result = await inspectAIBillingRecovery({ reservationId });
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function recoverReservation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const reservationId = Array.isArray(req.params.reservationId) ? req.params.reservationId[0] : req.params.reservationId;
    const result = await recoverAIBillingReservation({
      reservationId,
      action: req.body as AdminBillingRecoveryActionBody,
    });
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function reconcileWallet(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const walletId = Array.isArray(req.params.walletId) ? req.params.walletId[0] : req.params.walletId;
    const result = await reconcileWalletReservations({ walletId });
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
