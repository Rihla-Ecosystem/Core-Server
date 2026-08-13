import type { Request, Response, NextFunction } from 'express';
import * as adminPaymentService from '../services/admin-payment.service.js';
import type { AdminPaymentListQuery, AdminPaymentIdParams, AdminPaymentRefundResolveBody } from '../schemas/admin-payment.schema.js';
import { AppError } from '../middleware/errorHandler.js';
import { requestPaymentRefund } from '../services/payment-refund.service.js';

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as AdminPaymentListQuery;
    const result = await adminPaymentService.list(query);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getById(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const params = req.params as unknown as AdminPaymentIdParams;
    const result = await adminPaymentService.getById(params);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function refund(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, 'Authentication required');
    const params = req.params as unknown as AdminPaymentIdParams;
    const result = await requestPaymentRefund(params.id, req.user.userId);
    res.status(200).json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function resolveRefundReview(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError(401, 'Authentication required');
    const result = await adminPaymentService.resolveRefundReview(req.params.refundId, req.user.userId, (req.body as AdminPaymentRefundResolveBody).resolutionNote);
    res.status(200).json({ success: true, data: result });
  } catch (err) { next(err); }
}
