import type { Request, Response, NextFunction } from 'express';
import { listAIBillingRecoveryQueue } from '../services/ai-billing-recovery.service.js';
import type { AdminBillingRecoveryQueueQuery } from '../schemas/admin-billing-recovery.schema.js';

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
