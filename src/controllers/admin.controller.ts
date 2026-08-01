import { Request, Response, NextFunction } from 'express';
import * as userService from '../services/user.service.js';

export async function getAllUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? ''), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? ''), 10) || 50));
    const users = await userService.getAllUsers(page, limit);
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

export async function getAuditLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? ''), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? ''), 10) || 50));
    const logs = await userService.getAuditLogs(page, limit);
    res.json(logs);
  } catch (err) {
    next(err);
  }
}
