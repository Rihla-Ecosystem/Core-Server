import { Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler.js';
import * as tokenService from '../services/token.service.js';

/**
 * GET /api/tokens/wallet
 * Authenticated endpoint to retrieve the current user's token wallet balance and status.
 */
export async function getWalletBalance(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, 'Authentication required');
    }

    const userId = req.user.userId;

    const result = await tokenService.getTokenWalletBalance(userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/tokens/transactions
 * Authenticated endpoint to retrieve paginated token transactions for the authenticated user.
 */
export async function getTokenTransactions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, 'Authentication required');
    }

    const userId = req.user.userId;

    let page = 1;
    if (req.query.page !== undefined) {
      const pageStr = String(req.query.page).trim();
      const pageNum = Number(pageStr);
      if (!/^\d+$/.test(pageStr) || pageNum <= 0) {
        throw new AppError(400, 'Invalid page parameter');
      }
      page = pageNum;
    }

    let limit = 20;
    if (req.query.limit !== undefined) {
      const limitStr = String(req.query.limit).trim();
      const limitNum = Number(limitStr);
      if (!/^\d+$/.test(limitStr) || limitNum <= 0 || limitNum > 100) {
        throw new AppError(400, 'Invalid limit parameter');
      }
      limit = limitNum;
    }

    const result = await tokenService.getTokenTransactions(userId, page, limit);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
