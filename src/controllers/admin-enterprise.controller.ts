import { Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler.js';
import * as service from '../services/admin-enterprise.service.js';
import * as apiMonitor from '../services/api-monitor.service.js';
import { runAdminAssistant } from '../services/admin-assistant.service.js';

function sendSuccess<T>(res: Response, data: T, message = '', status = 200): void {
  res.status(status).json({ success: true, message, data });
}

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, 'Authentication required');
  return req.user.userId;
}

function stringParam(value: string | string[] | undefined): string {
  return String(value ?? '');
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export async function listRoles(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.listRoles(req.query as never));
  } catch (err) {
    next(err);
  }
}

export async function getRole(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.getRole(Number(stringParam(req.params.id))));
  } catch (err) {
    next(err);
  }
}

export async function createRole(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.createRole(req.body), 'Role created', 201);
  } catch (err) {
    next(err);
  }
}

export async function updateRole(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.updateRole(Number(stringParam(req.params.id)), req.body), 'Role updated');
  } catch (err) {
    next(err);
  }
}

export async function deleteRole(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.deleteRole(Number(stringParam(req.params.id)), actorId(req)), 'Role deleted');
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export async function listBadges(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.listBadges(req.query as never));
  } catch (err) {
    next(err);
  }
}

export async function getBadge(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.getBadge(Number(stringParam(req.params.id))));
  } catch (err) {
    next(err);
  }
}

export async function createBadge(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.createBadge(req.body), 'Badge created', 201);
  } catch (err) {
    next(err);
  }
}

export async function updateBadge(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.updateBadge(Number(stringParam(req.params.id)), req.body), 'Badge updated');
  } catch (err) {
    next(err);
  }
}

export async function deleteBadge(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.deleteBadge(Number(stringParam(req.params.id)), actorId(req)), 'Badge deleted');
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------

export async function listJourneys(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.listJourneys(req.query as never));
  } catch (err) {
    next(err);
  }
}

export async function getJourney(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.getJourney(stringParam(req.params.id)));
  } catch (err) {
    next(err);
  }
}

export async function createJourney(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.createJourney(req.body), 'Journey created', 201);
  } catch (err) {
    next(err);
  }
}

export async function updateJourney(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.updateJourney(stringParam(req.params.id), req.body), 'Journey updated');
  } catch (err) {
    next(err);
  }
}

export async function deleteJourney(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.deleteJourney(stringParam(req.params.id), actorId(req)), 'Journey deleted');
  } catch (err) {
    next(err);
  }
}

export async function addJourneyStep(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.addJourneyStep(stringParam(req.params.id), req.body), 'Journey step added', 201);
  } catch (err) {
    next(err);
  }
}

export async function updateJourneyStep(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.updateJourneyStep(stringParam(req.params.id), stringParam(req.params.stepId), req.body), 'Journey step updated');
  } catch (err) {
    next(err);
  }
}

export async function deleteJourneyStep(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.deleteJourneyStep(stringParam(req.params.id), stringParam(req.params.stepId)), 'Journey step deleted');
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

export async function listTrips(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.listTrips(req.query as never));
  } catch (err) {
    next(err);
  }
}

export async function getTrip(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.getTrip(stringParam(req.params.id)));
  } catch (err) {
    next(err);
  }
}

export async function deleteTrip(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.deleteTrip(stringParam(req.params.id), actorId(req)), 'Trip deleted');
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function listConversations(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.listConversations(req.query as never));
  } catch (err) {
    next(err);
  }
}

export async function getConversation(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.getConversation(stringParam(req.params.id)));
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Token transactions
// ---------------------------------------------------------------------------

export async function listTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.listTransactions(req.query as never));
  } catch (err) {
    next(err);
  }
}

export async function getTransactionStatistics(_req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.getTransactionStatistics());
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Notifications (admin)
// ---------------------------------------------------------------------------

export async function listNotifications(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.listNotifications(req.query as never));
  } catch (err) {
    next(err);
  }
}

export async function createNotification(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.createNotification(req.body);
    sendSuccess(res, result, 'Notification created', 201);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------

export async function listAuditLogs(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.listAuditLogs(req.query as never));
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Overview / health
// ---------------------------------------------------------------------------

export async function getOverview(_req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.getOverview());
  } catch (err) {
    next(err);
  }
}

export async function getSystemHealth(_req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.getSystemHealth());
  } catch (err) {
    next(err);
  }
}

export async function getEntityStatistics(_req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.getEntityStatistics());
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// API monitoring
// ---------------------------------------------------------------------------

export async function getApiMonitoringLogs(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, apiMonitor.getApiMonitoring(req.query as never));
  } catch (err) {
    next(err);
  }
}

export async function getApiMonitoringSummary(_req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, apiMonitor.getApiMonitoringSummary());
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// AI Admin Assistant
// ---------------------------------------------------------------------------

export async function runAssistant(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new AppError(401, 'Authentication required');
    const result = await runAdminAssistant(req.user.userId, req.body?.question);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// User-facing notifications
// ---------------------------------------------------------------------------

export async function getMyNotifications(req: Request, res: Response, next: NextFunction) {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Math.min(50, Number(req.query.limit) || 20);
    const isRead = req.query.isRead === 'true' ? true : req.query.isRead === 'false' ? false : undefined;
    sendSuccess(res, await service.listUserNotifications(actorId(req), page, limit, isRead));
  } catch (err) {
    next(err);
  }
}

export async function getMyUnreadCount(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, { unread: await service.getUnreadCount(actorId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function markNotificationRead(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.markNotificationRead(stringParam(req.params.id), actorId(req)), 'Notification marked as read');
  } catch (err) {
    next(err);
  }
}

export async function markAllNotificationsRead(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.markAllNotificationsRead(actorId(req)), 'All notifications marked as read');
  } catch (err) {
    next(err);
  }
}

export async function deleteNotification(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await service.deleteNotification(stringParam(req.params.id), actorId(req)), 'Notification deleted');
  } catch (err) {
    next(err);
  }
}
