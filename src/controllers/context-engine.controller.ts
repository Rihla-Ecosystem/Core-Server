// ---------------------------------------------------------------------------
// Context Engine / User-facing controller
// ---------------------------------------------------------------------------
import { Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler.js';
import * as engine from '../services/context-engine.service.js';
import { subscribeToNotifications } from '../services/notification-realtime.service.js';

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, 'Authentication required');
  return req.user.userId;
}

function paramId(req: Request): string {
  return String(req.params.id ?? '');
}

export async function reportLocation(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await engine.processLocationUpdate(actorId(req), req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function getInbox(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    const isRead = req.query.isRead === 'true' ? true : req.query.isRead === 'false' ? false : undefined;
    res.json({ success: true, data: await engine.listInboxNotifications(actorId(req), page, limit, isRead) });
  } catch (err) {
    next(err);
  }
}

export async function getUnreadCount(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: { unread: await engine.unreadCount(actorId(req)) } });
  } catch (err) {
    next(err);
  }
}

export async function markRead(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await engine.markRead(actorId(req), paramId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function markAllRead(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await engine.markAllRead(actorId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function deleteInbox(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await engine.deleteInboxNotification(actorId(req), paramId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function syncAfterReconnect(req: Request, res: Response, next: NextFunction) {
  try {
    const lastSync = req.body?.lastSync ? new Date(req.body.lastSync) : undefined;
    res.json({ success: true, data: await engine.syncUnreadAfterReconnect(actorId(req), lastSync) });
  } catch (err) {
    next(err);
  }
}

export async function stream(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = actorId(req);
    res.flushHeaders?.();
    subscribeToNotifications(res, userId);
  } catch (err) {
    next(err);
  }
}

export async function listReports(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    res.json({ success: true, data: await engine.getContextReports(actorId(req), page, limit) });
  } catch (err) {
    next(err);
  }
}

export async function getReport(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await engine.getContextReport(actorId(req), paramId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function getPreferences(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await engine.getUserNotificationPreferences(actorId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function updatePreferences(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await engine.updateUserNotificationPreferences(actorId(req), req.body ?? {}) });
  } catch (err) {
    next(err);
  }
}