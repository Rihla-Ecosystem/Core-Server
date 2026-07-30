import { Request, Response, NextFunction } from 'express';
import * as adminTokenPackageService from '../services/admin-token-package.service.js';
import { AppError } from '../middleware/errorHandler.js';
import type { AdminTokenPackageListQuery, AdminTokenPackageIdParams, AdminTokenPackageCreateBody, AdminTokenPackageUpdateBody, AdminTokenPackageStatusBody } from '../schemas/admin-token-package.schema.js';

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

export async function createAdminTokenPackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, 'Authentication required');
    }

    const input = req.body as AdminTokenPackageCreateBody;
    const result = await adminTokenPackageService.createAdminTokenPackage(input, req.user.userId);

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateAdminTokenPackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, 'Authentication required');
    }

    const { id } = req.params as unknown as AdminTokenPackageIdParams;
    const input = req.body as AdminTokenPackageUpdateBody;
    const result = await adminTokenPackageService.updateAdminTokenPackage(id, input, req.user.userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function updateAdminTokenPackageStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, 'Authentication required');
    }

    const { id } = req.params as unknown as AdminTokenPackageIdParams;
    const input = req.body as AdminTokenPackageStatusBody;
    const result = await adminTokenPackageService.updateAdminTokenPackageStatus(id, input, req.user.userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteAdminTokenPackage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError(401, 'Authentication required');
    }

    const { id } = req.params as unknown as AdminTokenPackageIdParams;
    const result = await adminTokenPackageService.deleteAdminTokenPackage(id, req.user.userId);

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}
