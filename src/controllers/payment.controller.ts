import { Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler.js';
import * as paymentService from '../services/payment.service.js';
import * as paymobWebhookService from '../services/paymob-webhook.service.js';

export async function createIntention(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, 'Authentication required');
    }

    const userId = req.user.userId;
    const { tokenPackageId, billing_data } = req.body;

    const result = await paymentService.createPaymentIntention({
      userId,
      tokenPackageId,
      billingData: billing_data,
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function handlePaymobWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const hmac = req.query.hmac;

    await paymobWebhookService.processPaymobWebhook(req.body, hmac);

    res.status(200).json({
      success: true,
    });
  } catch (err) {
    next(err);
  }
}
