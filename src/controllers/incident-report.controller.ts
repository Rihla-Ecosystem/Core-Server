// ---------------------------------------------------------------------------
// Incident Report controller (user-facing)
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

export async function createReport(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(201).json({ success: true, data: await service.createIncidentReport(actorId(req), req.body) });
  } catch (err) {
    next(err);
  }
}

export async function listReports(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: await service.listOwnReports(actorId(req), qp(req.query.page, 1), qp(req.query.limit, 20), opt(req.query.status)),
    });
  } catch (err) {
    next(err);
  }
}

export async function getReport(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await service.getIncidentReport(actorId(req), paramId(req)) });
  } catch (err) {
    next(err);
  }
}

export async function deleteReport(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await service.deleteIncidentReport(actorId(req), paramId(req)) });
  } catch (err) {
    next(err);
  }
}