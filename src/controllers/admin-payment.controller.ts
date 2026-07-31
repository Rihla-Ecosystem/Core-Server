import type { Request, Response, NextFunction } from 'express';
import * as adminPaymentService from '../services/admin-payment.service.js';
import type { AdminPaymentListQuery, AdminPaymentIdParams } from '../schemas/admin-payment.schema.js';

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
