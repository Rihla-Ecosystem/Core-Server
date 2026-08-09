// ---------------------------------------------------------------------------
// Incident Report admin controller (review queue)
// ---------------------------------------------------------------------------
import { Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler.js';
import * as service from '../services/incident-report.service.js';

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, 'Authentication required');
  return req.user.userId;
}

function qp(value: unknown, def: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100) : def;
}

function opt(value: unknown): string | undefined {
  return value === undefined || value === '' ? undefined : String(value);
}

function paramId(req: Request): string {
  return String(req.params.id ?? '');
}

export async function listReportsAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: await service.listAllIncidentReports({
        page: qp(req.query.page, 1),
        limit: qp(req.query.limit, 20),
        status: opt(req.query.status),
        type: opt(req.query.type),
        severity: opt(req.query.severity),
        search: opt(req.query.search),
      }),
    });
  } catch (err) {
    next(err);
  }
}

export async function getReportAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await service.getIncidentReportAdmin(paramId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function updateReportStatus(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: await service.updateIncidentReportStatus(actorId(req), paramId(req), req.body),
    });
  } catch (err) {
    next(err);
  }
}