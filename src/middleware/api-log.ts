import { Request, Response, NextFunction } from 'express';
import { recordRequest } from '../services/api-monitor.service.js';

export function apiLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.on('finish', () => {
    recordRequest(req, res, Date.now() - started);
  });
  next();
}
