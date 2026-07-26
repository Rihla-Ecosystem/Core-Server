import { Request, Response, NextFunction } from 'express';
import * as tokenPackageService from '../services/token-package.service.js';

/**
 * GET /api/token-packages
 * Public endpoint to list active token packages.
 */
export async function getTokenPackages(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const packages = await tokenPackageService.getActiveTokenPackages();

    res.status(200).json({
      success: true,
      data: packages,
    });
  } catch (err) {
    next(err);
  }
}
