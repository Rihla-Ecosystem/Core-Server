import type { Request, Response, NextFunction } from 'express';
import * as adminTokenWalletService from '../services/admin-token-wallet.service.js';
import { AppError } from '../middleware/errorHandler.js';
import type {
  AdminTokenWalletListQuery,
  AdminTokenWalletTransactionsQuery,
  AdminTokenWalletBonusBody,
  AdminTokenWalletAdjustmentBody,
} from '../schemas/admin-token-wallet.schema.js';

function queryOf<T>(req: Request): T {
  return req.query as T;
}

function paramsOf<T>(req: Request): T {
  return req.params as T;
}

export async function list(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = queryOf<AdminTokenWalletListQuery>(req);
    const result = await adminTokenWalletService.list(query);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getByUserId(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = paramsOf<{ userId: string }>(req);
    const result = await adminTokenWalletService.getWalletDetails(userId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getTransactions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId } = paramsOf<{ userId: string }>(req);
    const query = queryOf<AdminTokenWalletTransactionsQuery>(req);
    const result = await adminTokenWalletService.getTransactions(userId, query);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function grantBonus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, 'Authentication required');
    }

    const { userId } = paramsOf<{ userId: string }>(req);
    const input = req.body as AdminTokenWalletBonusBody;
    const result = await adminTokenWalletService.grantBonus(req.user.userId, userId, input);

    res.status(result.idempotentReplay ? 200 : 201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function createAdjustment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, 'Authentication required');
    }

    const { userId } = paramsOf<{ userId: string }>(req);
    const input = req.body as AdminTokenWalletAdjustmentBody;
    const result = await adminTokenWalletService.adjust(req.user.userId, userId, input);

    res.status(result.idempotentReplay ? 200 : 201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
