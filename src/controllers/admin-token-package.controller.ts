import { Request, Response, NextFunction } from 'express';
import * as adminTokenPackageService from '../services/admin-token-package.service.js';
import type { AdminTokenPackageListQuery, AdminTokenPackageIdParams } from '../schemas/admin-token-package.schema.js';

export async function getAdminTokenPackages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as unknown as AdminTokenPackageListQuery;
    const result = await adminTokenPackageService.getAdminTokenPackages(query);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function getAdminTokenPackageById(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params as unknown as AdminTokenPackageIdParams;
    const result = await adminTokenPackageService.getAdminTokenPackageById(id);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
