// ---------------------------------------------------------------------------
// Notification Administration controller (Dashboard)
// ---------------------------------------------------------------------------
import { Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler.js';
import * as service from '../services/notification-admin.service.js';

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, 'Authentication required');
  return req.user.userId;
}

function qp(value: unknown, def: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function opt(value: unknown): string | undefined {
  return value === undefined || value === '' ? undefined : String(value);
}

function boolParam(value: unknown): boolean | undefined {
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

function paramId(req: Request): string {
  return String(req.params.id ?? '');
}

function paramUserId(req: Request): string {
  return String(req.params.userId ?? '');
}

export async function listNotifications(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: await service.listAdminNotifications({
        page: qp(req.query.page, 1),
        limit: qp(req.query.limit, 20),
        search: opt(req.query.search),
        type: opt(req.query.type),
        category: opt(req.query.category),
        priority: opt(req.query.priority),
        source: opt(req.query.source),
        isRead: boolParam(req.query.isRead),
        userId: opt(req.query.userId),
      }),
    });
  } catch (err) {
    next(err);
  }
}

export async function createNotification(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json({ success: true, data: await service.createAndSendNotification(req.body, actorId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function listTemplates(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: await service.listTemplates({
        page: qp(req.query.page, 1),
        limit: qp(req.query.limit, 20),
        search: opt(req.query.search),
        isActive: boolParam(req.query.isActive),
      }),
    });
  } catch (err) {
    next(err);
  }
}

export async function createTemplate(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json({ success: true, data: await service.createTemplate(req.body, actorId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function updateTemplate(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await service.updateTemplate(paramId(req), req.body) });
  } catch (err) {
    next(err);
  }
}

export async function deleteTemplate(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await service.deleteTemplate(paramId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function listHistory(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: await service.listHistory({
        page: qp(req.query.page, 1),
        limit: qp(req.query.limit, 20),
        search: opt(req.query.search),
        status: opt(req.query.status),
        category: opt(req.query.category),
      }),
    });
  } catch (err) {
    next(err);
  }
}

export async function cancelScheduled(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await service.cancelScheduled(paramId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function getAnalytics(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await service.getAnalytics() });
  } catch (err) {
    next(err);
  }
}

export async function getReadUnreadStats(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await service.getReadUnreadStats() });
  } catch (err) {
    next(err);
  }
}

export async function getDeliveryLogs(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: await service.getDeliveryLogs({
        page: qp(req.query.page, 1),
        limit: qp(req.query.limit, 20),
        event: opt(req.query.event),
        userId: opt(req.query.userId),
      }),
    });
  } catch (err) {
    next(err);
  }
}

export async function listUserInbox(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: await service.listUserInbox(paramUserId(req), {
        page: qp(req.query.page, 1),
        limit: qp(req.query.limit, 20),
        isRead: boolParam(req.query.isRead),
      }),
    });
  } catch (err) {
    next(err);
  }
}

export async function listContextReports(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: await service.listContextReportsAdmin({ page: qp(req.query.page, 1), limit: qp(req.query.limit, 20), search: opt(req.query.search) }),
    });
  } catch (err) {
    next(err);
  }
}

export async function getContextReport(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await service.getContextReportAdmin(paramId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function getSettings(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await service.getNotificationSettings() });
  } catch (err) {
    next(err);
  }
}

export async function updateSettings(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await service.updateNotificationSettings(req.body) });
  } catch (err) {
    next(err);
  }
}

export async function getCategories(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: {
        types: ['INFO', 'SUCCESS', 'WARNING', 'ERROR', 'SYSTEM'],
        categories: [
          'SAFETY', 'SECURITY', 'WEATHER', 'TRAFFIC', 'TOURIST', 'HISTORICAL',
          'EMERGENCY', 'RESTRICTED_AREA', 'PHOTOGRAPHY', 'RECOMMENDATION', 'SYSTEM',
        ],
        priorities: ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'],
        sources: ['SYSTEM', 'AI', 'ADMIN', 'CONTEXT', 'EMERGENCY'],
        statuses: ['SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'],
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function processScheduled(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await service.processScheduledNotifications() });
  } catch (err) {
    next(err);
  }
}