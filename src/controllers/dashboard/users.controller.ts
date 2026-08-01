import { Request, Response, NextFunction } from 'express';
import { ParsedQs } from 'qs';
import { AppError } from '../../middleware/errorHandler.js';
import * as usersService from '../../services/dashboard/users.service.js';

function sendSuccess<T>(res: Response, data: T, message = '', status = 200): void {
  res.status(status).json({
    success: true,
    message,
    data,
  });
}

function requireActorId(req: Request): string {
  if (!req.user) {
    throw new AppError(401, 'Authentication required');
  }

  return req.user.userId;
}

type QueryParameter = string | ParsedQs | Array<string | ParsedQs> | undefined;

function parsePositiveInteger(value: QueryParameter): number | undefined {
  let normalized: string;
  if (typeof value === 'string') {
    normalized = value.trim();
  } else if (typeof value === 'number') {
    normalized = String(value);
  } else {
    return undefined;
  }

  if (!/^[1-9]\d*$/.test(normalized)) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function getSingleParam(value: string | string[] | undefined, name: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  throw new AppError(400, `Invalid ${name} route parameter`);
}

export async function listUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireActorId(req);
    const result = await usersService.listUsers({
      page: parsePositiveInteger(req.query.page) ?? 1,
      limit: parsePositiveInteger(req.query.limit) ?? 20,
      search: req.query.search as string | undefined,
      sort: req.query.sort as usersService.DashboardSortField,
      order: req.query.order as usersService.DashboardOrder,
      role: req.query.role as string | undefined,
      gender: req.query.gender as 'MALE' | 'FEMALE' | undefined,
      nationality: req.query.nationality as string | undefined,
      language: req.query.language as string | undefined,
      active: req.query.active as boolean | undefined,
      verified: req.query.verified as boolean | undefined,
      banned: req.query.banned as boolean | undefined,
      deleted: req.query.deleted as boolean | undefined,
      walletStatus: req.query.walletStatus as 'ACTIVE' | 'INACTIVE' | 'BLOCKED' | undefined,
      createdFrom: req.query.createdFrom as Date | undefined,
      createdTo: req.query.createdTo as Date | undefined,
      lastLoginFrom: req.query.lastLoginFrom as Date | undefined,
      lastLoginTo: req.query.lastLoginTo as Date | undefined,
      minXP: req.query.minXP as number | undefined,
      maxXP: req.query.maxXP as number | undefined,
      minLevel: req.query.minLevel as number | undefined,
      maxLevel: req.query.maxLevel as number | undefined,
      hasWallet: req.query.hasWallet as boolean | undefined,
      hasPayments: req.query.hasPayments as boolean | undefined,
      hasTrips: req.query.hasTrips as boolean | undefined,
      hasBadges: req.query.hasBadges as boolean | undefined,
      hasJourney: req.query.hasJourney as boolean | undefined,
    });

    sendSuccess(res, result, '');
  } catch (err) {
    next(err);
  }
}

export async function getUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireActorId(req);
    const data = await usersService.getUserProfile(getSingleParam(req.params.id, 'id'));
    sendSuccess(res, data, '');
  } catch (err) {
    next(err);
  }
}

export async function getUserStatistics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireActorId(req);
    const data = await usersService.getUserStatistics(getSingleParam(req.params.id, 'id'));
    sendSuccess(res, data, '');
  } catch (err) {
    next(err);
  }
}

export async function getGlobalStatistics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireActorId(req);
    const data = await usersService.getDashboardStatistics({
      search: req.query.search as string | undefined,
      role: req.query.role as string | undefined,
      gender: req.query.gender as 'MALE' | 'FEMALE' | undefined,
      nationality: req.query.nationality as string | undefined,
      language: req.query.language as string | undefined,
      active: req.query.active as boolean | undefined,
      verified: req.query.verified as boolean | undefined,
      banned: req.query.banned as boolean | undefined,
      deleted: req.query.deleted as boolean | undefined,
      walletStatus: req.query.walletStatus as 'ACTIVE' | 'INACTIVE' | 'BLOCKED' | undefined,
      createdFrom: req.query.createdFrom as Date | undefined,
      createdTo: req.query.createdTo as Date | undefined,
      lastLoginFrom: req.query.lastLoginFrom as Date | undefined,
      lastLoginTo: req.query.lastLoginTo as Date | undefined,
      minXP: req.query.minXP as number | undefined,
      maxXP: req.query.maxXP as number | undefined,
      minLevel: req.query.minLevel as number | undefined,
      maxLevel: req.query.maxLevel as number | undefined,
      hasWallet: req.query.hasWallet as boolean | undefined,
      hasPayments: req.query.hasPayments as boolean | undefined,
      hasTrips: req.query.hasTrips as boolean | undefined,
      hasBadges: req.query.hasBadges as boolean | undefined,
      hasJourney: req.query.hasJourney as boolean | undefined,
    });

    sendSuccess(res, data, '');
  } catch (err) {
    next(err);
  }
}

export async function getRecentActivity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireActorId(req);
    const data = await usersService.getRecentActivity();
    sendSuccess(res, data, '');
  } catch (err) {
    next(err);
  }
}

export async function getGrowthAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireActorId(req);
    const data = await usersService.getGrowthAnalytics();
    sendSuccess(res, data, '');
  } catch (err) {
    next(err);
  }
}

export async function getRevenueAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireActorId(req);
    const data = await usersService.getRevenueAnalytics();
    sendSuccess(res, data, '');
  } catch (err) {
    next(err);
  }
}

export async function getCountryAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireActorId(req);
    const data = await usersService.getCountryAnalytics();
    sendSuccess(res, data, '');
  } catch (err) {
    next(err);
  }
}

export async function getLanguageAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireActorId(req);
    const data = await usersService.getLanguageAnalytics();
    sendSuccess(res, data, '');
  } catch (err) {
    next(err);
  }
}

export async function getRetentionAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireActorId(req);
    const data = await usersService.getRetentionAnalytics();
    sendSuccess(res, data, '');
  } catch (err) {
    next(err);
  }
}

export async function getTopUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireActorId(req);
    const data = await usersService.getTopUsers();
    sendSuccess(res, data, '');
  } catch (err) {
    next(err);
  }
}

export async function deleteUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.deleteUser(getSingleParam(req.params.id, 'id'), actorId);
    sendSuccess(res, data, 'User soft deleted');
  } catch (err) {
    next(err);
  }
}

export async function restoreUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.restoreUser(getSingleParam(req.params.id, 'id'), actorId);
    sendSuccess(res, data, 'User restored');
  } catch (err) {
    next(err);
  }
}

export async function banUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.banUser(getSingleParam(req.params.id, 'id'), actorId);
    sendSuccess(res, data, 'User ban status updated');
  } catch (err) {
    next(err);
  }
}

export async function unbanUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.unbanUser(getSingleParam(req.params.id, 'id'), actorId);
    sendSuccess(res, data, 'User unbanned');
  } catch (err) {
    next(err);
  }
}

export async function activateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.activateUser(getSingleParam(req.params.id, 'id'), actorId);
    sendSuccess(res, data, 'User activated');
  } catch (err) {
    next(err);
  }
}

export async function deactivateUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.deactivateUser(getSingleParam(req.params.id, 'id'), actorId);
    sendSuccess(res, data, 'User deactivated');
  } catch (err) {
    next(err);
  }
}

export async function verifyEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.verifyEmail(getSingleParam(req.params.id, 'id'), actorId);
    sendSuccess(res, data, 'Email verified');
  } catch (err) {
    next(err);
  }
}

export async function changeRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.changeRole(getSingleParam(req.params.id, 'id'), req.body.role_id, actorId);
    sendSuccess(res, data, 'Role updated');
  } catch (err) {
    next(err);
  }
}

export async function resetWallet(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.resetWallet(getSingleParam(req.params.id, 'id'), actorId);
    sendSuccess(res, data, 'Wallet reset');
  } catch (err) {
    next(err);
  }
}

export async function resetXp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.resetXp(getSingleParam(req.params.id, 'id'), actorId);
    sendSuccess(res, data, 'XP reset');
  } catch (err) {
    next(err);
  }
}

export async function bulkDelete(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.bulkAction('delete', req.body.ids, actorId);
    sendSuccess(res, data, 'Bulk delete completed');
  } catch (err) {
    next(err);
  }
}

export async function bulkRestore(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.bulkAction('restore', req.body.ids, actorId);
    sendSuccess(res, data, 'Bulk restore completed');
  } catch (err) {
    next(err);
  }
}

export async function bulkBan(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.bulkAction('ban', req.body.ids, actorId);
    sendSuccess(res, data, 'Bulk ban completed');
  } catch (err) {
    next(err);
  }
}

export async function bulkUnban(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.bulkAction('unban', req.body.ids, actorId);
    sendSuccess(res, data, 'Bulk unban completed');
  } catch (err) {
    next(err);
  }
}

export async function bulkActivate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.bulkAction('activate', req.body.ids, actorId);
    sendSuccess(res, data, 'Bulk activate completed');
  } catch (err) {
    next(err);
  }
}

export async function bulkDeactivate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.bulkAction('deactivate', req.body.ids, actorId);
    sendSuccess(res, data, 'Bulk deactivate completed');
  } catch (err) {
    next(err);
  }
}

export async function bulkVerify(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.bulkAction('verify', req.body.ids, actorId);
    sendSuccess(res, data, 'Bulk verify completed');
  } catch (err) {
    next(err);
  }
}

export async function bulkChangeRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const data = await usersService.bulkChangeRole(req.body.ids, req.body.role_id, actorId);
    sendSuccess(res, data, 'Bulk role update completed');
  } catch (err) {
    next(err);
  }
}

export async function bulkExport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const exportResult = await usersService.bulkExport(req.body.ids, actorId, req.body.format);
    res.setHeader('Content-Type', exportResult.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${exportResult.filename}"`);
    res.status(200).send(exportResult.data);
  } catch (err) {
    next(err);
  }
}

export async function searchUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireActorId(req);
    const data = await usersService.searchUsers(req.query.search as string);
    sendSuccess(res, data, '');
  } catch (err) {
    next(err);
  }
}

export async function exportUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actorId = requireActorId(req);
    const exportResult = await usersService.exportUsers(actorId, {
      page: 1,
      limit: 1000,
      search: req.query.search as string | undefined,
      sort: req.query.sort as usersService.DashboardSortField,
      order: req.query.order as usersService.DashboardOrder,
      role: req.query.role as string | undefined,
      gender: req.query.gender as 'MALE' | 'FEMALE' | undefined,
      nationality: req.query.nationality as string | undefined,
      language: req.query.language as string | undefined,
      active: req.query.active as boolean | undefined,
      verified: req.query.verified as boolean | undefined,
      banned: req.query.banned as boolean | undefined,
      deleted: req.query.deleted as boolean | undefined,
      walletStatus: req.query.walletStatus as 'ACTIVE' | 'INACTIVE' | 'BLOCKED' | undefined,
      createdFrom: req.query.createdFrom as Date | undefined,
      createdTo: req.query.createdTo as Date | undefined,
      lastLoginFrom: req.query.lastLoginFrom as Date | undefined,
      lastLoginTo: req.query.lastLoginTo as Date | undefined,
      minXP: req.query.minXP as number | undefined,
      maxXP: req.query.maxXP as number | undefined,
      minLevel: req.query.minLevel as number | undefined,
      maxLevel: req.query.maxLevel as number | undefined,
      hasWallet: req.query.hasWallet as boolean | undefined,
      hasPayments: req.query.hasPayments as boolean | undefined,
      hasTrips: req.query.hasTrips as boolean | undefined,
      hasBadges: req.query.hasBadges as boolean | undefined,
      hasJourney: req.query.hasJourney as boolean | undefined,
      format: req.query.format as usersService.DashboardExportFormat,
    });

    res.setHeader('Content-Type', exportResult.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${exportResult.filename}"`);
    res.status(200).send(exportResult.data);
  } catch (err) {
    next(err);
  }
}

export async function adminTimeline(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireActorId(req);
    const data = await usersService.getAdminTimeline();
    sendSuccess(res, data, '');
  } catch (err) {
    next(err);
  }
}
