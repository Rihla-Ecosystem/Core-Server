import { Request, Response, NextFunction } from 'express';
import * as userService from '../services/user.service.js';
import * as paymentAdminService from '../services/payment-admin.service.js';
import * as aiUsageService from '../services/ai-usage.service.js';
import { getSystemHealth } from '../services/system.service.js';

export async function getAllUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const users = await userService.getAllUsers();
    res.json(users);
  } catch (err) {
    next(err);
  }
}

export async function updateUserRole(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as string;
    const { role_id } = req.body;
    const user = await userService.updateUserRole(id, role_id, req.user!.userId);
    res.json(user);
  } catch (err) {
    next(err);
  }
}

export async function banUser(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as string;
    const user = await userService.banUser(id, req.user!.userId);
    res.json(user);
  } catch (err) {
    next(err);
  }
}

export async function unbanUser(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id as string;
    const user = await userService.unbanUser(id, req.user!.userId);
    res.json(user);
  } catch (err) {
    next(err);
  }
}

export async function getStats(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await userService.getAdminStats());
  } catch (err) {
    next(err);
  }
}

export async function getMonthlyStats(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await userService.getMonthlyStats() });
  } catch (err) {
    next(err);
  }
}

export async function getAuditLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const logs = await userService.getAuditLogs();
    res.json(logs);
  } catch (err) {
    next(err);
  }
}

export async function getPayments(req: Request, res: Response, next: NextFunction) {
  try {
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    res.json(await paymentAdminService.getPaymentsList({ page, limit, status, search }));
  } catch (err) {
    next(err);
  }
}

export async function getPaymentsSummary(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await paymentAdminService.getPaymentsSummary());
  } catch (err) {
    next(err);
  }
}

export async function getAiUsage(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await aiUsageService.getAiUsageSummary());
  } catch (err) {
    next(err);
  }
}

export async function getSystemHealthController(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await getSystemHealth());
  } catch (err) {
    next(err);
  }
}
