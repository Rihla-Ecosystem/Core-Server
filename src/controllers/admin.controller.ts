import { Request, Response, NextFunction } from 'express';
import * as userService from '../services/user.service.js';

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

export async function getAuditLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const logs = await userService.getAuditLogs();
    res.json(logs);
  } catch (err) {
    next(err);
  }
}
